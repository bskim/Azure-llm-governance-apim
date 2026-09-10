import assert from 'node:assert/strict';
import test from 'node:test';

import { createInMemoryGovernanceStore } from '../../app/persistence/in-memory-governance-store.mjs';
import { createNotificationLedger } from '../../app/control-api/notification-ledger.mjs';
import { createBudgetNotificationSweep } from '../../app/control-api/budget-notification-sweep.mjs';
import { usageRollupDocumentId } from '../../app/governance-domain/usage/usage-rollup-validator.mjs';

const SCOPE = 'platform-engineering';
const PERIOD_START = '2026-08-10T00:00:00.000Z';
const PERIOD_END = '2026-08-10T04:00:00.000Z';
const NOW = '2026-08-10T04:05:00.000Z';

function rollupDocument({ windowStart, totalTokens }) {
  const end = new Date(Date.parse(windowStart) + 3600_000).toISOString();
  const prompt = Math.floor(totalTokens / 2);
  const measures = {
    requests: 1,
    promptTokens: prompt,
    completionTokens: totalTokens - prompt,
    totalTokens,
    tokenQuality: 'reported',
  };
  return {
    contractVersion: 'v1',
    documentType: 'usage-rollup',
    id: usageRollupDocumentId({ scopeGroupId: SCOPE, grain: 'organization', windowStart }),
    scopeGroupId: SCOPE,
    grain: 'organization',
    windowStart,
    windowEnd: end,
    asOf: end,
    sourceRevision: 'budget-sweep-test',
    completeness: { state: 'complete', reason: 'window-closed' },
    totals: { ...measures },
    byModel: [{ model: 'model-mini', measures: { ...measures } }],
  };
}

function publication(enforcedTokenQuota = 1000) {
  return {
    state: 'published',
    reasonCode: 'budgets-published',
    entries: [
      {
        budgetId: 'budget-platform-monthly',
        budgetVersion: 3,
        scope: 'organization',
        action: 'hard-block',
        state: 'enforceable',
        reasonCode: 'converted',
        enforcedTokenQuota,
        warnThresholdPercent: 80,
      },
    ],
    throttleTiers: [],
  };
}

function sweep(store, overrides = {}) {
  return createBudgetNotificationSweep({
    store,
    ledger: createNotificationLedger({ store, scopeGroupId: SCOPE }),
    clock: { nowIso: () => NOW },
    scopeGroupId: SCOPE,
    windowSeconds: 3600,
    publication: publication(),
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    ...overrides,
  });
}

async function raised(store) {
  return createNotificationLedger({ store, scopeGroupId: SCOPE }).list({
    sinceRaisedAt: '1970-01-01T00:00:00.000Z',
  });
}

async function seed(store, tokensPerWindow, windows = 4) {
  for (let index = 0; index < windows; index += 1) {
    await store.putRollup(
      rollupDocument({
        windowStart: new Date(Date.parse(PERIOD_START) + index * 3600_000).toISOString(),
        totalTokens: tokensPerWindow,
      }),
    );
  }
}

test('a period comfortably inside its budget raises nothing', async () => {
  const store = createInMemoryGovernanceStore();
  await seed(store, 100);

  const result = await sweep(store).run();

  assert.equal(result.raised, 0);
  assert.deepEqual(await raised(store), []);
});

test('crossing the warning threshold raises it once, however often the sweep runs', async () => {
  const store = createInMemoryGovernanceStore();
  await seed(store, 210);

  await sweep(store).run();
  const second = await sweep(store).run();

  const notifications = await raised(store);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].kind, 'budget-threshold-reached');
  assert.equal(second.raised, 0);
});

test('an exhausted budget is its own notification, not a louder warning', async () => {
  const store = createInMemoryGovernanceStore();
  await seed(store, 300);

  await sweep(store).run();

  const kinds = (await raised(store)).map((notification) => notification.kind).sort();
  assert.deepEqual(kinds, ['budget-exhausted', 'budget-threshold-reached']);
});

test('a period with a missing hour warns that it cannot be judged, not that it is fine', async () => {
  // The remaining hours total well under the cap. Reporting that as a healthy period
  // is exactly the failure this sweep exists to prevent.
  const store = createInMemoryGovernanceStore();
  await seed(store, 300, 2);

  await sweep(store).run();

  const notifications = await raised(store);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].kind, 'aggregate-stale');
});

test('two sweeps running together raise each crossing once', async () => {
  const store = createInMemoryGovernanceStore();
  await seed(store, 210);

  const [first, second] = await Promise.all([sweep(store).run(), sweep(store).run()]);

  assert.equal(first.raised + second.raised, 1);
  assert.equal((await raised(store)).length, 1);
});

test('a budget that could not be enforced is raised rather than passed over', async () => {
  const store = createInMemoryGovernanceStore();
  await seed(store, 100);

  await sweep(store, {
    publication: {
      state: 'published',
      reasonCode: 'budgets-published',
      entries: [
        {
          budgetId: 'budget-platform-monthly',
          budgetVersion: 3,
          scope: 'organization',
          action: 'hard-block',
          state: 'unenforceable',
          reasonCode: 'model-not-entitled',
          enforcedTokenQuota: null,
        },
      ],
      throttleTiers: [],
    },
  }).run();

  const notifications = await raised(store);
  assert.equal(notifications[0].kind, 'budget-unenforceable');
});

test('per-model warnings do not borrow another model or budget observation', async () => {
  const store = createInMemoryGovernanceStore();
  await seed(store, 210);
  const base = publication();
  const modelBudget = (budgetId, modelKey) => ({
    ...base.entries[0],
    budgetId,
    modelScope: 'per-model',
    modelKey,
    period: 'Daily',
  });
  await sweep(store, {
    publication: {
      ...base,
      entries: [
        modelBudget('budget-unused-model', 'model-unused'),
        modelBudget('budget-mini', 'model-mini'),
      ],
    },
  }).run();
  const notifications = await raised(store);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].key, /\|budget-mini\|3\|/);
  assert.equal(notifications[0].kind, 'budget-threshold-reached');
});
