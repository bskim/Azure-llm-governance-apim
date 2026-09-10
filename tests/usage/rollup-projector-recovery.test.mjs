import assert from 'node:assert/strict';
import test from 'node:test';

import { createInMemoryGovernanceStore } from '../../app/persistence/in-memory-governance-store.mjs';
import { createRollupProjector } from '../../app/functions/handlers/rollup-projector.mjs';
import { createScheduledRollupProjector } from '../../app/control-api/scheduled-rollup-projector.mjs';

const SCOPE = 'platform-engineering';

function usageQuery(byWindow = {}) {
  const asked = [];
  return {
    asked,
    async readWindow({ windowStart, windowEnd }) {
      asked.push(windowStart);
      const rows = byWindow[windowStart];
      if (rows === 'unavailable') throw new Error('log source unavailable');
      return {
        rows: rows ?? [],
        state: 'complete',
        rowCount: (rows ?? []).length,
        revision: `rev-${windowStart}-${windowEnd}`,
      };
    },
  };
}

function scheduled(store, query, now, overrides = {}) {
  const clock = { nowIso: () => now };
  return createScheduledRollupProjector({
    projector: createRollupProjector({
      usageQuery: query,
      rollupStore: store,
      recordSink: null,
      clock,
      config: { scopeGroupId: SCOPE, windowSeconds: 3600, ingestionLagSeconds: 300 },
    }),
    store,
    clock,
    scopeGroupId: SCOPE,
    windowSeconds: 3600,
    ingestionLagSeconds: 300,
    startedFrom: '2026-08-10T00:00:00.000Z',
    ownerCode: 'worker-a',
    leaseSeconds: 300,
    ...overrides,
  });
}

test('a window is not closed before the source has had time to deliver it', async () => {
  const store = createInMemoryGovernanceStore();
  const query = usageQuery();

  // The 00:00-01:00 window has ended, but the log source is still delivering it.
  const early = await scheduled(store, query, '2026-08-10T01:04:00.000Z').tick();
  assert.equal(early.outcome, 'skipped');
  assert.equal(early.reasonCode, 'nothing-due');
  assert.deepEqual(query.asked, []);

  const later = await scheduled(store, query, '2026-08-10T01:05:00.000Z').tick();
  assert.equal(later.outcome, 'ran');
  assert.deepEqual(query.asked, ['2026-08-10T00:00:00.000Z']);
});

test('every window missed while the projector was down is aggregated on the next run', async () => {
  const store = createInMemoryGovernanceStore();
  const query = usageQuery();

  const result = await scheduled(store, query, '2026-08-10T04:05:00.000Z').tick();

  assert.equal(result.outcome, 'ran');
  assert.deepEqual(query.asked, [
    '2026-08-10T00:00:00.000Z',
    '2026-08-10T01:00:00.000Z',
    '2026-08-10T02:00:00.000Z',
    '2026-08-10T03:00:00.000Z',
  ]);

  const windows = await store.queryRollupWindows({
    scopeGroupId: SCOPE,
    sinceWindowStart: '2026-08-10T00:00:00.000Z',
  });
  assert.deepEqual(
    [...new Set(windows.map((document) => document.windowStart))],
    query.asked,
    'each missed hour has its own rollup rather than one merged catch-up window',
  );
});

test('a window the source could not answer is written as degraded, not left as a hole', async () => {
  // Retrying it forever would stall the schedule, and skipping it silently would let
  // the dashboard read the outage as an hour with no traffic.
  const store = createInMemoryGovernanceStore();
  const query = usageQuery({ '2026-08-10T01:00:00.000Z': 'unavailable' });

  const result = await scheduled(store, query, '2026-08-10T03:05:00.000Z').tick();
  assert.equal(result.outcome, 'ran');

  const windows = await store.queryRollupWindows({
    scopeGroupId: SCOPE,
    sinceWindowStart: '2026-08-10T00:00:00.000Z',
  });
  const outage = windows.find(
    (document) => document.windowStart === '2026-08-10T01:00:00.000Z' && document.grain === 'organization',
  );
  assert.equal(outage.completeness.state, 'degraded');
  assert.notEqual(outage.completeness.reason, undefined);

  const after = await scheduled(store, query, '2026-08-10T04:05:00.000Z').tick();
  assert.equal(after.outcome, 'ran');
  assert.equal(
    query.asked.filter((windowStart) => windowStart === '2026-08-10T01:00:00.000Z').length,
    1,
    'the degraded window is recorded once, not retried forever',
  );
});

test('two projectors running the same schedule aggregate each window once', async () => {
  const store = createInMemoryGovernanceStore();
  const query = usageQuery();

  const [first, second] = await Promise.all([
    scheduled(store, query, '2026-08-10T03:05:00.000Z', { ownerCode: 'worker-a' }).tick(),
    scheduled(store, query, '2026-08-10T03:05:00.000Z', { ownerCode: 'worker-b' }).tick(),
  ]);

  assert.deepEqual([first.outcome, second.outcome].sort(), ['ran', 'skipped']);
  assert.deepEqual(query.asked, [
    '2026-08-10T00:00:00.000Z',
    '2026-08-10T01:00:00.000Z',
    '2026-08-10T02:00:00.000Z',
  ]);
});

test('an outage longer than the backfill limit reports the hours it will never cover', async () => {
  const store = createInMemoryGovernanceStore();
  const query = usageQuery();

  const result = await scheduled(store, query, '2026-08-12T00:05:00.000Z', {
    maxBackfillWindows: 4,
  }).tick();

  assert.equal(query.asked.length, 4);
  assert.equal(result.skipped.count, 44);
  assert.equal(result.skipped.windowStart, '2026-08-10T00:00:00.000Z');
  assert.equal(result.skipped.windowEnd, '2026-08-11T20:00:00.000Z');
});
