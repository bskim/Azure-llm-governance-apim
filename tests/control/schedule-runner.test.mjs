import assert from 'node:assert/strict';
import test from 'node:test';

import { createInMemoryGovernanceStore } from '../../app/persistence/in-memory-governance-store.mjs';
import { createScheduleRunner } from '../../app/control-api/schedule-runner.mjs';

const SCOPE = 'platform-engineering';

function runner(store, ownerCode, work, overrides = {}) {
  return createScheduleRunner({
    store,
    scopeGroupId: SCOPE,
    scheduleId: 'usage-rollup',
    intervalSeconds: 3600,
    startedFrom: '2026-08-10T00:00:00.000Z',
    leaseSeconds: 300,
    ownerCode,
    run: work,
    ...overrides,
  });
}

function recorder() {
  const windows = [];
  return { windows, work: async (window) => void windows.push(window.windowStart) };
}

test('a restart runs every window that fell due while nothing was running', async () => {
  const store = createInMemoryGovernanceStore();
  const seen = recorder();

  const result = await runner(store, 'worker-a', seen.work).tick('2026-08-10T05:00:00.000Z');

  assert.equal(result.outcome, 'ran');
  assert.deepEqual(seen.windows, [
    '2026-08-10T00:00:00.000Z',
    '2026-08-10T01:00:00.000Z',
    '2026-08-10T02:00:00.000Z',
    '2026-08-10T03:00:00.000Z',
    '2026-08-10T04:00:00.000Z',
  ]);

  // A second process starting later must not repeat what is already recorded.
  const after = recorder();
  const second = await runner(store, 'worker-b', after.work).tick('2026-08-10T06:00:00.000Z');
  assert.deepEqual(after.windows, ['2026-08-10T05:00:00.000Z']);
  assert.equal(second.outcome, 'ran');
});

test('two runners that both planned from the same reading run the work once', async () => {
  const store = createInMemoryGovernanceStore();
  const a = recorder();
  const b = recorder();

  const [first, second] = await Promise.all([
    runner(store, 'worker-a', a.work).tick('2026-08-10T03:00:00.000Z'),
    runner(store, 'worker-b', b.work).tick('2026-08-10T03:00:00.000Z'),
  ]);

  const outcomes = [first.outcome, second.outcome].sort();
  assert.deepEqual(outcomes, ['ran', 'skipped']);
  assert.equal(a.windows.length + b.windows.length, 3, 'the three closed windows ran exactly once');

  const loser = first.outcome === 'skipped' ? first : second;
  assert.equal(loser.reasonCode, 'claim-lost', 'the loser finds out from the store before it starts');
});

test('a runner arriving while another still holds the lease does nothing', async () => {
  const store = createInMemoryGovernanceStore();
  let release;
  const inFlight = new Promise((resolve) => {
    release = resolve;
  });

  const slow = runner(store, 'worker-a', async () => {
    await inFlight;
  }).tick('2026-08-10T03:00:00.000Z');
  // Let the first runner's claim reach the store, so the second one is arriving at a
  // lease that is already recorded rather than racing to write one.
  await new Promise(setImmediate);

  const later = recorder();
  const blocked = await runner(store, 'worker-b', later.work).tick('2026-08-10T03:00:01.000Z');

  assert.equal(blocked.outcome, 'skipped');
  assert.equal(blocked.reasonCode, 'lease-held');
  assert.deepEqual(later.windows, []);

  release();
  assert.equal((await slow).outcome, 'ran');
});

test('work that throws leaves the checkpoint where the completed windows ended', async () => {
  const store = createInMemoryGovernanceStore();
  const done = [];

  const result = await runner(store, 'worker-a', async (window) => {
    if (window.windowStart === '2026-08-10T02:00:00.000Z') throw new Error('projector unavailable');
    done.push(window.windowStart);
  }).tick('2026-08-10T05:00:00.000Z');

  assert.equal(result.outcome, 'incomplete');
  assert.equal(result.reasonCode, 'run-interrupted');
  assert.deepEqual(done, ['2026-08-10T00:00:00.000Z', '2026-08-10T01:00:00.000Z']);

  const retried = recorder();
  const again = await runner(store, 'worker-a', retried.work).tick('2026-08-10T05:10:00.000Z');
  assert.equal(again.outcome, 'ran');
  assert.equal(retried.windows[0], '2026-08-10T02:00:00.000Z', 'the failed window is retried, not skipped');
});

test('a failure before any window completes releases the lease rather than holding it', async () => {
  // A held lease after a crash stops the schedule for as long as it lasts. Failing is
  // allowed; blocking every other runner because of it is not.
  const store = createInMemoryGovernanceStore();

  const result = await runner(store, 'worker-a', async () => {
    throw new Error('projector unavailable');
  }).tick('2026-08-10T03:00:00.000Z');

  assert.equal(result.outcome, 'incomplete');
  const held = await store.readScheduleCheckpoint({ scopeGroupId: SCOPE, scheduleId: 'usage-rollup' });
  assert.equal(held.document.lease, null);
  assert.equal(held.document.completedThrough, null);
});

test('a tick with nothing due does not write and does not claim a run', async () => {
  const store = createInMemoryGovernanceStore();
  await runner(store, 'worker-a', async () => {}).tick('2026-08-10T03:00:00.000Z');
  const before = await store.readScheduleCheckpoint({ scopeGroupId: SCOPE, scheduleId: 'usage-rollup' });

  const seen = recorder();
  const result = await runner(store, 'worker-a', seen.work).tick('2026-08-10T03:30:00.000Z');

  assert.equal(result.outcome, 'skipped');
  assert.equal(result.reasonCode, 'nothing-due');
  assert.deepEqual(seen.windows, []);
  const after = await store.readScheduleCheckpoint({ scopeGroupId: SCOPE, scheduleId: 'usage-rollup' });
  assert.equal(after.etag, before.etag, 'an idle tick is not a write');
});

test('a schedule whose process restarts between ticks still gains an origin', async () => {
  const store = createInMemoryGovernanceStore();
  const seen = recorder();
  const boundary = (at) => new Date(Math.floor(Date.parse(at) / 3_600_000) * 3_600_000).toISOString();

  // A host that scales to zero builds a new runner for every tick, and its start
  // point is derived from a clock that has moved. If the first tick records nothing,
  // the origin moves with it and no window is ever due — the schedule idles forever.
  const first = await runner(store, 'worker-a', seen.work, {
    startedFrom: boundary('2026-08-10T05:05:00.000Z'),
  }).tick('2026-08-10T05:00:00.000Z');
  assert.equal(first.reasonCode, 'nothing-due');

  const second = await runner(store, 'worker-a', seen.work, {
    startedFrom: boundary('2026-08-10T06:05:00.000Z'),
  }).tick('2026-08-10T06:00:00.000Z');

  assert.equal(second.outcome, 'ran');
  assert.deepEqual(seen.windows, ['2026-08-10T05:00:00.000Z']);
});

test('a long outage reports the windows it gave up on instead of losing them', async () => {
  const store = createInMemoryGovernanceStore();
  const seen = recorder();

  const result = await runner(store, 'worker-a', seen.work, { maxBackfillWindows: 6 }).tick(
    '2026-08-12T00:00:00.000Z',
  );

  assert.equal(result.outcome, 'ran');
  assert.equal(seen.windows.length, 6);
  assert.equal(result.skipped.count, 42);
  assert.equal(result.skipped.reasonCode, 'backfill-limit-reached');

  const held = await store.readScheduleCheckpoint({ scopeGroupId: SCOPE, scheduleId: 'usage-rollup' });
  assert.equal(held.document.skipped.count, 42, 'the gap outlives the run that could not close it');
});

test('the same window is never handed to the work twice across restarts', async () => {
  const store = createInMemoryGovernanceStore();
  const seen = recorder();

  for (const now of ['2026-08-10T02:00:00.000Z', '2026-08-10T02:30:00.000Z', '2026-08-10T04:00:00.000Z']) {
    await runner(store, 'worker-a', seen.work).tick(now);
  }

  assert.deepEqual(seen.windows, [
    '2026-08-10T00:00:00.000Z',
    '2026-08-10T01:00:00.000Z',
    '2026-08-10T02:00:00.000Z',
    '2026-08-10T03:00:00.000Z',
  ]);
  assert.equal(new Set(seen.windows).size, seen.windows.length);
});
