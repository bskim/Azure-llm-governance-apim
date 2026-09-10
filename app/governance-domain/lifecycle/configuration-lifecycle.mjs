/**
 * The publication lifecycle of a configuration revision.
 *
 * This is a pure reducer over one revision. It holds the invariants that decide
 * whether a change is safe to be serving traffic, and it holds them structurally
 * rather than by convention:
 *
 * - a revision cannot become active unless every target was written AND read back,
 *   so a partial publish has no path to `active`;
 * - the approver is not the author, so one administrator cannot ship their own
 *   change unreviewed;
 * - every command states the revision it believes it is acting on, so a second
 *   publisher receives a conflict instead of overwriting the first;
 * - a supersede names the revision it defers to, so it cannot quietly mean "leave
 *   nothing serving"; it also does not republish that revision's content, so it is
 *   named for what it records rather than for a restoration it does not perform.
 *
 * The store enforces the same concurrency with an if-match precondition. This module
 * refuses the transition; the store refuses the write. Both are needed: one gives a
 * reason a person can act on, the other closes the race.
 */

export const LIFECYCLE_STATES = Object.freeze([
  'draft',
  'approved',
  'publishing',
  'active',
  'failed',
  'superseded',
  'withdrawn',
]);

export const LIFECYCLE_COMMANDS = Object.freeze([
  'edit',
  'approve',
  'withdraw',
  'abandon',
  'publish',
  'complete',
  'fail',
  'retry',
  'supersede',
]);

export const TARGET_OUTCOMES = Object.freeze(['pending', 'written', 'verified', 'failed']);

/**
 * Checks a revision that came back out of a store rather than out of this module.
 *
 * The reducer's output is trustworthy by construction; a document read from storage
 * is not, and every consumer downstream treats the two the same way.
 */
export function assertConfigurationRevision(revision) {
  if (revision === null || typeof revision !== 'object' || Array.isArray(revision)) {
    fail('revision must be an object.');
  }
  if (revision.contractVersion !== 'v1') fail('contractVersion must be v1.');
  if (revision.documentType !== 'configuration-revision') {
    fail('documentType must be configuration-revision.');
  }
  assertId(revision.revisionId, 'revisionId');
  assertId(revision.scopeGroupId, 'scopeGroupId');
  assertId(revision.authoredBy, 'authoredBy');
  assertInstant(revision.authoredAt, 'authoredAt');
  if (!Number.isSafeInteger(revision.revisionNumber) || revision.revisionNumber < 1) {
    fail('revisionNumber must be a positive integer.');
  }
  if (!LIFECYCLE_STATES.includes(revision.state)) fail('state is unsupported.');
  if (!Array.isArray(revision.targets) || revision.targets.length === 0) {
    fail('A revision must declare at least one publication target.');
  }
  for (const target of revision.targets) {
    assertId(target?.targetCode, 'target.targetCode');
    if (!TARGET_OUTCOMES.includes(target.outcome)) fail('target.outcome is unsupported.');
  }
  // The history is what a conflict report is derived from, so an empty one would
  // make every overwrite look like it destroyed nothing.
  if (!Array.isArray(revision.history) || revision.history.length === 0) {
    fail('A revision must carry the actions that produced it.');
  }
  return revision;
}

// `written` is deliberately not enough to finish. A target that was written but whose
// read-back did not confirm it is a target nobody has seen serving the new value.
const PUBLISHABLE_OUTCOME = 'verified';

const ALLOWED_FROM = Object.freeze({
  edit: ['draft'],
  approve: ['draft'],
  withdraw: ['draft', 'approved'],
  abandon: ['draft', 'approved', 'publishing', 'failed'],
  publish: ['approved'],
  complete: ['publishing'],
  fail: ['publishing'],
  retry: ['failed'],
  supersede: ['active', 'failed'],
});

const NEXT_STATE = Object.freeze({
  edit: 'draft',
  approve: 'approved',
  withdraw: 'draft',
  abandon: 'withdrawn',
  publish: 'publishing',
  complete: 'active',
  fail: 'failed',
  retry: 'publishing',
  supersede: 'superseded',
});

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
// A reason travels into an audit record and onto an administrator's screen, so it is
// a code, not a place to put an exception message or a URL.
const REASON_CODE = /^[a-z][a-z0-9-]{2,63}$/;

/**
 * What an operator may record when marking a publish failed.
 *
 * A narrower set than the reasons the reducer itself produces: those describe why an
 * action was refused, while these describe why a publish is being abandoned. The list
 * lives here so a screen offers what the product defines rather than a vocabulary an
 * operator would have to already know.
 */
export const OPERATOR_FAILURE_REASONS = Object.freeze([
  'readback-mismatch',
  'gateway-write-rejected',
  'gateway-unreachable',
  'partial-publish',
  'superseded-by-operator',
]);

function fail(message) {
  throw new TypeError(message);
}

function refuse(code, detail = {}) {
  return Object.freeze({ ok: false, code, ...detail });
}

function assertId(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) fail(`${name} must be a bounded identifier.`);
}

function isReasonCode(value) {
  return typeof value === 'string' && REASON_CODE.test(value);
}

function assertInstant(value, name) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    fail(`${name} must be an ISO-8601 instant.`);
  }
}

export function createRevision({ revisionId, scopeGroupId, revisionNumber, authoredBy, authoredAt, targets }) {
  assertId(revisionId, 'revisionId');
  assertId(scopeGroupId, 'scopeGroupId');
  assertId(authoredBy, 'authoredBy');
  assertInstant(authoredAt, 'authoredAt');
  if (!Number.isSafeInteger(revisionNumber) || revisionNumber < 1) {
    fail('revisionNumber must be a positive integer.');
  }
  if (!Array.isArray(targets) || targets.length === 0) {
    // A publish with no target would report success without changing anything.
    fail('A revision must declare at least one publication target.');
  }
  for (const target of targets) assertId(target, 'target');

  return Object.freeze({
    contractVersion: 'v1',
    documentType: 'configuration-revision',
    revisionId,
    scopeGroupId,
    revisionNumber,
    state: 'draft',
    authoredBy,
    authoredAt,
    approvedBy: null,
    approvedAt: null,
    publishedBy: null,
    publishStartedAt: null,
    publishCompletedAt: null,
    targets: Object.freeze(
      [...targets].sort().map((targetCode) => Object.freeze({ targetCode, outcome: 'pending', reasonCode: null })),
    ),
    failure: null,
    supersededInFavourOf: null,
    history: Object.freeze([
      Object.freeze({ at: authoredAt, actor: authoredBy, from: null, to: 'draft', command: 'create', reasonCode: 'revision-created' }),
    ]),
  });
}

function withHistory(revision, entry) {
  return Object.freeze([...revision.history, Object.freeze(entry)]);
}

function resetTargetsForRetry(targets) {
  // A target already verified is not rewritten by a retry: repeating a write that
  // succeeded widens the blast radius of a failure that happened elsewhere.
  return Object.freeze(
    targets.map((target) =>
      target.outcome === PUBLISHABLE_OUTCOME
        ? target
        : Object.freeze({ targetCode: target.targetCode, outcome: 'pending', reasonCode: null }),
    ),
  );
}

/**
 * Applies one command to one revision.
 *
 * Returns a refusal rather than throwing for anything an operator could cause, so the
 * screen can explain it. Throwing is reserved for a malformed call.
 */
export function applyLifecycleCommand({
  revision,
  command,
  actor,
  at,
  expectedRevisionNumber,
  reasonCode = null,
  publishingRevisionId,
  previousActiveRevisionId = null,
  selfApprovalGranted,
}) {
  if (revision === null || typeof revision !== 'object') fail('revision is required.');
  if (!LIFECYCLE_COMMANDS.includes(command)) fail(`command '${command}' is unsupported.`);
  assertId(actor, 'actor');
  assertInstant(at, 'at');

  // Required, not optional. A check that silently does nothing when the caller forgets
  // an argument is not a check; the caller must state which revision it read.
  if (!Number.isSafeInteger(expectedRevisionNumber)) {
    fail('expectedRevisionNumber is required: state the revision you read.');
  }
  if (expectedRevisionNumber !== revision.revisionNumber) {
    return refuse('revision-conflict', {
      expectedRevisionNumber,
      currentRevisionNumber: revision.revisionNumber,
    });
  }

  if (!ALLOWED_FROM[command].includes(revision.state)) {
    return refuse('transition-not-allowed', { from: revision.state, command });
  }

  if (command === 'approve' && actor === revision.authoredBy) {
    // Three answers, not two: `true` is an authority the caller checked and found,
    // `false` is one it checked and did not find, and omitting it means it never
    // looked. Letting the last of those pass would make the rule optional.
    if (selfApprovalGranted === undefined) {
      fail('selfApprovalGranted is required to approve your own change: state whether the actor holds it.');
    }
    if (selfApprovalGranted !== true) return refuse('separation-of-duties');
  }

  if (command === 'publish') {
    // `null` means the caller looked and found nothing in flight. Omitting the argument
    // means it never looked, and those must not be the same answer.
    if (publishingRevisionId === undefined) {
      fail('publishingRevisionId is required on publish: state what is already in flight, or null.');
    }
    if (publishingRevisionId !== null && publishingRevisionId !== revision.revisionId) {
      // Two publishers writing the same targets would interleave, and the loser would
      // never know.
      return refuse('publish-in-progress', { publishingRevisionId });
    }
  }

  if (command === 'complete') {
    const unverified = revision.targets.filter((target) => target.outcome !== PUBLISHABLE_OUTCOME);
    if (unverified.length > 0) {
      return refuse('targets-not-verified', {
        targetCodes: unverified.map((target) => target.targetCode),
      });
    }
  }

  if (command === 'fail' && !isReasonCode(reasonCode)) {
    return refuse('failure-reason-required');
  }

  if (command === 'supersede') {
    if (previousActiveRevisionId === null) {
      // Marking this superseded with nothing to defer to would leave no configuration
      // serving, which is not a safer state than the one being abandoned.
      return refuse('no-previous-active');
    }

    assertId(previousActiveRevisionId, 'previousActiveRevisionId');
    if (previousActiveRevisionId === revision.revisionId) return refuse('supersede-to-self');
  }
  if (command === 'abandon' && hasPublicationActivity(revision)) {
    if (revision.targets.some((target) => target.outcome === PUBLISHABLE_OUTCOME)) {
      return refuse('proposal-abandonment-verified-targets');
    }
    return refuse('proposal-abandonment-publish-started');
  }

  // Withdrawing an approval returns the proposal to its author; withdrawing an
  // unapproved proposal closes it so a new proposal is not blocked indefinitely.
  const to = command === 'withdraw' && revision.state === 'draft' ? 'withdrawn' : NEXT_STATE[command];
  // An approval by the author is not an ordinary approval, and an audit record that
  // called it one would claim a second person reviewed the change.
  const selfApproved = command === 'approve' && actor === revision.authoredBy;
  const next = {
    ...revision,
    state: to,
    history: withHistory(revision, {
      at,
      actor,
      from: revision.state,
      to,
      command,
      reasonCode: reasonCode ?? (selfApproved ? 'self-approval-granted' : `${command}-applied`),
    }),
  };

  if (command === 'approve') {
    next.approvedBy = actor;
    next.approvedAt = at;
  }
  if (command === 'withdraw') {
    // Approval does not survive an edit cycle; the next publish needs a fresh one.
    next.approvedBy = null;
    next.approvedAt = null;
  }
  if (command === 'publish' || command === 'retry') {
    next.publishedBy = actor;
    next.publishStartedAt = at;
    next.publishCompletedAt = null;
    next.failure = null;
    next.targets = command === 'retry' ? resetTargetsForRetry(revision.targets) : revision.targets;
  }
  if (command === 'complete') {
    next.publishCompletedAt = at;
    next.failure = null;
  }
  if (command === 'fail') {
    next.failure = Object.freeze({ reasonCode, at });
  }
  if (command === 'supersede') {
    next.supersededInFavourOf = previousActiveRevisionId;
  }

  next.targets = Object.freeze(next.targets);
  return Object.freeze({ ok: true, revision: Object.freeze(next) });
}

/**
 * Records what one publication target actually did.
 *
 * Outcomes only move forward within an attempt, so a late duplicate report cannot
 * downgrade a target that already verified.
 */
export function recordTargetOutcome({ revision, targetCode, outcome, at, reasonCode = null }) {
  if (revision === null || typeof revision !== 'object') fail('revision is required.');
  if (!TARGET_OUTCOMES.includes(outcome)) fail(`outcome '${outcome}' is unsupported.`);
  assertInstant(at, 'at');

  if (revision.state !== 'publishing') {
    return refuse('not-publishing', { state: revision.state });
  }
  const index = revision.targets.findIndex((target) => target.targetCode === targetCode);
  if (index === -1) return refuse('target-not-declared', { targetCode });

  if (outcome === 'failed' && !isReasonCode(reasonCode)) {
    return refuse('failure-reason-required');
  }

  // `verified` and `failed` are both terminal for an attempt, so neither may replace
  // the other: a stray late report must not fail a publish that was already confirmed.
  const rank = { pending: 0, written: 1, verified: 2, failed: 2 };
  const current = revision.targets[index];
  if (rank[outcome] < rank[current.outcome] || (rank[outcome] === rank[current.outcome] && outcome !== current.outcome)) {
    return refuse('outcome-regression', { targetCode, from: current.outcome, to: outcome });
  }

  const targets = [...revision.targets];
  targets[index] = Object.freeze({
    targetCode,
    outcome,
    reasonCode: outcome === 'failed' ? reasonCode : null,
  });

  return Object.freeze({
    ok: true,
    revision: Object.freeze({
      ...revision,
      targets: Object.freeze(targets),
      history: withHistory(revision, {
        at,
        actor: targetCode,
        from: current.outcome,
        to: outcome,
        command: 'target-outcome',
        reasonCode: reasonCode ?? `target-${outcome}`,
      }),
    }),
  });
}

/** Whether every declared target was written and confirmed by a read-back. */
export function isFullyVerified(revision) {
  return revision.targets.every((target) => target.outcome === PUBLISHABLE_OUTCOME);
}

/**
 * A publication attempt reserves the revision before it writes a target. This remains
 * true after a failure so withdrawal cannot claim that no target-side effect occurred.
 */
export function hasPublicationActivity(revision) {
  return revision.state === 'publishing'
    || revision.publishedBy !== null
    || revision.publishStartedAt !== null
    || revision.publishCompletedAt !== null
    || revision.targets.some((target) => target.outcome !== 'pending');
}

/**
 * What could be done to this revision next, read from the same table the reducer
 * uses. A screen that computed this separately would eventually offer a button the
 * reducer refuses.
 */
export function availableCommands(revision, { actor = null, selfApprovalGranted = false } = {}) {
  return Object.freeze(
    LIFECYCLE_COMMANDS.filter((command) => {
      if (!ALLOWED_FROM[command].includes(revision.state)) return false;
      if (command === 'approve' && actor !== null && actor === revision.authoredBy) {
        return selfApprovalGranted === true;
      }
      if (command === 'complete' && !isFullyVerified(revision)) return false;
      if (command === 'abandon' && hasPublicationActivity(revision)) {
        return false;
      }
      return true;
    }),
  );
}

export function summariseTargets(revision) {
  const counts = { pending: 0, written: 0, verified: 0, failed: 0 };
  for (const target of revision.targets) counts[target.outcome] += 1;
  return Object.freeze({
    ...counts,
    total: revision.targets.length,
    // A publish that touched some targets and not others is the state an operator has
    // to be told about explicitly; it looks like success from either end alone.
    partial: counts.failed > 0 && counts.verified > 0,
  });
}
