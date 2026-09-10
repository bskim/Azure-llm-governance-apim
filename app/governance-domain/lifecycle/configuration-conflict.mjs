/**
 * What a save would destroy, when two administrators edited the same revision.
 *
 * The store refuses a write whose tag is stale, which is what actually closes the
 * race. This module answers the question the person then has: *what did somebody
 * else do while I was editing?* A refusal without that answer leaves them guessing,
 * and guessing usually ends with someone overwriting work they never saw.
 *
 * The revision already records every action in order, so the entries added since the
 * reader loaded it are exactly the other administrator's work. Nothing has to be
 * reconstructed by comparing fields.
 */

const OVERWRITE_REASON = /^[a-z][a-z0-9-]{2,63}$/;

function fail(message) {
  throw new TypeError(message);
}

function sameEntry(left, right) {
  return (
    left.at === right.at &&
    left.actor === right.actor &&
    left.command === right.command &&
    left.from === right.from &&
    left.to === right.to &&
    left.reasonCode === right.reasonCode
  );
}

function targetOutcomes(revision) {
  return new Map(revision.targets.map((target) => [target.targetCode, target]));
}

export function compareRevisionForOverwrite({ loaded, current }) {
  if (loaded === null || typeof loaded !== 'object') fail('loaded revision is required.');
  if (current === null || typeof current !== 'object') fail('current revision is required.');
  if (loaded.revisionId !== current.revisionId || loaded.scopeGroupId !== current.scopeGroupId) {
    fail('Only two readings of the same revision can be compared.');
  }

  const priorLength = loaded.history.length;
  // The stored revision must contain what was read, unchanged. If it does not, the
  // two are not the same lineage, and describing the difference as "someone else's
  // recent work" would be a guess dressed up as a finding.
  const diverged = loaded.history.some((entry, index) => {
    const stored = current.history[index];
    return stored === undefined || !sameEntry(entry, stored);
  });
  if (diverged) {
    return Object.freeze({
      conflicted: true,
      reasonCode: 'history-diverged',
      loadedRevisionNumber: loaded.revisionNumber,
      currentRevisionNumber: current.revisionNumber,
      currentState: current.state,
      discarded: Object.freeze([]),
      discardedTargets: Object.freeze([]),
    });
  }

  const discarded = current.history.slice(priorLength).map((entry) => Object.freeze({ ...entry }));

  const before = targetOutcomes(loaded);
  const discardedTargets = current.targets
    .filter((target) => {
      const held = before.get(target.targetCode);
      return held === undefined || held.outcome !== target.outcome || held.reasonCode !== target.reasonCode;
    })
    .map((target) =>
      Object.freeze({
        targetCode: target.targetCode,
        from: before.get(target.targetCode)?.outcome ?? null,
        to: target.outcome,
        reasonCode: target.reasonCode,
      }),
    );

  if (discarded.length === 0 && discardedTargets.length === 0) {
    return Object.freeze({
      conflicted: false,
      reasonCode: 'no-change-since-read',
      loadedRevisionNumber: loaded.revisionNumber,
      currentRevisionNumber: current.revisionNumber,
      currentState: current.state,
      discarded: Object.freeze([]),
      discardedTargets: Object.freeze([]),
    });
  }

  return Object.freeze({
    conflicted: true,
    reasonCode: 'changed-since-read',
    loadedRevisionNumber: loaded.revisionNumber,
    currentRevisionNumber: current.revisionNumber,
    currentState: current.state,
    discarded: Object.freeze(discarded),
    discardedTargets: Object.freeze(discardedTargets),
  });
}

/**
 * The record an overwrite leaves behind.
 *
 * Choosing to overwrite destroys work somebody else did deliberately. That is worth
 * an audit entry on its own: without one, the only trace of their change is its
 * absence, and nobody can answer why it went.
 */
export function describeOverwrite({ comparison, actor, at, reasonCode = 'conflict-overwritten' }) {
  if (comparison?.conflicted !== true) fail('An overwrite record needs a conflict to describe.');
  if (typeof actor !== 'string' || actor.length === 0) fail('actor is required.');
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) fail('at must be an ISO-8601 instant.');
  if (!OVERWRITE_REASON.test(reasonCode)) fail('reasonCode must be a bounded lower-case code.');

  return Object.freeze({
    category: 'publish',
    action: 'conflicting-change-overwritten',
    actorCode: actor,
    actorKind: 'user',
    occurredAt: at,
    reasonCode,
    discardedCommands: Object.freeze(comparison.discarded.map((entry) => entry.command)),
    discardedActors: Object.freeze([...new Set(comparison.discarded.map((entry) => entry.actor))]),
    discardedTargetCodes: Object.freeze(comparison.discardedTargets.map((target) => target.targetCode)),
    overwrittenRevisionNumber: comparison.currentRevisionNumber,
  });
}
