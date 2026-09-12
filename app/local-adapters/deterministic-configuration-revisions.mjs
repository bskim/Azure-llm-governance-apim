import {
  applyLifecycleCommand,
  createRevision,
  recordTargetOutcome,
} from '../governance-domain/lifecycle/configuration-lifecycle.mjs';

/**
 * Deterministic configuration revisions for local development.
 *
 * Every one is produced by driving the real reducer, so a state the screen renders
 * is a state the product can actually reach. A hand-written fixture would eventually
 * describe a revision the state machine refuses to produce.
 */

const SCOPE_GROUP_ID = 'platform-engineering';
const AUTHOR = 'local-admin';
const APPROVER = 'local-auditor';
// Retained as a separate owner fixture; ordinary administrators can self-approve too.
const OWNER = 'local-owner';
const TARGETS = Object.freeze(['gateway-named-values', 'gateway-policy', 'gateway-backend']);

function at(minute) {
  return `2026-07-24T09:${String(minute).padStart(2, '0')}:00.000Z`;
}

function draft(revisionId, revisionNumber, authoredAt, authoredBy = AUTHOR) {
  return createRevision({
    revisionId,
    scopeGroupId: SCOPE_GROUP_ID,
    revisionNumber,
    authoredBy,
    authoredAt,
    targets: TARGETS,
  });
}

function must(result) {
  if (result.ok !== true) throw new Error(`local fixture drove an illegal transition: ${result.code}`);
  return result.revision;
}

// The fixture is a real caller, so it states the revision it read and, on a publish,
// what it found already in flight.
function command(revision, name, when, options = {}) {
  return must(
    applyLifecycleCommand({
      revision,
      command: name,
      actor: APPROVER,
      at: when,
      expectedRevisionNumber: revision.revisionNumber,
      publishingRevisionId: name === 'publish' ? null : undefined,
      ...options,
    }),
  );
}

function mark(revision, targetCode, outcome, when, reasonCode) {
  return must(recordTargetOutcome({ revision, targetCode, outcome, at: when, reasonCode }));
}

function verify(revision, targetCode, when) {
  return mark(mark(revision, targetCode, 'written', when), targetCode, 'verified', when);
}

function buildRevisions() {
  // The revision serving traffic now.
  let active = command(draft('revision-0007', 7, at(10)), 'approve', at(12));
  active = command(active, 'publish', at(14));
  for (const target of TARGETS) active = verify(active, target, at(15));
  active = command(active, 'complete', at(16));

  // A publish in flight: one target confirmed, one written but not yet read back.
  let publishing = command(draft('revision-0008', 8, at(20)), 'approve', at(22));
  publishing = command(publishing, 'publish', at(24));
  publishing = verify(publishing, 'gateway-named-values', at(25));
  publishing = mark(publishing, 'gateway-policy', 'written', at(26));

  // A publish that wrote one target and could not confirm another. This is the state
  // that looks like success from either end alone.
  let failed = command(draft('revision-0006', 6, at(30)), 'approve', at(32));
  failed = command(failed, 'publish', at(34));
  failed = verify(failed, 'gateway-named-values', at(35));
  failed = mark(failed, 'gateway-policy', 'failed', at(36), 'readback-mismatch');
  failed = command(failed, 'fail', at(37), { reasonCode: 'readback-mismatch' });

  const approved = command(draft('revision-0009', 9, at(40)), 'approve', at(42));
  const pending = draft('revision-0010', 10, at(45));
  // Retain the owner-authored draft alongside the ordinary administrator's draft,
  // without rewriting the seeded revision histories.
  const ownerDraft = draft('revision-0011', 11, at(46), OWNER);

  let superseded = command(draft('revision-0005', 5, at(1)), 'approve', at(2));
  superseded = command(superseded, 'publish', at(3));
  for (const target of TARGETS) superseded = verify(superseded, target, at(4));
  superseded = command(superseded, 'complete', at(5));
  superseded = command(superseded, 'supersede', at(6), { previousActiveRevisionId: 'revision-0004' });

  return Object.freeze([pending, approved, publishing, active, failed, superseded, ownerDraft]);
}

const REVISIONS = buildRevisions();

export function getDeterministicConfigurationRevisions() {
  return REVISIONS;
}

export const LOCAL_LIFECYCLE_ACTORS = Object.freeze({ author: AUTHOR, approver: APPROVER, owner: OWNER });

/** Which local actors hold `approve-own-configuration`. Never read from a request. */
export const LOCAL_SELF_APPROVERS = Object.freeze([AUTHOR, OWNER]);
export const LOCAL_RECOVERY_ABANDONERS = Object.freeze([OWNER]);
