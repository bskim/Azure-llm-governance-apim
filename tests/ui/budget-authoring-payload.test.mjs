import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildBudgetAddPayload,
  buildBudgetEditPayload,
} from '../../app/admin-ui/public/budget-authoring.mjs';
import { assertBudgetSnapshotV1 } from '../../app/governance-domain/policy/budget-publication.mjs';

const models = ['coding-fast', 'coding-primary'];
const options = {
  models,
  throttleTierCodes: ['tier-reduced', 'tier-minimal'],
};
const base = {
  scope: 'organization',
  amount: '40,000,000',
  action: 'HARD_BLOCK',
  modelScope: 'all-models',
  modelKey: '',
  period: 'Monthly',
  warnAtBasisPoints: '',
  graceBasisPoints: '',
  tiers: [],
};

function readRecord(overrides = {}) {
  return {
    budgetCode: 'budget-organization-monthly',
    scopeKind: 'organization',
    configuredLimit: { unit: 'tokens', currency: null, amount: 40_000_000 },
    action: 'HARD_BLOCK',
    modelScope: 'all-models',
    period: 'Monthly',
    thresholds: {},
    ...overrides,
  };
}

test('the shared browser builder sends a complete all-model add and omits modelKey', () => {
  const result = buildBudgetAddPayload(base, options, 'budget-organization-new');

  assert.equal(result.ok, true);
  assert.deepEqual(result.payload, {
    command: 'add',
    budget: {
      budgetId: 'budget-organization-new',
      scope: 'organization',
      action: 'HARD_BLOCK',
      modelScope: 'all-models',
      accountingBasis: 'apim-estimated-total-tokens',
      limit: { unit: 'tokens', currency: null, amount: 40_000_000 },
      period: 'Monthly',
      thresholds: {},
    },
  });
  assert.equal(Object.hasOwn(result.payload.budget, 'modelKey'), false);
});

test('per-model creation accepts only a model supplied by access options', () => {
  const accepted = buildBudgetAddPayload(
    { ...base, scope: 'team', modelScope: 'per-model', modelKey: 'coding-fast' },
    options,
    'budget-team-fast',
  );
  assert.equal(accepted.ok, true);
  assert.equal(accepted.payload.budget.modelKey, 'coding-fast');

  assert.equal(buildBudgetAddPayload(
    { ...base, modelScope: 'per-model', modelKey: 'guessed-model' },
    options,
    'budget-bad',
  ).error, 'modelKey');
  assert.equal(buildBudgetAddPayload(
    { ...base, scope: 'subject', modelScope: 'per-model', modelKey: 'coding-fast' },
    options,
    'budget-bad',
  ).error, 'perModelScope');
});

test('edit payload carries every mutable budget field but never scope', () => {
  const result = buildBudgetEditPayload(
    readRecord({ budgetCode: 'budget-team-fast', scopeKind: 'team' }),
    {
      ...base,
      amount: '50000000',
      action: 'SOFT_WARNING',
      modelScope: 'per-model',
      modelKey: 'coding-primary',
      period: 'Weekly',
      graceBasisPoints: '750',
    },
    options,
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.payload.changes, {
    amount: 50_000_000,
    action: 'SOFT_WARNING',
    modelScope: 'per-model',
    modelKey: 'coding-primary',
    period: 'Weekly',
    thresholds: { graceBasisPoints: 750 },
  });

  assert.equal(Object.hasOwn(result.payload.changes, 'scope'), false);

  const allModels = buildBudgetEditPayload(
    readRecord({ budgetCode: 'budget-team-fast', scopeKind: 'team' }),
    { ...base, amount: '40000001', modelKey: 'coding-fast' },
    options,
  );
  assert.equal(Object.hasOwn(allModels.payload.changes, 'modelKey'), false);
});

test('edit helper refuses a canonical full-form no-op before submission', () => {
  const record = readRecord();
  const unchanged = buildBudgetEditPayload(record, { ...base }, options);
  assert.deepEqual(unchanged, { ok: false, error: 'noChange', field: 'amount' });

  const changes = [
    { amount: '40000001' },
    { action: 'SOFT_WARNING', graceBasisPoints: '1000' },
    { modelScope: 'per-model', modelKey: 'coding-fast' },
    { period: 'Daily' },
    { warnAtBasisPoints: '8500' },
  ];
  for (const change of changes) {
    assert.equal(
      buildBudgetEditPayload(record, { ...base, ...change }, options).ok,
      true,
      `expected ${Object.keys(change).join(',')} to be treated as a change`,
    );
  }
});

test('no-op comparison preserves exact thresholds and model keys independent of key order', () => {
  const exactCases = [
    {
      values: {
        ...base,
        action: 'SOFT_WARNING',
        graceBasisPoints: '123',
      },
      record: readRecord({
        action: 'SOFT_WARNING',
        thresholds: { graceBasisPoints: 123 },
      }),
    },
    {
      values: { ...base, warnAtBasisPoints: '1' },
      record: readRecord({ thresholds: { warnAtBasisPoints: 1 } }),
    },
    {
      values: { ...base, modelScope: 'per-model', modelKey: 'coding-primary' },
      record: readRecord({
        scopeKind: 'team',
        modelScope: 'per-model',
        modelKey: 'coding-primary',
      }),
    },
  ];

  for (const { values, record } of exactCases) {
    assert.deepEqual(
      buildBudgetEditPayload(record, values, options),
      { ok: false, error: 'noChange', field: 'amount' },
    );
  }
});

test('invalid legacy values do not prevent a valid repair', () => {
  const retiredModel = readRecord({
    scopeKind: 'team',
    modelScope: 'per-model',
    modelKey: 'retired-model',
  });
  assert.equal(buildBudgetEditPayload(
    retiredModel,
    { ...base, modelScope: 'per-model', modelKey: 'coding-primary' },
    options,
  ).ok, true);

  const undeclaredTier = readRecord({
    action: 'THROTTLE',
    thresholds: { tiers: [{ atBasisPoints: 7_000, tierCode: 'retired-tier' }] },
  });
  assert.equal(buildBudgetEditPayload(undeclaredTier, { ...base }, options).ok, true);
});

test('throttle tiers are complete, ascending, bounded, and selected from gateway options', () => {
  const accepted = buildBudgetAddPayload({
    ...base,
    action: 'THROTTLE',
    tiers: [
      { atBasisPoints: '7000', tierCode: 'tier-reduced' },
      { atBasisPoints: '12000', tierCode: 'tier-minimal' },
      { atBasisPoints: '', tierCode: '' },
    ],
  }, options, 'budget-throttle');
  assert.equal(accepted.ok, true);
  assert.deepEqual(accepted.payload.budget.thresholds.tiers, [
    { atBasisPoints: 7_000, tierCode: 'tier-reduced' },
    { atBasisPoints: 12_000, tierCode: 'tier-minimal' },
  ]);

  assert.equal(buildBudgetAddPayload({
    ...base,
    action: 'THROTTLE',
    tiers: [
      { atBasisPoints: '9000', tierCode: 'tier-reduced' },
      { atBasisPoints: '8000', tierCode: 'tier-minimal' },
    ],
  }, options, 'budget-throttle').error, 'throttleAscending');

  assert.equal(buildBudgetAddPayload({
    ...base,
    action: 'THROTTLE',
    tiers: [{ atBasisPoints: '7000', tierCode: 'invented-tier' }],
  }, options, 'budget-throttle').error, 'throttleCode');
  assert.equal(buildBudgetAddPayload({
    ...base,
    action: 'THROTTLE',
    tiers: [{ atBasisPoints: '7000', tierCode: 'tier-reduced' }],
  }, { models }, 'budget-throttle').error, 'throttleUnavailable');
});

test('the throttle payload produced for the real UI is accepted by the budget domain', () => {
  const result = buildBudgetAddPayload({
    ...base,
    action: 'THROTTLE',
    tiers: [
      { atBasisPoints: '7000', tierCode: 'tier-reduced' },
      { atBasisPoints: '9000', tierCode: 'tier-minimal' },
    ],
  }, options, 'budget-organization-throttle');
  assert.equal(result.ok, true);

  const snapshot = assertBudgetSnapshotV1({
    contractVersion: 'v1',
    snapshotId: 'budget-ui-generated-001',
    tenantId: 'tenant-local-demo',
    version: 1,
    status: 'complete',
    capturedAt: '2026-09-09T00:00:00.000Z',
    expiresAt: '2026-09-10T00:00:00.000Z',
    sourceRevision: 'budget-ui-generated-source-001',
    budgets: [{ ...result.payload.budget, budgetVersion: 1 }],
  }, {
    evaluationTime: '2026-09-09T01:00:00.000Z',
    principalTenantId: 'tenant-local-demo',
  });

  assert.deepEqual(snapshot.budgets[0].thresholds, result.payload.budget.thresholds);
});

test('hard-block warning and soft-warning grace enforce their distinct ranges', () => {
  assert.deepEqual(
    buildBudgetAddPayload({ ...base, warnAtBasisPoints: '8500' }, options, 'budget-hard')
      .payload.budget.thresholds,
    { warnAtBasisPoints: 8_500 },
  );
  assert.equal(
    buildBudgetAddPayload({ ...base, warnAtBasisPoints: '10000' }, options, 'budget-hard').error,
    'hardWarning',
  );
  assert.equal(
    buildBudgetAddPayload({ ...base, action: 'SOFT_WARNING', graceBasisPoints: '0' }, options, 'budget-soft').error,
    'softGrace',
  );
});
