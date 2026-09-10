import assert from 'node:assert/strict';
import test from 'node:test';

import { createInMemoryGovernanceStore } from '../../app/persistence/in-memory-governance-store.mjs';
import { createNotificationLedger } from '../../app/control-api/notification-ledger.mjs';
import { createScheduledBudgetNotifications } from '../../app/control-api/scheduled-budget-notifications.mjs';
import { assertBudgetSnapshotV1 } from '../../app/governance-domain/policy/budget-publication.mjs';
import { assertModelRegistrySnapshotV1 } from '../../app/governance-domain/registry/model-registry-validator.mjs';
import { usageRollupDocumentId } from '../../app/governance-domain/usage/usage-rollup-validator.mjs';

const SCOPE = 'platform-engineering';
const TENANT = 'tenant-local-demo';
// Two hours into a day that is itself two days into a month, so the daily and monthly
// periods start at different instants and cannot be confused for one another.
const NOW = '2026-08-03T02:10:00.000Z';
const EVALUATION = '2026-08-03T00:00:00.000Z';
const MONTH_START = '2026-08-01T00:00:00.000Z';
const DAY_START = '2026-08-03T00:00:00.000Z';

function model(modelKey, rate) {
  return {
    modelKey,
    providerKey: 'azure-openai',
    apiFamilies: ['openai-chat-completions', 'openai-responses'],
    lifecycle: 'generally-available',
    safetyPolicy: 'local-default-policy',
  };
}

function registry() {
  return assertModelRegistrySnapshotV1(
    {
      contractVersion: 'v1',
      snapshotId: 'model-registry-001',
      tenantId: TENANT,
      version: 1,
      status: 'complete',
      capturedAt: '2026-08-02T23:55:00.000Z',
      expiresAt: '2026-08-04T00:00:00.000Z',
      sourceRevision: 'model-registry-source-001',
      models: [model('coding-fast', 100), model('coding-primary', 1_000)],
      applications: [],
    },
    { evaluationTime: EVALUATION, principalTenantId: TENANT },
  );
}

function budget(overrides = {}) {
  return {
    budgetId: 'budget-organization-monthly',
    budgetVersion: 1,
    scope: 'organization',
    action: 'HARD_BLOCK',
    modelScope: 'all-models',
    accountingBasis: 'apim-estimated-total-tokens',
    limit: { unit: 'tokens', currency: null, amount: 1_000_000 },
    period: 'Monthly',
    thresholds: { warnAtBasisPoints: 8_000 },
    ...overrides,
  };
}

function budgetSnapshot(budgets) {
  return assertBudgetSnapshotV1(
    {
      contractVersion: 'v1',
      snapshotId: 'budget-snapshot-001',
      tenantId: TENANT,
      version: 3,
      status: 'complete',
      capturedAt: '2026-08-02T23:55:00.000Z',
      expiresAt: '2026-08-04T00:00:00.000Z',
      sourceRevision: 'budget-source-001',
      budgets,
    },
    { evaluationTime: EVALUATION, principalTenantId: TENANT },
  );
}

function snapshots(budgets, allowlist = ['coding-fast']) {
  return {
    budgetSnapshot: budgetSnapshot(budgets),
    modelRegistrySnapshot: registry(),
    entitlementSnapshot: {
      bindings: [
        { bindingId: 'binding-global', state: 'active', target: { kind: 'global' }, modelAllowlist: allowlist },
      ],
    },
  };
}

function rollup({ grain, grainKey = null, windowStart, totalTokens }) {
  const end = new Date(Date.parse(windowStart) + 3_600_000).toISOString();
  const prompt = Math.floor(totalTokens / 2);
  const measures = {
    requests: 1,
    promptTokens: prompt,
    completionTokens: totalTokens - prompt,
    totalTokens,
    tokenQuality: 'reported',
  };
  const document = {
    contractVersion: 'v1',
    documentType: 'usage-rollup',
    id: usageRollupDocumentId({ scopeGroupId: SCOPE, grain, grainKey, windowStart }),
    scopeGroupId: SCOPE,
    grain,
    windowStart,
    windowEnd: end,
    asOf: end,
    sourceRevision: 'budget-schedule-test',
    completeness: { state: 'complete', reason: 'window-closed' },
    totals: { ...measures },
    byModel: [{ model: 'coding-fast', measures: { ...measures } }],
  };
  if (grain !== 'organization') document.grainKey = grainKey;
  return document;
}

/** Every hour from the month's start through the last closed window. */
function organizationWindows(tokensPerWindow, { from = MONTH_START, to = '2026-08-03T01:00:00.000Z' } = {}) {
  const documents = [];
  for (let at = Date.parse(from); at <= Date.parse(to); at += 3_600_000) {
    documents.push(
      rollup({ grain: 'organization', windowStart: new Date(at).toISOString(), totalTokens: tokensPerWindow }),
    );
  }
  return documents;
}

async function seed(store, documents) {
  for (const document of documents) {
    await store.putRollup(document);
  }
}

function schedule(store, overrides = {}) {
  return createScheduledBudgetNotifications({
    store,
    ledger: createNotificationLedger({ store, scopeGroupId: SCOPE }),
    readPublishedSnapshots: async () => snapshots([budget()]),
    clock: { nowIso: () => NOW },
    scopeGroupId: SCOPE,
    windowSeconds: 3600,
    // The newest closed window is 01:00, so the period is observable through 02:00.
    ingestionLagSeconds: 0,
    ...overrides,
  });
}

async function listRaised(store) {
  return createNotificationLedger({ store, scopeGroupId: SCOPE }).list({
    sinceRaisedAt: '1970-01-01T00:00:00.000Z',
  });
}

test('a period that crossed its warning threshold raises one notification', async () => {
  const store = createInMemoryGovernanceStore();
  // 50 windows before the run, 17_000 tokens each = 850_000 of a 1_000_000 quota.
  await seed(store, organizationWindows(17_000));

  const result = await schedule(store).run();

  assert.equal(result.outcome, 'ran');
  assert.equal(result.raised, 1);
  const [notification] = await listRaised(store);
  assert.equal(notification.kind, 'budget-threshold-reached');
  assert.equal(notification.periodStart, MONTH_START);
});

test('the same crossing is not raised twice', async () => {
  const store = createInMemoryGovernanceStore();
  await seed(store, organizationWindows(17_000));

  await schedule(store).run();
  const second = await schedule(store).run();

  // The planner suppresses it before the ledger is asked, so the run raises nothing
  // rather than the ledger refusing a duplicate.
  assert.equal(second.raised, 0);
  assert.equal((await listRaised(store)).length, 1);
});

test('each budget is compared against its own period, not one period for the run', async () => {
  const store = createInMemoryGovernanceStore();
  // Every hour of the month carries traffic, but only the two hours of today are the
  // daily period. A single period for the run would compare one of them wrongly.
  await seed(store, organizationWindows(17_000));

  const result = await schedule(store, {
    readPublishedSnapshots: async () =>
      snapshots([
        budget({
          budgetId: 'budget-organization-daily',
          period: 'Daily',
          modelScope: 'per-model',
          modelKey: 'coding-fast',
          thresholds: { warnAtBasisPoints: 8_000 },
        }),
        budget(),
      ]),
  }).run();

  const byPeriod = new Map(result.periods.map((entry) => [entry.period, entry]));
  assert.equal(byPeriod.get('Monthly').periodStart, MONTH_START);
  assert.equal(byPeriod.get('Daily').periodStart, DAY_START);
  // The month crossed 80 per cent; the day's two windows are 34_000 tokens and did not.
  assert.equal(byPeriod.get('Monthly').raised, 1);
  assert.equal(byPeriod.get('Daily').raised, 0);
});

test('a team budget is compared against every team the period saw', async () => {
  const store = createInMemoryGovernanceStore();
  await seed(store, organizationWindows(17_000));
  for (const teamKey of ['team-alpha', 'team-beta']) {
    await seed(
      store,
      organizationWindows(0).map((document) =>
        rollup({
          grain: 'team',
          grainKey: teamKey,
          windowStart: document.windowStart,
          totalTokens: teamKey === 'team-alpha' ? 17_000 : 1,
        }),
      ),
    );
  }

  const result = await schedule(store, {
    readPublishedSnapshots: async () =>
      snapshots([budget({ budgetId: 'budget-team-monthly', scope: 'team' })]),
  }).run();

  const [monthly] = result.periods;
  assert.equal(monthly.scopesObserved, 2, 'both teams must be compared, not the budget alone');
  const raisedFor = (await listRaised(store)).map((notification) => notification.scopeKey);
  assert.deepEqual(raisedFor, ['team-alpha'], 'only the team that crossed is warned');
});

test('a gap in the period is reported as unjudgeable, not totalled lower and not silent', async () => {
  const store = createInMemoryGovernanceStore();
  const windows = organizationWindows(17_000);
  // Withheld from the middle: taking one off an end would shorten the period rather
  // than leave a hole in it.
  windows.splice(Math.floor(windows.length / 2), 1);
  await seed(store, windows);

  const result = await schedule(store).run();

  assert.equal(result.periods[0].coverage, 'partial');
  assert.equal(result.periods[0].coverageReason, 'window-missing');
  const kinds = (await listRaised(store)).map((notification) => notification.kind);
  assert.deepEqual(kinds, ['aggregate-stale'], 'a period nobody could judge must say so');
});

test('nothing published is reported as unreadable, not as a period that earned nothing', async () => {
  const store = createInMemoryGovernanceStore();
  await seed(store, organizationWindows(17_000));

  const result = await schedule(store, {
    readPublishedSnapshots: async () => {
      const error = new Error('published-policy-source-incomplete');
      error.reasonCode = 'published-policy-source-incomplete';
      throw error;
    },
  }).run();

  assert.equal(result.outcome, 'unavailable');
  assert.equal(result.reasonCode, 'published-policy-source-incomplete');
  assert.equal(result.raised, 0);
});

test('a published set with no organization entitlement cannot bind a budget', async () => {
  const store = createInMemoryGovernanceStore();
  await seed(store, organizationWindows(17_000));

  const result = await schedule(store, {
    readPublishedSnapshots: async () => ({
      ...snapshots([budget()]),
      entitlementSnapshot: { bindings: [] },
    }),
  }).run();

  assert.equal(result.outcome, 'unavailable');
  assert.equal(result.reasonCode, 'organization-entitlement-absent');
});

test('the run states which branch it took for every period', async () => {
  const store = createInMemoryGovernanceStore();
  await seed(store, organizationWindows(1));

  const result = await schedule(store).run();

  assert.equal(result.observedThrough, '2026-08-03T02:00:00.000Z');
  for (const entry of result.periods) {
    assert.ok(['compared', 'skipped'].includes(entry.state));
    assert.match(entry.reasonCode, /^[a-z][a-z0-9-]*$/);
  }
});

test('construction refuses a dependency it cannot work without', () => {
  const store = createInMemoryGovernanceStore();
  const ledger = createNotificationLedger({ store, scopeGroupId: SCOPE });
  const clock = { nowIso: () => NOW };
  const readPublishedSnapshots = async () => snapshots([budget()]);

  assert.throws(
    () => createScheduledBudgetNotifications({ ledger, readPublishedSnapshots, clock, scopeGroupId: SCOPE }),
    TypeError,
  );
  assert.throws(
    () => createScheduledBudgetNotifications({ store, readPublishedSnapshots, clock, scopeGroupId: SCOPE }),
    TypeError,
  );
  assert.throws(
    () => createScheduledBudgetNotifications({ store, ledger, clock, scopeGroupId: SCOPE }),
    TypeError,
  );
  assert.throws(
    () => createScheduledBudgetNotifications({ store, ledger, readPublishedSnapshots, scopeGroupId: SCOPE }),
    TypeError,
  );
  assert.throws(
    () => createScheduledBudgetNotifications({ store, ledger, readPublishedSnapshots, clock }),
    TypeError,
  );
});
