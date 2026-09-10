import assert from 'node:assert/strict';
import test from 'node:test';

import { projectBudgets } from '../../app/control-api/budgets-read-model-projector.mjs';
import { assertBudgetSnapshotV1, publishBudgets } from '../../app/governance-domain/policy/budget-publication.mjs';
import { assertModelRegistrySnapshotV1 } from '../../app/governance-domain/registry/model-registry-validator.mjs';

const evaluationTime = '2026-08-07T00:00:00.000Z';
const tenantId = 'tenant-local-demo';

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
      tenantId,
      version: 1,
      status: 'complete',
      capturedAt: '2026-08-06T23:55:00.000Z',
      expiresAt: '2026-08-07T00:30:00.000Z',
      sourceRevision: 'model-registry-source-001',
      models: [model('coding-fast', 100), model('coding-primary', 1_000)],
      applications: [],
    },
    { evaluationTime, principalTenantId: tenantId },
  );
}

function budget(overrides = {}) {
  return {
    budgetId: 'budget-org',
    budgetVersion: 1,
    scope: 'organization',
    action: 'HARD_BLOCK',
    modelScope: 'all-models',
    accountingBasis: 'apim-estimated-total-tokens',
    limit: { unit: 'tokens', currency: null, amount: 40_000_000 },
    period: 'Monthly',
    thresholds: {},
    ...overrides,
  };
}

function publication(budgets, overrides = {}) {
  const snapshot = assertBudgetSnapshotV1(
    {
      contractVersion: 'v1',
      snapshotId: 'budget-snapshot-001',
      tenantId,
      version: 3,
      status: 'complete',
      capturedAt: '2026-08-06T23:55:00.000Z',
      expiresAt: '2026-08-07T00:30:00.000Z',
      sourceRevision: 'budget-source-001',
      budgets,
      ...overrides,
    },
    { evaluationTime, principalTenantId: tenantId },
  );
  return publishBudgets({
    budgetSnapshot: snapshot,
    registry: registry(),
    allowedModels: ['coding-fast', 'coding-primary'],
    evaluationTime,
  });
}

function authorization(permittedReadScopes, permittedTeamKeys = []) {
  return {
    contractVersion: 'v1',
    readAuthority: 'authoritative',
    permittedReadScopes,
    permittedTeamKeys,
    reasonCode: 'authorized',
  };
}

function project(budgets, { scope = 'global', teamKey = null, scopes = ['self', 'team', 'global'], teams = ['developer-experience'], modelSelection = null } = {}) {
  return projectBudgets({
    authorization: authorization(scopes, teams),
    publication: publication(budgets),
    selection: { scope, teamKey, generatedAt: evaluationTime },
    freshness: { state: 'fresh', reportedAt: evaluationTime, lagSeconds: 300 },
    modelSelection,
  });
}

test('a budget shows what was configured and what is actually enforced', () => {
  const model = project([
    budget({ action: 'SOFT_WARNING', thresholds: { graceBasisPoints: 1_000 } }),
  ]);
  const [record] = model.records;

  assert.equal(model.readModelVersion, 'budgets.v1');
  assert.equal(record.configuredLimit.amount, 40_000_000);
  assert.equal(record.convertedTokenQuota, 40_000_000);
  assert.equal(record.enforcedTokenQuota, 44_000_000);
  assert.equal(record.warnThresholdPercent, 90);
});

test('records preserve authored model keys and thresholds without reverse derivation', () => {
  const [enforceable] = project([
    budget({
      action: 'SOFT_WARNING',
      modelScope: 'per-model',
      modelKey: 'coding-primary',
      thresholds: { graceBasisPoints: 333 },
    }),
  ]).records;
  const [unenforceable] = project([
    budget({
      modelScope: 'per-model',
      modelKey: 'never-published',
      thresholds: { warnAtBasisPoints: 9_999 },
    }),
  ]).records;

  assert.equal(enforceable.modelKey, 'coding-primary');
  assert.deepEqual(enforceable.thresholds, { graceBasisPoints: 333 });
  assert.equal(unenforceable.modelKey, 'never-published');
  assert.deepEqual(unenforceable.thresholds, { warnAtBasisPoints: 9_999 });
});

test('a budget shows the limit it states and when that was derived', () => {
  const [record] = project([
    budget({ limit: { unit: 'tokens', currency: null, amount: 1_000_000 } }),
  ]).records;

  assert.equal(record.configuredLimit.unit, 'tokens');
  assert.equal(record.configuredLimit.amount, 1_000_000);
  assert.equal(record.convertedTokenQuota, 1_000_000);
  assert.equal(record.derivedAt, evaluationTime);
});

test('a downgrade a pin suppresses is named, so the budget is not blamed for it', () => {
  const compiled = {
    contracts: ['openai-responses', 'openai-chat-completions'],
    modelSelectionIntent: 'pinned',
    substitutionNotice: 'header',
  };
  const { modelSelection } = project([budget()], { modelSelection: compiled });

  assert.equal(modelSelection.intent, 'pinned');
  assert.equal(modelSelection.downgradeAvailable, true);
  assert.equal(modelSelection.downgradeSuppressedBy, 'model-pinned');

  const accepting = project([budget()], {
    modelSelection: { ...compiled, modelSelectionIntent: 'preferred' },
  }).modelSelection;
  assert.equal(accepting.downgradeSuppressedBy, null);

  // No plan at all is a different statement from a plan that will not be taken.
  assert.equal(project([budget()]).modelSelection, null);
  const noChain = project([budget()], {
    modelSelection: { ...compiled, contracts: [] },
  }).modelSelection;
  assert.equal(noChain.downgradeAvailable, false);
  assert.equal(noChain.downgradeSuppressedBy, null);
});

test('the contracts a downgrade compiles on are named, not reduced to a yes or no', () => {
  // A chain serving one contract and not another is what this account actually looks
  // like, and the previous all-contracts test could never be satisfied by any model
  // in the catalogue, so a working downgrade reported as none configured.
  const partial = project([budget()], {
    modelSelection: {
      contracts: ['openai-responses'],
      modelSelectionIntent: 'preferred',
      substitutionNotice: 'header',
    },
  }).modelSelection;

  assert.deepEqual(partial.downgradeContracts, ['openai-responses']);
  assert.equal(partial.downgradeAvailable, true);

  const sorted = project([budget()], {
    modelSelection: {
      contracts: ['openai-responses', 'anthropic-messages'],
      modelSelectionIntent: 'preferred',
      substitutionNotice: 'header',
    },
  }).modelSelection;
  assert.deepEqual(sorted.downgradeContracts, ['anthropic-messages', 'openai-responses']);

  const none = project([budget()], {
    modelSelection: { contracts: [], modelSelectionIntent: 'preferred', substitutionNotice: 'header' },
  }).modelSelection;
  assert.deepEqual(none.downgradeContracts, []);
  assert.equal(none.downgradeAvailable, false);
});

test('a throttle shows its tiers and no enforced quota', () => {
  const [record] = project([
    budget({
      action: 'THROTTLE',
      thresholds: {
        tiers: [
          { atBasisPoints: 7_000, tierCode: 'tier-reduced' },
          { atBasisPoints: 9_000, tierCode: 'tier-minimal' },
        ],
      },
    }),
  ]).records;

  assert.equal(record.enforcedTokenQuota, null);
  assert.deepEqual(
    record.throttleTiers.map((tier) => tier.tierCode),
    ['tier-reduced', 'tier-minimal'],
  );
});

test('a budget that cannot bind appears with its reason', () => {
  const [record] = project([
    budget({
      modelScope: 'per-model',
      modelKey: 'never-published',
      limit: { unit: 'tokens', currency: null, amount: 1_000_000 },
    }),
  ]).records;

  assert.equal(record.state, 'unenforceable');
  assert.equal(record.reasonCode, 'model-not-entitled');
  assert.equal(record.enforcedTokenQuota, null);
  assert.equal(record.convertedTokenQuota, null);
});

test('a team reader sees team and organization budgets but not another principal', () => {
  const model = project(
    [
      budget({ budgetId: 'budget-org', scope: 'organization' }),
      budget({ budgetId: 'budget-subject', scope: 'subject' }),
      budget({ budgetId: 'budget-team', scope: 'team' }),
    ],
    { scope: 'team', teamKey: 'developer-experience' },
  );

  assert.deepEqual(
    model.records.map((record) => record.scopeKind),
    ['organization', 'team'],
  );
});

test('a self reader sees its own scopes and the organization ceiling', () => {
  const model = project(
    [
      budget({ budgetId: 'budget-org', scope: 'organization' }),
      budget({ budgetId: 'budget-subject', scope: 'subject' }),
      budget({ budgetId: 'budget-team', scope: 'team' }),
    ],
    { scope: 'self' },
  );

  assert.deepEqual(
    model.records.map((record) => record.scopeKind),
    ['organization', 'subject'],
  );
});

test('records are ordered by budget code rather than by configuration order', () => {
  const model = project([
    budget({ budgetId: 'budget-a' }),
    budget({ budgetId: 'budget-b', scope: 'team' }),
    budget({ budgetId: 'budget-c', scope: 'subject' }),
  ]);

  assert.deepEqual(
    model.records.map((record) => record.budgetCode),
    ['budget-a', 'budget-b', 'budget-c'],
  );
});

test('an unauthorized scope is refused before any budget is projected', () => {
  assert.throws(
    () =>
      projectBudgets({
        authorization: authorization(['self']),
        publication: publication([budget()]),
        selection: { scope: 'global', generatedAt: evaluationTime },
      }),
    /scope-denied/,
  );
});

test('degraded membership evidence is refused before any budget is projected', () => {
  assert.throws(
    () =>
      projectBudgets({
        authorization: { contractVersion: 'v1', readAuthority: 'degraded', permittedReadScopes: [] },
        publication: publication([budget()]),
        selection: { scope: 'global', generatedAt: evaluationTime },
      }),
    /membership-not-authoritative/,
  );
});

test('an unavailable publication reports no budgets rather than none configured', () => {
  const model = projectBudgets({
    authorization: authorization(['global']),
    publication: publication([], { status: 'stale', reason: 'publisher behind', budgets: [] }),
    selection: { scope: 'global', generatedAt: evaluationTime },
    freshness: { state: 'fresh', reportedAt: evaluationTime, lagSeconds: 300 },
  });

  assert.equal(model.quality.state, 'unavailable');
  assert.equal(model.quality.reasonCode, 'budget-snapshot-stale');
  assert.deepEqual(model.records, []);
});

test('the read model carries no raw principal identifier', () => {
  const serialized = JSON.stringify(project([budget()]));

  assert.ok(!serialized.includes('subjectId'));
  assert.ok(!serialized.includes(tenantId));
  assert.ok(!serialized.includes('resourceId'));
});

test('a period that went past its cap says by how much, and a gap makes that a floor', () => {
  // A 40,000,000 token limit served with a ten percent grace band, so the quota the
  // gateway actually enforces is what the period is measured against.
  const quota = 44_000_000;
  const over = (consumedTokens, completeness = 'complete') => projectBudgets({
    authorization: authorization(['self', 'team', 'global'], ['developer-experience']),
    publication: publication([budget({ action: 'SOFT_WARNING', thresholds: { graceBasisPoints: 1_000 } })]),
    selection: { scope: 'global', teamKey: null, generatedAt: evaluationTime },
    freshness: { state: 'fresh', reportedAt: evaluationTime, lagSeconds: 300 },
    observations: [{
      scope: 'organization',
      scopeKey: null,
      budgetId: 'budget-org',
      budgetVersion: 1,
      period: 'Monthly',
      modelScope: 'all-models',
      consumedTokens,
      completeness,
      completenessReason: completeness === 'complete' ? 'period-measured' : 'window-missing',
      windowsCovered: completeness === 'complete' ? 24 : 20,
      windowsMissing: completeness === 'complete' ? 0 : 4,
    }],
  }).records[0].consumption;

  const under = over(quota - 1_000);
  assert.equal(under.overCap, false);
  // Not over is reported as nothing to state rather than as a zero, which would read
  // as a cap that was exactly reached.
  assert.equal(under.exceededByTokens, null);

  const past = over(quota + 487_000);
  assert.equal(past.overCap, true);
  assert.equal(past.exceededByTokens, 487_000);
  assert.equal(past.state, 'measured');

  // A gap lowers a total, so a period already over the cap is over whatever is
  // missing. The figure is a floor, and the remainder is still withheld.
  const partial = over(quota + 12_000, 'partial');
  assert.equal(partial.state, 'partial');
  assert.equal(partial.overCap, true);
  assert.equal(partial.exceededByTokens, 12_000);
  assert.equal(partial.remainingTokens, null);
});
