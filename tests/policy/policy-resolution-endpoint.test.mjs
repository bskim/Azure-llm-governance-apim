import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPolicyResolver,
  UNRESOLVABLE_REASONS,
} from '../../app/control-api/policy-resolution-endpoint.mjs';
import {
  ADMISSION_REFUSED_REASONS,
  isAdmissionRefusedReason,
  rosterRefusalReason,
} from '../../app/governance-domain/authorization/governance-authorization-evaluator.mjs';
import { createPrincipalKeyDeriver } from '../../app/governance-domain/identity/principal-key-derivation.mjs';
import { createPrincipalContextFactory } from '../../app/governance-domain/principal-context/principal-context-factory.mjs';
import { createDeterministicMembershipResolver } from '../../app/local-adapters/deterministic-membership-resolver.mjs';
import { createFixedClock, createSequenceIdGenerator } from '../../app/local-adapters/deterministic-time.mjs';
import { getDeterministicGovernanceSnapshots } from '../../app/local-adapters/deterministic-governance-snapshots.mjs';

const EVALUATION_TIME = '2026-07-24T10:00:00.000Z';
const TENANT_ID = 'tenant-local-demo';
const SECRET = 'a-local-test-secret-of-sufficient-length';

const CONFIG = Object.freeze({
  cacheTtlSeconds: 60,
  warnThresholdPercent: 80,
});

function identityFor(subjectId) {
  return {
    source: 'local-deterministic',
    validationId: `validation-${subjectId}`,
    validatedAt: '2026-07-24T09:55:00.000Z',
    credentialExpiresAt: '2026-07-24T11:00:00.000Z',
    validationState: 'local-trusted',
    subject: { tenantId: TENANT_ID, subjectId, principalType: 'user' },
    application: { applicationId: 'app-local-console', authenticationFlow: 'delegated' },
  };
}

function membershipsFor(subjectId, groupIds, status = 'complete') {
  return {
    snapshotId: `snapshot-${subjectId}`,
    status,
    source: 'local-fixture',
    tenantId: TENANT_ID,
    subjectId,
    resolvedAt: '2026-07-24T09:55:00.000Z',
    expiresAt: '2026-07-24T10:30:00.000Z',
    maxAgeSeconds: 2_100,
    sourceRevision: `revision-${subjectId}-001`,
    groups: groupIds.map((groupId) => ({
      groupId,
      membership: 'direct',
      authorizationRelevant: true,
    })),
    ...(status === 'complete' ? {} : { reason: `local-${status}-membership` }),
  };
}

function createResolver({
  subjectId,
  groupIds,
  status = 'complete',
  config = CONFIG,
  snapshotProvider = () => getDeterministicGovernanceSnapshots(),
} = {}) {
  const identity = identityFor(subjectId);
  const membershipResolver = createDeterministicMembershipResolver([
    { tenantId: TENANT_ID, subjectId, memberships: membershipsFor(subjectId, groupIds, status) },
  ]);
  return createPolicyResolver({
    deriver: createPrincipalKeyDeriver({ secret: SECRET, version: 1 }),
    scopeGroupId: 'organization',
    snapshotProvider,
    principalContextFactory: createPrincipalContextFactory({
      membershipResolver,
      clock: createFixedClock(EVALUATION_TIME),
      idGenerator: createSequenceIdGenerator(`resolver-${subjectId}`),
    }),
    identityResolver: () => identity,
    clock: createFixedClock(EVALUATION_TIME),
    config,
  });
}

/** Widens the global binding so the caller is entitled to the cheaper alternative too. */
function snapshotsAllowingBothModels() {
  const snapshots = getDeterministicGovernanceSnapshots();
  const entitlementSnapshot = structuredClone(snapshots.entitlementSnapshot);
  for (const binding of entitlementSnapshot.bindings) {
    if (binding.target.kind === 'global') binding.modelAllowlist = ['coding-fast', 'coding-primary'];
  }
  return { ...snapshots, entitlementSnapshot };
}

test('an entitled caller resolves with a compiled single-hop fallback', async () => {
  const resolver = createResolver({
    subjectId: 'user-local-admin',
    groupIds: ['group-governance-admin'],
    snapshotProvider: snapshotsAllowingBothModels,
  });
  const { document } = await resolver.resolve({ apiFamily: 'openai-responses' });

  assert.equal(document.fallback.enabled, true);
  assert.equal(document.fallback.maxDepth, 1);
  assert.deepEqual(document.fallback.chain, [{ from: 'coding-primary', to: 'coding-fast' }]);
  assert.equal(document.modelSelectionIntent, 'preferred');
});

test('a gateway that states no wire contract is given no chain to substitute from', async () => {
  // The chain is compiled against the contract in use. Without one, a substitute
  // would be chosen without knowing whether it answers the route being served.
  const resolver = createResolver({
    subjectId: 'user-local-admin',
    groupIds: ['group-governance-admin'],
    snapshotProvider: snapshotsAllowingBothModels,
  });

  for (const stated of [{}, { apiFamily: 'openai-embeddings' }]) {
    const { document } = await resolver.resolve(stated);
    assert.equal(document.fallback.enabled, false);
    assert.deepEqual(document.fallback.chain, []);
  }
});

test('a plan that has not opted its callers in resolves pinned, chain or no chain', async () => {
  const resolver = createResolver({
    subjectId: 'user-local-admin',
    groupIds: ['group-governance-admin'],
    snapshotProvider: () => {
      const snapshots = snapshotsAllowingBothModels();
      const plans = snapshots.fallbackPolicySnapshot.plans.map((plan) => {
        const { modelSelectionIntent, ...rest } = plan;
        return rest;
      });
      return {
        ...snapshots,
        fallbackPolicySnapshot: { ...snapshots.fallbackPolicySnapshot, plans },
      };
    },
  });
  const { document } = await resolver.resolve({ apiFamily: 'openai-responses' });

  // The compiled hop is still published, so an administrator can see what would happen.
  // What is absent is the caller's consent to it, and the gateway reads that field.
  assert.deepEqual(document.fallback.chain, [{ from: 'coding-primary', to: 'coding-fast' }]);
  assert.equal(Object.hasOwn(document, 'modelSelectionIntent'), false);
});

test('an unresolvable caller is told nothing about substitution, because nothing was read', async () => {
  // The property this has always protected is that an outcome which is not a resolution
  // never implies the caller opted into being served another model. Carrying no document
  // at all is the same property, stated in the only way that cannot be misread.
  const resolver = createResolver({
    subjectId: 'user-local-admin',
    groupIds: ['group-governance-admin'],
    status: 'ambiguous',
  });
  const { status, document } = await resolver.resolve({ apiFamily: 'openai-responses' });

  assert.equal(status, 503);
  assert.equal(document, null);
});

test('an inline notice reaches the gateway only when the plan asked for one', async () => {
  const withNotice = createResolver({
    subjectId: 'user-local-admin',
    groupIds: ['group-governance-admin'],
    snapshotProvider: () => {
      const snapshots = snapshotsAllowingBothModels();
      const plans = snapshots.fallbackPolicySnapshot.plans.map((plan) => ({
        ...plan,
        substitutionNotice: 'inline',
      }));
      return {
        ...snapshots,
        fallbackPolicySnapshot: { ...snapshots.fallbackPolicySnapshot, plans },
      };
    },
  });
  const noticed = await withNotice.resolve({ apiFamily: 'openai-responses' });

  assert.equal(noticed.document.substitutionNotice, 'inline');

  const plain = createResolver({
    subjectId: 'user-local-admin',
    groupIds: ['group-governance-admin'],
    snapshotProvider: snapshotsAllowingBothModels,
  });
  const { document } = await plain.resolve({ apiFamily: 'openai-responses' });

  assert.equal(Object.hasOwn(document, 'substitutionNotice'), false);
});

test('a caller not entitled to the cheaper alternative resolves with fallback disabled', async () => {
  // The plan still applies, but its only hop targets a model this caller may not use,
  // so the compiler removes it rather than the composer quietly repairing the chain.
  const resolver = createResolver({
    subjectId: 'user-local-admin',
    groupIds: ['group-governance-admin'],
  });
  const { document } = await resolver.resolve({ apiFamily: 'openai-responses' });

  assert.deepEqual(document.allowedModels, ['coding-primary']);
  assert.deepEqual(document.modelDeployments, [
    { modelKey: 'coding-primary', providerDeploymentName: 'deploy-coding-primary' },
  ]);
  assert.equal(document.fallback.enabled, false);
  assert.deepEqual(document.fallback.chain, []);
});

test('absent catalogue evidence refuses when a logical model cannot be mapped to a provider deployment', async () => {
  const resolver = createResolver({
    subjectId: 'user-local-admin',
    groupIds: ['group-governance-admin'],
    snapshotProvider: () => {
      const { modelRegistrySnapshot, ...rest } = snapshotsAllowingBothModels();
      return rest;
    },
  });
  const { status, reasonCode, document } = await resolver.resolve({ apiFamily: 'openai-responses' });

  assert.equal(status, 503);
  assert.equal(reasonCode, 'composition-failed');
  assert.equal(document, null);
});

test('a degraded empty catalogue refuses rather than guessing that an alias is a deployment name', async () => {
  const resolver = createResolver({
    subjectId: 'user-local-admin',
    groupIds: ['group-governance-admin'],
    snapshotProvider: () => {
      const snapshots = snapshotsAllowingBothModels();
      return {
        ...snapshots,
        modelRegistrySnapshot: {
          ...snapshots.modelRegistrySnapshot,
          status: 'stale',
          reason: 'catalogue publisher behind',
          models: [],
          applications: [],
        },
      };
    },
  });
  const { reasonCode, document } = await resolver.resolve({ apiFamily: 'openai-responses' });

  assert.equal(reasonCode, 'composition-failed');
  assert.equal(document, null);
});

test('a budget tighter than the entitlement replaces the entitlement quota', async () => {
  const resolver = createResolver({
    subjectId: 'user-local-admin',
    groupIds: ['group-governance-admin'],
  });
  const { document } = await resolver.resolve({ apiFamily: 'openai-responses' });
  const organization = document.limits.find((limit) => limit.scope === 'organization');

  // A 20,000,000 token budget with a tenth of a limit as grace enforces 22,000,000,
  // which is tighter than the 40,000,000 the entitlement alone would have allowed.
  assert.equal(organization.tokenQuota, 22_000_000);
  // The budget's own warning falls at 90 percent of the enforced quota, but the
  // deployment already asks for one at 80, and the earlier warning is the safer one.
  assert.equal(document.warnThresholdPercent, 80);
});

test('a budget warning earlier than the deployment default wins', async () => {
  const resolver = createResolver({
    subjectId: 'user-local-admin',
    groupIds: ['group-governance-admin'],
    snapshotProvider: () => {
      const snapshots = getDeterministicGovernanceSnapshots();
      const budgetSnapshot = structuredClone(snapshots.budgetSnapshot);
      budgetSnapshot.budgets[0].thresholds = { graceBasisPoints: 10_000 };
      return { ...snapshots, budgetSnapshot };
    },
  });
  const { document } = await resolver.resolve({ apiFamily: 'openai-responses' });

  // Doubling the quota with grace puts the configured limit at half of it.
  assert.equal(document.warnThresholdPercent, 50);
});

test('absent budget evidence leaves the entitlement quota in place rather than uncapping', async () => {
  const resolver = createResolver({
    subjectId: 'user-local-admin',
    groupIds: ['group-governance-admin'],
    snapshotProvider: () => {
      const { budgetSnapshot, ...rest } = getDeterministicGovernanceSnapshots();
      return rest;
    },
  });
  const { document } = await resolver.resolve({ apiFamily: 'openai-responses' });
  const organization = document.limits.find((limit) => limit.scope === 'organization');

  assert.equal(organization.tokenQuota, 40_000_000);
  assert.equal(document.warnThresholdPercent, CONFIG.warnThresholdPercent);
});

test('a degraded budget snapshot publishes no quota and never reports the budget as met', async () => {
  const resolver = createResolver({
    subjectId: 'user-local-admin',
    groupIds: ['group-governance-admin'],
    snapshotProvider: () => {
      const snapshots = getDeterministicGovernanceSnapshots();
      return {
        ...snapshots,
        budgetSnapshot: {
          ...snapshots.budgetSnapshot,
          status: 'stale',
          reason: 'budget publisher behind',
          budgets: [],
        },
      };
    },
  });
  const { reasonCode, document } = await resolver.resolve({ apiFamily: 'openai-responses' });
  const organization = document.limits.find((limit) => limit.scope === 'organization');

  assert.equal(reasonCode, 'resolved');
  assert.equal(organization.tokenQuota, 40_000_000);
});

test('a throttle budget puts its declared tiers into the resolved document', async () => {
  const resolver = createResolver({
    subjectId: 'user-local-admin',
    groupIds: ['group-governance-admin'],
    snapshotProvider: () => {
      const snapshots = getDeterministicGovernanceSnapshots();
      const budgetSnapshot = structuredClone(snapshots.budgetSnapshot);
      budgetSnapshot.budgets.push({
        budgetId: 'budget-team-throttle',
        budgetVersion: 1,
        scope: 'team',
        action: 'THROTTLE',
        modelScope: 'all-models',
        accountingBasis: 'apim-estimated-total-tokens',
        limit: { unit: 'tokens', currency: null, amount: 30_000_000 },
        period: 'Monthly',
        thresholds: {
          tiers: [
            { atBasisPoints: 7_000, tierCode: 'tier-reduced' },
            { atBasisPoints: 9_000, tierCode: 'tier-minimal' },
          ],
        },
      });
      return { ...snapshots, budgetSnapshot };
    },
  });
  const { document } = await resolver.resolve({ apiFamily: 'openai-responses' });

  assert.deepEqual(document.throttleTiers, [
    {
      scope: 'team',
      modelScope: 'all-models',
      budgetId: 'budget-team-throttle',
      budgetVersion: 1,
      action: 'THROTTLE',
      quotaPeriod: 'Monthly',
      accountingBasis: 'apim-estimated-total-tokens',
      againstTokenQuota: 30_000_000,
      atBasisPoints: 7_000,
      tierCode: 'tier-reduced',
    },
    {
      scope: 'team',
      modelScope: 'all-models',
      budgetId: 'budget-team-throttle',
      budgetVersion: 1,
      action: 'THROTTLE',
      quotaPeriod: 'Monthly',
      accountingBasis: 'apim-estimated-total-tokens',
      againstTokenQuota: 30_000_000,
      atBasisPoints: 9_000,
      tierCode: 'tier-minimal',
    },
  ]);
});

test('an undeployed throttle tier code fails resolution before an ineffective policy is published', async () => {
  const resolver = createResolver({
    subjectId: 'user-local-admin',
    groupIds: ['group-governance-admin'],
    snapshotProvider: () => {
      const snapshots = getDeterministicGovernanceSnapshots();
      const budgetSnapshot = structuredClone(snapshots.budgetSnapshot);
      budgetSnapshot.budgets.push({
        budgetId: 'budget-team-unsupported-throttle',
        budgetVersion: 1,
        scope: 'team',
        action: 'THROTTLE',
        modelScope: 'all-models',
        accountingBasis: 'apim-estimated-total-tokens',
        limit: { unit: 'tokens', currency: null, amount: 30_000_000 },
        period: 'Monthly',
        thresholds: { tiers: [{ atBasisPoints: 7_000, tierCode: 'tier-unhandled' }] },
      });
      return { ...snapshots, budgetSnapshot };
    },
  });

  const result = await resolver.resolve({ apiFamily: 'openai-responses' });
  assert.equal(result.status, 503);
  assert.equal(result.reasonCode, UNRESOLVABLE_REASONS.compositionFailed);
  assert.equal(result.document, null);
});

test('a document without a throttle budget carries no tiers at all', async () => {
  const resolver = createResolver({
    subjectId: 'user-local-admin',
    groupIds: ['group-governance-admin'],
  });
  const { document } = await resolver.resolve({ apiFamily: 'openai-responses' });

  assert.equal(Object.hasOwn(document, 'throttleTiers'), false);
});

test('an entitled caller resolves to a hierarchical policy', async () => {
  const resolver = createResolver({
    subjectId: 'user-local-admin',
    groupIds: ['group-governance-admin'],
  });
  const { status, reasonCode, document } = await resolver.resolve({ apiFamily: 'openai-responses' });

  assert.equal(status, 200);
  assert.equal(reasonCode, 'resolved');
  assert.equal(document.resolution, 'resolved');
  assert.equal(document.scopeGroupId, 'platform-engineering');
  assert.deepEqual(
    document.limits.map((limit) => limit.scope),
    ['organization', 'team', 'subject'],
  );
});

test('the document never carries a raw subject or tenant identifier', async () => {
  const resolver = createResolver({
    subjectId: 'user-local-admin',
    groupIds: ['group-governance-admin'],
  });
  const { document } = await resolver.resolve({ apiFamily: 'openai-responses' });
  const serialized = JSON.stringify(document);

  assert.ok(!serialized.includes('user-local-admin'));
  assert.ok(!serialized.includes(TENANT_ID));
  assert.ok(!serialized.includes('app-local-console'));
  assert.match(document.attribution.subjectKey, /^sk1-/);
  assert.equal(document.attribution.teamKey, 'platform-engineering', 'team stays readable');
});

test('the cached window is bounded by the configured lifetime', async () => {
  const resolver = createResolver({
    subjectId: 'user-local-admin',
    groupIds: ['group-governance-admin'],
  });
  const { document } = await resolver.resolve({ apiFamily: 'openai-responses' });

  assert.equal(
    Date.parse(document.expiresAt) - Date.parse(document.resolvedAt),
    CONFIG.cacheTtlSeconds * 1000,
  );
});

test('an unresolved membership is refused rather than granted a model nobody checked', async () => {
  // It is still not a statement about the caller -- the reason keeps saying the roster
  // could not be read, not that this person was removed -- but it no longer answers with
  // a document, because a conservative document is still a grant.
  const resolver = createResolver({
    subjectId: 'user-local-admin',
    groupIds: ['group-governance-admin'],
    status: 'ambiguous',
  });
  const { status, reasonCode, document } = await resolver.resolve({ apiFamily: 'openai-responses' });

  assert.equal(status, 503);
  assert.equal(reasonCode, UNRESOLVABLE_REASONS.membershipUnresolved);
  assert.equal(document, null);
});

test('a caller mapped to two teams resolves combined grants without invented team attribution', async () => {
  const resolver = createResolver({
    subjectId: 'user-local-admin',
    groupIds: ['group-end-user', 'group-governance-admin'],
  });
  const { status, reasonCode, document } = await resolver.resolve({ apiFamily: 'openai-responses' });

  assert.equal(status, 200);
  assert.equal(reasonCode, 'resolved');
  assert.equal(document.attribution.teamKey, null);
  assert.equal(document.scopeGroupId, 'organization');
  assert.deepEqual(document.allowedModels, ['coding-primary']);
  assert.equal(document.limits.some((limit) => limit.scope === 'team'), false);
  assert.equal(
    document.limits.find((limit) => limit.scope === 'subject')?.tokenQuota,
    6_000_000,
    'the stricter applicable team quota must follow the caller onto the subject counter',
  );
});

test('an unresolvable outcome that is not an overlap carries no diagnostics', async () => {
  const resolver = createResolver({
    subjectId: 'user-local-admin',
    groupIds: ['group-governance-admin'],
    status: 'ambiguous',
  });
  const { reasonCode, diagnostics } = await resolver.resolve({ apiFamily: 'openai-responses' });

  assert.equal(reasonCode, UNRESOLVABLE_REASONS.membershipUnresolved);
  assert.equal(diagnostics, null);
});

test('groups the team catalogue does not name are ignored, not counted as ambiguity', async () => {
  // Belonging to many directory groups is ordinary in any organization large enough to
  // run governance. Only groups the catalogue maps to a team may make a caller ambiguous.
  const resolver = createResolver({
    subjectId: 'user-local-admin',
    groupIds: ['group-all-company', 'group-governance-admin', 'group-payroll', 'group-social'],
  });
  const { status, document } = await resolver.resolve({ apiFamily: 'openai-responses' });

  assert.equal(status, 200);
  assert.equal(document.attribution.teamKey, 'platform-engineering');
});

test('a teamless caller with a direct subject policy resolves without invented team attribution', async () => {
  const resolver = createResolver({
    subjectId: 'user-local-admin',
    groupIds: ['group-unmapped'],
  });
  const { status, reasonCode, document } = await resolver.resolve({ apiFamily: 'openai-responses' });

  assert.equal(status, 200);
  assert.equal(reasonCode, 'resolved');
  assert.equal(document.attribution.teamKey, null);
  assert.equal(document.scopeGroupId, 'organization');
  assert.deepEqual(document.allowedModels, ['coding-primary']);
});

test('a teamless caller without a direct subject policy is refused', async () => {
  const resolver = createResolver({
    subjectId: 'user-local-admin',
    groupIds: ['group-unmapped'],
    snapshotProvider: () => {
      const snapshots = getDeterministicGovernanceSnapshots();
      const entitlementSnapshot = structuredClone(snapshots.entitlementSnapshot);
      entitlementSnapshot.bindings = entitlementSnapshot.bindings.filter(
        (binding) => binding.target.kind !== 'subject' || binding.target.key !== 'user-local-admin',
      );
      return { ...snapshots, entitlementSnapshot };
    },
  });
  const { status, reasonCode, document } = await resolver.resolve({ apiFamily: 'openai-responses' });

  assert.equal(status, 403);
  assert.equal(reasonCode, 'principal-not-entitled');
  assert.equal(document, null);
});

test('an unresolvable outcome is stable, and never becomes a document on a retry', async () => {
  const resolver = createResolver({
    subjectId: 'user-local-admin',
    groupIds: ['group-governance-admin'],
    status: 'ambiguous',
  });
  const first = await resolver.resolve({ apiFamily: 'openai-responses' });
  const second = await resolver.resolve({ apiFamily: 'openai-responses' });

  assert.deepEqual(first, second);
  assert.equal(second.document, null);
});

test('the resolver refuses a configuration that still carries a withdrawn degraded setting', () => {
  // Ignoring one would leave an operator believing a cap applies that nothing reads,
  // which is how the grant these configured survived unnoticed in the first place.
  const withdrawn = {
    degradedLimit: { tokenQuota: 100_000, quotaPeriod: 'Monthly' },
    degradedAllowedModels: ['gpt-5.4-mini'],
    unattributedTeamKey: 'unattributed',
  };
  for (const [key, value] of Object.entries(withdrawn)) {
    assert.throws(
      () =>
        createResolver({
          subjectId: 'user-local-admin',
          groupIds: ['group-governance-admin'],
          config: { ...CONFIG, [key]: value },
        }),
      new RegExp(`config\\.${key} has been withdrawn`),
      key,
    );
    // Stating it as undecided is not a way back in either.
    assert.throws(
      () =>
        createResolver({
          subjectId: 'user-local-admin',
          groupIds: ['group-governance-admin'],
          config: { ...CONFIG, [key]: null },
        }),
      TypeError,
      `${key} as null`,
    );
  }
});

test('the resolver refuses a non-positive cache lifetime', () => {
  assert.throws(
    () =>
      createResolver({
        subjectId: 'user-local-admin',
        groupIds: ['group-governance-admin'],
        config: { ...CONFIG, cacheTtlSeconds: 0 },
      }),
    /cacheTtlSeconds/,
  );
});

test('a principal the roster does not list is refused, and carries no document', async () => {
  // Removing someone from the published set leaves their membership document absent,
  // which the stored resolver reports as unmapped. Before this was a refusal it reached
  // the same degraded grant as an unreadable store, so a removal handed the caller a
  // model instead of taking one away -- and a newly issued token kept working.
  const removed = createResolver({
    subjectId: 'user-local-admin',
    groupIds: ['group-governance-admin'],
    status: 'unmapped',
  });

  const resolved = await removed.resolve({ apiFamily: 'openai-responses' });
  assert.equal(resolved.status, 403);
  assert.equal(resolved.reasonCode, 'membership-evidence-unmapped');
  assert.equal(resolved.document, null);
});

test('a roster nobody could read is refused as unresolvable, not as a removal', async () => {
  // The distinction the two refusals rest on: "read it, not listed" is an answer about
  // the caller and is terminal, "could not read it" is not an answer at all and may
  // succeed on a retry. Both now refuse; what must never collapse is which is which.
  for (const status of ['stale', 'incomplete', 'ambiguous', 'source-unavailable']) {
    const undetermined = createResolver({
      subjectId: 'user-local-admin',
      groupIds: ['group-governance-admin'],
      status,
    });
    const resolved = await undetermined.resolve({ apiFamily: 'openai-responses' });
    assert.equal(resolved.status, 503, status);
    assert.equal(resolved.reasonCode, UNRESOLVABLE_REASONS.membershipUnresolved, status);
    assert.equal(resolved.document, null, status);
  }
});

test('the admission refusal set names only outcomes that were actually determined', () => {
  assert.deepEqual(
    [...ADMISSION_REFUSED_REASONS].sort(),
    ['membership-evidence-unmapped', 'model-intersection-empty', 'principal-not-entitled'],
  );
  assert.equal(isAdmissionRefusedReason('membership-evidence-source-unavailable'), false);
  assert.equal(rosterRefusalReason({ status: 'empty-complete' }), null);
  // An absent argument is not an answer either, so it cannot pass silently.
  assert.throws(() => isAdmissionRefusedReason(undefined), TypeError);
  assert.throws(() => rosterRefusalReason(null), TypeError);
});

/** One scenario per reason, so the sweep below cannot silently miss a path. */
const UNRESOLVABLE_SCENARIOS = Object.freeze({
  [UNRESOLVABLE_REASONS.membershipUnresolved]: {
    subjectId: 'user-local-admin',
    groupIds: ['group-governance-admin'],
    status: 'source-unavailable',
  },
  [UNRESOLVABLE_REASONS.compositionFailed]: {
    subjectId: 'user-local-admin',
    groupIds: ['group-governance-admin'],
    // Admission succeeds and the document then refuses to compose, which is what a
    // configuration fault downstream of entitlement looks like from here.
    config: { ...CONFIG, warnThresholdPercent: 0 },
  },
});

test('every reason that could not establish entitlement answers 503 with no document', async () => {
  // The status matters, but the document is what grants, so it is what is asserted.
  for (const [reason, scenario] of Object.entries(UNRESOLVABLE_SCENARIOS)) {
    const resolved = await createResolver(scenario).resolve({ apiFamily: 'openai-responses' });
    assert.equal(resolved.reasonCode, reason, reason);
    assert.equal(resolved.status, 503, reason);
    assert.equal(resolved.document, null, reason);
  }
});

test('no outcome carries a model allowlist unless it actually resolved one', async () => {
  // A document is the grant, and `allowedModels` is the part of it that names models.
  // Whatever the reason, only a real resolution may carry one.
  const scenarios = [
    ...Object.values(UNRESOLVABLE_SCENARIOS),
    { subjectId: 'user-local-admin', groupIds: ['group-unmapped'] },
    { subjectId: 'user-local-admin', groupIds: ['group-governance-admin'], status: 'unmapped' },
    { subjectId: 'user-local-admin', groupIds: ['group-governance-admin'] },
  ];

  let resolvedCount = 0;
  for (const scenario of scenarios) {
    const { reasonCode, document } = await createResolver(scenario).resolve({ apiFamily: 'openai-responses' });
    if (reasonCode === 'resolved') {
      resolvedCount += 1;
      assert.ok(Array.isArray(document.allowedModels), reasonCode);
      continue;
    }
    assert.equal(document, null, reasonCode);
  }
  // Otherwise the sweep would pass by never resolving anything.
  assert.ok(resolvedCount >= 1);
});

test('a determined denial still refuses, and degraded secondary evidence still resolves', async () => {
  // The three outcomes this change had to leave alone, asserted together so a later
  // widening of the refusal cannot quietly take the other two with it.
  const denied = await createResolver({
    subjectId: 'user-local-admin',
    groupIds: ['group-unmapped'],
    snapshotProvider: () => {
      const snapshots = getDeterministicGovernanceSnapshots();
      const entitlementSnapshot = structuredClone(snapshots.entitlementSnapshot);
      entitlementSnapshot.bindings = entitlementSnapshot.bindings.filter(
        (binding) => binding.target.kind !== 'subject' || binding.target.key !== 'user-local-admin',
      );
      return { ...snapshots, entitlementSnapshot };
    },
  }).resolve({ apiFamily: 'openai-responses' });
  assert.equal(denied.status, 403);
  assert.equal(denied.document, null);

  const catalogueBehind = await createResolver({
    subjectId: 'user-local-admin',
    groupIds: ['group-governance-admin'],
    snapshotProvider: () => {
      const snapshots = getDeterministicGovernanceSnapshots();
      return {
        ...snapshots,
        modelRegistrySnapshot: { ...snapshots.modelRegistrySnapshot, status: 'stale', models: [] },
      };
    },
  }).resolve({ apiFamily: 'openai-responses' });
  assert.equal(catalogueBehind.status, 503);
  assert.equal(catalogueBehind.reasonCode, 'composition-failed');
  assert.equal(catalogueBehind.document, null);

  const budgetBehind = await createResolver({
    subjectId: 'user-local-admin',
    groupIds: ['group-governance-admin'],
    snapshotProvider: () => {
      const snapshots = getDeterministicGovernanceSnapshots();
      return {
        ...snapshots,
        budgetSnapshot: { ...snapshots.budgetSnapshot, status: 'stale', budgets: [] },
      };
    },
  }).resolve({ apiFamily: 'openai-responses' });
  assert.equal(budgetBehind.status, 200);
  assert.equal(budgetBehind.reasonCode, 'resolved');
  assert.deepEqual(budgetBehind.document.allowedModels, ['coding-primary']);
});
