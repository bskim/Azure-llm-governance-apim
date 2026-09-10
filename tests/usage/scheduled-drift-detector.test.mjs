import assert from 'node:assert/strict';
import test from 'node:test';

import { createInMemoryGovernanceStore } from '../../app/persistence/in-memory-governance-store.mjs';
import { createNotificationLedger } from '../../app/control-api/notification-ledger.mjs';
import { createScheduledDriftDetector } from '../../app/control-api/scheduled-drift-detector.mjs';
import { usageRollupDocumentId } from '../../app/governance-domain/usage/usage-rollup-validator.mjs';

const SCOPE = 'platform-engineering';

function rollup({ windowStart, requests, totalTokens, state = 'complete' }) {
  const end = new Date(Date.parse(windowStart) + 3600_000).toISOString();
  // A window still open was summarized before it ended, and the validator holds the
  // document to that.
  const asOf = state === 'complete' ? end : new Date(Date.parse(windowStart) + 1800_000).toISOString();
  return {
    contractVersion: 'v1',
    documentType: 'usage-rollup',
    id: usageRollupDocumentId({ scopeGroupId: SCOPE, grain: 'organization', windowStart }),
    scopeGroupId: SCOPE,
    grain: 'organization',
    windowStart,
    windowEnd: end,
    asOf,
    sourceRevision: 'drift-test',
    completeness: { state, reason: state === 'complete' ? 'window-closed' : 'window-open' },
    totals: {
      requests,
      promptTokens: Math.floor(totalTokens / 2),
      completionTokens: totalTokens - Math.floor(totalTokens / 2),
      totalTokens,
      tokenQuality: 'reported',
    },
    byModel: [
      {
        model: 'model-mini',
        measures: {
          requests,
          promptTokens: Math.floor(totalTokens / 2),
          completionTokens: totalTokens - Math.floor(totalTokens / 2),
          totalTokens,
          tokenQuality: 'reported',
        },
      },
    ],
  };
}

function providerUsage(byWindow) {
  const asked = [];
  return {
    asked,
    async readWindow({ windowStart }) {
      asked.push(windowStart);
      const answer = byWindow[windowStart];
      if (answer === 'unavailable') throw new Error('provider metrics unreachable');
      return answer ?? { requests: 0, totalTokens: 0 };
    },
  };
}

function detector(store, provider, now, overrides = {}) {
  return createScheduledDriftDetector({
    store,
    ledger: createNotificationLedger({ store, scopeGroupId: SCOPE }),
    providerUsage: provider,
    clock: { nowIso: () => now },
    scopeGroupId: SCOPE,
    windowSeconds: 3600,
    ingestionLagSeconds: 300,
    startedFrom: '2026-08-10T00:00:00.000Z',
    ownerCode: 'worker-a',
    leaseSeconds: 300,
    ...overrides,
  });
}

async function notifications(store) {
  return createNotificationLedger({ store, scopeGroupId: SCOPE }).list({
    sinceRaisedAt: '1970-01-01T00:00:00.000Z',
  });
}

test('a window the two sides agree on raises nothing', async () => {
  const store = createInMemoryGovernanceStore();
  await store.putRollup(rollup({ windowStart: '2026-08-10T00:00:00.000Z', requests: 100, totalTokens: 1000 }));
  const provider = providerUsage({ '2026-08-10T00:00:00.000Z': { requests: 100, totalTokens: 1000 } });

  const result = await detector(store, provider, '2026-08-10T01:05:00.000Z').tick();

  assert.equal(result.outcome, 'ran');
  assert.deepEqual(await notifications(store), []);
});

test('a disputed window raises one notification, and re-running raises none', async () => {
  const store = createInMemoryGovernanceStore();
  await store.putRollup(rollup({ windowStart: '2026-08-10T00:00:00.000Z', requests: 60, totalTokens: 600 }));
  const provider = providerUsage({ '2026-08-10T00:00:00.000Z': { requests: 100, totalTokens: 1000 } });

  await detector(store, provider, '2026-08-10T01:05:00.000Z').tick();
  const raised = await notifications(store);
  assert.equal(raised.length, 1);
  assert.equal(raised[0].kind, 'usage-drift-detected');
  assert.equal(raised[0].periodStart, '2026-08-10T00:00:00.000Z');

  // A backfill or a second worker sees the same window again; it is the same fact.
  await createScheduledDriftDetector({
    store,
    ledger: createNotificationLedger({ store, scopeGroupId: SCOPE }),
    providerUsage: provider,
    clock: { nowIso: () => '2026-08-10T01:05:00.000Z' },
    scopeGroupId: SCOPE,
    windowSeconds: 3600,
    ingestionLagSeconds: 300,
    startedFrom: '2026-08-10T00:00:00.000Z',
    ownerCode: 'worker-b',
    leaseSeconds: 300,
    scheduleId: 'usage-drift-replay',
  }).tick();

  assert.equal((await notifications(store)).length, 1);
});

test('a provider that could not answer is unverifiable, never a provider that reported nothing', async () => {
  // Treating an unreachable source as zero would make every window look like the
  // gateway invented traffic, and the real dispute would be buried in false ones.
  const store = createInMemoryGovernanceStore();
  await store.putRollup(rollup({ windowStart: '2026-08-10T00:00:00.000Z', requests: 100, totalTokens: 1000 }));
  const provider = providerUsage({ '2026-08-10T00:00:00.000Z': 'unavailable' });

  await detector(store, provider, '2026-08-10T01:05:00.000Z').tick();

  const raised = await notifications(store);
  assert.equal(raised.length, 1);
  assert.equal(raised[0].kind, 'usage-drift-unverifiable');
});

test('a tick reports what the comparison concluded, not only that it happened', async () => {
  // A provider that answered nothing produces the same run outcome as one that
  // agreed, so an operator reading the run alone cannot tell a broken credential
  // from a clean window.
  const store = createInMemoryGovernanceStore();
  await store.putRollup(rollup({ windowStart: '2026-08-10T00:00:00.000Z', requests: 100, totalTokens: 1000 }));

  const unreachable = await detector(
    store,
    providerUsage({ '2026-08-10T00:00:00.000Z': 'unavailable' }),
    '2026-08-10T01:05:00.000Z',
  ).tick();

  assert.equal(unreachable.outcome, 'ran');
  assert.equal(unreachable.comparison.providerRead, 0);
  assert.equal(unreachable.comparison.providerUnavailable, 1);
  assert.equal(unreachable.comparison.states.indeterminate, 1);
  assert.equal(unreachable.comparison.raised, 1);

  const agreed = createInMemoryGovernanceStore();
  await agreed.putRollup(rollup({ windowStart: '2026-08-10T00:00:00.000Z', requests: 100, totalTokens: 1000 }));
  const clean = await detector(
    agreed,
    providerUsage({ '2026-08-10T00:00:00.000Z': { requests: 100, totalTokens: 1000 } }),
    '2026-08-10T01:05:00.000Z',
  ).tick();

  assert.equal(clean.comparison.providerRead, 1);
  assert.equal(clean.comparison.providerUnavailable, 0);
  assert.equal(clean.comparison.raised, 0);
  // The two runs are indistinguishable without this, which is the whole point.
  assert.notDeepEqual(clean.comparison, unreachable.comparison);
});

test('a window with no rollup at all is unverifiable rather than a zero side', async () => {
  const store = createInMemoryGovernanceStore();
  const provider = providerUsage({ '2026-08-10T00:00:00.000Z': { requests: 100, totalTokens: 1000 } });

  await detector(store, provider, '2026-08-10T01:05:00.000Z').tick();

  const raised = await notifications(store);
  assert.equal(raised.length, 1);
  assert.equal(raised[0].kind, 'usage-drift-unverifiable');
});

test('an incomplete rollup is not compared as though it were final', async () => {
  const store = createInMemoryGovernanceStore();
  await store.putRollup(
    rollup({ windowStart: '2026-08-10T00:00:00.000Z', requests: 40, totalTokens: 400, state: 'partial' }),
  );
  const provider = providerUsage({ '2026-08-10T00:00:00.000Z': { requests: 100, totalTokens: 1000 } });

  await detector(store, provider, '2026-08-10T01:05:00.000Z').tick();

  const raised = await notifications(store);
  assert.equal(raised[0].kind, 'usage-drift-unverifiable');
});

test('every window missed while nothing was running is compared on the next run', async () => {
  const store = createInMemoryGovernanceStore();
  for (const hour of ['00', '01', '02']) {
    await store.putRollup(
      rollup({ windowStart: `2026-08-10T${hour}:00:00.000Z`, requests: 100, totalTokens: 1000 }),
    );
  }
  const provider = providerUsage({
    '2026-08-10T00:00:00.000Z': { requests: 100, totalTokens: 1000 },
    '2026-08-10T01:00:00.000Z': { requests: 100, totalTokens: 1000 },
    '2026-08-10T02:00:00.000Z': { requests: 100, totalTokens: 1000 },
  });

  await detector(store, provider, '2026-08-10T03:05:00.000Z').tick();

  assert.deepEqual(provider.asked, [
    '2026-08-10T00:00:00.000Z',
    '2026-08-10T01:00:00.000Z',
    '2026-08-10T02:00:00.000Z',
  ]);
});

test('two detectors on the same schedule compare each window once', async () => {
  const store = createInMemoryGovernanceStore();
  await store.putRollup(rollup({ windowStart: '2026-08-10T00:00:00.000Z', requests: 100, totalTokens: 1000 }));
  const provider = providerUsage({ '2026-08-10T00:00:00.000Z': { requests: 100, totalTokens: 1000 } });

  const [first, second] = await Promise.all([
    detector(store, provider, '2026-08-10T01:05:00.000Z', { ownerCode: 'worker-a' }).tick(),
    detector(store, provider, '2026-08-10T01:05:00.000Z', { ownerCode: 'worker-b' }).tick(),
  ]);

  assert.deepEqual([first.outcome, second.outcome].sort(), ['ran', 'skipped']);
  assert.deepEqual(provider.asked, ['2026-08-10T00:00:00.000Z']);
});
