import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { assertBudgetSnapshotV1, publishBudgets } from '../../app/governance-domain/policy/budget-publication.mjs';
import { deriveTokenQuota } from '../../app/governance-domain/policy/budget-token-quota.mjs';
import { assertModelRegistrySnapshotV1 } from '../../app/governance-domain/registry/model-registry-validator.mjs';

const evaluationTime = '2026-08-07T00:00:00.000Z';
const tenantId = 'tenant-local-demo';

function model(modelKey, rateHalves) {
  return {
    modelKey,
    providerKey: 'azure-openai',
    apiFamilies: ['openai-chat-completions', 'openai-responses'],
    lifecycle: 'generally-available',
    safetyPolicy: 'local-default-policy',
  };
}

// Both rates equal, so the even-split rate is exactly the number given.
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
    limit: { unit: 'tokens', currency: null, amount: 1_000_000 },
    period: 'Monthly',
    thresholds: {},
    ...overrides,
  };
}

function snapshot(budgets, overrides = {}) {
  return {
    contractVersion: 'v1',
    snapshotId: 'budget-snapshot-001',
    tenantId,
    version: 2,
    status: 'complete',
    capturedAt: '2026-08-06T23:55:00.000Z',
    expiresAt: '2026-08-07T00:30:00.000Z',
    sourceRevision: 'budget-source-001',
    budgets,
    ...overrides,
  };
}

function accept(budgets, overrides = {}) {
  return assertBudgetSnapshotV1(snapshot(budgets, overrides), {
    evaluationTime,
    principalTenantId: tenantId,
  });
}

function publish(budgets, overrides = {}) {
  return publishBudgets({
    budgetSnapshot: accept(budgets, overrides.snapshot),
    registry: overrides.registry ?? registry(),
    allowedModels: overrides.allowedModels ?? ['coding-fast', 'coding-primary'],
    observedMix: overrides.observedMix,
    declaredTierCodes: overrides.declaredTierCodes,
    evaluationTime,
  });
}

test('a throttle naming a tier the deployment does not declare is unenforceable', () => {
  const throttle = budget({
    action: 'THROTTLE',
    thresholds: { tiers: [{ atBasisPoints: 7_000, tierCode: 'tier-invented' }] },
  });

  const declared = publish([throttle], { declaredTierCodes: ['tier-reduced', 'tier-minimal'] });
  assert.equal(declared.unenforceable[0].reasonCode, 'throttle-tier-undeclared');
  assert.deepEqual(declared.throttleTiers, []);

  // Without a declared set there is nothing to check against, so the tier passes.
  assert.equal(publish([throttle]).throttleTiers.length, 1);
});

test('a throttle naming declared tiers is published', () => {
  const result = publish(
    [
      budget({
        action: 'THROTTLE',
        thresholds: { tiers: [{ atBasisPoints: 7_000, tierCode: 'tier-reduced' }] },
      }),
    ],
    { declaredTierCodes: ['tier-reduced', 'tier-minimal'] },
  );

  assert.equal(result.throttleTiers.length, 1);
  assert.deepEqual(result.unenforceable, []);
});

test('independent throttle budgets retain their local tier codes', () => {
  const result = publish([
    budget({
      budgetId: 'budget-subject',
      scope: 'subject',
      action: 'THROTTLE',
      thresholds: { tiers: [{ atBasisPoints: 7_000, tierCode: 'tier-reduced' }] },
    }),
    budget({
      budgetId: 'budget-team',
      scope: 'team',
      action: 'THROTTLE',
      thresholds: { tiers: [{ atBasisPoints: 7_000, tierCode: 'tier-reduced' }] },
    }),
  ]);

  assert.equal(result.throttleTiers.length, 2);
  assert.deepEqual(result.throttleTiers.map((tier) => tier.scope), ['subject', 'team']);
});

test('a throttle and a hard block at the same coverage publish independent APIM controls', () => {
  const result = publish([
    budget({ budgetId: 'budget-organization-cap' }),
    budget({
      budgetId: 'budget-organization-throttle',
      action: 'THROTTLE',
      thresholds: { tiers: [{ atBasisPoints: 8000, tierCode: 'tier-reduced' }] },
    }),
  ]);

  assert.equal(result.limits.length, 1);
  assert.equal(result.limits[0].budgetId, 'budget-organization-cap');
  assert.equal(result.throttleTiers.length, 1);
  assert.equal(result.throttleTiers[0].budgetId, 'budget-organization-throttle');
});

test('a hard block publishes the configured limit as the enforced quota', () => {
  const result = publish([budget()]);

  assert.deepEqual(result.limits, [
    {
      scope: 'organization',
      modelScope: 'all-models',
      tokenQuota: 1_000_000,
      quotaPeriod: 'Monthly',
      budgetId: 'budget-org',
      budgetVersion: 1,
      budgetAction: 'HARD_BLOCK',
      accountingBasis: 'apim-estimated-total-tokens',
      budgetThresholds: {},
    },
  ]);
  assert.equal(result.warnThresholdPercent, null);
  assert.deepEqual(result.throttleTiers, []);
  assert.deepEqual(result.unenforceable, []);
});

test('a soft warning enforces the limit plus grace and warns at the limit', () => {
  const result = publish([
    budget({ action: 'SOFT_WARNING', thresholds: { graceBasisPoints: 500 } }),
  ]);

  // 1,000,000 plus 5 percent, and the warning falls where the configured limit sits
  // inside the larger quota.
  assert.equal(result.limits[0].tokenQuota, 1_050_000);
  assert.equal(result.warnThresholdPercent, 95);
});

test('a soft warning grace of a full further limit doubles the quota', () => {
  const result = publish([
    budget({ action: 'SOFT_WARNING', thresholds: { graceBasisPoints: 10_000 } }),
  ]);

  assert.equal(result.limits[0].tokenQuota, 2_000_000);
  assert.equal(result.warnThresholdPercent, 50);
});

test('a large soft-warning limit preserves its exact 50-percent warning threshold', () => {
  const result = publish([
    budget({
      action: 'SOFT_WARNING',
      limit: { unit: 'tokens', currency: null, amount: 4_503_599_627_370_472 },
      thresholds: { graceBasisPoints: 10_000 },
    }),
  ]);

  assert.equal(result.limits[0].tokenQuota, 9_007_199_254_740_944);
  assert.equal(result.warnThresholdPercent, 50);
});

test('a soft-warning grace that exceeds the contract token maximum is refused before composition', () => {
  assert.throws(
    () => publish([
      budget({
        action: 'SOFT_WARNING',
        limit: { unit: 'tokens', currency: null, amount: Number.MAX_SAFE_INTEGER },
        thresholds: { graceBasisPoints: 1 },
      }),
    ]),
    /exceeds the maximum/,
  );
});

test('a hard block may declare an approaching signal for the downgrade trigger', () => {
  const result = publish([
    budget({ thresholds: { warnAtBasisPoints: 8_000 } }),
  ]);

  assert.equal(result.limits[0].tokenQuota, 1_000_000);
  assert.equal(result.warnThresholdPercent, 80);
});

test('the earliest warning wins when several budgets ask for one', () => {
  const result = publish([
    budget({ budgetId: 'budget-org', thresholds: { warnAtBasisPoints: 9_000 } }),
    budget({
      budgetId: 'budget-team',
      scope: 'team',
      thresholds: { warnAtBasisPoints: 7_000 },
    }),
  ]);

  assert.equal(result.warnThresholdPercent, 70);
});

test('a throttle publishes tiers against its own derived quota and denies nothing', () => {
  const result = publish([
    budget({
      action: 'THROTTLE',
      thresholds: {
        tiers: [
          { atBasisPoints: 7_000, tierCode: 'tier-reduced' },
          { atBasisPoints: 9_000, tierCode: 'tier-minimal' },
        ],
      },
    }),
  ]);

  assert.deepEqual(result.limits, [], 'a throttle is not a denial.');
  assert.equal(result.throttleTiers.length, 2);
  assert.equal(result.throttleTiers[0].tierCode, 'tier-reduced');
  assert.equal(result.throttleTiers[0].againstTokenQuota, 1_000_000);
  assert.equal(result.throttleTiers[0].scope, 'organization');
  assert.deepEqual(result.throttleTiers[0], {
    scope: 'organization',
    modelScope: 'all-models',
    budgetId: 'budget-org',
    budgetVersion: 1,
    action: 'THROTTLE',
    quotaPeriod: 'Monthly',
    accountingBasis: 'apim-estimated-total-tokens',
    atBasisPoints: 7_000,
    tierCode: 'tier-reduced',
    againstTokenQuota: 1_000_000,
  });
});

test('budgets sharing an APIM counter identity are rejected instead of silently selecting one', () => {
  assert.throws(
    () => accept([
      budget({ budgetId: 'budget-a', limit: { unit: 'tokens', currency: null, amount: 5_000_000 } }),
      budget({ budgetId: 'budget-b', limit: { unit: 'tokens', currency: null, amount: 2_000_000 } }),
    ]),
    /counter identity/,
  );
  assert.throws(
    () => accept([
      budget({ budgetId: 'budget-a', period: 'Daily' }),
      budget({ budgetId: 'budget-b', period: 'Monthly' }),
    ]),
    /counter identity/,
  );
});

test('budgets at different scopes each publish their own limit, in a stable order', () => {
  // Supplied sorted by identifier; the output is ordered by scope instead.
  const result = publish([
    budget({ budgetId: 'budget-org', scope: 'organization' }),
    budget({ budgetId: 'budget-subject', scope: 'subject' }),
    budget({ budgetId: 'budget-team', scope: 'team' }),
  ]);

  assert.deepEqual(
    result.limits.map((limit) => limit.scope),
    ['organization', 'team', 'subject'],
  );
});

test('a token budget is published as the quota it states, with no conversion between', () => {
  const result = publish([
    budget({
      limit: { unit: 'tokens', currency: null, amount: 1_000_000 },
    }),
  ]);

  assert.equal(result.limits[0].tokenQuota, 1_000_000);
  const [entry] = result.entries;
  assert.equal(entry.configuredLimit.unit, 'tokens');
  assert.equal(entry.convertedTokenQuota, 1_000_000);
  assert.equal(entry.enforcedTokenQuota, 1_000_000);
});

test('a soft warning entry separates what was converted from what is enforced', () => {
  const [entry] = publish([
    budget({ action: 'SOFT_WARNING', thresholds: { graceBasisPoints: 500 } }),
  ]).entries;

  assert.equal(entry.convertedTokenQuota, 1_000_000);
  assert.equal(entry.enforcedTokenQuota, 1_050_000);
  assert.equal(entry.warnThresholdPercent, 95);
});

test('a throttle entry enforces no quota of its own', () => {
  const [entry] = publish([
    budget({
      action: 'THROTTLE',
      thresholds: { tiers: [{ atBasisPoints: 7_000, tierCode: 'tier-reduced' }] },
    }),
  ]).entries;

  assert.equal(entry.convertedTokenQuota, 1_000_000);
  assert.equal(entry.enforcedTokenQuota, null);
});

test('a budget nothing is entitled to reach publishes no quota and is reported with its reason', () => {
  const result = publish([budget({ limit: { unit: 'tokens', currency: null, amount: 1_000_000 } })], {
    allowedModels: [],
  });

  assert.deepEqual(result.limits, []);
  assert.equal(result.unenforceable.length, 1);
  assert.equal(result.unenforceable[0].budgetId, 'budget-org');
  assert.equal(result.unenforceable[0].reasonCode, 'no-entitled-model');
});

test('one unenforceable budget does not suppress the budgets that can bind', () => {
  const result = publish([
    budget({ budgetId: 'budget-a', limit: { unit: 'tokens', currency: null, amount: 3_000_000 } }),
    budget({
      budgetId: 'budget-b',
      scope: 'team',
      modelScope: 'per-model',
      modelKey: 'never-published',
      limit: { unit: 'tokens', currency: null, amount: 1_000_000 },
    }),
  ]);

  assert.equal(result.limits.length, 1);
  assert.equal(result.limits[0].scope, 'organization');
  assert.equal(result.unenforceable.length, 1);
  assert.equal(result.unenforceable[0].reasonCode, 'model-not-entitled');
});

test('a degraded budget snapshot publishes nothing and says so', () => {
  const result = publish([], {
    snapshot: { status: 'source-unavailable', reason: 'budget publisher unreachable', budgets: [] },
  });

  assert.equal(result.state, 'unavailable');
  assert.deepEqual(result.limits, []);
  assert.equal(result.warnThresholdPercent, null);
});

test('a complete snapshot with no budgets is not the same as an unavailable one', () => {
  const result = publish([]);

  assert.equal(result.state, 'published');
  assert.deepEqual(result.limits, []);
});

test('the published result is frozen through its nested records', () => {
  const result = publish([budget()]);

  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.limits));
  assert.ok(Object.isFrozen(result.limits[0]));
  assert.ok(Object.isFrozen(result.entries));
  assert.ok(Object.isFrozen(result.entries[0]));
});

test('a hard block may not carry a grace, because a hard block with grace is a soft warning', () => {
  assert.throws(
    () => accept([budget({ thresholds: { graceBasisPoints: 500 } })]),
    /thresholds/,
  );
});

test('a soft warning must state its grace', () => {
  assert.throws(() => accept([budget({ action: 'SOFT_WARNING', thresholds: {} })]), /graceBasisPoints/);
});

test('a grace is bounded at one further limit', () => {
  accept([budget({ action: 'SOFT_WARNING', thresholds: { graceBasisPoints: 10_000 } })]);
  assert.throws(
    () => accept([budget({ action: 'SOFT_WARNING', thresholds: { graceBasisPoints: 10_001 } })]),
    /graceBasisPoints/,
  );
  assert.throws(
    () => accept([budget({ action: 'SOFT_WARNING', thresholds: { graceBasisPoints: 0 } })]),
    /graceBasisPoints/,
  );
});

test('a throttle must declare between one and four ascending, uniquely coded tiers', () => {
  assert.throws(() => accept([budget({ action: 'THROTTLE', thresholds: { tiers: [] } })]), /tiers/);

  const five = Array.from({ length: 5 }, (_, index) => ({
    atBasisPoints: 1_000 * (index + 1),
    tierCode: `tier-${index}`,
  }));
  assert.throws(() => accept([budget({ action: 'THROTTLE', thresholds: { tiers: five } })]), /tiers/);

  assert.throws(
    () =>
      accept([
        budget({
          action: 'THROTTLE',
          thresholds: {
            tiers: [
              { atBasisPoints: 9_000, tierCode: 'tier-a' },
              { atBasisPoints: 7_000, tierCode: 'tier-b' },
            ],
          },
        }),
      ]),
    /ascending/,
  );

  assert.throws(
    () =>
      accept([
        budget({
          action: 'THROTTLE',
          thresholds: {
            tiers: [
              { atBasisPoints: 7_000, tierCode: 'tier-a' },
              { atBasisPoints: 9_000, tierCode: 'tier-a' },
            ],
          },
        }),
      ]),
    /tierCode/,
  );
});

test('an approaching signal must leave room before the limit', () => {
  accept([budget({ thresholds: { warnAtBasisPoints: 9_999 } })]);
  assert.throws(
    () => accept([budget({ thresholds: { warnAtBasisPoints: 10_000 } })]),
    /warnAtBasisPoints/,
  );
});

test('budgets are sorted and unique by identifier, and a degraded snapshot carries none', () => {
  assert.throws(
    () => accept([
      budget({ budgetId: 'zeta' }),
      budget({ budgetId: 'alpha', scope: 'team' }),
    ]),
    /sorted/,
  );
  assert.throws(() => accept([budget(), budget()]), /duplicate/i);
  assert.throws(
    () => assertBudgetSnapshotV1(snapshot([budget()], { status: 'stale', reason: 'behind' }), {
      evaluationTime,
      principalTenantId: tenantId,
    }),
    /cannot carry/,
  );
});

test('a snapshot for another tenant is refused', () => {
  assert.throws(
    () => assertBudgetSnapshotV1(snapshot([budget()], { tenantId: 'other' }), {
      evaluationTime,
      principalTenantId: tenantId,
    }),
    /tenant/i,
  );
});

test('unknown fields are refused on the snapshot and on a budget', () => {
  assert.throws(() => accept([budget({ deploymentName: 'x' })]), /not allowed/);
  assert.throws(
    () => assertBudgetSnapshotV1(snapshot([budget()], { backendUrl: 'x' }), {
      evaluationTime,
      principalTenantId: tenantId,
    }),
    /not allowed/,
  );
});

test('a budget the quota derivation would refuse cannot be published in the first place', () => {
  // The snapshot validator used to check the keys a budget carries and never the limit
  // inside it, so a unit the derivation refuses could be stored, and the refusal then
  // arrived as a thrown error from the publisher rather than as an unenforceable entry.
  assert.throws(
    () => accept([budget({ limit: { unit: 'minor', currency: 'USD', amount: 1_000 } })]),
    /unit must be tokens/,
  );
  assert.throws(
    () => accept([budget({ limit: { unit: 'tokens', currency: 'USD', amount: 1_000 } })]),
    /currency must be null/,
  );
  assert.throws(
    () => accept([budget({ limit: { unit: 'tokens', currency: null, amount: -1 } })]),
    /positive integer/,
  );
  assert.throws(
    () => accept([budget({ limit: { unit: 'tokens', currency: null, amount: 0 } })]),
    /positive/,
  );
  assert.throws(() => accept([budget({ modelScope: 'per-model' })]), /modelKey is required/);
  assert.throws(
    () => accept([budget({ modelKey: 'coding-fast' })]),
    /allowed only for a per-model budget/,
  );
  assert.throws(
    () => accept([budget({ scope: 'subject', modelScope: 'per-model', modelKey: 'coding-fast' })]),
    /subject\/application per-model budgets are not supported/,
  );
  assert.throws(
    () => accept([budget({ scope: 'application', modelScope: 'per-model', modelKey: 'coding-fast' })]),
    /subject\/application per-model budgets are not supported/,
  );
  assert.throws(() => accept([budget({ accountingBasis: 'reported-output-tokens' })]), /accountingBasis/);
  assert.throws(() => accept([budget({ accountingBasis: undefined })]), /accountingBasis/);

  // Every rejected shape above reaches the same rule the derivation applies, so the two
  // cannot answer differently: what publishes is what binds.
  for (const invalid of [
    { limit: { unit: 'minor', currency: 'USD', amount: 1_000 } },
    { modelScope: 'per-model' },
  ]) {
    assert.throws(
      () => deriveTokenQuota({
        budget: budget(invalid),
        allowedModels: ['coding-fast'],
        evaluationTime,
      }),
      TypeError,
    );
  }
});

test('the current budget snapshot schema and runtime both require accountingBasis', async () => {
  const schema = JSON.parse(
    await readFile(
      new URL('../../app/governance-domain/contracts/v1/budget-snapshot.schema.json', import.meta.url),
      'utf8',
    ),
  );

  assert.ok(schema.$defs.budget.required.includes('accountingBasis'));
  assert.equal(schema.$defs.limit.properties.amount.minimum, 1);
  assert.equal(Object.hasOwn(schema.properties, 'allOf'), false);
  assert.equal(schema.properties.budgets.items.$ref, '#/$defs/budget');
  assert.equal(Object.hasOwn(schema.$defs, 'legacyBudget'), false);
  assert.ok(
    schema.$defs.budget.allOf.some((rule) =>
      rule.then?.required?.includes('modelKey') &&
      rule.else?.not?.required?.includes('modelKey'),
    ),
  );
  assert.throws(
    () => accept([{ ...budget(), accountingBasis: undefined }]),
    /accountingBasis/,
  );
});
