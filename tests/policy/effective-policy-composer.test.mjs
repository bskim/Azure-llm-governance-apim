import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { composeEffectivePolicyDocument } from '../../app/governance-domain/policy/effective-policy-composer.mjs';
import { assertEffectivePolicyDocument } from '../../app/governance-domain/policy/effective-policy-validator.mjs';

const IDENTIFIERS = Object.freeze({
  derivationVersion: 1,
  subjectKey: 'sk1-0123456789abcdefghijklmnop',
  applicationKey: 'ak1-0123456789abcdefghijklmnop',
  principalKey: 'pk1-0123456789abcdefghijklmnop',
  teamKey: 'platform-engineering',
  scopeGroupId: 'platform-engineering',
});

const RESOLVED_AT = '2026-07-24T10:00:00.000Z';
const EXPIRES_AT = '2026-07-24T10:01:00.000Z';

function binding(overrides) {
  return {
    bindingId: 'binding-1',
    bindingVersion: 1,
    target: { kind: 'global', key: null },
    modelAllowlist: ['coding-fast', 'coding-primary'],
    limits: { tokenQuota: 40_000_000, quotaPeriod: 'Monthly' },
    ...overrides,
  };
}

function scenario({ bindings, ...rest } = {}) {
  const resolved = bindings ?? [binding()];
  const modelKeys = ['coding-fast', 'coding-primary'];
  return {
    authorization: {
      decision: 'allow',
      modelAllowlist: modelKeys,
      appliedBindings: resolved.map((item) => ({
        bindingId: item.bindingId,
        bindingVersion: item.bindingVersion,
        targetKind: item.target.kind,
        targetKey: item.target.key,
      })),
    },
    entitlementSnapshot: { bindings: resolved },
    modelRegistrySnapshot: {
      models: modelKeys.map((modelKey) => ({
        modelKey,
        providerDeploymentName: `deployment-${modelKey}`,
      })),
    },
    identifiers: IDENTIFIERS,
    configVersion: 1,
    resolvedAt: RESOLVED_AT,
    expiresAt: EXPIRES_AT,
    ...rest,
  };
}

test('binding target kinds project onto the governed counter scopes', () => {
  const document = composeEffectivePolicyDocument(
    scenario({
      bindings: [
        binding(),
        binding({
          bindingId: 'binding-team',
          target: { kind: 'team', key: 'platform-engineering' },
          limits: { tokenQuota: 12_000_000, quotaPeriod: 'Monthly' },
        }),
        binding({
          bindingId: 'binding-subject',
          target: { kind: 'subject', key: 'user-1' },
          limits: { tokenQuota: 6_000_000, quotaPeriod: 'Monthly', tokensPerMinute: 120_000 },
        }),
        binding({
          bindingId: 'binding-application',
          target: { kind: 'application', key: 'app-1' },
          limits: { tokenQuota: 3_000_000, quotaPeriod: 'Monthly' },
        }),
      ],
    }),
  );

  assert.deepEqual(
    document.limits.map((limit) => limit.scope),
    ['organization', 'team', 'subject', 'application'],
  );
  assert.equal(document.resolution, 'resolved');
  assert.deepEqual(document.modelDeployments, [
    { modelKey: 'coding-fast', providerDeploymentName: 'deployment-coding-fast' },
    { modelKey: 'coding-primary', providerDeploymentName: 'deployment-coding-primary' },
  ]);
  assert.equal(document.limits.find((limit) => limit.scope === 'subject').tokensPerMinute, 120_000);
});

test('resolved model deployment mappings cover allowed aliases exactly once and in order', () => {
  const document = structuredClone(composeEffectivePolicyDocument(scenario()));
  const invalid = [
    (value) => { delete value.modelDeployments; },
    (value) => { value.modelDeployments.pop(); },
    (value) => { value.modelDeployments.push({ ...value.modelDeployments[0] }); },
    (value) => { value.modelDeployments[0].modelKey = 'not-allowed'; },
    (value) => { value.modelDeployments.reverse(); },
    (value) => { value.modelDeployments[0].providerDeploymentName = ''; },
    (value) => { value.modelDeployments[0].unexpected = true; },
  ];
  for (const mutate of invalid) {
    const candidate = structuredClone(document);
    mutate(candidate);
    assert.throws(() => assertEffectivePolicyDocument(candidate));
  }
});

test('all-model effective limits and throttle tiers cannot carry a model key', () => {
  const document = structuredClone(composeEffectivePolicyDocument(scenario()));
  document.limits[0].modelKey = 'coding-primary';
  assert.throws(() => assertEffectivePolicyDocument(document), /modelKey/);

  const throttled = structuredClone(composeEffectivePolicyDocument(
    scenario({
      throttleTiers: [{
        scope: 'organization',
        modelScope: 'all-models',
        budgetId: 'budget-organization',
        budgetVersion: 1,
        action: 'THROTTLE',
        quotaPeriod: 'Monthly',
        accountingBasis: 'apim-estimated-total-tokens',
        againstTokenQuota: 1000,
        atBasisPoints: 5000,
        tierCode: 'tier-reduced',
      }],
    }),
  ));
  throttled.throttleTiers[0].modelKey = 'coding-primary';
  assert.throws(() => assertEffectivePolicyDocument(throttled), /modelKey/);
});

test('effective-policy schema encodes model-key scope conditionals at each nested schema level', () => {
  const schema = JSON.parse(readFileSync(
    new URL('../../app/governance-domain/contracts/v1/effective-policy-document.schema.json', import.meta.url),
    'utf8',
  ));
  const requiresPerModelKey = (condition) =>
    condition.if?.properties?.modelScope?.const === 'per-model' &&
    condition.then?.required?.includes('modelKey') &&
    condition.else?.not?.required?.includes('modelKey');

  assert.ok(schema.$defs.limit.allOf.some(requiresPerModelKey));
  assert.ok(schema.properties.throttleTiers.items.allOf.some(requiresPerModelKey));
});

test('the most restrictive quota wins when one scope is capped twice', () => {
  const document = composeEffectivePolicyDocument(
    scenario({
      bindings: [
        binding(),
        binding({
          bindingId: 'team-a',
          target: { kind: 'team', key: 'a' },
          limits: { tokenQuota: 12_000_000, quotaPeriod: 'Monthly' },
        }),
        binding({
          bindingId: 'team-b',
          target: { kind: 'team', key: 'b' },
          limits: { tokenQuota: 4_000_000, quotaPeriod: 'Monthly' },
        }),
      ],
    }),
  );

  const team = document.limits.find((limit) => limit.scope === 'team');
  assert.equal(team.tokenQuota, 4_000_000);
});

test('each counter is capped by the tightest binding for that counter, not by whoever won the quota', () => {
  // A caller in two groups is capped by both. If one group caps the monthly quota
  // and the other caps the per-minute rate, taking the whole limit set from a single
  // winning binding silently discards the other group's cap.
  const document = composeEffectivePolicyDocument(
    scenario({
      bindings: [
        binding(),
        binding({
          bindingId: 'team-tight-quota',
          target: { kind: 'team', key: 'a' },
          limits: { tokenQuota: 4_000_000, quotaPeriod: 'Monthly', tokensPerMinute: 80_000, requestsPerMinute: 120 },
        }),
        binding({
          bindingId: 'team-tight-rate',
          target: { kind: 'team', key: 'b' },
          limits: { tokenQuota: 100_000_000, quotaPeriod: 'Monthly', tokensPerMinute: 10_000, requestsPerMinute: 15 },
        }),
      ],
    }),
  );

  const team = document.limits.find((limit) => limit.scope === 'team');
  assert.equal(team.tokenQuota, 4_000_000);
  assert.equal(team.tokensPerMinute, 10_000);
  assert.equal(team.requestsPerMinute, 15);
});

test('per-model pressure is carried only for models this caller may reach', () => {
  // The document is addressed to one caller. Another team's burn rate is not theirs to
  // read, and a model they cannot use tells them nothing they could act on.
  const document = composeEffectivePolicyDocument(
    scenario({
      modelPressure: [
        { model: 'coding-primary', consumedBasisPoints: 8200 },
        { model: 'not-entitled', consumedBasisPoints: 9900 },
      ],
    }),
  );

  assert.deepEqual(document.modelPressure, [{ model: 'coding-primary', consumedBasisPoints: 8200 }]);
});

test('budget identity and accounting basis survive composition into an enforceable limit and throttle tier', () => {
  const document = composeEffectivePolicyDocument(
    scenario({
      budgetLimits: [{
        scope: 'organization',
        modelScope: 'per-model',
        modelKey: 'coding-primary',
        tokenQuota: 1_000_000,
        quotaPeriod: 'Monthly',
        budgetId: 'budget-primary',
        budgetVersion: 3,
        budgetAction: 'HARD_BLOCK',
        accountingBasis: 'apim-estimated-total-tokens',
        budgetThresholds: {},
      }],
      throttleTiers: [{
        scope: 'team',
        modelScope: 'all-models',
        budgetId: 'budget-team-pressure',
        budgetVersion: 2,
        action: 'THROTTLE',
        quotaPeriod: 'Weekly',
        accountingBasis: 'apim-estimated-total-tokens',
        againstTokenQuota: 900_000,
        atBasisPoints: 7_000,
        tierCode: 'tier-reduced',
      }],
    }),
  );

  assert.deepEqual(
    document.limits.find((limit) => limit.budgetId === 'budget-primary'),
    {
      scope: 'organization',
      modelScope: 'per-model',
      modelKey: 'coding-primary',
      tokenQuota: 1_000_000,
      quotaPeriod: 'Monthly',
      budgetId: 'budget-primary',
      budgetVersion: 3,
      budgetAction: 'HARD_BLOCK',
      accountingBasis: 'apim-estimated-total-tokens',
      budgetThresholds: {},
    },
  );
  assert.deepEqual(document.throttleTiers, [{
    scope: 'team',
    modelScope: 'all-models',
    budgetId: 'budget-team-pressure',
    budgetVersion: 2,
    action: 'THROTTLE',
    quotaPeriod: 'Weekly',
    accountingBasis: 'apim-estimated-total-tokens',
    againstTokenQuota: 900_000,
    atBasisPoints: 7_000,
    tierCode: 'tier-reduced',
  }]);
});

test('composition carries same-coverage throttle and hard-block budgets without suppressing either control', () => {
  const document = composeEffectivePolicyDocument(
    scenario({
      budgetLimits: [{
        scope: 'organization',
        modelScope: 'all-models',
        tokenQuota: 1_000_000,
        quotaPeriod: 'Monthly',
        budgetId: 'budget-organization-cap',
        budgetVersion: 1,
        budgetAction: 'HARD_BLOCK',
        accountingBasis: 'apim-estimated-total-tokens',
        budgetThresholds: {},
      }],
      throttleTiers: [{
        scope: 'organization',
        modelScope: 'all-models',
        budgetId: 'budget-organization-throttle',
        budgetVersion: 1,
        action: 'THROTTLE',
        quotaPeriod: 'Monthly',
        accountingBasis: 'apim-estimated-total-tokens',
        againstTokenQuota: 1_000_000,
        atBasisPoints: 8000,
        tierCode: 'tier-reduced',
      }],
    }),
  );

  assert.equal(document.limits.length, 1, 'the tighter budget cap survives composition');
  assert.equal(document.limits[0].budgetId, 'budget-organization-cap');
  assert.equal(document.throttleTiers[0].budgetId, 'budget-organization-throttle');
});

test('subject and team throttle budgets may reuse their local tier codes', () => {
  const document = composeEffectivePolicyDocument(
    scenario({
      bindings: [
        binding(),
        binding({
          bindingId: 'binding-team',
          target: { kind: 'team', key: 'platform-engineering' },
          limits: { tokenQuota: 12_000_000, quotaPeriod: 'Monthly' },
        }),
        binding({
          bindingId: 'binding-subject',
          target: { kind: 'subject', key: 'subject-a' },
          limits: { tokenQuota: 6_000_000, quotaPeriod: 'Monthly' },
        }),
      ],
      throttleTiers: [
        {
          scope: 'subject',
          modelScope: 'all-models',
          budgetId: 'budget-subject',
          budgetVersion: 1,
          action: 'THROTTLE',
          quotaPeriod: 'Monthly',
          accountingBasis: 'apim-estimated-total-tokens',
          againstTokenQuota: 600_000,
          atBasisPoints: 7_000,
          tierCode: 'tier-reduced',
        },
        {
          scope: 'team',
          modelScope: 'all-models',
          budgetId: 'budget-team',
          budgetVersion: 1,
          action: 'THROTTLE',
          quotaPeriod: 'Monthly',
          accountingBasis: 'apim-estimated-total-tokens',
          againstTokenQuota: 1_200_000,
          atBasisPoints: 7_000,
          tierCode: 'tier-reduced',
        },
      ],
    }),
  );

  assert.equal(document.throttleTiers.length, 2);
});

test('a document carries no pressure field when nothing was measured', () => {
  // An empty array would read as "measured, all at zero", which is a different claim.
  const document = composeEffectivePolicyDocument(scenario());
  assert.equal(Object.hasOwn(document, 'modelPressure'), false);
});

test('restrictiveness compares quotas that accrue over different periods', () => {
  // 100k daily is roughly 3m monthly, so it binds tighter than a 12m monthly cap
  // even though its own number is far smaller.
  const document = composeEffectivePolicyDocument(
    scenario({
      bindings: [
        binding(),
        binding({
          bindingId: 'team-monthly',
          target: { kind: 'team', key: 'a' },
          limits: { tokenQuota: 12_000_000, quotaPeriod: 'Monthly' },
        }),
        binding({
          bindingId: 'team-daily',
          target: { kind: 'team', key: 'b' },
          limits: { tokenQuota: 100_000, quotaPeriod: 'Daily' },
        }),
      ],
    }),
  );

  const team = document.limits.find((limit) => limit.scope === 'team');
  assert.equal(team.tokenQuota, 100_000);
  assert.equal(team.quotaPeriod, 'Daily', 'the winning binding keeps its configured period');
});

test('composition refuses to emit a policy with no organization-wide cap', () => {
  assert.throws(
    () =>
      composeEffectivePolicyDocument(
        scenario({
          bindings: [
            binding({
              bindingId: 'team-only',
              target: { kind: 'team', key: 'a' },
              limits: { tokenQuota: 1_000, quotaPeriod: 'Monthly' },
            }),
          ],
        }),
      ),
    /uncapped/,
  );
});

test('a binding without a quota still contributes its rate counters', () => {
  const document = composeEffectivePolicyDocument(
    scenario({
      bindings: [
        binding(),
        binding({
          bindingId: 'rate-only',
          target: { kind: 'team', key: 'a' },
          limits: { requestsPerMinute: 40, tokensPerMinute: 40_000 },
        }),
      ],
    }),
  );

  assert.deepEqual(document.limits.map((limit) => limit.scope), ['organization', 'team']);
  const team = document.limits.find((limit) => limit.scope === 'team');
  assert.equal(team.requestsPerMinute, 40);
  assert.equal(team.tokensPerMinute, 40_000);
  assert.equal(Object.hasOwn(team, 'tokenQuota'), false);
});

test('a fallback hop leaving the allowlist is refused rather than quietly dropped', () => {
  // The chain arrives compiled, so a hop outside the allowlist is a compiler defect.
  // Repairing it here would hide the defect and would make the same authored plan
  // valid or invalid depending on which caller composed it.
  assert.throws(
    () =>
      composeEffectivePolicyDocument(
        scenario({
          warnThresholdPercent: 80,
          fallback: {
            enabled: true,
            maxDepth: 1,
            chain: [
              { from: 'coding-primary', to: 'coding-fast' },
              { from: 'coding-fast', to: 'coding-unlisted' },
            ],
          },
        }),
      ),
    /leaves the caller's allowed models/,
  );
});

test('a compiled chain inside the allowlist is preserved exactly', () => {
  const document = composeEffectivePolicyDocument(
    scenario({
      warnThresholdPercent: 80,
      fallback: {
        enabled: true,
        maxDepth: 1,
        chain: [{ from: 'coding-primary', to: 'coding-fast' }],
      },
    }),
  );

  assert.deepEqual(document.fallback.chain, [{ from: 'coding-primary', to: 'coding-fast' }]);
});

test('an enabled fallback chain without a warning threshold is refused', () => {
  assert.throws(
    () =>
      composeEffectivePolicyDocument(
        scenario({
          fallback: {
            enabled: true,
            maxDepth: 1,
            chain: [{ from: 'coding-primary', to: 'coding-fast' }],
          },
        }),
      ),
    /warnThresholdPercent is required/,
  );
});

test('fallback is disabled when the compiler found no permitted target', () => {
  const document = composeEffectivePolicyDocument(
    scenario({
      fallback: {
        enabled: true,
        maxDepth: 1,
        chain: [],
      },
    }),
  );

  assert.equal(document.fallback.enabled, false);
  assert.deepEqual(document.fallback.chain, []);
});

test('a decision that is not an allow cannot be composed into a resolved policy', () => {
  for (const decision of ['deny', 'unavailable']) {
    assert.throws(
      () => composeEffectivePolicyDocument(scenario({ authorization: { decision } })),
      /Cannot compose a resolved policy/,
    );
  }
});

test('a binding that changed version between decision and composition is refused', () => {
  const context = scenario();
  context.entitlementSnapshot.bindings[0].bindingVersion = 2;
  assert.throws(() => composeEffectivePolicyDocument(context), /changed version/);
});

test('the document identifier is derived rather than supplied', () => {
  const document = composeEffectivePolicyDocument(scenario());
  assert.equal(
    document.id,
    `effective-policy|${IDENTIFIERS.scopeGroupId}|${IDENTIFIERS.principalKey}`,
  );
});

test('composition refuses identifiers whose partition disagrees with the team', () => {
  assert.throws(
    () =>
      composeEffectivePolicyDocument(
        scenario({ identifiers: { ...IDENTIFIERS, scopeGroupId: 'another-team' } }),
      ),
    /team-attributed policy must use that team/,
  );
});

test('multiple team limits fold conservatively into a teamless subject counter', () => {
  const context = scenario({
    identifiers: { ...IDENTIFIERS, teamKey: null, scopeGroupId: 'organization' },
  });
  context.entitlementSnapshot.bindings.push({
    ...structuredClone(context.entitlementSnapshot.bindings[1]),
    bindingId: 'binding-team-second-001',
    target: { kind: 'team', key: 'second-team' },
    limits: {
      requestsPerMinute: 7,
      tokensPerMinute: 7000,
      tokenQuota: 700000,
      quotaPeriod: 'Monthly',
    },
  });
  context.authorization.appliedBindings.push({
    bindingId: 'binding-team-second-001',
    bindingVersion: context.entitlementSnapshot.bindings.at(-1).bindingVersion,
    targetKind: 'team',
    targetKey: 'second-team',
  });

  const document = composeEffectivePolicyDocument(context);
  assert.equal(document.limits.some((limit) => limit.scope === 'team'), false);
  const subject = document.limits.find((limit) => limit.scope === 'subject');
  assert.equal(subject.requestsPerMinute, 7);
  assert.equal(subject.tokensPerMinute, 7000);
  assert.equal(subject.tokenQuota, 700000);
});

test('rate-only team limits survive a multi-team fold without inventing a quota', () => {
  const context = scenario({
    bindings: [
      binding(),
      binding({
        bindingId: 'binding-team-first-001',
        target: { kind: 'team', key: 'first-team' },
        limits: { requestsPerMinute: 11, tokensPerMinute: 11000 },
      }),
      binding({
        bindingId: 'binding-team-second-001',
        target: { kind: 'team', key: 'second-team' },
        limits: { requestsPerMinute: 9, tokensPerMinute: 9000 },
      }),
    ],
    identifiers: { ...IDENTIFIERS, teamKey: null, scopeGroupId: 'organization' },
  });

  const document = composeEffectivePolicyDocument(context);
  const subject = document.limits.find((limit) => limit.scope === 'subject');
  assert.equal(subject.requestsPerMinute, 9);
  assert.equal(subject.tokensPerMinute, 9000);
  assert.equal(Object.hasOwn(subject, 'tokenQuota'), false);
  assert.equal(Object.hasOwn(subject, 'quotaPeriod'), false);
});

test('a notice cannot be promised to a caller whose model will never be substituted', () => {
  assert.throws(
    () =>
      composeEffectivePolicyDocument(
        scenario({ modelSelectionIntent: 'pinned', substitutionNotice: 'inline' }),
      ),
    /requires an accepted substitute/,
  );

  const announced = composeEffectivePolicyDocument(
    scenario({ modelSelectionIntent: 'preferred', substitutionNotice: 'inline' }),
  );
  assert.equal(announced.substitutionNotice, 'inline');

  // The default is the channel every response can carry, so it is not restated.
  const quiet = composeEffectivePolicyDocument(scenario({ modelSelectionIntent: 'preferred' }));
  assert.equal(Object.hasOwn(quiet, 'substitutionNotice'), false);
});
