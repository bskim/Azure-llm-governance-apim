import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createRemovalPreview,
  digest,
  generateOwnershipEvidence,
  sealManifest,
  verifyOwnershipEvidenceBundle,
} from '../../tools/deployment/ownership-contract.mjs';
import {
  createFixture,
  ids,
} from '../infra/fixtures/ownership-contract-fixture.mjs';

const NOW = new Date('2026-09-03T06:07:00.000Z');
const repositoryRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const removeScript = path.join(repositoryRoot, 'tools', 'distribution', 'Remove-Deployment.ps1');
const contractEngine = path.join(repositoryRoot, 'tools', 'deployment', 'ownership-contract.mjs');

function withoutOwnership(entry) {
  const copy = structuredClone(entry);
  delete copy.classification;
  delete copy.creation;
  delete copy.unchanged;
  delete copy.purgeEligible;
  delete copy.retentionUntil;
  copy.lifecycleState = 'present';
  return copy;
}

function resign(value) {
  delete value.canonicalDigest;
  value.canonicalDigest = digest(value);
  return value;
}

function generationInput({
  existingResourceGroup = false,
  createdAt = '2026-09-03T06:00:00.000Z',
  readbackObservedAt = '2026-09-03T06:05:00.000Z',
} = {}) {
  const { candidate } = createFixture({ createdAt, readbackObservedAt });
  const created = candidate.inventory.entries.filter((entry) => entry.classification === 'created');
  const external = candidate.inventory.entries.filter((entry) => entry.classification === 'external-reference');
  const protectedEntries = candidate.inventory.entries.filter(
    (entry) => entry.classification === 'protected-preexisting',
  );
  const preexistingResourceIds = [
    ...protectedEntries.map((entry) => entry.id),
    ...(existingResourceGroup ? [candidate.header.identity.resourceGroupId] : []),
  ];
  const receiptIds = created
    .map((entry) => entry.id)
    .filter((id) => !preexistingResourceIds.includes(id));
  const receipt = resign({
    schemaVersion: 'llm-governance-creation-receipt/v1',
    operationId: candidate.header.creationOperationId,
    deploymentId: created[0].creation.deploymentId,
    correlationId: created[0].creation.correlationId,
    observedAt: createdAt,
    createdResourceIds: receiptIds,
  });
  const authoritativeReadback = resign({
    schemaVersion: 'llm-governance-authoritative-readback/v1',
    identity: candidate.header.identity,
    observedAt: readbackObservedAt,
    entries: candidate.inventory.entries.map(withoutOwnership),
  });
  return resign({
    schemaVersion: 'llm-governance-ownership-generation-input/v1',
    deploymentInputs: {
      identity: candidate.header.identity,
      sourceCommit: candidate.header.sourceCommit,
      artifactDigest: candidate.header.artifactDigest,
      approvedPlanDigest: candidate.evidence.approvedPlanDigest,
      previewDigest: candidate.evidence.previewDigest,
      creationOperationId: candidate.header.creationOperationId,
      deploymentNames: candidate.header.deploymentNames,
      createdAt: candidate.header.createdAt,
      preexistingResourceIds,
      protectedTargets: [
        ...candidate.protectedTargets,
        ...(existingResourceGroup ? [candidate.header.identity.resourceGroupId] : []),
      ],
    },
    outputSeed: {
      schemaVersion: 'llm-governance-bicep-ownership-seed/v1',
      identity: candidate.header.identity,
      createdResourceIds: created
        .filter((entry) => entry.kind === 'azure-resource')
        .map((entry) => entry.id),
      createdAzureRoleAssignmentIds: created
        .filter((entry) => entry.kind === 'azure-role-assignment')
        .map((entry) => entry.id),
      createdDirectoryObjects: created
        .filter((entry) => ['entra-application', 'entra-service-principal'].includes(entry.kind))
        .map((entry) => ({
          kind: entry.kind,
          objectId: entry.objectId,
          appId: entry.appId,
          ...(entry.applicationObjectId ? { applicationObjectId: entry.applicationObjectId } : {}),
        })),
      createdGraphAssignmentIds: created
        .filter((entry) => entry.kind === 'graph-assignment')
        .map((entry) => entry.id),
      externalReferences: external.map((entry) => ({
        id: entry.id,
        classification: 'external-reference',
      })),
      protectedResourceIds: [
        ...external.map((entry) => entry.id),
        ...preexistingResourceIds,
      ],
      keyVaultLifecycle: {
        purgeProtectionEnabled: true,
        softDeleteRetentionInDays: 7,
        deletionDisposition: 'DeletedPendingRetention',
        referencedResourceIds: [],
        ownershipResolution: 'main-deployment-receipt',
      },
      bootstrapManifestRequired: false,
      requiresCreationReceipts: true,
      requiresRecursiveApimReadback: true,
      requiresExactReadback: true,
    },
    creationReceipts: [receipt],
    authoritativeReadback,
  });
}

function overlappingRoleGenerationInput() {
  const input = generationInput();
  const accountId = `${ids.resourceGroup}/providers/Microsoft.DocumentDB/databaseAccounts/governance`;
  const principalId = '55555555-5555-4555-8555-555555555555';
  const roleId = '66666666-6666-4666-8666-666666666666';
  const roles = [
    {
      id: `${ids.resourceGroup}/providers/Microsoft.Authorization/roleAssignments/${roleId}`,
      type: 'Microsoft.Authorization/roleAssignments',
      scope: ids.resourceGroup,
      roleDefinitionId: `/subscriptions/${input.deploymentInputs.identity.subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/${roleId}`,
    },
    {
      id: `${accountId}/sqlRoleAssignments/${roleId}`,
      type: 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments',
      scope: accountId,
      roleDefinitionId: `${accountId}/sqlRoleDefinitions/00000000-0000-0000-0000-000000000002`,
    },
  ].map((role) => ({ ...role, kind: 'azure-role-assignment', principalId, lifecycleState: 'present' }));
  const entries = [
    {
      id: accountId, kind: 'azure-resource',
      type: 'Microsoft.DocumentDB/databaseAccounts',
      scope: ids.resourceGroup, lifecycleState: 'present',
    },
    ...roles,
  ];
  input.outputSeed.createdResourceIds.push(...entries.map((entry) => entry.id));
  input.outputSeed.createdAzureRoleAssignmentIds.push(...roles.map((entry) => entry.id));
  input.creationReceipts[0].createdResourceIds.push(...entries.map((entry) => entry.id));
  input.authoritativeReadback.entries.push(...entries);
  resign(input.creationReceipts[0]);
  resign(input.authoritativeReadback);
  return resign(input);
}

function protectedFoundryRoleGenerationInput() {
  const input = generationInput();
  const functionId = `${ids.resourceGroup}/providers/Microsoft.Web/sites/func-governance`;
  const owners = [
    {
      id: functionId,
      principalId: '77777777-7777-4777-8777-777777777777',
      type: 'Microsoft.Web/sites',
    },
    {
      id: ids.apiManagement,
      principalId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      type: 'Microsoft.ApiManagement/service',
    },
  ];
  input.outputSeed.createdResourceIds.push(functionId);
  input.creationReceipts[0].createdResourceIds.push(functionId);
  input.authoritativeReadback.entries.push({
    ...owners[0],
    kind: 'azure-resource',
    scope: ids.resourceGroup,
    lifecycleState: 'present',
  });
  input.authoritativeReadback.entries.find((entry) => entry.id === ids.apiManagement).principalId =
    owners[1].principalId;
  const exceptions = [
    ['88888888-8888-4888-8888-888888888888', '99999999-9999-4999-8999-999999999999'],
    ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
  ].map(([roleId, definitionId], index) => {
    const owner = owners[index];
    const roleAssignmentId = `${ids.foundryAccount}/providers/Microsoft.Authorization/roleAssignments/${roleId}`;
    const roleDefinitionId = `/subscriptions/${input.deploymentInputs.identity.subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/${definitionId}`;
    input.outputSeed.createdResourceIds.push(roleAssignmentId);
    input.outputSeed.createdAzureRoleAssignmentIds.push(roleAssignmentId);
    input.creationReceipts[0].createdResourceIds.push(roleAssignmentId);
    input.authoritativeReadback.entries.push({
      id: roleAssignmentId,
      kind: 'azure-role-assignment',
      type: 'Microsoft.Authorization/roleAssignments',
      scope: ids.foundryAccount,
      principalId: owner.principalId,
      roleDefinitionId,
      lifecycleState: 'present',
    });
    return {
      roleAssignmentId,
      scope: ids.foundryAccount,
      principalId: owner.principalId,
      roleDefinitionId,
      principalResourceId: owner.id,
    };
  });
  input.deploymentInputs.protectedRoleAssignmentExceptions = exceptions;
  resign(input.creationReceipts[0]);
  resign(input.authoritativeReadback);
  return resign(input);
}

function protectedKeyVaultRoleGenerationInput() {
  const input = generationInput({ existingResourceGroup: true });
  const functionId = `${ids.resourceGroup}/providers/Microsoft.Web/sites/func-governance`;
  const principalId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const roleAssignmentId =
    `${ids.keyVault}/providers/Microsoft.Authorization/roleAssignments/ffffffff-ffff-4fff-8fff-ffffffffffff`;
  const roleDefinitionId =
    `/subscriptions/${input.deploymentInputs.identity.subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/4633458b-17de-408a-b874-0445c86b69e6`;
  input.outputSeed.createdResourceIds.push(functionId, roleAssignmentId);
  input.outputSeed.createdAzureRoleAssignmentIds.push(roleAssignmentId);
  input.creationReceipts[0].createdResourceIds.push(functionId, roleAssignmentId);
  input.authoritativeReadback.entries.push(
    {
      id: functionId,
      kind: 'azure-resource',
      type: 'Microsoft.Web/sites',
      resourceKind: 'functionapp,linux',
      scope: ids.resourceGroup,
      principalId,
      lifecycleState: 'present',
    },
    {
      id: roleAssignmentId,
      kind: 'azure-role-assignment',
      type: 'Microsoft.Authorization/roleAssignments',
      scope: ids.keyVault,
      principalId,
      roleDefinitionId,
      lifecycleState: 'present',
    },
  );
  input.deploymentInputs.protectedRoleAssignmentExceptions = [{
    roleAssignmentId,
    scope: ids.keyVault,
    principalId,
    roleDefinitionId,
    principalResourceId: functionId,
  }];
  input.deploymentInputs.preexistingResourceIds.push(ids.keyVault);
  input.deploymentInputs.protectedTargets.push(ids.keyVault);
  resign(input.creationReceipts[0]);
  resign(input.authoritativeReadback);
  return resign(input);
}

test('exact Key Vault Secrets User grant for a new Function is previewed while vault remains protected', () => {
  const input = protectedKeyVaultRoleGenerationInput();
  const exception = input.deploymentInputs.protectedRoleAssignmentExceptions[0];
  const bundle = generateOwnershipEvidence(input, NOW);
  assert.deepEqual(verifyOwnershipEvidenceBundle(bundle, NOW), bundle);
  assert.ok(bundle.preview.delete.resources.includes(exception.roleAssignmentId));
  assert.equal(bundle.preview.delete.resources.includes(ids.keyVault), false);
  assert.ok(bundle.preview.preserve.some((entry) => entry.id === ids.keyVault));
});

test('protected Key Vault exception denies web apps, missing Function evidence, other roles, and broad scopes', () => {
  const defaultDenied = protectedKeyVaultRoleGenerationInput();
  delete defaultDenied.deploymentInputs.protectedRoleAssignmentExceptions;
  resign(defaultDenied);
  assert.throws(
    () => generateOwnershipEvidence(defaultDenied, NOW),
    /generation-created-target-is-protected/,
  );
  for (const mode of ['apim', 'webapp', 'missingKind', 'role', 'secret', 'resourceGroup']) {
    const input = protectedKeyVaultRoleGenerationInput();
    const exception = input.deploymentInputs.protectedRoleAssignmentExceptions[0];
    const owner = input.authoritativeReadback.entries.find(
      (entry) => entry.id === exception.principalResourceId,
    );
    if (mode === 'apim') {
      owner.type = 'Microsoft.ApiManagement/service';
    } else if (mode === 'webapp') {
      owner.resourceKind = 'app,linux';
    } else if (mode === 'missingKind') {
      delete owner.resourceKind;
    } else if (mode === 'role') {
      exception.roleDefinitionId =
        `/subscriptions/${input.deploymentInputs.identity.subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/43d0d8ad-25c7-4714-9337-8ba259a9fe05`;
    } else {
      exception.scope = mode === 'secret'
        ? `${ids.keyVault}/secrets/principal-key-secret`
        : ids.resourceGroup;
    }
    resign(input.authoritativeReadback);
    resign(input);
    assert.throws(
      () => generateOwnershipEvidence(input, NOW),
      ['apim', 'webapp', 'missingKind'].includes(mode) ? /contract-protected-role-owner-invalid/
        : mode === 'role' ? /contract-protected-key-vault-role-invalid/
          : /contract-protected-role-scope-invalid/,
    );
  }
});

test('Function resource kind is bound through seal and preview readback identity', () => {
  const bundle = generateOwnershipEvidence(protectedKeyVaultRoleGenerationInput(), NOW);
  const functionEntry = bundle.manifest.inventory.entries.find(
    (entry) => entry.type.toLowerCase() === 'microsoft.web/sites',
  );
  assert.equal(functionEntry.resourceKind, 'functionapp,linux');

  const candidate = structuredClone(bundle.candidate);
  candidate.inventory.entries.find((entry) => entry.id === functionEntry.id).resourceKind = 'app,linux';
  assert.throws(() => sealManifest(candidate), /contract-protected-role-owner-invalid/);

  const driftedReadback = structuredClone(bundle.readback);
  driftedReadback.entries.find((entry) => entry.id === functionEntry.id).resourceKind = 'app,linux';
  resign(driftedReadback);
  const preview = createRemovalPreview(bundle.manifest, bundle.state, driftedReadback, NOW);
  assert.equal(preview.status, 'blocked');
  assert.ok(preview.blocked.includes(`identity-mismatch:${functionEntry.id}`));
});

test('exact protected Foundry account role grants for a newly created owned identity are previewed', () => {
  const input = protectedFoundryRoleGenerationInput();
  const originalSeed = structuredClone(input.outputSeed);
  const originalProtectedTargets = structuredClone(input.deploymentInputs.protectedTargets);
  const bundle = generateOwnershipEvidence(input, NOW);
  assert.deepEqual(verifyOwnershipEvidenceBundle(bundle, NOW), bundle);
  assert.equal(digest(bundle.generationInput.outputSeed), digest(originalSeed));
  assert.equal(digest(bundle.manifest.protectedTargets), digest(originalProtectedTargets));
  assert.equal(bundle.manifest.protectedRoleAssignmentExceptions.length, 2);
  assert.equal(
    bundle.state.protectedRoleAssignmentExceptionsDigest,
    bundle.manifest.protectedRoleAssignmentExceptionsDigest,
  );
  assert.equal(
    bundle.readback.protectedRoleAssignmentExceptionsDigest,
    bundle.manifest.protectedRoleAssignmentExceptionsDigest,
  );
  assert.equal(
    bundle.preview.protectedRoleAssignmentExceptionsDigest,
    bundle.manifest.protectedRoleAssignmentExceptionsDigest,
  );
  for (const exception of input.deploymentInputs.protectedRoleAssignmentExceptions) {
    assert.ok(bundle.preview.delete.resources.includes(exception.roleAssignmentId));
  }
  assert.ok(bundle.preview.preserve.some((entry) => entry.id === ids.foundryAccount));
  assert.equal(bundle.preview.delete.resources.includes(ids.foundryAccount), false);
});

test('protected Foundry role exception defaults closed and rejects reused or foreign owners', () => {
  const denied = protectedFoundryRoleGenerationInput();
  delete denied.deploymentInputs.protectedRoleAssignmentExceptions;
  resign(denied);
  assert.throws(() => generateOwnershipEvidence(denied, NOW), /generation-created-target-is-protected/);

  for (const mode of ['reused', 'reusedGrant', 'foreign', 'unsupported']) {
    const input = protectedFoundryRoleGenerationInput();
    const exception = input.deploymentInputs.protectedRoleAssignmentExceptions[0];
    if (mode === 'reused') {
      input.deploymentInputs.preexistingResourceIds.push(exception.principalResourceId);
    } else if (mode === 'reusedGrant') {
      input.deploymentInputs.preexistingResourceIds.push(exception.roleAssignmentId);
    } else if (mode === 'foreign') {
      exception.principalResourceId = exception.principalResourceId.replace(
        input.deploymentInputs.identity.resourceGroupName,
        'rg-foreign',
      );
    } else {
      input.authoritativeReadback.entries.find((entry) => entry.id === exception.principalResourceId).type =
        'Microsoft.ManagedIdentity/userAssignedIdentities';
    }
    resign(input.authoritativeReadback);
    resign(input);
    assert.throws(
      () => generateOwnershipEvidence(input, NOW),
      mode === 'reused' ? /generation-preexisting-not-protected|contract-protected-role-owner-invalid/
        : mode === 'reusedGrant' ? /contract-protected-role-readback-mismatch/
        : /contract-protected-role-owner-invalid/,
    );
  }
});

test('protected Foundry role exception binds exact owner, principal, role, scope, receipts, and freshness', () => {
  const mutations = {
    owner: (input, exception) => { exception.principalResourceId = ids.keyVault; },
    principal: (input, exception) => { exception.principalId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'; },
    role: (input, exception) => {
      exception.roleDefinitionId =
        `/subscriptions/${input.deploymentInputs.identity.subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/dddddddd-dddd-4ddd-8ddd-dddddddddddd`;
    },
    scope: (input, exception) => { exception.scope = `${ids.foundryAccount}/projects/project`; },
    receipt: (input, exception) => {
      input.creationReceipts[0].createdResourceIds =
        input.creationReceipts[0].createdResourceIds.filter((id) => id !== exception.roleAssignmentId);
    },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const input = protectedFoundryRoleGenerationInput();
    mutate(input, input.deploymentInputs.protectedRoleAssignmentExceptions[0]);
    resign(input.creationReceipts[0]);
    resign(input);
    assert.throws(
      () => generateOwnershipEvidence(input, NOW),
      name === 'scope' ? /contract-protected-role-scope-invalid/
        : name === 'receipt' ? /generation-creation-receipt-missing/
          : /contract-protected-role-(owner-invalid|readback-mismatch)/,
      name,
    );
  }
  const stale = protectedFoundryRoleGenerationInput();
  stale.deploymentInputs.createdAt = '2026-09-03T04:59:00.000Z';
  stale.authoritativeReadback.observedAt = '2026-09-03T05:00:00.000Z';
  resign(stale.authoritativeReadback);
  resign(stale);
  assert.throws(() => generateOwnershipEvidence(stale, NOW), /readback-stale/);
});

test('protected role exception is revalidated by seal, state, readback, preview, and bundle verification', () => {
  const bundle = generateOwnershipEvidence(protectedFoundryRoleGenerationInput(), NOW);
  const candidate = structuredClone(bundle.candidate);
  candidate.protectedRoleAssignmentExceptions[0].principalId =
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  candidate.protectedRoleAssignmentExceptionsDigest = digest(candidate.protectedRoleAssignmentExceptions);
  assert.throws(() => sealManifest(candidate), /contract-protected-role-readback-mismatch/);

  for (const document of ['state', 'readback']) {
    const changed = structuredClone(bundle[document]);
    changed.protectedRoleAssignmentExceptionsDigest = digest({ tampered: document });
    resign(changed);
    assert.throws(
      () => createRemovalPreview(
        bundle.manifest,
        document === 'state' ? changed : bundle.state,
        document === 'readback' ? changed : bundle.readback,
        NOW,
      ),
      new RegExp(`${document}-protected-role-exceptions-digest-mismatch`),
    );
  }

  const tampered = structuredClone(bundle);
  tampered.manifest.protectedRoleAssignmentExceptions[0].roleDefinitionId =
    '/subscriptions/foreign/providers/Microsoft.Authorization/roleDefinitions/foreign';
  resign(tampered.manifest);
  resign(tampered);
  assert.throws(
    () => verifyOwnershipEvidenceBundle(tampered, NOW),
    /contract-protected-role-definition-invalid|evidence-bundle-regeneration-mismatch/,
  );
});

test('main resource and role lists can overlap without modifying the emitted seed or duplicating targets', () => {
  const input = overlappingRoleGenerationInput();
  const originalSeed = structuredClone(input.outputSeed);
  const bundle = generateOwnershipEvidence(input, NOW);
  assert.deepEqual(input.outputSeed, originalSeed);
  assert.equal(digest(bundle.generationInput.outputSeed), digest(originalSeed));
  assert.deepEqual(verifyOwnershipEvidenceBundle(bundle, NOW), bundle);
  for (const id of originalSeed.createdAzureRoleAssignmentIds) {
    const entries = bundle.manifest.inventory.entries.filter((entry) => entry.id === id);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, 'azure-role-assignment');
    assert.equal(bundle.preview.delete.resources.filter((target) => target === id).length, 1);
  }
  assert.equal(bundle.preview.mutationImplemented, false);
});

test('overlapping role claims still require creation receipts and specialized authoritative metadata', () => {
  const errors = {
    receipt: /generation-creation-receipt-missing/,
    kind: /generation-created-kind-mismatch/,
    principal: /contract-string-required: .*principalId/,
    definition: /contract-string-required: .*roleDefinitionId/,
  };
  for (const change of ['receipt', 'kind', 'principal', 'definition']) {
    const input = overlappingRoleGenerationInput();
    const id = input.outputSeed.createdAzureRoleAssignmentIds[0];
    const entry = input.authoritativeReadback.entries.find((candidate) => candidate.id === id);
    if (change === 'receipt') {
      input.creationReceipts[0].createdResourceIds = input.creationReceipts[0].createdResourceIds.filter((value) => value !== id);
    } else if (change === 'kind') {
      entry.kind = 'azure-resource';
    } else {
      delete entry[change === 'principal' ? 'principalId' : 'roleDefinitionId'];
    }
    resign(input.creationReceipts[0]);
    resign(input.authoritativeReadback);
    resign(input);
    assert.throws(() => generateOwnershipEvidence(input, NOW), errors[change]);
  }
});

test('unrelated kind conflicts and repeated IDs within a seed list remain invalid', () => {
  const conflict = generationInput();
  conflict.outputSeed.createdGraphAssignmentIds.push(ids.keyVault);
  resign(conflict);
  assert.throws(() => generateOwnershipEvidence(conflict, NOW), /generation-created-kind-conflict/);
  const duplicate = overlappingRoleGenerationInput();
  duplicate.outputSeed.createdAzureRoleAssignmentIds.push(duplicate.outputSeed.createdAzureRoleAssignmentIds[0]);
  resign(duplicate);
  assert.throws(() => generateOwnershipEvidence(duplicate, NOW), /contract-duplicate-value/);
});

function bootstrapGenerationInput() {
  const input = generationInput();
  const secretId = `${ids.keyVault}/secrets/principal-key-secret`;
  const createdResourceIds = [ids.resourceGroup, ids.keyVault, secretId];
  input.deploymentInputs.preexistingResourceIds = [];
  input.outputSeed = {
    schemaVersion: input.outputSeed.schemaVersion,
    identity: input.outputSeed.identity,
    createdResourceIds,
    externalReferences: [],
    keyVaultLifecycle: {
      resourceId: ids.keyVault,
      purgeProtectionEnabled: true,
      softDeleteRetentionInDays: 7,
      deletionDisposition: 'DeletedPendingRetention',
    },
    requiresCreationReceipts: true,
    requiresExactReadback: true,
  };
  input.creationReceipts = [resign({ ...input.creationReceipts[0], createdResourceIds })];
  input.authoritativeReadback.entries = [
    ...input.authoritativeReadback.entries.filter((entry) => createdResourceIds.includes(entry.id)),
    {
      id: secretId,
      kind: 'azure-resource',
      type: 'Microsoft.KeyVault/vaults/secrets',
      scope: ids.keyVault,
      lifecycleState: 'present',
    },
  ];
  resign(input.authoritativeReadback);
  return resign(input);
}

test('the exact standalone bootstrap seed generates evidence without adding main-only fields', () => {
  const input = bootstrapGenerationInput();
  const originalSeed = structuredClone(input.outputSeed);
  const bundle = generateOwnershipEvidence(input, NOW);
  assert.deepEqual(bundle.generationInput.outputSeed, originalSeed);
  assert.deepEqual(input.outputSeed, originalSeed);
  assert.deepEqual(verifyOwnershipEvidenceBundle(bundle, NOW), bundle);
  assert.equal(bundle.preview.status, 'ready');
  assert.equal(bundle.preview.mutationImplemented, false);
  assert.deepEqual(new Set(bundle.preview.delete.resources), new Set(originalSeed.createdResourceIds));
  assert.deepEqual(bundle.preview.purgeEligible.keyVault, []);
  const vault = bundle.manifest.inventory.entries.find((entry) => entry.id === ids.keyVault);
  assert.equal(vault.purgeProtectionEnabled, true);
  assert.equal(vault.softDeleteRetentionInDays, 7);
});

test('bootstrap lifecycle must identify its exact claimed vault and agree with readback', () => {
  for (const resourceId of [ids.apiManagement, `${ids.keyVault}/secrets/principal-key-secret`]) {
    const input = bootstrapGenerationInput();
    input.outputSeed.keyVaultLifecycle.resourceId = resourceId;
    resign(input);
    assert.throws(() => generateOwnershipEvidence(input, NOW), /generation-key-vault-resource-id-mismatch/);
  }
  const input = bootstrapGenerationInput();
  input.authoritativeReadback.entries.find((entry) => entry.id === ids.keyVault).purgeProtectionEnabled = false;
  resign(input.authoritativeReadback);
  resign(input);
  assert.throws(() => generateOwnershipEvidence(input, NOW), /generation-key-vault-readback-mismatch/);
});

test('bootstrap support does not relax main fields, creation proof, or unknown-field rejection', () => {
  for (const field of [
    'createdAzureRoleAssignmentIds', 'createdDirectoryObjects', 'createdGraphAssignmentIds', 'protectedResourceIds',
  ]) {
    const input = generationInput();
    delete input.outputSeed[field];
    resign(input);
    assert.throws(() => generateOwnershipEvidence(input, NOW), /contract-array-required/);
  }
  const missingReceipt = bootstrapGenerationInput();
  missingReceipt.creationReceipts = [];
  resign(missingReceipt);
  assert.throws(() => generateOwnershipEvidence(missingReceipt, NOW), /generation-creation-receipt-missing/);

  for (const input of [generationInput(), bootstrapGenerationInput()]) {
    input.outputSeed.keyVaultLifecycle.unrecognized = true;
    resign(input);
    assert.throws(() => generateOwnershipEvidence(input, NOW), /contract-unknown-field/);
  }
  const mixed = generationInput();
  mixed.outputSeed.keyVaultLifecycle.resourceId = ids.keyVault;
  resign(mixed);
  assert.throws(() => generateOwnershipEvidence(mixed, NOW), /contract-unknown-field/);
});

test('mixed created, reused, and protected evidence generates a sealed ready removal preview', () => {
  const input = generationInput();
  const bundle = generateOwnershipEvidence(input, NOW);
  assert.equal(bundle.manifest.sealed, true);
  assert.equal(bundle.preview.status, 'ready');
  assert.equal(bundle.preview.mutationImplemented, false);
  assert.deepEqual(verifyOwnershipEvidenceBundle(bundle, NOW), bundle);

  const classifications = new Map(
    bundle.manifest.inventory.entries.map((entry) => [entry.id, entry.classification]),
  );
  assert.equal(classifications.get(ids.resourceGroup), 'created');
  assert.equal(classifications.get(ids.foundryAccount), 'external-reference');
  assert.equal(classifications.get(ids.protectedApplication), 'protected-preexisting');
  assert.ok(bundle.preview.delete.resources.includes(ids.resourceGroup));
  assert.equal(bundle.preview.delete.resources.includes(ids.foundryAccount), false);
  assert.ok(bundle.preview.preserve.some((entry) => entry.id === ids.foundryAccount));
  assert.ok(bundle.preview.preserve.some((entry) => entry.id === ids.protectedApplication));
});

test('an existing resource group is protected even when deployment output names it', () => {
  const bundle = generateOwnershipEvidence(generationInput({ existingResourceGroup: true }), NOW);
  const resourceGroup = bundle.manifest.inventory.entries.find((entry) => entry.id === ids.resourceGroup);
  assert.equal(resourceGroup.classification, 'protected-preexisting');
  assert.equal(bundle.preview.delete.resources.includes(ids.resourceGroup), false);
  assert.ok(bundle.preview.preserve.some((entry) => entry.id === ids.resourceGroup));
});

test('outputs alone cannot prove creation and exact-ID conflicts or readback gaps are rejected', () => {
  const missingReceipt = generationInput();
  missingReceipt.creationReceipts[0].createdResourceIds = missingReceipt.creationReceipts[0].createdResourceIds
    .filter((id) => id !== ids.apiManagement);
  resign(missingReceipt.creationReceipts[0]);
  resign(missingReceipt);
  assert.throws(
    () => generateOwnershipEvidence(missingReceipt, NOW),
    /generation-creation-receipt-missing/,
  );

  const conflict = generationInput();
  conflict.outputSeed.externalReferences.push({
    id: ids.apiManagement,
    classification: 'external-reference',
  });
  resign(conflict);
  assert.throws(() => generateOwnershipEvidence(conflict, NOW), /generation-classification-conflict/);

  const missingReadback = generationInput();
  missingReadback.authoritativeReadback.entries = missingReadback.authoritativeReadback.entries
    .filter((entry) => entry.id !== ids.keyVault);
  resign(missingReadback.authoritativeReadback);
  resign(missingReadback);
  assert.throws(() => generateOwnershipEvidence(missingReadback, NOW), /generation-readback-id-missing/);

  const unexpectedReceipt = generationInput();
  unexpectedReceipt.creationReceipts[0].createdResourceIds.push('/subscriptions/unknown/resource');
  resign(unexpectedReceipt.creationReceipts[0]);
  resign(unexpectedReceipt);
  assert.throws(() => generateOwnershipEvidence(unexpectedReceipt, NOW), /generation-receipt-id-unexpected/);
});

test('tampering and stale readback block bundle verification and removal preview', () => {
  const bundle = generateOwnershipEvidence(generationInput(), NOW);
  const changed = structuredClone(bundle);
  changed.manifest.inventory.entries[0].type = 'Microsoft.Storage/storageAccounts';
  assert.throws(() => verifyOwnershipEvidenceBundle(changed, NOW), /contract-canonical-digest-mismatch/);
  assert.throws(
    () => verifyOwnershipEvidenceBundle(bundle, new Date('2026-09-03T06:36:00.001Z')),
    /readback-stale/,
  );
});

test('generated bundle flows through the local-only PowerShell removal preview', {
  skip: process.platform !== 'win32',
}, () => {
  const parent = path.join(repositoryRoot, 'tests', 'distribution', '.test-work');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'ownership-generation-'));
  try {
    const bundlePath = path.join(directory, 'bundle.json');
    const previewPath = path.join(directory, 'preview.json');
    const now = new Date();
    const input = generationInput({
      createdAt: new Date(now.valueOf() - 120_000).toISOString(),
      readbackObservedAt: new Date(now.valueOf() - 30_000).toISOString(),
    });
    writeFileSync(bundlePath, JSON.stringify(generateOwnershipEvidence(input, now)));
    const result = spawnSync('pwsh', [
      '-NoProfile',
      '-File',
      removeScript,
      '-EvidenceBundlePath',
      bundlePath,
      '-Preview',
      '-OutputPath',
      previewPath,
    ], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: { ...process.env, TZ: 'UTC' },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const preview = JSON.parse(readFileSync(previewPath, 'utf8'));
    assert.equal(preview.schemaVersion, 'llm-governance-removal-preview/v1');
    assert.equal(preview.status, 'ready');
    assert.equal(preview.mutationImplemented, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('postprovision generation is opt-in and refuses partial configuration', () => {
  const workflow = readFileSync(path.join(repositoryRoot, 'azure.yaml'), 'utf8');
  assert.match(
    workflow,
    /postprovision:[\s\S]*Repair-EasyAuthClientAllowlist\.mjs[\s\S]*ownership-contract\.mjs generate-if-configured/,
  );
  const environment = { ...process.env };
  delete environment.OWNERSHIP_GENERATION_INPUT_FILE;
  delete environment.OWNERSHIP_EVIDENCE_BUNDLE_FILE;
  const absent = spawnSync(process.execPath, [contractEngine, 'generate-if-configured'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: environment,
  });
  assert.equal(absent.status, 0, absent.stderr);
  assert.equal(absent.stdout, '');

  const partial = spawnSync(process.execPath, [contractEngine, 'generate-if-configured'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: {
      ...environment,
      OWNERSHIP_GENERATION_INPUT_FILE: 'input.json',
    },
  });
  assert.equal(partial.status, 1);
  assert.match(partial.stderr, /generation-environment-incomplete/);

  const parent = path.join(repositoryRoot, 'tests', 'distribution', '.test-work');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'ownership-hook-'));
  try {
    const inputPath = path.join(directory, 'generation-input.json');
    const outputPath = path.join(directory, 'evidence-bundle.json');
    const now = new Date();
    writeFileSync(inputPath, JSON.stringify(generationInput({
      createdAt: new Date(now.valueOf() - 120_000).toISOString(),
      readbackObservedAt: new Date(now.valueOf() - 30_000).toISOString(),
    })));
    const generated = spawnSync(process.execPath, [contractEngine, 'generate-if-configured'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...environment,
        OWNERSHIP_GENERATION_INPUT_FILE: inputPath,
        OWNERSHIP_EVIDENCE_BUNDLE_FILE: outputPath,
      },
    });
    assert.equal(generated.status, 0, generated.stderr);
    const bundle = JSON.parse(readFileSync(outputPath, 'utf8'));
    assert.equal(bundle.schemaVersion, 'llm-governance-ownership-evidence-bundle/v1');
    assert.equal(bundle.preview.status, 'ready');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
