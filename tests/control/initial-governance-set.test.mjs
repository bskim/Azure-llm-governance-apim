import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INITIAL_SET_REASONS,
  InitialGovernanceSetRefusedError,
  buildInitialGovernanceSet,
} from '../../app/governance-domain/policy/initial-governance-set.mjs';
import { AUTHORED_POLICY_RETENTION_SECONDS } from '../../app/governance-domain/lifecycle/authored-policy-retention.mjs';
import { REGISTRY_CAPTURE_RETENTION_SECONDS } from '../../app/governance-domain/registry/registry-capture-retention.mjs';

const AT = '2026-08-26T02:00:00.000Z';
const MODEL = 'coding-model';
const GROUP = '00000000-0000-4000-8000-000000000001';
const TENANT = '00000000-0000-4000-8000-000000000002';
const deployments = [{
  deploymentName: 'deploy-coding-model',
  modelName: 'coding-model',
  modelVersion: '1',
  modelFormat: 'OpenAI',
  capabilities: { chatCompletion: true, responses: true },
  raiPolicyName: null,
}];

function input(overrides = {}) {
  return {
    tenantId: TENANT,
    scopeGroupId: 'organization',
    organization: {
      models: [MODEL],
      limits: { requestsPerMinute: 80, tokensPerMinute: 80_000, tokenQuota: 40_000_000, quotaPeriod: 'Monthly' },
    },
    teams: [{ teamKey: 'engineering', membershipGroupId: GROUP, models: [MODEL], limits: { requestsPerMinute: 40, tokensPerMinute: 40_000 } }],
    models: [{ deploymentName: 'deploy-coding-model', modelKey: MODEL }],
    ...overrides,
  };
}

test('structured input and provider rows produce five validated snapshots without memberships', () => {
  const built = buildInitialGovernanceSet({ input: input(), deployments, at: AT });
  assert.deepEqual(Object.keys(built.content.snapshots).sort(), [
    'assignmentSnapshot',
    'budgetSnapshot',
    'entitlementSnapshot',
    'fallbackPolicySnapshot',
    'modelRegistrySnapshot',
  ]);
  assert.equal('memberships' in built.content, false);
  assert.equal(built.content.snapshots.assignmentSnapshot.assignments.length, 0);
  assert.deepEqual(built.summary.teamKeys, ['engineering']);
  assert.deepEqual(built.summary.modelKeys, [MODEL]);
});

test('the initial set uses the declared authored and registry retention contracts', () => {
  const built = buildInitialGovernanceSet({ input: input(), deployments, at: AT });
  assert.equal(
    Date.parse(built.summary.expiresAt.authored) - Date.parse(AT),
    AUTHORED_POLICY_RETENTION_SECONDS * 1000,
  );
  assert.equal(
    Date.parse(built.summary.expiresAt.registry) - Date.parse(AT),
    REGISTRY_CAPTURE_RETENTION_SECONDS * 1000,
  );
});

test('group identity is a directory object id rather than a display name', () => {
  assert.throws(
    () => buildInitialGovernanceSet({
      input: input({ teams: [{ teamKey: 'engineering', membershipGroupId: 'Engineering Team' }] }),
      deployments,
      at: AT,
    }),
    (error) => error instanceof InitialGovernanceSetRefusedError
      && error.code === INITIAL_SET_REASONS.groupIdNotGuid,
  );
});

test('a narrower allowlist cannot name a model the organization does not allow', () => {
  const second = { ...deployments[0], deploymentName: 'deploy-secondary', modelName: 'secondary' };
  assert.throws(
    () => buildInitialGovernanceSet({
      input: input({
        models: [
          { deploymentName: 'deploy-coding-model', modelKey: MODEL },
          { deploymentName: 'deploy-secondary', modelKey: 'secondary' },
        ],
        teams: [{ teamKey: 'engineering', membershipGroupId: GROUP, models: ['secondary'], limits: {} }],
      }),
      deployments: [...deployments, second],
      at: AT,
    }),
    (error) => error instanceof InitialGovernanceSetRefusedError
      && error.code === INITIAL_SET_REASONS.modelOutsideOrganization,
  );
});

test('a model descriptor is captured from the provider row, not accepted in input', () => {
  const provided = input();
  provided.models[0].providerKey = 'other';
  assert.throws(() => buildInitialGovernanceSet({ input: provided, deployments, at: AT }), TypeError);
});

test('the builder imports no development fixture', async () => {
  const source = await import('node:fs/promises').then(({ readFile }) =>
    readFile(new URL('../../app/governance-domain/policy/initial-governance-set.mjs', import.meta.url), 'utf8'));
  assert.doesNotMatch(source, /local-adapters|deterministic-governance/);
});

test('tenant identity has its own refusal instead of being reported as a bad group', () => {
  assert.throws(
    () => buildInitialGovernanceSet({ input: input({ tenantId: 'not-a-tenant' }), deployments, at: AT }),
    (error) => error instanceof InitialGovernanceSetRefusedError
      && error.code === INITIAL_SET_REASONS.tenantIdNotGuid,
  );
});