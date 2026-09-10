import assert from 'node:assert/strict';
import test from 'node:test';

import { projectBudgets } from '../../app/control-api/budgets-read-model-projector.mjs';

const generatedAt = '2026-08-10T04:05:00.000Z';

function authorization(overrides = {}) {
  return {
    contractVersion: 'v1',
    readAuthority: 'authoritative',
    permittedReadScopes: ['self', 'team', 'global'],
    permittedTeamKeys: ['platform-engineering'],
    effectiveRoles: ['governance-admin'],
    reasonCode: 'authorized',
    ...overrides,
  };
}

function publication(overrides = {}) {
  return {
    state: 'published',
    reasonCode: 'budgets-published',
    entries: [
      {
        budgetId: 'budget-platform-monthly',
        budgetVersion: 3,
        scope: 'organization',
        action: 'hard-block',
        modelScope: 'all-models',
        period: 'Monthly',
        state: 'enforceable',
        reasonCode: 'converted',
        configuredLimit: { amountMinor: 100_000, currency: 'USD' },
        convertedTokenQuota: 1000,
        enforcedTokenQuota: 1000,
        warnThresholdPercent: 80,
        basisModels: ['model-mini'],
        ratePerMillionMinor: 100,
        currency: 'USD',
        derivedAt: '2026-08-01T00:00:00.000Z',
      },
    ],
    throttleTiers: [],
    ...overrides,
  };
}

function project(overrides = {}) {
  return projectBudgets({
    authorization: authorization(),
    publication: publication(),
    selection: { scope: 'global', teamKey: null, generatedAt },
    freshness: { state: 'fresh', reportedAt: generatedAt, lagSeconds: 300 },
    ...overrides,
  });
}

const OBSERVED = Object.freeze([
  Object.freeze({
    scope: 'organization',
    scopeKey: null,
    budgetId: 'budget-platform-monthly',
    budgetVersion: 3,
    period: 'Monthly',
    modelScope: 'all-models',
    consumedTokens: 840,
    completeness: 'complete',
    completenessReason: null,
    windowsExpected: 4,
    windowsCovered: 4,
    windowsMissing: 0,
  }),
]);

test('a budget says how much of it has been used and how much is left', () => {
  const [record] = project({ observations: OBSERVED }).records;

  assert.equal(record.consumption.consumedTokens, 840);
  assert.equal(record.consumption.remainingTokens, 160);
  assert.equal(record.consumption.consumedBasisPoints, 8400);
  assert.equal(record.consumption.state, 'measured');
});

test('a period with a missing hour is not presented as a comfortable one', () => {
  // The measured total is genuinely lower, and showing it beside the cap without
  // saying so would read as room the organization does not have.
  const [record] = project({
    observations: [
      { ...OBSERVED[0], consumedTokens: 420, completeness: 'partial', completenessReason: 'window-missing', windowsCovered: 2, windowsMissing: 2 },
    ],
  }).records;

  assert.equal(record.consumption.state, 'partial');
  assert.equal(record.consumption.reasonCode, 'window-missing');
  assert.equal(record.consumption.consumedTokens, 420, 'what was measured is still shown');
  assert.equal(record.consumption.remainingTokens, null, 'a remainder computed from a gap would be a guess');
});

test('a budget with no observation says so rather than showing nothing used', () => {
  const [record] = project({ observations: [] }).records;

  assert.equal(record.consumption.state, 'unmeasured');
  assert.equal(record.consumption.consumedTokens, null);
  assert.equal(record.consumption.remainingTokens, null);
});

test('a budget that could not be enforced has nothing to measure against', () => {
  const [record] = project({
    publication: publication({
      entries: [
        {
          ...publication().entries[0],
          state: 'unenforceable',
          reasonCode: 'model-not-entitled',
          convertedTokenQuota: null,
          enforcedTokenQuota: null,
        },
      ],
    }),
    observations: OBSERVED,
  }).records;

  assert.equal(record.consumption.state, 'unmeasured');
  assert.equal(record.consumption.reasonCode, 'no-quota-to-measure');
});

test('consumption past the cap is reported as past it, never clamped to full', () => {
  const [record] = project({
    observations: [{ ...OBSERVED[0], consumedTokens: 1300 }],
  }).records;

  assert.equal(record.consumption.consumedBasisPoints, 13000);
  assert.equal(record.consumption.remainingTokens, 0);
  assert.equal(record.consumption.overCap, true);
});

test('each budget uses its own identity-matched observation, not the first scope total', () => {
  const perModel = {
    ...publication().entries[0],
    budgetId: 'budget-platform-primary-monthly',
    budgetVersion: 4,
    modelScope: 'per-model',
    modelKey: 'model-primary',
  };
  const records = project({
    publication: publication({ entries: [publication().entries[0], perModel] }),
    observations: [
      OBSERVED[0],
      {
        ...OBSERVED[0],
        budgetId: perModel.budgetId,
        budgetVersion: perModel.budgetVersion,
        modelScope: perModel.modelScope,
        modelKey: perModel.modelKey,
        consumedTokens: 120,
      },
    ],
  }).records;

  assert.equal(records.find((record) => record.budgetCode === 'budget-platform-monthly').consumption.consumedTokens, 840);
  assert.equal(records.find((record) => record.budgetCode === perModel.budgetId).consumption.consumedTokens, 120);
});

test('a screen with no observations at all still renders the budgets', () => {
  const model = project();

  assert.equal(model.records.length, 1);
  assert.equal(model.records[0].consumption.state, 'unmeasured');
});

test('the consumption figures carry no principal or body vocabulary', () => {
  const serialized = JSON.stringify(project({ observations: OBSERVED }));
  for (const forbidden of ['prompt', 'completion', 'subjectId', 'authorization']) {
    assert.doesNotMatch(serialized, new RegExp(forbidden, 'i'));
  }
});
