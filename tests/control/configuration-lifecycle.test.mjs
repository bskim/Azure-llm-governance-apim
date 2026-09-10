import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyLifecycleCommand,
  availableCommands,
  createRevision,
  isFullyVerified,
  recordTargetOutcome,
  summariseTargets,
} from '../../app/governance-domain/lifecycle/configuration-lifecycle.mjs';

const AUTHOR = 'actor-author';
const APPROVER = 'actor-approver';
const T0 = '2026-07-24T10:00:00.000Z';

function revision(overrides = {}) {
  return createRevision({
    revisionId: 'revision-001',
    scopeGroupId: 'platform-engineering',
    revisionNumber: 4,
    authoredBy: AUTHOR,
    authoredAt: T0,
    targets: ['gateway-named-values', 'gateway-policy'],
    ...overrides,
  });
}

function apply(current, command, options = {}) {
  const result = applyLifecycleCommand({
    revision: current,
    command,
    actor: options.actor ?? APPROVER,
    at: options.at ?? T0,
    expectedRevisionNumber: current.revisionNumber,
    publishingRevisionId: command === 'publish' ? null : undefined,
    ...options,
  });
  return result;
}

function mustApply(current, command, options = {}) {
  const result = apply(current, command, options);
  assert.equal(result.ok, true, `${command} should have been allowed: ${result.code}`);
  return result.revision;
}

function verifyAll(current) {
  let next = current;
  for (const target of current.targets) {
    next = recordTargetOutcome({ revision: next, targetCode: target.targetCode, outcome: 'written', at: T0 }).revision;
    next = recordTargetOutcome({ revision: next, targetCode: target.targetCode, outcome: 'verified', at: T0 }).revision;
  }
  return next;
}

test('a revision starts as a draft that nobody has approved', () => {
  const draft = revision();
  assert.equal(draft.state, 'draft');
  assert.equal(draft.approvedBy, null);
  assert.deepEqual(draft.targets.map((target) => target.outcome), ['pending', 'pending']);
  assert.equal(draft.history.length, 1);
});

test('a revision must declare where it will be published', () => {
  assert.throws(() => revision({ targets: [] }), /at least one publication target/);
});

test('the author cannot approve their own change', () => {
  const refused = apply(revision(), 'approve', { actor: AUTHOR, selfApprovalGranted: false });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'separation-of-duties');

  const approved = mustApply(revision(), 'approve', { actor: APPROVER });
  assert.equal(approved.state, 'approved');
  assert.equal(approved.approvedBy, APPROVER);
});

test('a caller that never checked the self-approval authority is not treated as having checked', () => {
  // Refusing here would be safe but would hide the caller's omission, and allowing it
  // would make the rule optional. Neither is an answer, so it is an error.
  assert.throws(
    () => apply(revision(), 'approve', { actor: AUTHOR }),
    /selfApprovalGranted is required/,
  );
});

test('an actor holding the self-approval authority may approve their own change', () => {
  const approved = mustApply(revision(), 'approve', { actor: AUTHOR, selfApprovalGranted: true });
  assert.equal(approved.state, 'approved');
  assert.equal(approved.approvedBy, AUTHOR);
});

test('a self-approval is recorded as one, not as an ordinary approval', () => {
  const approved = mustApply(revision(), 'approve', { actor: AUTHOR, selfApprovalGranted: true });
  assert.equal(approved.history.at(-1).reasonCode, 'self-approval-granted');

  const reviewed = mustApply(revision(), 'approve', { actor: APPROVER });
  assert.equal(reviewed.history.at(-1).reasonCode, 'approve-applied');
});

test('the authority only reaches approval, and only the author', () => {
  // Granting it must not quietly relax any other transition.
  const refused = apply(revision(), 'complete', { actor: AUTHOR, selfApprovalGranted: true });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'transition-not-allowed');

  const approved = mustApply(revision(), 'approve', { actor: APPROVER, selfApprovalGranted: true });
  assert.equal(approved.history.at(-1).reasonCode, 'approve-applied');
});

test('a screen offers self-approval only to an actor that holds the authority', () => {
  const draft = revision();
  assert.equal(availableCommands(draft, { actor: AUTHOR }).includes('approve'), false);
  assert.equal(
    availableCommands(draft, { actor: AUTHOR, selfApprovalGranted: true }).includes('approve'),
    true,
  );
  assert.equal(availableCommands(draft, { actor: APPROVER }).includes('approve'), true);
});

test('a stale editor is told the revision moved instead of overwriting it', () => {
  const refused = apply(revision(), 'approve', { expectedRevisionNumber: 3 });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'revision-conflict');
  assert.equal(refused.currentRevisionNumber, 4);

  assert.equal(apply(revision(), 'approve', { expectedRevisionNumber: 4 }).ok, true);
});

test('withdrawing an approval does not leave the approval behind', () => {
  const approved = mustApply(revision(), 'approve');
  const withdrawn = mustApply(approved, 'withdraw', { actor: AUTHOR });
  assert.equal(withdrawn.state, 'draft');
  assert.equal(withdrawn.approvedBy, null);
  assert.equal(withdrawn.approvedAt, null);
});

test('a second publisher is refused while another revision is mid-publish', () => {
  const approved = mustApply(revision(), 'approve');
  const refused = apply(approved, 'publish', { publishingRevisionId: 'revision-002' });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'publish-in-progress');
  assert.equal(refused.publishingRevisionId, 'revision-002');

  assert.equal(apply(approved, 'publish', { publishingRevisionId: 'revision-001' }).ok, true);
});

test('a written target is not enough; a revision goes active only after read-back', () => {
  const publishing = mustApply(mustApply(revision(), 'approve'), 'publish');

  let written = publishing;
  for (const target of publishing.targets) {
    written = recordTargetOutcome({ revision: written, targetCode: target.targetCode, outcome: 'written', at: T0 }).revision;
  }
  const tooEarly = apply(written, 'complete');
  assert.equal(tooEarly.ok, false);
  assert.equal(tooEarly.code, 'targets-not-verified');
  assert.deepEqual(tooEarly.targetCodes, ['gateway-named-values', 'gateway-policy']);

  const verified = verifyAll(publishing);
  assert.equal(isFullyVerified(verified), true);
  const active = mustApply(verified, 'complete');
  assert.equal(active.state, 'active');
  assert.equal(active.publishCompletedAt, T0);
});

test('a partial publish cannot reach active and is reported as partial', () => {
  const publishing = mustApply(mustApply(revision(), 'approve'), 'publish');
  let partial = recordTargetOutcome({ revision: publishing, targetCode: 'gateway-named-values', outcome: 'written', at: T0 }).revision;
  partial = recordTargetOutcome({ revision: partial, targetCode: 'gateway-named-values', outcome: 'verified', at: T0 }).revision;
  partial = recordTargetOutcome({
    revision: partial,
    targetCode: 'gateway-policy',
    outcome: 'failed',
    at: T0,
    reasonCode: 'gateway-write-rejected',
  }).revision;

  assert.equal(apply(partial, 'complete').code, 'targets-not-verified');
  const summary = summariseTargets(partial);
  assert.equal(summary.partial, true);
  assert.equal(summary.verified, 1);
  assert.equal(summary.failed, 1);

  const failed = mustApply(partial, 'fail', { reasonCode: 'partial-publish' });
  assert.equal(failed.state, 'failed');
  assert.equal(failed.failure.reasonCode, 'partial-publish');
});

test('a read-back that disagrees fails the publish rather than completing it', () => {
  const publishing = mustApply(mustApply(revision(), 'approve'), 'publish');
  let written = publishing;
  for (const target of publishing.targets) {
    written = recordTargetOutcome({ revision: written, targetCode: target.targetCode, outcome: 'written', at: T0 }).revision;
  }
  const mismatched = recordTargetOutcome({
    revision: written,
    targetCode: 'gateway-policy',
    outcome: 'failed',
    at: T0,
    reasonCode: 'readback-mismatch',
  }).revision;

  assert.equal(apply(mismatched, 'complete').ok, false);
  const failed = mustApply(mismatched, 'fail', { reasonCode: 'readback-mismatch' });
  assert.equal(failed.failure.reasonCode, 'readback-mismatch');
});

test('a failure must say why', () => {
  const publishing = mustApply(mustApply(revision(), 'approve'), 'publish');
  assert.equal(apply(publishing, 'fail').code, 'failure-reason-required');
  assert.equal(
    recordTargetOutcome({ revision: publishing, targetCode: 'gateway-policy', outcome: 'failed', at: T0 }).code,
    'failure-reason-required',
  );
});

test('a retry rewrites only what did not succeed', () => {
  const publishing = mustApply(mustApply(revision(), 'approve'), 'publish');
  let partial = recordTargetOutcome({ revision: publishing, targetCode: 'gateway-named-values', outcome: 'written', at: T0 }).revision;
  partial = recordTargetOutcome({ revision: partial, targetCode: 'gateway-named-values', outcome: 'verified', at: T0 }).revision;
  partial = recordTargetOutcome({ revision: partial, targetCode: 'gateway-policy', outcome: 'failed', at: T0, reasonCode: 'gateway-write-rejected' }).revision;
  const failed = mustApply(partial, 'fail', { reasonCode: 'partial-publish' });

  const retried = mustApply(failed, 'retry');
  assert.equal(retried.state, 'publishing');
  assert.equal(retried.failure, null);
  assert.deepEqual(
    retried.targets.map((target) => [target.targetCode, target.outcome]),
    [['gateway-named-values', 'verified'], ['gateway-policy', 'pending']],
  );
});

test('a late duplicate report cannot downgrade a target that already verified', () => {
  const publishing = mustApply(mustApply(revision(), 'approve'), 'publish');
  const verified = verifyAll(publishing);
  for (const outcome of ['pending', 'written']) {
    const regressed = recordTargetOutcome({ revision: verified, targetCode: 'gateway-policy', outcome, at: T0 });
    assert.equal(regressed.ok, false, outcome);
    assert.equal(regressed.code, 'outcome-regression', outcome);
  }
  // A stray late failure must not undo a target that was already confirmed, or a
  // publish that finished correctly could be failed by a straggler.
  const lateFailure = recordTargetOutcome({
    revision: verified,
    targetCode: 'gateway-policy',
    outcome: 'failed',
    at: T0,
    reasonCode: 'gateway-write-rejected',
  });
  assert.equal(lateFailure.ok, false);
  assert.equal(lateFailure.code, 'outcome-regression');

  // The mirror case: a failed target is not silently promoted to verified either.
  const failedTarget = recordTargetOutcome({
    revision: publishing,
    targetCode: 'gateway-policy',
    outcome: 'failed',
    at: T0,
    reasonCode: 'gateway-write-rejected',
  }).revision;
  assert.equal(
    recordTargetOutcome({ revision: failedTarget, targetCode: 'gateway-policy', outcome: 'verified', at: T0 }).code,
    'outcome-regression',
  );
});

test('a command that does not say which revision it read is refused outright', () => {
  // Omitting the check is not the same as passing it. A silent no-op would leave a
  // stale editor unprotected without anyone noticing.
  assert.throws(
    () => applyLifecycleCommand({ revision: revision(), command: 'approve', actor: APPROVER, at: T0 }),
    /expectedRevisionNumber is required/,
  );
});

test('a publish that never checked for another publisher is refused outright', () => {
  const approved = mustApply(revision(), 'approve');
  assert.throws(
    () =>
      applyLifecycleCommand({
        revision: approved,
        command: 'publish',
        actor: APPROVER,
        at: T0,
        expectedRevisionNumber: approved.revisionNumber,
      }),
    /publishingRevisionId is required/,
  );
  // Explicit `null` means the caller looked and found nothing in flight.
  assert.equal(
    applyLifecycleCommand({
      revision: approved,
      command: 'publish',
      actor: APPROVER,
      at: T0,
      expectedRevisionNumber: approved.revisionNumber,
      publishingRevisionId: null,
    }).ok,
    true,
  );
});

test('a reason is a code, not a place to put an exception message', () => {
  const publishing = mustApply(mustApply(revision(), 'approve'), 'publish');
  for (const bad of ['Write failed at https://example.invalid/x?key=abc', 'ERR', 'Gateway Rejected']) {
    assert.equal(apply(publishing, 'fail', { reasonCode: bad }).code, 'failure-reason-required', bad);
    assert.equal(
      recordTargetOutcome({ revision: publishing, targetCode: 'gateway-policy', outcome: 'failed', at: T0, reasonCode: bad }).code,
      'failure-reason-required',
      bad,
    );
  }
});

test('editing keeps the revision a draft and leaves its targets untouched', () => {
  const edited = mustApply(revision(), 'edit', { actor: AUTHOR });
  assert.equal(edited.state, 'draft');
  assert.deepEqual(edited.targets, revision().targets);
  assert.equal(edited.history.at(-1).command, 'edit');
});

test('every state refuses the commands it has no transition for', () => {
  const draft = revision();
  const approved = mustApply(draft, 'approve');
  const publishing = mustApply(approved, 'publish');
  const active = mustApply(verifyAll(publishing), 'complete');
  const failed = mustApply(publishing, 'fail', { reasonCode: 'gateway-unreachable' });
  const superseded = mustApply(active, 'supersede', { previousActiveRevisionId: 'revision-000' });

  const illegal = [
    [approved, ['edit', 'approve', 'complete', 'fail', 'retry', 'supersede']],
    [publishing, ['edit', 'approve', 'withdraw', 'publish', 'retry', 'supersede']],
    [active, ['edit', 'approve', 'withdraw', 'publish', 'complete', 'fail', 'retry']],
    [failed, ['edit', 'approve', 'withdraw', 'publish', 'complete', 'fail']],
    // Superseded is terminal: nothing continues from it.
    [superseded, ['edit', 'approve', 'withdraw', 'publish', 'complete', 'fail', 'retry', 'supersede']],
  ];
  for (const [current, commands] of illegal) {
    for (const command of commands) {
      const refused = apply(current, command, {
        actor: APPROVER,
        reasonCode: 'gateway-unreachable',
        previousActiveRevisionId: 'revision-000',
      });
      assert.equal(refused.ok, false, `${current.state}/${command}`);
      assert.equal(refused.code, 'transition-not-allowed', `${current.state}/${command}`);
    }
  }
});

test('a target nobody declared is refused, and outcomes are refused outside a publish', () => {
  const publishing = mustApply(mustApply(revision(), 'approve'), 'publish');
  assert.equal(
    recordTargetOutcome({ revision: publishing, targetCode: 'somewhere-else', outcome: 'written', at: T0 }).code,
    'target-not-declared',
  );
  assert.equal(
    recordTargetOutcome({ revision: revision(), targetCode: 'gateway-policy', outcome: 'written', at: T0 }).code,
    'not-publishing',
  );
});

test('superseding to nothing is refused', () => {
  const active = mustApply(verifyAll(mustApply(mustApply(revision(), 'approve'), 'publish')), 'complete');
  assert.equal(apply(active, 'supersede').code, 'no-previous-active');
  assert.equal(
    apply(active, 'supersede', { previousActiveRevisionId: 'revision-001' }).code,
    'supersede-to-self',
  );

  const superseded = mustApply(active, 'supersede', { previousActiveRevisionId: 'revision-000' });
  assert.equal(superseded.state, 'superseded');
  assert.equal(superseded.supersededInFavourOf, 'revision-000');
});

test('a failed publish can be marked superseded without being retried', () => {
  const publishing = mustApply(mustApply(revision(), 'approve'), 'publish');
  const failed = mustApply(publishing, 'fail', { reasonCode: 'gateway-unreachable' });
  const superseded = mustApply(failed, 'supersede', { previousActiveRevisionId: 'revision-000' });
  assert.equal(superseded.state, 'superseded');
});

test('a zero-target-effect draft or approval can be abandoned for legacy recovery', () => {
  const draft = revision();
  const approved = mustApply(draft, 'approve');

  for (const held of [draft, approved]) {
    const abandoned = mustApply(held, 'abandon');
    assert.equal(abandoned.state, 'withdrawn');
    assert.equal(abandoned.history.at(-1).command, 'abandon');
    assert.equal(availableCommands(held).includes('abandon'), true);
  }

  const verifiedDraft = {
    ...draft,
    targets: Object.freeze(draft.targets.map((target, index) =>
      index === 0 ? { ...target, outcome: 'verified' } : target)),
  };
  assert.equal(apply(verifiedDraft, 'abandon').code, 'proposal-abandonment-verified-targets');
  const startedApproval = {
    ...approved,
    publishedBy: APPROVER,
    publishStartedAt: T0,
  };
  assert.equal(apply(startedApproval, 'abandon').code, 'proposal-abandonment-publish-started');
});

test('a draft withdrawal closes the proposal and every other illegal transition says so', () => {
  const draft = revision();
  const withdrawn = mustApply(draft, 'withdraw', { actor: AUTHOR   });

  test('abandonment is terminal only before publication activity begins', () => {
    const publishing = mustApply(mustApply(revision(), 'approve'), 'publish');
    const failed = mustApply(publishing, 'fail', { reasonCode: 'gateway-unreachable' });
    assert.equal(apply(failed, 'abandon').code, 'proposal-abandonment-publish-started');
    assert.equal(availableCommands(failed).includes('abandon'), false);

    const partiallyVerified = recordTargetOutcome({
      revision: publishing,
      targetCode: 'gateway-policy',
      outcome: 'verified',
      at: T0,
    }).revision;
    const refused = apply(partiallyVerified, 'abandon');
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'proposal-abandonment-verified-targets');
    assert.equal(availableCommands(partiallyVerified).includes('abandon'), false);
  });
  assert.equal(withdrawn.state, 'withdrawn');
  assert.equal(withdrawn.history.at(-1).actor, AUTHOR);
  for (const command of ['publish', 'complete', 'fail', 'retry', 'supersede']) {
    const refused = apply(draft, command, { reasonCode: 'x', previousActiveRevisionId: 'revision-000' });
    assert.equal(refused.ok, false, command);
    assert.equal(refused.code, 'transition-not-allowed', command);
    assert.equal(refused.from, 'draft');
  }
});

test('history records who did what, and is never rewritten', () => {
  const approved = mustApply(revision(), 'approve');
  const publishing = mustApply(approved, 'publish');
  const active = mustApply(verifyAll(publishing), 'complete');

  assert.deepEqual(
    active.history.map((entry) => [entry.command, entry.from, entry.to]),
    [
      ['create', null, 'draft'],
      ['approve', 'draft', 'approved'],
      ['publish', 'approved', 'publishing'],
      ['target-outcome', 'pending', 'written'],
      ['target-outcome', 'written', 'verified'],
      ['target-outcome', 'pending', 'written'],
      ['target-outcome', 'written', 'verified'],
      ['complete', 'publishing', 'active'],
    ],
  );
  assert.equal(active.history[1].actor, APPROVER);
  assert.throws(() => {
    active.history.push({});
  });
});
