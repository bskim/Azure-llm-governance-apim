import {
  applyLifecycleCommand,
  assertConfigurationRevision,
} from '../governance-domain/lifecycle/configuration-lifecycle.mjs';
import {
  compareRevisionForOverwrite,
  describeOverwrite,
} from '../governance-domain/lifecycle/configuration-conflict.mjs';

/**
 * Saving a configuration change, including the case where somebody else saved first.
 *
 * Two checks run, and both are needed. The reducer refuses a command aimed at a
 * revision the caller did not read, which gives a person a reason they can act on.
 * The store refuses a write whose tag is stale, which closes the window between
 * deciding to save and saving. Checking in the application alone would leave that
 * window open; refusing at the store alone would leave the person with nothing but
 * an error code.
 *
 * On a conflict the caller is told exactly what the other administrator did, because
 * the choice being offered is whether to destroy it.
 */

function fail(message) {
  throw new TypeError(message);
}

export function createConfigurationWriter({ store }) {
  if (typeof store?.readConfigurationRevision !== 'function' || typeof store?.putConfigurationRevision !== 'function') {
    fail('store must be able to read and write configuration revisions.');
  }

  async function readForEdit({ scopeGroupId, revisionId }) {
    const held = await store.readConfigurationRevision({ scopeGroupId, revisionId });
    if (held === null) return null;
    // The tag travels with the document because the caller cannot save safely
    // without handing back the version it actually saw.
    return Object.freeze({ revision: held.document, etag: held.etag });
  }

  async function conflictFrom({ loaded, priorReading, at }) {
    const held = await store.readConfigurationRevision({
      scopeGroupId: loaded.scopeGroupId,
      revisionId: loaded.revisionId,
    });
    if (held === null) {
      return Object.freeze({ outcome: 'vanished', reasonCode: 'revision-absent', at });
    }
    // Compared against what the caller actually read. Comparing the stored revision
    // with a fresh read of itself would always report that nothing changed, which is
    // the one answer a conflict proves wrong.
    const comparison = compareRevisionForOverwrite({ loaded: priorReading ?? loaded, current: held.document });
    return Object.freeze({
      outcome: 'conflict',
      reasonCode: comparison.reasonCode,
      comparison,
      // Handed back so a caller who chooses to overwrite writes against what it was
      // just shown, not against the version it had before the conflict.
      currentEtag: held.etag,
      current: held.document,
    });
  }

  /**
   * @param force - overwrite the other administrator's work.
   * @param acknowledgedEtag - the version the caller was shown when it agreed to the
   *   loss. The overwrite is written against that version, so a change arriving while
   *   the warning was on screen produces a second warning instead of being carried
   *   away by a confirmation that never mentioned it.
   */
  async function save({
    loaded,
    etag,
    command,
    actor,
    at,
    force = false,
    acknowledgedEtag = null,
    priorReading = null,
    expectedRevisionNumber,
    ...rest
  }) {
    assertConfigurationRevision(loaded);
    if (typeof etag !== 'string' || etag.length === 0) {
      fail('etag is required: state the version you read.');
    }

    const applied = applyLifecycleCommand({
      revision: loaded,
      command,
      actor,
      at,
      // A caller that read an older revision says so, and the reducer refuses before
      // the store is touched. Defaulting to the stored number would make every save
      // look current to the reducer and leave only the tag to catch the race.
      expectedRevisionNumber: expectedRevisionNumber ?? priorReading?.revisionNumber ?? loaded.revisionNumber,
      ...rest,
    });
    if (applied.ok !== true) {
      if (applied.code === 'revision-conflict') return conflictFrom({ loaded, priorReading, at });
      // The reducer states what it refused over — which publish is in flight, which
      // targets are unconfirmed. Dropping it leaves the operator hunting for an
      // answer the refusal already had.
      const { ok, code, ...detail } = applied;
      return Object.freeze({
        outcome: 'refused',
        reasonCode: applied.code,
        detail: Object.keys(detail).length === 0 ? null : Object.freeze(detail),
      });
    }

    try {
      const written = await store.putConfigurationRevision(applied.revision, { ifMatch: etag });
      return Object.freeze({
        outcome: 'saved',
        revision: written.document,
        etag: written.etag,
        overwrote: null,
      });
    } catch (error) {
      if (error?.name !== 'ConcurrencyConflictError') throw error;

      const conflict = await conflictFrom({ loaded, priorReading, at });
      if (!force || conflict.outcome !== 'conflict' || conflict.comparison.reasonCode === 'history-diverged') {
        // A diverged history is not a difference a person can weigh, so it is never
        // offered as something to overwrite.
        return conflict;
      }
      // Forcing without naming the version that was seen would destroy whatever
      // happens to be stored now, which is not what anybody agreed to.
      if (typeof acknowledgedEtag !== 'string' || acknowledgedEtag.length === 0) return conflict;

      let overwritten;
      try {
        overwritten = await store.putConfigurationRevision(applied.revision, { ifMatch: acknowledgedEtag });
      } catch (raced) {
        if (raced?.name !== 'ConcurrencyConflictError') throw raced;
        // Something landed after the warning was rendered. It gets its own warning.
        return conflictFrom({ loaded, priorReading, at });
      }
      return Object.freeze({
        outcome: 'saved',
        revision: overwritten.document,
        etag: overwritten.etag,
        // The discarded work leaves a record. Its absence would otherwise be the only
        // evidence it ever existed.
        overwrote: describeOverwrite({ comparison: conflict.comparison, actor, at }),
      });
    }
  }

  return Object.freeze({ readForEdit, save });
}
