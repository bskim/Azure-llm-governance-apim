import assert from 'node:assert/strict';
import test from 'node:test';

import { projectModels } from '../../app/control-api/models-read-model-projector.mjs';

const generatedAt = '2026-07-24T10:00:00.000Z';
const ALICE = 'sk1-local-platform-engineering-1';
const BOB = 'sk1-local-developer-experience-1';

function authorization(permittedReadScopes = ['self', 'team', 'global']) {
  return {
    contractVersion: 'v1',
    readAuthority: 'authoritative',
    permittedReadScopes,
    permittedTeamKeys: ['platform-engineering', 'developer-experience'],
    reasonCode: 'authorized',
  };
}

function model(modelKey, overrides = {}) {
  const descriptor = {
    modelKey,
    providerKey: 'azure-openai',
    providerDeploymentName: `deploy-${modelKey}`,
    apiFamilies: ['openai-chat-completions', 'openai-responses'],
    lifecycle: 'generally-available',
    safetyPolicy: 'local-default-policy',
    ...overrides,
  };
  if (descriptor.providerDeploymentName === undefined) delete descriptor.providerDeploymentName;
  return descriptor;
}

function quotaDeployment(modelKey, { allocated, limit, capacity }) {
  return {
    deploymentName: `deploy-${modelKey}`,
    modelName: modelKey,
    modelVersion: '2026-03-05',
    modelFormat: 'OpenAI',
    skuName: 'GlobalStandard',
    capabilities: { chatCompletion: true, responses: true },
    residencyArea: 'US',
    raiPolicyName: 'local-default-policy',
    capacity,
    requestsPerMinute: capacity,
    tokensPerMinute: capacity * 1_000,
    provisioningState: 'Succeeded',
    pool: {
      poolKey: `OpenAI.GlobalStandard.${modelKey}`,
      allocated,
      limit,
      unit: 'Count',
      matchQuality: 'exact',
    },
    poolReasonCode: null,
  };
}

function quotaSnapshot() {
  return {
    contractVersion: 'v1',
    snapshotId: 'provider-quota-test',
    status: 'complete',
    region: 'eastus2',
    capturedAt: '2026-07-24T09:56:00.000Z',
    expiresAt: '2026-07-24T10:11:00.000Z',
    sourceRevision: 'test-quota',
    deployments: [
      quotaDeployment('coding-fast', { allocated: 50, limit: 3_000, capacity: 50 }),
      quotaDeployment('coding-primary', { allocated: 1_000, limit: 1_000, capacity: 1_000 }),
    ],
  };
}

function registry(overrides = {}) {
  return {
    status: 'complete',
    version: 4,
    capturedAt: '2026-07-24T09:55:00.000Z',
    expiresAt: '2026-08-23T09:55:00.000Z',
    sourceRevision: 'registry-source-001',
    models: [model('coding-primary'), model('coding-fast')],
    ...overrides,
  };
}

function binding(bindingId, modelAllowlist, requestsPerMinute, tokensPerMinute) {
  return {
    bindingId,
    state: 'active',
    target: { kind: 'global', key: null },
    modelAllowlist,
    limits: { requestsPerMinute, tokensPerMinute, tokenQuota: 1_000, quotaPeriod: 'Monthly' },
  };
}

const entitlementSnapshot = {
  bindings: [
    binding('b1', ['coding-primary'], 80, 80_000),
    binding('b2', ['coding-primary', 'coding-fast'], 120, 120_000),
    { ...binding('b3', ['coding-fast'], 5, 5_000), state: 'revoked' },
  ],
};

function record({ correlationId, modelKey = 'coding-primary', subjectKey = ALICE, teamKey = 'platform-engineering', outcome = 'served' }) {
  const tokens = outcome === 'refused' ? 0 : 100;
  return {
    correlationId,
    outcome,
    attribution: { teamKey, subjectKey, applicationKey: 'ak1-local-console-0000' },
    requested: { modelKey, providerKey: 'azure-openai' },
    effective: { modelKey, providerKey: 'azure-openai' },
    usage: {
      promptTokens: tokens,
      completionTokens: tokens,
      totalTokens: tokens * 2,
      tokenQuality: outcome === 'refused' ? 'reported' : 'reported',
    },
  };
}

const completeWindow = Object.freeze({
  windowStart: '2026-07-24T07:00:00.000Z',
  windowEnd: '2026-07-24T10:00:00.000Z',
  asOf: generatedAt,
  completeness: { state: 'complete', reason: 'window-closed' },
  freshness: { state: 'fresh', reportedAt: '2026-07-24T10:00:00.000Z', lagSeconds: 300 },
});

function project(overrides = {}) {
  return projectModels({
    authorization: authorization(overrides.scopes),
    registry: overrides.registry === undefined ? registry() : overrides.registry,
    entitlementSnapshot,
    records: overrides.records ?? [record({ correlationId: 'r1' })],
    window: overrides.window ?? completeWindow,
    selection: {
      scope: overrides.scope ?? 'global',
      teamKey: overrides.teamKey ?? null,
      generatedAt,
    },
    viewer: overrides.viewer ?? null,
    providerQuota: overrides.providerQuota ?? null,
  });
}

test('a model row carries its wire contracts, maturity and safety policy', () => {
  const readModel = project();
  assert.equal(readModel.readModelVersion, 'models.v1');
  assert.equal(readModel.registry.state, 'complete');
  assert.deepEqual(readModel.records.map((row) => row.modelKey), ['coding-fast', 'coding-primary']);

  const primary = readModel.records.find((row) => row.modelKey === 'coding-primary');
  assert.equal(primary.registrationState, 'registered');
  assert.equal(primary.lifecycle, 'generally-available');
  assert.equal(primary.providerDeploymentName, 'deploy-coding-primary');
});

test('deployment names come from the registered mapping even without provider quota data', () => {
  for (const providerQuota of [null, { ...quotaSnapshot(), status: 'unavailable' }]) {
    const readModel = project({ providerQuota });
    assert.deepEqual(
      readModel.records.map(({ modelKey, providerDeploymentName }) => [modelKey, providerDeploymentName]),
      [['coding-fast', 'deploy-coding-fast'], ['coding-primary', 'deploy-coding-primary']],
    );
  }
});

test('missing deployment mappings stay unknown rather than being inferred from logical aliases', () => {
  const legacy = project({
    registry: registry({ models: [model('coding-primary', { providerDeploymentName: undefined })] }),
  });
  assert.equal(legacy.records.find((row) => row.modelKey === 'coding-primary').providerDeploymentName, null);
  const unregistered = project({ records: [record({ correlationId: 'unregistered', modelKey: 'unregistered-model' })] });
  assert.equal(unregistered.records.find((row) => row.modelKey === 'unregistered-model').providerDeploymentName, null);
});

test('a provider quota reading is joined onto the model that declares its deployment', () => {
  const readModel = project({ providerQuota: quotaSnapshot() });
  const primary = readModel.records.find((row) => row.modelKey === 'coding-primary');

  assert.equal(readModel.quality.providerQuotaState, 'complete');
  assert.equal(primary.providerQuota.source, 'provider-deployment');
  assert.equal(primary.providerQuota.deploymentName, 'deploy-coding-primary');
  assert.equal(primary.providerQuota.tokensPerMinute, 1_000_000);
  assert.deepEqual(primary.providerQuota.pool, {
    allocated: 1_000,
    limit: 1_000,
    allocatable: 0,
    unit: 'Count',
    matchQuality: 'exact',
    fullyAllocated: true,
  });
  assert.deepEqual(primary.providerAgreement, {
    state: 'agrees',
    reasonCode: null,
    changedFields: [],
  });
});

test('provider divergence names only the descriptor fields a recapture would change', () => {
  const snapshot = quotaSnapshot();
  snapshot.deployments.find((entry) => entry.deploymentName === 'deploy-coding-primary').capabilities.responses = false;
  const readModel = project({ providerQuota: snapshot });
  const primary = readModel.records.find((row) => row.modelKey === 'coding-primary');

  assert.equal(primary.providerAgreement.state, 'diverged');
  assert.equal(primary.providerAgreement.reasonCode, 'provider-descriptor-diverged');
  assert.deepEqual(primary.providerAgreement.changedFields, ['api-families']);
});

test('an absent provider deployment is distinct from an unread provider snapshot', () => {
  const snapshot = quotaSnapshot();
  snapshot.deployments = snapshot.deployments.filter((entry) => entry.deploymentName !== 'deploy-coding-primary');
  const absent = project({ providerQuota: snapshot }).records.find((row) => row.modelKey === 'coding-primary');
  assert.equal(absent.providerAgreement.state, 'deployment-absent');

  const unread = project().records.find((row) => row.modelKey === 'coding-primary');
  assert.equal(unread.providerAgreement.state, 'unverified');
  assert.notEqual(unread.providerAgreement.state, 'agrees');
});

test('allocated capacity is never presented as tokens that were spent', () => {
  const readModel = project({
    providerQuota: quotaSnapshot(),
    records: [record({ correlationId: 'r1' })],
  });
  const primary = readModel.records.find((row) => row.modelKey === 'coding-primary');

  // The provider figure moves when a deployment is created or resized, never when a
  // request is served, so it must not borrow the vocabulary of consumption.
  const serialized = JSON.stringify(primary.providerQuota);
  for (const forbidden of ['consumed', 'used', 'exhausted', 'remaining', 'spent']) {
    assert.ok(!serialized.includes(`"${forbidden}"`), `provider allocation must not carry ${forbidden}`);
  }
  // Real usage lives on its own field and is a different number entirely.
  assert.equal(primary.consumption.totalTokens, 200);
  assert.equal(primary.providerQuota.pool.allocated, 1_000);
});

test('what is still deployable is reported, not only whether anything is', () => {
  const readModel = project({ providerQuota: quotaSnapshot() });
  const fast = readModel.records.find((row) => row.modelKey === 'coding-fast');
  assert.equal(fast.providerQuota.pool.allocatable, 2_950);
  assert.equal(fast.providerQuota.pool.fullyAllocated, false);
});

test('a deployment the provider published under no quota pool says so', () => {
  const snapshot = quotaSnapshot();
  snapshot.deployments[1].pool = null;
  snapshot.deployments[1].poolReasonCode = 'pool-not-matched';
  const readModel = project({ providerQuota: snapshot });
  const primary = readModel.records.find((row) => row.modelKey === 'coding-primary');

  // The deployment's own rate limits are still known; only the pool is missing.
  assert.equal(primary.providerQuota.source, 'provider-deployment');
  assert.equal(primary.providerQuota.tokensPerMinute, 1_000_000);
  assert.equal(primary.providerQuota.pool, null);
  assert.equal(primary.providerQuota.reasonCode, 'pool-not-matched');
});

test('a quota nobody read is absent with the reason, never a zero', () => {
  const withoutSnapshot = project();
  for (const row of withoutSnapshot.records) {
    assert.equal(row.providerQuota.pool, null);
    assert.equal(row.providerQuota.tokensPerMinute, null);
    assert.equal(row.providerQuota.source, 'not-collected');
    assert.equal(row.providerQuota.reasonCode, 'quota-snapshot-unavailable');
  }
  assert.equal(withoutSnapshot.quality.providerQuotaState, 'unavailable');

  // A model that never says which deployment it routes to cannot be joined at all,
  // and that is a different gap from a snapshot that failed to arrive.
  const undeclared = project({
    registry: { ...registry(), models: [model('coding-primary', { providerDeploymentName: undefined })] },
    providerQuota: quotaSnapshot(),
  });
  assert.equal(undeclared.records[0].providerQuota.reasonCode, 'deployment-not-declared');
});

test('an expired quota snapshot is not silently trusted', () => {
  const readModel = project({
    providerQuota: { ...quotaSnapshot(), expiresAt: '2026-07-24T09:59:00.000Z' },
  });
  assert.equal(readModel.quality.providerQuotaState, 'expired');
  for (const row of readModel.records) {
    assert.equal(row.providerQuota.reasonCode, 'quota-snapshot-expired');
    assert.equal(row.providerQuota.pool, null);
  }
});

test('a declared deployment missing from the snapshot is named rather than blank', () => {
  const snapshot = quotaSnapshot();
  snapshot.deployments = snapshot.deployments.filter((d) => d.deploymentName !== 'deploy-coding-fast');
  const readModel = project({ providerQuota: snapshot });
  const fast = readModel.records.find((row) => row.modelKey === 'coding-fast');
  assert.equal(fast.providerQuota.reasonCode, 'deployment-not-found');
});

test('internal rate limits are reported as a range because they belong to a binding', () => {
  const readModel = project();
  const primary = readModel.records.find((row) => row.modelKey === 'coding-primary');
  assert.deepEqual(primary.internalLimits, {
    grantingBindings: 2,
    requestsPerMinute: { min: 80, max: 120 },
    tokensPerMinute: { min: 80_000, max: 120_000 },
  });

  // A revoked binding grants nothing, so only the active one counts.
  const fast = readModel.records.find((row) => row.modelKey === 'coding-fast');
  assert.equal(fast.internalLimits.grantingBindings, 1);
});

test('consumption and failures are joined onto the model that served them', () => {
  const readModel = project({
    records: [
      record({ correlationId: 'r1' }),
      record({ correlationId: 'r2', outcome: 'failed' }),
      record({ correlationId: 'r3', modelKey: 'coding-fast', outcome: 'refused' }),
    ],
  });

  const primary = readModel.records.find((row) => row.modelKey === 'coding-primary');
  assert.equal(primary.consumption.requests, 2);
  assert.equal(primary.consumption.totalTokens, 400);
  assert.equal(primary.consumption.outcomes.failed, 1);

  const fast = readModel.records.find((row) => row.modelKey === 'coding-fast');
  assert.equal(fast.consumption.outcomes.refused, 1);
  // A per-model row does not carry its own per-model breakdown.
  assert.equal('byModel' in fast.consumption, false);
});

test('a registered model with no traffic reports absent consumption rather than zeros', () => {
  const readModel = project();
  const fast = readModel.records.find((row) => row.modelKey === 'coding-fast');
  assert.equal(fast.consumption, null);
});

test('a model that served traffic but is not registered is still listed', () => {
  const readModel = project({
    records: [record({ correlationId: 'r1', modelKey: 'shadow-model' })],
  });
  const shadow = readModel.records.find((row) => row.modelKey === 'shadow-model');
  assert.equal(shadow.registrationState, 'unregistered');
  assert.equal(shadow.internalLimits, null);
  assert.equal(shadow.consumption.requests, 1);
});

test('an unavailable registry still reports the models that served traffic', () => {
  const readModel = project({ registry: { ...registry(), status: 'stale' } });
  assert.equal(readModel.registry.state, 'unavailable');
  assert.equal(readModel.registry.version, null);
  assert.deepEqual(readModel.records.map((row) => row.registrationState), ['unregistered']);
});

test('an expired registry is named as expired rather than silently trusted', () => {
  const readModel = project({ registry: { ...registry(), expiresAt: '2026-07-24T09:59:00.000Z' } });
  assert.equal(readModel.registry.state, 'expired');
  assert.equal(readModel.quality.catalogueState, 'expired');
  assert.equal(readModel.records.length, 2);
});

test('a registry inside its warning band is reachable as expiring before validation refuses it', () => {
  const readModel = project({
    registry: { ...registry(), expiresAt: '2026-07-30T10:00:00.000Z' },
  });
  assert.equal(readModel.registry.state, 'expiring');
  assert.equal(readModel.quality.catalogueState, 'expiring');
  assert.equal(readModel.records.length, 2);
});

test('consumption is filtered by read scope before it reaches a model row', () => {
  const records = [
    record({ correlationId: 'r1' }),
    record({ correlationId: 'r2', subjectKey: BOB, teamKey: 'developer-experience' }),
  ];
  const team = project({ records, scope: 'team', teamKey: 'platform-engineering' });
  assert.equal(team.records.find((row) => row.modelKey === 'coding-primary').consumption.requests, 1);

  const self = project({ records, scope: 'self', viewer: { subjectKey: BOB } });
  assert.equal(self.records.find((row) => row.modelKey === 'coding-primary').consumption.requests, 1);

  assert.throws(
    () => project({ records, scopes: ['self'] }),
    (error) => error.code === 'scope-denied',
  );
});

test('an unobserved window lists the catalogue but publishes no consumption', () => {
  const readModel = project({
    window: { ...completeWindow, completeness: { state: 'degraded', reason: 'source-unavailable' } },
  });
  assert.equal(readModel.quality.countsMeasured, false);
  assert.equal(readModel.quality.reasonCode, 'source-unavailable');
  assert.equal(readModel.records.length, 2);
  assert.ok(readModel.records.every((row) => row.consumption === null));
});

test('the read model carries no request body and no raw principal identifier', () => {
  const serialized = JSON.stringify(project());
  for (const forbidden of ['prompt', 'completion', 'subjectId', 'applicationId', 'backendUrl', 'resourceId']) {
    assert.ok(!serialized.includes(`"${forbidden}"`), `read model must not carry ${forbidden}`);
  }
});
