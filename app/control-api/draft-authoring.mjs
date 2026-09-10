import {
  assertPublishableContent,
  configurationDraftDocument,
  DRAFT_REASONS,
} from '../governance-domain/lifecycle/configuration-draft-document.mjs';
import { createRevision } from '../governance-domain/lifecycle/configuration-lifecycle.mjs';

/**
 * Authoring a change, as the same versioned set the publisher already applies.
 *
 * An operator edits one budget, not five snapshots, but what gets published is still
 * the whole set: a partial write would land without the other four being revalidated,
 * and the resolver would have to decide which of two write paths was authoritative.
 * So an edit produces a complete proposal, and the pipeline that applies it is the one
 * that already verifies each target by reading it back.
 */

export class DraftUnavailableError extends Error {
  constructor(reasonCode) {
    super(`The proposal cannot be read: ${reasonCode}.`);
    this.name = 'DraftUnavailableError';
    this.code = reasonCode;
  }
}

function nextRevisionNumber(revisions) {
  return revisions.reduce((highest, revision) => Math.max(highest, revision.revisionNumber), 0) + 1;
}

export function createDraftAuthor({
  store,
  scopeGroupId,
  clock,
  targets,
  assertContent = assertPublishableContent,
}) {
  for (const method of [
    'queryConfigurationRevisions',
    'putConfigurationRevision',
    'readConfigurationDraft',
    'putConfigurationDraft',
  ]) {
    if (typeof store?.[method] !== 'function') throw new TypeError(`store must implement ${method}.`);
  }
  if (typeof scopeGroupId !== 'string' || scopeGroupId.length === 0) {
    throw new TypeError('scopeGroupId is required.');
  }
  if (typeof clock?.nowIso !== 'function') throw new TypeError('clock is required.');
  if (!Array.isArray(targets) || targets.length === 0) throw new TypeError('targets are required.');
  if (typeof assertContent !== 'function') throw new TypeError('assertContent must be a function.');

  return Object.freeze({
    /**
     * The draft is written before the revision. A revision whose draft is missing is
     * refused by name, so the surviving half of a torn write blocks a publish; a draft
     * whose revision is missing is unreachable and publishes nothing.
     */
    async propose({ content, authoredBy }) {
      try {
        assertContent(content);
      } catch (error) {
        throw new DraftUnavailableError(error.code ?? DRAFT_REASONS.contentIncomplete);
      }

      const at = clock.nowIso();
      const revisions = await store.queryConfigurationRevisions({ scopeGroupId });
      const revisionNumber = nextRevisionNumber(revisions);
      const revisionId = `revision-${String(revisionNumber).padStart(4, '0')}`;

      await store.putConfigurationDraft(
        configurationDraftDocument({ scopeGroupId, revisionId, content, authoredBy, authoredAt: at }),
        { ifMatch: null },
      );

      const revision = createRevision({
        revisionId,
        scopeGroupId,
        revisionNumber,
        authoredBy,
        authoredAt: at,
        targets,
      });
      const { etag } = await store.putConfigurationRevision(revision, { ifMatch: null });
      return { revision, etag };
    },

    /**
     * What a publish will apply. Read from the store rather than accepted from the
     * request that triggers the publish, so the content that was approved is the
     * content that lands.
     */
    async proposedContent({ revisionId }) {
      let held;
      try {
        held = await store.readConfigurationDraft({ scopeGroupId, revisionId });
      } catch {
        throw new DraftUnavailableError(DRAFT_REASONS.contentUnreadable);
      }
      if (held === null) throw new DraftUnavailableError(DRAFT_REASONS.contentAbsent);
      return held.document.content;
    },
  });
}
