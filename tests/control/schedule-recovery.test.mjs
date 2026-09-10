import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertScheduleCheckpoint,
  completeScheduleRun,
  createScheduleCheckpoint,
  planScheduleRun,
  scheduleCheckpointDocumentId,
} from '../../app/governance-domain/scheduling/schedule-recovery.mjs';

const SCOPE = 'platform-engineering';
const HOUR = 3600;

function checkpoint(overrides = {}) {
  return {
    ...createScheduleCheckpoint({
      scopeGroupId: SCOPE,
      scheduleId: 'usage-rollup',
      intervalSeconds: HOUR,
      startedFrom: '2026-08-10T00:00:00.000Z',
    }),
    ...overrides,
  };
}

test('a first run does not backfill from the beginning of time', () => {
  const plan = planScheduleRun({
    checkpoint: checkpoint(),
    now: '2026-08-10T02:30:00.000Z',
    ownerCode: 'worker-a',
    leaseSeconds: 300,
  });

  assert.equal(plan.ok, true);
  assert.deepEqual(
    plan.windows.map((window) => window.windowStart),
    ['2026-08-10T00:00:00.000Z', '2026-08-10T01:00:00.000Z'],
  );
  // 02:00 has not closed at 02:30, and a window reported before it closed would be a
  // partial count presented as a final one.
  assert.equal(plan.skipped, null);
});

test('every window missed while the process was down is planned after restart', () => {
  const plan = planScheduleRun({
    checkpoint: checkpoint(),
    now: '2026-08-10T05:00:00.000Z',
    ownerCode: 'worker-a',
    leaseSeconds: 300,
  });

  assert.equal(plan.windows.length, 5);
  assert.equal(plan.windows[0].windowStart, '2026-08-10T00:00:00.000Z');
  assert.equal(plan.windows.at(-1).windowEnd, '2026-08-10T05:00:00.000Z');
});

test('a second runner is refused while the lease is live, and gets no windows', () => {
  const first = planScheduleRun({
    checkpoint: checkpoint(),
    now: '2026-08-10T05:00:00.000Z',
    ownerCode: 'worker-a',
    leaseSeconds: 300,
  });

  const second = planScheduleRun({
    checkpoint: first.checkpoint,
    now: '2026-08-10T05:01:00.000Z',
    ownerCode: 'worker-b',
    leaseSeconds: 300,
  });

  assert.equal(second.ok, false);
  assert.equal(second.reasonCode, 'lease-held');
  assert.equal(second.windows.length, 0);
});

test('an expired lease is taken over and the same windows are planned again', () => {
  // The first runner died mid-run. Its work was never recorded, so repeating the
  // window is correct; skipping it because somebody once claimed it is not.
  const first = planScheduleRun({
    checkpoint: checkpoint(),
    now: '2026-08-10T05:00:00.000Z',
    ownerCode: 'worker-a',
    leaseSeconds: 300,
  });

  const second = planScheduleRun({
    checkpoint: first.checkpoint,
    now: '2026-08-10T05:06:00.000Z',
    ownerCode: 'worker-b',
    leaseSeconds: 300,
  });

  assert.equal(second.ok, true);
  assert.deepEqual(
    second.windows.map((window) => window.runId),
    first.windows.map((window) => window.runId),
    'a run identifier names the window, not the attempt',
  );
  assert.equal(second.checkpoint.lease.ownerCode, 'worker-b');
});

test('a backfill cap reports what it did not run instead of dropping it quietly', () => {
  const plan = planScheduleRun({
    checkpoint: checkpoint(),
    now: '2026-08-14T00:00:00.000Z',
    ownerCode: 'worker-a',
    leaseSeconds: 300,
    maxBackfillWindows: 10,
  });

  assert.equal(plan.windows.length, 10);
  assert.equal(plan.skipped.count, 86);
  assert.equal(plan.skipped.windowStart, '2026-08-10T00:00:00.000Z');
  assert.equal(plan.skipped.windowEnd, '2026-08-13T14:00:00.000Z');
  assert.equal(plan.skipped.reasonCode, 'backfill-limit-reached');
  // The newest windows are the ones run, because a dashboard showing the present
  // matters more than replaying a week nobody is waiting on.
  assert.equal(plan.windows[0].windowStart, '2026-08-13T14:00:00.000Z');
});

test('a skipped range survives on the checkpoint so the gap outlives the run', () => {
  const plan = planScheduleRun({
    checkpoint: checkpoint(),
    now: '2026-08-14T00:00:00.000Z',
    ownerCode: 'worker-a',
    leaseSeconds: 300,
    maxBackfillWindows: 10,
  });

  assert.deepEqual(plan.checkpoint.skipped, plan.skipped);
  const completed = completeScheduleRun({
    checkpoint: plan.checkpoint,
    ownerCode: 'worker-a',
    through: plan.windows.at(-1).windowEnd,
    at: '2026-08-14T00:05:00.000Z',
  });
  assert.deepEqual(completed.checkpoint.skipped, plan.skipped);
});

test('completing a run only advances the checkpoint as far as the work reached', () => {
  const plan = planScheduleRun({
    checkpoint: checkpoint(),
    now: '2026-08-10T05:00:00.000Z',
    ownerCode: 'worker-a',
    leaseSeconds: 300,
  });

  const completed = completeScheduleRun({
    checkpoint: plan.checkpoint,
    ownerCode: 'worker-a',
    through: plan.windows[2].windowEnd,
    at: '2026-08-10T05:02:00.000Z',
  });

  assert.equal(completed.ok, true);
  assert.equal(completed.checkpoint.completedThrough, '2026-08-10T03:00:00.000Z');
  assert.equal(completed.checkpoint.lease, null);

  const again = planScheduleRun({
    checkpoint: completed.checkpoint,
    now: '2026-08-10T05:03:00.000Z',
    ownerCode: 'worker-a',
    leaseSeconds: 300,
  });
  assert.deepEqual(
    again.windows.map((window) => window.windowStart),
    ['2026-08-10T03:00:00.000Z', '2026-08-10T04:00:00.000Z'],
  );
});

test('a runner that no longer holds the lease cannot record a completion', () => {
  const plan = planScheduleRun({
    checkpoint: checkpoint(),
    now: '2026-08-10T05:00:00.000Z',
    ownerCode: 'worker-a',
    leaseSeconds: 300,
  });

  const foreign = completeScheduleRun({
    checkpoint: plan.checkpoint,
    ownerCode: 'worker-b',
    through: '2026-08-10T05:00:00.000Z',
    at: '2026-08-10T05:02:00.000Z',
  });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.reasonCode, 'lease-not-held');

  const expired = completeScheduleRun({
    checkpoint: plan.checkpoint,
    ownerCode: 'worker-a',
    through: '2026-08-10T05:00:00.000Z',
    at: '2026-08-10T05:06:00.000Z',
  });
  assert.equal(expired.ok, false);
  assert.equal(expired.reasonCode, 'lease-expired');
});

test('completing past what was planned is refused rather than marking unrun windows done', () => {
  const plan = planScheduleRun({
    checkpoint: checkpoint(),
    now: '2026-08-10T05:00:00.000Z',
    ownerCode: 'worker-a',
    leaseSeconds: 300,
  });

  const overreach = completeScheduleRun({
    checkpoint: plan.checkpoint,
    ownerCode: 'worker-a',
    through: '2026-08-10T09:00:00.000Z',
    at: '2026-08-10T05:02:00.000Z',
  });
  assert.equal(overreach.ok, false);
  assert.equal(overreach.reasonCode, 'completion-beyond-plan');
});

test('a clock that moved backwards is refused rather than producing negative windows', () => {
  const plan = planScheduleRun({
    checkpoint: checkpoint({ completedThrough: '2026-08-10T06:00:00.000Z' }),
    now: '2026-08-10T04:00:00.000Z',
    ownerCode: 'worker-a',
    leaseSeconds: 300,
  });

  assert.equal(plan.ok, false);
  assert.equal(plan.reasonCode, 'clock-behind-checkpoint');
});

test('nothing due is its own answer, distinct from a refusal', () => {
  const plan = planScheduleRun({
    checkpoint: checkpoint({ completedThrough: '2026-08-10T05:00:00.000Z' }),
    now: '2026-08-10T05:30:00.000Z',
    ownerCode: 'worker-a',
    leaseSeconds: 300,
  });

  assert.equal(plan.ok, false);
  assert.equal(plan.reasonCode, 'nothing-due');
  assert.equal(plan.checkpoint.lease, null, 'a lease is not taken for work that does not exist');
});

test('the checkpoint document carries no principal, body, or credential vocabulary', () => {
  const plan = planScheduleRun({
    checkpoint: checkpoint(),
    now: '2026-08-10T05:00:00.000Z',
    ownerCode: 'worker-a',
    leaseSeconds: 300,
  });
  const serialized = JSON.stringify(assertScheduleCheckpoint(plan.checkpoint));
  for (const forbidden of ['prompt', 'message', 'token', 'secret', 'authorization', 'subjectKey']) {
    assert.doesNotMatch(serialized, new RegExp(forbidden, 'i'));
  }
  assert.equal(
    plan.checkpoint.id,
    scheduleCheckpointDocumentId({ scopeGroupId: SCOPE, scheduleId: 'usage-rollup' }),
  );
});

test('an owner code shaped like a directory object identifier is refused', () => {
  assert.throws(
    () =>
      planScheduleRun({
        checkpoint: checkpoint(),
        now: '2026-08-10T05:00:00.000Z',
        ownerCode: '4f2a7c11-8f0e-4a2f-9d3b-1c5e6a7b8c9d',
        leaseSeconds: 300,
      }),
    /ownerCode/,
  );
});
