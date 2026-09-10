import {
  digest,
  sealManifest,
} from '../../../tools/deployment/ownership-contract.mjs';

const schemas = Object.freeze({
  candidate: 'llm-governance-ownership-candidate/v1',
  state: 'llm-governance-ownership-state/v1',
  readback: 'llm-governance-ownership-readback/v1',
  preflight: 'llm-governance-create-only-preflight/v1',
  approval: 'llm-governance-removal-approval/v1',
});

export const verificationIdentity = Object.freeze({
  tenantId: '00000000-0000-4000-8000-000000000001',
  subscriptionId: '00000000-0000-4000-8000-000000000002',
  environmentName: 'verification',
  resourceGroupName: 'rg-test-verification',
  resourceGroupId: ['', 'subscriptions', '00000000-0000-4000-8000-000000000002', 'resourceGroups', 'rg-test-verification'].join('/'),
  location: 'example-region',
});

const foundryGroup = `/subscriptions/${verificationIdentity.subscriptionId}/resourceGroups/rg-test-foundry`;
const foundryRoot = `${foundryGroup}/providers/Microsoft.CognitiveServices/accounts/test-foundry-account`;
export const requiredProtectedTargets = Object.freeze([
  foundryGroup,
  foundryRoot,
  `${foundryRoot}/projects/test-project`,
  `${foundryRoot}/deployments/test-model`,
  '/providers/Microsoft.Graph/protectedPreexisting',
  '/providers/Microsoft.Authorization/protectedPreexisting',
]);

export const ids = Object.freeze({
  resourceGroup: verificationIdentity.resourceGroupId,
  apiManagement: `${verificationIdentity.resourceGroupId}/providers/Microsoft.ApiManagement/service/apim-verification`,
  keyVault: `${verificationIdentity.resourceGroupId}/providers/Microsoft.KeyVault/vaults/kv-verification`,
  liveApplication: '/providers/Microsoft.Graph/applications/11111111-1111-4111-8111-111111111111',
  liveServicePrincipal: '/providers/Microsoft.Graph/servicePrincipals/22222222-2222-4222-8222-222222222222',
  deletedApplication: '/providers/Microsoft.Graph/applications/33333333-3333-4333-8333-333333333333',
  protectedApplication: '/providers/Microsoft.Graph/protectedPreexisting',
  foundryAccount: requiredProtectedTargets[1],
  foundryProject: requiredProtectedTargets[2],
  foundryDeployment: requiredProtectedTargets[3],
});

const operationId = 'verification-operation-1';
const receiptDigest = digest({ receipt: operationId });

function creation() {
  return {
    operationId,
    deploymentId: `${verificationIdentity.resourceGroupId}/providers/Microsoft.Resources/deployments/main-verification`,
    correlationId: 'verification-correlation-1',
    receiptDigest,
  };
}

function createdEntry(id, kind, type, scope, extra = {}) {
  return {
    id,
    kind,
    type,
    scope,
    classification: 'created',
    creation: creation(),
    ...extra,
  };
}

function entryIdentity(entry) {
  const copy = structuredClone(entry);
  delete copy.creation;
  delete copy.lifecycleState;
  delete copy.purgeEligible;
  delete copy.retentionUntil;
  delete copy.unchanged;
  return copy;
}

export function resign(value) {
  delete value.canonicalDigest;
  value.canonicalDigest = digest(value);
  return value;
}

export function createFixture({
  approvedPlanDigest = digest({ plan: 'verification' }),
  freshFoundry = false,
  secondModelDeployments = [],
  createdAt = '2026-09-03T06:00:00.000Z',
  readbackObservedAt = '2026-09-03T06:05:00.000Z',
} = {}) {
  const foundryResourceGroupName = freshFoundry
    ? verificationIdentity.resourceGroupName
    : 'rg-test-foundry';
  const foundryResourceGroupId = freshFoundry
    ? verificationIdentity.resourceGroupId
    : foundryGroup;
  const fixtureFoundryRoot = `${foundryResourceGroupId}/providers/Microsoft.CognitiveServices/accounts/test-foundry-account`;
  const fixtureFoundryEntries = [
    [fixtureFoundryRoot, 'Microsoft.CognitiveServices/accounts'],
    [`${fixtureFoundryRoot}/projects/test-project`, 'Microsoft.CognitiveServices/accounts/projects'],
    [`${fixtureFoundryRoot}/deployments/test-model`, 'Microsoft.CognitiveServices/accounts/deployments'],
  ];
  for (const deployment of secondModelDeployments) {
    fixtureFoundryEntries.push([
      `${fixtureFoundryRoot}/deployments/${deployment.deploymentName}`,
      'Microsoft.CognitiveServices/accounts/deployments',
    ]);
  }
  const foundryEntries = [
    ...fixtureFoundryEntries,
  ].map(([id, type]) => ({
    id,
    kind: 'azure-resource',
    type,
    scope: fixtureFoundryRoot,
    classification: freshFoundry ? 'created' : 'external-reference',
    ...(freshFoundry ? { creation: creation() } : {}),
  }));

  const entries = [
    createdEntry(
      ids.resourceGroup,
      'azure-resource',
      'Microsoft.Resources/resourceGroups',
      `/subscriptions/${verificationIdentity.subscriptionId}`,
    ),
    createdEntry(
      ids.apiManagement,
      'azure-resource',
      'Microsoft.ApiManagement/service',
      ids.resourceGroup,
    ),
    createdEntry(
      ids.keyVault,
      'azure-resource',
      'Microsoft.KeyVault/vaults',
      ids.resourceGroup,
      { purgeProtectionEnabled: true, softDeleteRetentionInDays: 7 },
    ),
    createdEntry(
      ids.liveApplication,
      'entra-application',
      'Microsoft.Graph/applications',
      '/providers/Microsoft.Graph',
      {
        objectId: ids.liveApplication,
        appId: '44444444-4444-4444-8444-444444444444',
      },
    ),
    createdEntry(
      ids.liveServicePrincipal,
      'entra-service-principal',
      'Microsoft.Graph/servicePrincipals',
      '/providers/Microsoft.Graph',
      {
        objectId: ids.liveServicePrincipal,
        appId: '44444444-4444-4444-8444-444444444444',
        applicationObjectId: ids.liveApplication,
      },
    ),
    createdEntry(
      ids.deletedApplication,
      'entra-application',
      'Microsoft.Graph/applications',
      '/providers/Microsoft.Graph',
      {
        objectId: ids.deletedApplication,
        appId: '55555555-5555-4555-8555-555555555555',
      },
    ),
    {
      id: ids.protectedApplication,
      kind: 'entra-application',
      type: 'Microsoft.Graph/applications',
      scope: '/providers/Microsoft.Graph',
      classification: 'protected-preexisting',
      objectId: ids.protectedApplication,
      appId: '66666666-6666-4666-8666-666666666666',
    },
    ...foundryEntries,
  ];

  const candidate = {
    schemaVersion: schemas.candidate,
    manifestVersion: 1,
    header: {
      identity: verificationIdentity,
      sourceCommit: '0123456789abcdef0123456789abcdef01234567',
      artifactDigest: digest({ artifact: 'verification' }),
      creationOperationId: operationId,
      deploymentNames: ['main-verification'],
      createdAt,
    },
    inventory: { entries },
    evidence: {
      approvedPlanDigest,
      previewDigest: digest({ preview: 'verification' }),
      readbackDigest: digest({ creationReadback: 'verification' }),
    },
    protectedTargets: freshFoundry
      ? requiredProtectedTargets.filter((target) => !target.startsWith(foundryGroup))
      : requiredProtectedTargets,
    protectedTargetsDigest: digest(freshFoundry
      ? requiredProtectedTargets.filter((target) => !target.startsWith(foundryGroup))
      : requiredProtectedTargets),
  };
  const manifest = sealManifest(candidate);
  const stateEntries = manifest.inventory.entries.map(entryIdentity);
  const state = resign({
    schemaVersion: schemas.state,
    identity: verificationIdentity,
    manifestVersion: manifest.manifestVersion,
    manifestDigest: manifest.canonicalDigest,
    approvedPlanDigest: manifest.evidence.approvedPlanDigest,
    inventoryDigest: digest(stateEntries),
    entries: stateEntries,
    deletedEntryIds: [],
  });
  const readback = resign({
    schemaVersion: schemas.readback,
    identity: verificationIdentity,
    manifestVersion: manifest.manifestVersion,
    manifestDigest: manifest.canonicalDigest,
    approvedPlanDigest: manifest.evidence.approvedPlanDigest,
    protectedTargetsDigest: manifest.protectedTargetsDigest,
    observedAt: readbackObservedAt,
    entries: manifest.inventory.entries.map((entry) => ({
      ...entryIdentity(entry),
      lifecycleState: 'present',
      ...(entry.classification === 'created' ? {} : { unchanged: true }),
    })),
  });
  return { candidate, manifest, state, readback };
}

export function markSoftDeleted(fixture, id, { purgeEligible, retentionUntil } = {}) {
  fixture.state.deletedEntryIds = [...new Set([...fixture.state.deletedEntryIds, id])].sort();
  resign(fixture.state);
  const entry = fixture.readback.entries.find((candidate) => candidate.id === id);
  entry.lifecycleState = 'soft-deleted';
  if (purgeEligible !== undefined) entry.purgeEligible = purgeEligible;
  if (retentionUntil !== undefined) entry.retentionUntil = retentionUntil;
  resign(fixture.readback);
  return fixture;
}

export function createPreflight(manifest, {
  freshFoundry = false,
  secondModelDeployments = [],
  stage = 'postprovision',
} = {}) {
  const preflight = {
    schemaVersion: schemas.preflight,
    identity: verificationIdentity,
    approvedPlanDigest: manifest.evidence.approvedPlanDigest,
    sourceCommit: manifest.header.sourceCommit,
    previewDigest: manifest.evidence.previewDigest,
    creationOperationId: manifest.header.creationOperationId,
    stage,
    observedAt: '2026-09-03T05:55:00.000Z',
    validUntil: '2026-09-03T06:25:00.000Z',
    resourceGroup: { id: verificationIdentity.resourceGroupId, exists: false },
    foundry: {
      resourceGroupName: freshFoundry ? verificationIdentity.resourceGroupName : 'rg-test-foundry',
      accountName: 'test-foundry-account',
      projectName: 'test-project',
      deploymentName: 'test-model',
      classification: freshFoundry ? 'created' : 'external-reference',
      freshFoundry,
      ...(secondModelDeployments.length ? { secondModelDeployments } : {}),
    },
    activeNameCollisions: [],
    softDeletedNameCollisions: [],
    entraCollisions: [],
    protectedTargets: requiredProtectedTargets,
    protectedTargetsDigest: digest(requiredProtectedTargets),
  };
  return resign(preflight);
}

export function createEnvironment({ freshFoundry = false, secondModelDeployments = [] } = {}) {
  return {
    AZURE_TENANT_ID: verificationIdentity.tenantId,
    AZURE_SUBSCRIPTION_ID: verificationIdentity.subscriptionId,
    AZURE_ENV_NAME: verificationIdentity.environmentName,
    AZURE_LOCATION: verificationIdentity.location,
    GATEWAY_RESOURCE_GROUP_NAME: verificationIdentity.resourceGroupName,
    CREATE_FOUNDRY: String(freshFoundry),
    FOUNDRY_RESOURCE_GROUP_NAME: freshFoundry ? verificationIdentity.resourceGroupName : 'rg-test-foundry',
    FOUNDRY_ACCOUNT_NAME: 'test-foundry-account',
    FOUNDRY_PROJECT_NAME: 'test-project',
    FOUNDRY_DEFAULT_MODEL_DEPLOYMENT: 'test-model',
    FOUNDRY_SECOND_MODEL_DEPLOYMENTS: JSON.stringify(secondModelDeployments),
  };
}

export function createApproval(preview, phase, targetIds) {
  const approval = {
    schemaVersion: schemas.approval,
    phase,
    approvalId: `approval-${phase}`,
    approvedByObjectId: '77777777-7777-4777-8777-777777777777',
    approvedAt: '2026-09-03T06:06:00.000Z',
    expiresAt: '2026-09-03T06:16:00.000Z',
    manifestDigest: preview.manifestDigest,
    approvedPlanDigest: preview.approvedPlanDigest,
    readbackDigest: preview.readbackDigest,
    previewDigest: preview.canonicalDigest,
    targetIds,
    targetDigest: digest(targetIds),
  };
  return resign(approval);
}
