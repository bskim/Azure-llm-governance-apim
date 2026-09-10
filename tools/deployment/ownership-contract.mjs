#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const identityKeys = Object.freeze([
  'tenantId',
  'subscriptionId',
  'environmentName',
  'resourceGroupName',
  'resourceGroupId',
  'location',
]);

const schemaVersions = Object.freeze({
  preflight: 'llm-governance-create-only-preflight/v1',
  candidate: 'llm-governance-ownership-candidate/v1',
  manifest: 'llm-governance-ownership-manifest/v1',
  state: 'llm-governance-ownership-state/v1',
  readback: 'llm-governance-ownership-readback/v1',
  preview: 'llm-governance-removal-preview/v1',
  approval: 'llm-governance-removal-approval/v1',
  authorization: 'llm-governance-removal-authorization/v1',
});

const classifications = new Set(['created', 'external-reference', 'protected-preexisting']);
const entryKinds = new Set([
  'azure-resource',
  'azure-role-assignment',
  'deployment-record',
  'entra-application',
  'entra-service-principal',
  'graph-assignment',
]);
const lifecycleStates = new Set(['present', 'absent', 'soft-deleted']);
const approvalPhases = new Set([
  'resource-delete',
  'entra-cleanup',
  'entra-purge',
  'apim-purge',
  'key-vault-purge',
]);
const readbackMaximumAgeMilliseconds = 30 * 60 * 1000;
const readbackMaximumAgeSeconds = readbackMaximumAgeMilliseconds / 1000;

function fail(code, detail = '') {
  const suffix = detail ? `: ${detail}` : '';
  throw new Error(`${code}${suffix}`);
}

function requireObject(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('contract-object-required', name);
  return value;
}

function requireArray(value, name) {
  if (!Array.isArray(value)) fail('contract-array-required', name);
  return value;
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) fail('contract-string-required', name);
  return value;
}

function requireDigest(value, name) {
  requireString(value, name);
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) fail('contract-digest-invalid', name);
  return value;
}

function requireGuid(value, name) {
  requireString(value, name);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    fail('contract-guid-invalid', name);
  }
  return value;
}

function requireAppRoleId(value, name) {
  if (value === '00000000-0000-0000-0000-000000000000') return value;
  return requireGuid(value, name);
}

function requireCommit(value, name) {
  requireString(value, name);
  if (!/^[a-f0-9]{40}([a-f0-9]{24})?$/i.test(value)) fail('contract-source-commit-invalid', name);
  return value;
}

function requireTimestamp(value, name) {
  const parsed = new Date(requireString(value, name));
  if (Number.isNaN(parsed.valueOf())) fail('contract-timestamp-invalid', name);
  return parsed;
}

function requireClock(now) {
  const parsed = now instanceof Date ? new Date(now.valueOf()) : new Date(now);
  if (Number.isNaN(parsed.valueOf())) fail('contract-clock-invalid');
  return parsed;
}

function requireOnlyKeys(value, allowed, name) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) fail('contract-unknown-field', `${name}.${unknown.sort()[0]}`);
}

function normalized(value) {
  if (Array.isArray(value)) {
    return value.map(normalized).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalized(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(normalized(value));
}

export function digest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

function withoutDigest(value) {
  const copy = structuredClone(value);
  delete copy.canonicalDigest;
  return copy;
}

function assertCanonicalDigest(value, name) {
  requireDigest(value.canonicalDigest, `${name}.canonicalDigest`);
  const actual = digest(withoutDigest(value));
  if (value.canonicalDigest !== actual) fail('contract-canonical-digest-mismatch', name);
}

function assertIdentity(identity, name, expected = null) {
  requireObject(identity, name);
  requireOnlyKeys(identity, identityKeys, name);
  requireGuid(identity.tenantId, `${name}.tenantId`);
  requireGuid(identity.subscriptionId, `${name}.subscriptionId`);
  for (const key of identityKeys.slice(2)) requireString(identity[key], `${name}.${key}`);
  const expectedResourceGroupId = `/subscriptions/${identity.subscriptionId}/resourceGroups/${identity.resourceGroupName}`;
  if (identity.resourceGroupId.toLowerCase() !== expectedResourceGroupId.toLowerCase()) {
    fail('contract-identity-resource-group-mismatch', name);
  }
  if (expected !== null) {
    for (const key of identityKeys) {
      if (identity[key] !== expected[key]) fail('contract-identity-mismatch', `${name}.${key}`);
    }
  }
}

function assertStringSet(values, name) {
  const list = requireArray(values, name).map((value, index) => requireString(value, `${name}[${index}]`));
  const unique = new Set(list);
  if (unique.size !== list.length) fail('contract-duplicate-value', name);
  return [...unique].sort();
}

function assertProtectedTargets(targets, name) {
  const actual = assertStringSet(targets, name);
  if (actual.length === 0) fail('contract-protected-targets-empty', name);
  return actual;
}

// Enumerated protected C0 identifiers/tokens. Matching is exact-segment or
// exact-prefix against this list, never a bare substring test: a substring
// test on "c0" also matches unrelated GUIDs and resource names that merely
// contain that character pair (for example a role-assignment GUID or a
// resource name like `func-account0-eus2`), which would wrongly deny
// legitimate created ownership.
function isStructurallyProtected(id, protectedTargets) {
  const candidate = id.toLowerCase();
  return protectedTargets.some((target) => {
    const prefix = target.toLowerCase();
    return candidate === prefix || candidate.startsWith(`${prefix}/`);
  });
}

function assertCreation(creation, name, expectedOperationId) {
  requireObject(creation, name);
  requireOnlyKeys(creation, ['operationId', 'deploymentId', 'correlationId', 'receiptDigest'], name);
  if (requireString(creation.operationId, `${name}.operationId`) !== expectedOperationId) {
    fail('contract-creation-operation-mismatch', name);
  }
  requireString(creation.deploymentId, `${name}.deploymentId`);
  requireString(creation.correlationId, `${name}.correlationId`);
  requireDigest(creation.receiptDigest, `${name}.receiptDigest`);
}

function assertEntry(entry, index, operationId, allowLifecycle) {
  const name = `inventory.entries[${index}]`;
  requireObject(entry, name);
  const allowed = [
    'id',
    'kind',
    'type',
    'scope',
    'classification',
    'creation',
    'objectId',
    'appId',
    'applicationObjectId',
    'principalId',
    'resourceId',
    'appRoleId',
    'roleDefinitionId',
    'purgeProtectionEnabled',
    'softDeleteRetentionInDays',
    'lifecycleState',
    'purgeEligible',
    'retentionUntil',
    'unchanged',
  ];
  requireOnlyKeys(entry, allowLifecycle ? allowed : allowed.filter((key) => ![
    'lifecycleState',
    'purgeEligible',
    'retentionUntil',
    'unchanged',
  ].includes(key)), name);
  requireString(entry.id, `${name}.id`);
  if (!entryKinds.has(entry.kind)) fail('contract-entry-kind-invalid', name);
  requireString(entry.type, `${name}.type`);
  requireString(entry.scope, `${name}.scope`);
  if (!classifications.has(entry.classification)) fail('contract-classification-invalid', name);

  if (entry.classification === 'created' && !allowLifecycle) {
    assertCreation(entry.creation, `${name}.creation`, operationId);
  } else if (entry.classification !== 'created' && 'creation' in entry) {
    fail('contract-noncreated-entry-has-creation', entry.id);
  }

  if (entry.kind === 'entra-application') {
    if (requireString(entry.objectId, `${name}.objectId`) !== entry.id) fail('contract-object-id-mismatch', entry.id);
    requireGuid(entry.appId, `${name}.appId`);
  }
  if (entry.kind === 'entra-service-principal') {
    if (requireString(entry.objectId, `${name}.objectId`) !== entry.id) fail('contract-object-id-mismatch', entry.id);
    requireGuid(entry.appId, `${name}.appId`);
    requireString(entry.applicationObjectId, `${name}.applicationObjectId`);
  }
  if (entry.kind === 'graph-assignment') {
    requireString(entry.principalId, `${name}.principalId`);
    requireString(entry.resourceId, `${name}.resourceId`);
    requireAppRoleId(entry.appRoleId, `${name}.appRoleId`);
  }
  if (entry.kind === 'azure-role-assignment') {
    requireString(entry.principalId, `${name}.principalId`);
    requireString(entry.roleDefinitionId, `${name}.roleDefinitionId`);
  }
  if (entry.classification === 'created' && entry.type.toLowerCase() === 'microsoft.keyvault/vaults') {
    if (entry.purgeProtectionEnabled !== true || entry.softDeleteRetentionInDays !== 7) {
      fail('contract-key-vault-retention-posture-invalid', entry.id);
    }
  }

  if (allowLifecycle) {
    if (!lifecycleStates.has(entry.lifecycleState)) fail('contract-lifecycle-state-invalid', entry.id);
    if (entry.classification !== 'created' && entry.unchanged !== true) {
      fail('contract-protected-readback-not-unchanged', entry.id);
    }
    if (entry.purgeEligible !== undefined && typeof entry.purgeEligible !== 'boolean') {
      fail('contract-purge-eligibility-invalid', entry.id);
    }
    if (entry.retentionUntil !== undefined) requireString(entry.retentionUntil, `${name}.retentionUntil`);
  }
}

function assertInventory(inventory, operationId, allowLifecycle) {
  requireObject(inventory, 'inventory');
  requireOnlyKeys(inventory, ['entries'], 'inventory');
  const entries = requireArray(inventory.entries, 'inventory.entries');
  entries.forEach((entry, index) => assertEntry(entry, index, operationId, allowLifecycle));
  const ids = entries.map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) fail('contract-duplicate-entry-id');

  const applications = new Map(
    entries.filter((entry) => entry.kind === 'entra-application')
      .map((entry) => [entry.objectId, entry]),
  );
  for (const principal of entries.filter((entry) => entry.kind === 'entra-service-principal')) {
    const application = applications.get(principal.applicationObjectId);
    if (!application || application.appId !== principal.appId) {
      fail('contract-service-principal-link-mismatch', principal.id);
    }
  }
  return entries;
}

function entryIdentity(entry) {
  const copy = structuredClone(entry);
  delete copy.creation;
  delete copy.lifecycleState;
  delete copy.purgeEligible;
  delete copy.retentionUntil;
  delete copy.unchanged;
  return normalized(copy);
}

function assertEvidence(evidence, name) {
  requireObject(evidence, name);
  requireOnlyKeys(evidence, ['approvedPlanDigest', 'previewDigest', 'readbackDigest'], name);
  requireDigest(evidence.approvedPlanDigest, `${name}.approvedPlanDigest`);
  requireDigest(evidence.previewDigest, `${name}.previewDigest`);
  requireDigest(evidence.readbackDigest, `${name}.readbackDigest`);
}

function foundryEntries(identity, foundry) {
  const resourceGroupId = `/subscriptions/${identity.subscriptionId}/resourceGroups/${foundry.resourceGroupName}`;
  const accountId = `${resourceGroupId}/providers/Microsoft.CognitiveServices/accounts/${foundry.accountName}`;
  const entries = [
    { id: accountId, type: 'Microsoft.CognitiveServices/accounts' },
    { id: `${accountId}/projects/${foundry.projectName}`, type: 'Microsoft.CognitiveServices/accounts/projects' },
    { id: `${accountId}/deployments/${foundry.deploymentName}`, type: 'Microsoft.CognitiveServices/accounts/deployments' },
  ];
  for (const deployment of foundry.secondModelDeployments ?? []) {
    entries.push({
      id: `${accountId}/deployments/${deployment.deploymentName}`,
      type: 'Microsoft.CognitiveServices/accounts/deployments',
    });
  }
  return entries;
}

export function parseSecondModelDeployments(environment) {
  const source = typeof environment.FOUNDRY_SECOND_MODEL_DEPLOYMENTS === 'string'
    && environment.FOUNDRY_SECOND_MODEL_DEPLOYMENTS.trim()
    ? environment.FOUNDRY_SECOND_MODEL_DEPLOYMENTS.trim()
    : '[]';
  let deployments;
  try {
    deployments = JSON.parse(source);
  } catch {
    fail('second-model-deployments-json-invalid');
  }
  if (!Array.isArray(deployments) || deployments.length > 1) fail('second-model-deployments-invalid');
  for (const deployment of deployments) {
    requireObject(deployment, 'secondModelDeployments[]');
    requireOnlyKeys(deployment, ['deploymentName', 'modelName', 'modelVersion', 'modelFormat', 'skuName', 'capacity'], 'secondModelDeployments[]');
    for (const key of ['deploymentName', 'modelName', 'modelVersion', 'modelFormat', 'skuName']) {
      requireString(deployment[key], `secondModelDeployments[].${key}`);
    }
    if (!Number.isSafeInteger(deployment.capacity) || deployment.capacity < 1) {
      fail('second-model-deployments-capacity-invalid');
    }
  }
  return normalized(deployments);
}

function assertFoundryPreflight(preflight, environment) {
  const foundry = requireObject(preflight.foundry, 'preflight.foundry');
  requireOnlyKeys(foundry, [
    'resourceGroupName',
    'accountName',
    'projectName',
    'deploymentName',
    'classification',
    'freshFoundry',
    'secondModelDeployments',
  ], 'preflight.foundry');
  const freshFoundry = foundry.freshFoundry === undefined ? false : foundry.freshFoundry;
  if (typeof freshFoundry !== 'boolean') fail('preflight-foundry-fresh-invalid');
  for (const key of ['resourceGroupName', 'accountName', 'projectName', 'deploymentName']) {
    requireString(foundry[key], `preflight.foundry.${key}`);
    requireString(environment[{
      resourceGroupName: 'FOUNDRY_RESOURCE_GROUP_NAME',
      accountName: 'FOUNDRY_ACCOUNT_NAME',
      projectName: 'FOUNDRY_PROJECT_NAME',
      deploymentName: 'FOUNDRY_DEFAULT_MODEL_DEPLOYMENT',
    }[key]], `environment.${key}`);
  }
  const secondModelDeployments = parseSecondModelDeployments(environment);
  const declaredSecond = foundry.secondModelDeployments ?? [];
  const preflightSecondDeployments = parseSecondModelDeployments({
    FOUNDRY_SECOND_MODEL_DEPLOYMENTS: JSON.stringify(declaredSecond),
  });
  if (canonicalJson(preflightSecondDeployments) !== canonicalJson(secondModelDeployments)) {
    fail('preflight-foundry-mismatch', 'secondModelDeployments');
  }
  if (secondModelDeployments.length > 0 && !freshFoundry) {
    fail('preflight-second-foundry-requires-fresh-mode');
  }
  const expectedFoundry = {
    resourceGroupName: environment.FOUNDRY_RESOURCE_GROUP_NAME?.trim(),
    accountName: environment.FOUNDRY_ACCOUNT_NAME?.trim(),
    projectName: environment.FOUNDRY_PROJECT_NAME?.trim(),
    deploymentName: environment.FOUNDRY_DEFAULT_MODEL_DEPLOYMENT?.trim(),
    classification: freshFoundry ? 'created' : 'external-reference',
  };
  for (const [key, expected] of Object.entries(expectedFoundry)) {
    if (foundry[key] !== expected) fail('preflight-foundry-mismatch', key);
  }
  if (environment.CREATE_FOUNDRY?.trim() !== String(freshFoundry)) {
    fail('preflight-environment-mismatch', 'CREATE_FOUNDRY');
  }
  if (freshFoundry && foundry.resourceGroupName !== preflight.identity.resourceGroupName) {
    fail('preflight-fresh-foundry-resource-group-mismatch');
  }
  return { foundry, freshFoundry };
}

function assertFoundryManifestContinuity(preflight, manifest) {
  const { foundry, freshFoundry } = assertFoundryPreflight(preflight, {
    CREATE_FOUNDRY: String(preflight.foundry.freshFoundry ?? false),
    FOUNDRY_RESOURCE_GROUP_NAME: preflight.foundry.resourceGroupName,
    FOUNDRY_ACCOUNT_NAME: preflight.foundry.accountName,
    FOUNDRY_PROJECT_NAME: preflight.foundry.projectName,
    FOUNDRY_DEFAULT_MODEL_DEPLOYMENT: preflight.foundry.deploymentName,
    FOUNDRY_SECOND_MODEL_DEPLOYMENTS: JSON.stringify(preflight.foundry.secondModelDeployments ?? []),
  });
  const entries = new Map(manifest.inventory.entries.map((entry) => [entry.id.toLowerCase(), entry]));
  const expectedEntries = foundryEntries(manifest.header.identity, foundry);
  const expectedIds = new Set(expectedEntries.map((entry) => entry.id.toLowerCase()));
  for (const expected of expectedEntries) {
    const entry = entries.get(expected.id.toLowerCase());
    if (!entry || entry.type.toLowerCase() !== expected.type.toLowerCase()
      || entry.classification !== (freshFoundry ? 'created' : 'external-reference')) {
      fail('verification-continuation-foundry-ownership-mismatch', expected.id);
    }
    if (!freshFoundry && !manifest.protectedTargets.some((target) => target.toLowerCase() === expected.id.toLowerCase())) {
      fail('verification-continuation-external-foundry-not-protected', expected.id);
    }
  }
  const createdFoundryIds = manifest.inventory.entries
    .filter((entry) => entry.classification === 'created'
      && [
        'microsoft.cognitiveservices/accounts',
        'microsoft.cognitiveservices/accounts/projects',
        'microsoft.cognitiveservices/accounts/deployments',
      ].includes(entry.type.toLowerCase()))
    .map((entry) => entry.id.toLowerCase());
  if (freshFoundry && (createdFoundryIds.length !== expectedIds.size
    || createdFoundryIds.some((id) => !expectedIds.has(id)))) {
    fail('verification-continuation-unexpected-created-foundry');
  }
  if (!freshFoundry && createdFoundryIds.length) fail('verification-continuation-unexpected-created-foundry');
  return { foundry, freshFoundry };
}

export function validateCreateOnlyPreflight(preflight, environment, approvedPlanDigest, now = new Date()) {
  requireObject(preflight, 'preflight');
  requireOnlyKeys(preflight, [
    'schemaVersion',
    'identity',
    'approvedPlanDigest',
    'sourceCommit',
    'previewDigest',
    'creationOperationId',
    'stage',
    'observedAt',
    'validUntil',
    'resourceGroup',
    'foundry',
    'activeNameCollisions',
    'softDeletedNameCollisions',
    'entraCollisions',
    'protectedTargets',
    'protectedTargetsDigest',
    'canonicalDigest',
  ], 'preflight');
  if (preflight.schemaVersion !== schemaVersions.preflight) fail('preflight-schema-version-invalid');
  assertIdentity(preflight.identity, 'preflight.identity');
  if (preflight.approvedPlanDigest !== approvedPlanDigest) fail('preflight-plan-digest-mismatch');
  requireDigest(preflight.approvedPlanDigest, 'preflight.approvedPlanDigest');
  requireString(preflight.sourceCommit, 'preflight.sourceCommit');
  requireDigest(preflight.previewDigest, 'preflight.previewDigest');
  requireString(preflight.creationOperationId, 'preflight.creationOperationId');
  const stage = preflight.stage === undefined && preflight.foundry?.freshFoundry !== true
    ? 'postprovision'
    : preflight.stage;
  if (!['bootstrap', 'postprovision'].includes(stage)) fail('preflight-stage-invalid');
  if ((environment.OWNERSHIP_VALIDATION_STAGE?.trim() || 'postprovision') !== stage) {
    fail('preflight-environment-mismatch', 'OWNERSHIP_VALIDATION_STAGE');
  }
  const observedAt = new Date(requireString(preflight.observedAt, 'preflight.observedAt'));
  const validUntil = new Date(requireString(preflight.validUntil, 'preflight.validUntil'));
  if (Number.isNaN(observedAt.valueOf()) || Number.isNaN(validUntil.valueOf()) || validUntil <= observedAt) {
    fail('preflight-window-invalid');
  }
  if (now > validUntil) fail('preflight-stale');

  const resourceGroup = requireObject(preflight.resourceGroup, 'preflight.resourceGroup');
  requireOnlyKeys(resourceGroup, ['id', 'exists'], 'preflight.resourceGroup');
  if (resourceGroup.id !== preflight.identity.resourceGroupId || resourceGroup.exists !== false) {
    fail('preflight-resource-group-not-create-only');
  }

  const { freshFoundry } = assertFoundryPreflight(preflight, environment);

  for (const field of ['activeNameCollisions', 'softDeletedNameCollisions', 'entraCollisions']) {
    if (requireArray(preflight[field], `preflight.${field}`).length !== 0) fail('preflight-collision-detected', field);
  }
  const protectedTargets = assertProtectedTargets(preflight.protectedTargets, 'preflight.protectedTargets');
  if (preflight.protectedTargetsDigest !== digest(protectedTargets)) fail('preflight-protected-digest-mismatch');

  const requiredEnvironment = {
    AZURE_TENANT_ID: preflight.identity.tenantId,
    AZURE_SUBSCRIPTION_ID: preflight.identity.subscriptionId,
    AZURE_ENV_NAME: preflight.identity.environmentName,
    AZURE_LOCATION: preflight.identity.location,
    GATEWAY_RESOURCE_GROUP_NAME: preflight.identity.resourceGroupName,
    CREATE_FOUNDRY: String(freshFoundry),
  };
  for (const [key, expected] of Object.entries(requiredEnvironment)) {
    if (environment[key]?.trim() !== expected) fail('preflight-environment-mismatch', key);
  }
  assertCanonicalDigest(preflight, 'preflight');
  return Object.freeze({
    mode: freshFoundry ? 'verification-create-only-fresh-foundry' : 'verification-create-only-external-foundry',
    freshFoundry,
    creationOperationId: preflight.creationOperationId,
    preflightDigest: preflight.canonicalDigest,
    approvedPlanDigest,
  });
}

export function sealManifest(candidate) {
  requireObject(candidate, 'candidate');
  requireOnlyKeys(candidate, [
    'schemaVersion',
    'manifestVersion',
    'header',
    'inventory',
    'evidence',
    'protectedTargets',
    'protectedTargetsDigest',
  ], 'candidate');
  if (candidate.schemaVersion !== schemaVersions.candidate) fail('candidate-schema-version-invalid');
  if (!Number.isSafeInteger(candidate.manifestVersion) || candidate.manifestVersion < 1) {
    fail('manifest-version-invalid');
  }

  const header = requireObject(candidate.header, 'header');
  requireOnlyKeys(header, [
    'identity',
    'sourceCommit',
    'artifactDigest',
    'creationOperationId',
    'deploymentNames',
    'createdAt',
  ], 'header');
  assertIdentity(header.identity, 'header.identity');
  requireCommit(header.sourceCommit, 'header.sourceCommit');
  requireDigest(header.artifactDigest, 'header.artifactDigest');
  requireString(header.creationOperationId, 'header.creationOperationId');
  assertStringSet(header.deploymentNames, 'header.deploymentNames');
  requireString(header.createdAt, 'header.createdAt');

  const entries = assertInventory(candidate.inventory, header.creationOperationId, false);
  if (!entries.some((entry) => entry.classification === 'created' && entry.id === header.identity.resourceGroupId)) {
    fail('manifest-resource-group-creation-missing');
  }
  assertEvidence(candidate.evidence, 'evidence');
  const protectedTargets = assertProtectedTargets(candidate.protectedTargets, 'protectedTargets');
  if (candidate.protectedTargetsDigest !== digest(protectedTargets)) fail('manifest-protected-digest-mismatch');
  for (const entry of entries.filter((candidateEntry) => candidateEntry.classification === 'created')) {
    if (isStructurallyProtected(entry.id, protectedTargets)) {
      fail('contract-created-target-is-protected', entry.id);
    }
  }

  const manifest = {
    ...structuredClone(candidate),
    schemaVersion: schemaVersions.manifest,
    sealed: true,
  };
  manifest.canonicalDigest = digest(manifest);
  return normalized(manifest);
}

export function verifyManifest(manifest) {
  requireObject(manifest, 'manifest');
  if (manifest.schemaVersion !== schemaVersions.manifest || manifest.sealed !== true) {
    fail('manifest-not-sealed');
  }
  assertIdentity(manifest.header?.identity, 'manifest.header.identity');
  assertProtectedTargets(manifest.protectedTargets, 'manifest.protectedTargets');
  if (manifest.protectedTargetsDigest !== digest(manifest.protectedTargets)) fail('manifest-protected-digest-mismatch');
  assertInventory(manifest.inventory, manifest.header.creationOperationId, false);
  for (const entry of manifest.inventory.entries.filter((candidateEntry) => candidateEntry.classification === 'created')) {
    if (isStructurallyProtected(entry.id, manifest.protectedTargets)) {
      fail('contract-created-target-is-protected', entry.id);
    }
  }
  assertEvidence(manifest.evidence, 'manifest.evidence');
  assertCanonicalDigest(manifest, 'manifest');
  return manifest;
}

function verifyState(manifest, state) {
  requireObject(state, 'state');
  requireOnlyKeys(state, [
    'schemaVersion',
    'identity',
    'manifestVersion',
    'manifestDigest',
    'approvedPlanDigest',
    'inventoryDigest',
    'entries',
    'deletedEntryIds',
    'canonicalDigest',
  ], 'state');
  if (state.schemaVersion !== schemaVersions.state) fail('state-schema-version-invalid');
  assertIdentity(state.identity, 'state.identity', manifest.header.identity);
  if (state.manifestVersion !== manifest.manifestVersion) fail('state-manifest-version-mismatch');
  if (state.manifestDigest !== manifest.canonicalDigest) fail('state-manifest-digest-mismatch');
  if (state.approvedPlanDigest !== manifest.evidence.approvedPlanDigest) fail('state-plan-digest-mismatch');
  const stateEntries = requireArray(state.entries, 'state.entries').map(entryIdentity);
  const manifestEntries = manifest.inventory.entries.map(entryIdentity);
  if (canonicalJson(stateEntries) !== canonicalJson(manifestEntries)) fail('state-inventory-mismatch');
  if (state.inventoryDigest !== digest(stateEntries)) fail('state-inventory-digest-mismatch');
  const deletedEntryIds = assertStringSet(state.deletedEntryIds, 'state.deletedEntryIds');
  const knownIds = new Set(manifest.inventory.entries.map((entry) => entry.id));
  for (const id of deletedEntryIds) if (!knownIds.has(id)) fail('state-deleted-id-unknown', id);
  assertCanonicalDigest(state, 'state');
  return new Set(deletedEntryIds);
}

function verifyReadback(manifest, readback, deletedEntryIds) {
  requireObject(readback, 'readback');
  requireOnlyKeys(readback, [
    'schemaVersion',
    'identity',
    'manifestVersion',
    'manifestDigest',
    'approvedPlanDigest',
    'protectedTargetsDigest',
    'observedAt',
    'entries',
    'canonicalDigest',
  ], 'readback');
  if (readback.schemaVersion !== schemaVersions.readback) fail('readback-schema-version-invalid');
  assertIdentity(readback.identity, 'readback.identity', manifest.header.identity);
  if (readback.manifestVersion !== manifest.manifestVersion) fail('readback-manifest-version-mismatch');
  if (readback.manifestDigest !== manifest.canonicalDigest) fail('readback-manifest-digest-mismatch');
  if (readback.approvedPlanDigest !== manifest.evidence.approvedPlanDigest) fail('readback-plan-digest-mismatch');
  if (readback.protectedTargetsDigest !== manifest.protectedTargetsDigest) fail('readback-protected-digest-mismatch');
  requireString(readback.observedAt, 'readback.observedAt');

  const inventory = { entries: requireArray(readback.entries, 'readback.entries') };
  const readbackEntries = assertInventory(inventory, manifest.header.creationOperationId, true);
  const expectedById = new Map(manifest.inventory.entries.map((entry) => [entry.id, entry]));
  const actualById = new Map(readbackEntries.map((entry) => [entry.id, entry]));
  const missing = [];
  const unknown = [];
  const blocked = [];

  for (const [id, expected] of expectedById) {
    const actual = actualById.get(id);
    if (!actual) {
      missing.push(id);
      continue;
    }
    if (canonicalJson(entryIdentity(actual)) !== canonicalJson(entryIdentity(expected))) {
      blocked.push(`identity-mismatch:${id}`);
      continue;
    }
    const markedDeleted = deletedEntryIds.has(id);
    if (markedDeleted && actual.lifecycleState === 'present') blocked.push(`deleted-state-present:${id}`);
    if (!markedDeleted && actual.lifecycleState !== 'present') missing.push(id);
  }
  for (const id of actualById.keys()) {
    if (!expectedById.has(id)) unknown.push(id);
  }
  assertCanonicalDigest(readback, 'readback');
  return { readbackEntries, missing: missing.sort(), unknown: unknown.sort(), blocked: blocked.sort() };
}

function targetSets(entries) {
  const liveCreated = entries.filter((entry) => entry.classification === 'created' && entry.lifecycleState === 'present');
  const softDeleted = entries.filter((entry) => entry.classification === 'created' && entry.lifecycleState === 'soft-deleted');
  const resourceKinds = new Set(['azure-resource', 'azure-role-assignment', 'deployment-record']);
  const entraKinds = new Set(['entra-application', 'entra-service-principal', 'graph-assignment']);
  return {
    resourceDelete: liveCreated.filter((entry) => resourceKinds.has(entry.kind)).map((entry) => entry.id).sort(),
    entraCleanup: liveCreated.filter((entry) => entraKinds.has(entry.kind)).map((entry) => entry.id).sort(),
    entraPurge: softDeleted.filter((entry) => entry.kind === 'entra-application' && entry.purgeEligible === true).map((entry) => entry.id).sort(),
    apimPurge: softDeleted.filter((entry) => entry.type.toLowerCase() === 'microsoft.apimanagement/service' && entry.purgeEligible === true).map((entry) => entry.id).sort(),
    keyVaultPurge: softDeleted.filter((entry) => entry.type.toLowerCase() === 'microsoft.keyvault/vaults' && entry.purgeEligible === true).map((entry) => entry.id).sort(),
    keyVaultPendingRetention: softDeleted.filter((entry) => entry.type.toLowerCase() === 'microsoft.keyvault/vaults' && entry.purgeEligible !== true).map((entry) => ({
      id: entry.id,
      retentionUntil: entry.retentionUntil ?? null,
      state: 'DeletedPendingRetention',
    })),
  };
}

export function createRemovalPreview(manifestInput, state, readback, now = new Date()) {
  const manifest = verifyManifest(manifestInput);
  const deletedEntryIds = verifyState(manifest, state);
  const agreement = verifyReadback(manifest, readback, deletedEntryIds);
  const evaluatedAt = requireClock(now);
  const manifestCreatedAt = requireTimestamp(manifest.header.createdAt, 'manifest.header.createdAt');
  const readbackObservedAt = requireTimestamp(readback.observedAt, 'readback.observedAt');
  if (readbackObservedAt > evaluatedAt) fail('readback-observed-at-future');
  if (readbackObservedAt < manifestCreatedAt) fail('readback-observed-before-manifest');
  const readbackValidUntil = new Date(readbackObservedAt.valueOf() + readbackMaximumAgeMilliseconds);
  if (evaluatedAt > readbackValidUntil) fail('readback-stale');
  const targets = targetSets(agreement.readbackEntries);
  const preserve = agreement.readbackEntries
    .filter((entry) => entry.classification !== 'created')
    .map((entry) => ({ id: entry.id, classification: entry.classification }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const preview = {
    schemaVersion: schemaVersions.preview,
    identity: manifest.header.identity,
    manifestVersion: manifest.manifestVersion,
    manifestDigest: manifest.canonicalDigest,
    approvedPlanDigest: manifest.evidence.approvedPlanDigest,
    stateDigest: state.canonicalDigest,
    readbackDigest: readback.canonicalDigest,
    readbackFreshness: {
      observedAt: readbackObservedAt.toISOString(),
      validUntil: readbackValidUntil.toISOString(),
      maximumAgeSeconds: readbackMaximumAgeSeconds,
    },
    protectedTargetsDigest: manifest.protectedTargetsDigest,
    status: agreement.missing.length || agreement.unknown.length || agreement.blocked.length ? 'blocked' : 'ready',
    delete: {
      resources: targets.resourceDelete,
      entraObjects: targets.entraCleanup,
    },
    preserve,
    blocked: agreement.blocked,
    missing: agreement.missing,
    unknown: agreement.unknown,
    purgeEligible: {
      entraApplications: targets.entraPurge,
      apiManagement: targets.apimPurge,
      keyVault: targets.keyVaultPurge,
    },
    pendingRetention: {
      keyVault: targets.keyVaultPendingRetention,
    },
    mutationImplemented: false,
  };
  preview.canonicalDigest = digest(preview);
  return normalized(preview);
}

export function validateVerificationContinuation(preflight, manifest, state, readback, now = new Date()) {
  const preview = createRemovalPreview(manifest, state, readback, now);
  if (preview.status !== 'ready') fail('verification-continuation-agreement-blocked');
  if (manifest.header.creationOperationId !== preflight.creationOperationId) {
    fail('verification-continuation-operation-mismatch');
  }

  assertIdentity(manifest.header.identity, 'manifest.header.identity', preflight.identity);
  if (manifest.evidence.approvedPlanDigest !== preflight.approvedPlanDigest
    || manifest.evidence.previewDigest !== preflight.previewDigest) {
    fail('verification-continuation-evidence-mismatch');
  }
  const { freshFoundry } = assertFoundryManifestContinuity(preflight, manifest);
  const resourceGroup = readback.entries.find((entry) => entry.id === manifest.header.identity.resourceGroupId);
  if (!resourceGroup || resourceGroup.classification !== 'created' || resourceGroup.lifecycleState !== 'present') {
    fail('verification-continuation-resource-group-not-owned');
  }
  const keyVaults = readback.entries.filter((entry) => entry.classification === 'created'
    && entry.type.toLowerCase() === 'microsoft.keyvault/vaults'
    && entry.lifecycleState === 'present');
  if (keyVaults.length !== 1) fail('verification-continuation-key-vault-count-invalid');
  return Object.freeze({
    manifestDigest: manifest.canonicalDigest,
    readbackDigest: readback.canonicalDigest,
    agreementDigest: preview.canonicalDigest,
    resourceGroupId: resourceGroup.id,
    keyVaultId: keyVaults[0].id,
    freshFoundry,
  });
}

export function validateBootstrapContinuation(preflight, manifest, state, readback, now = new Date()) {
  if (preflight.stage !== 'bootstrap') fail('verification-bootstrap-stage-mismatch');
  const preview = createRemovalPreview(manifest, state, readback, now);
  if (preview.status !== 'ready') fail('verification-bootstrap-agreement-blocked');
  assertIdentity(manifest.header.identity, 'manifest.header.identity', preflight.identity);
  if (manifest.header.creationOperationId !== preflight.creationOperationId) {
    fail('verification-bootstrap-operation-mismatch');
  }
  if (manifest.evidence.approvedPlanDigest !== preflight.approvedPlanDigest
    || manifest.evidence.previewDigest !== preflight.previewDigest) {
    fail('verification-bootstrap-evidence-mismatch');
  }
  const resourceGroup = readback.entries.find((entry) => entry.id === manifest.header.identity.resourceGroupId);
  if (!resourceGroup || resourceGroup.classification !== 'created' || resourceGroup.lifecycleState !== 'present') {
    fail('verification-bootstrap-resource-group-not-owned');
  }
  const keyVaults = readback.entries.filter((entry) => entry.classification === 'created'
    && entry.type.toLowerCase() === 'microsoft.keyvault/vaults'
    && entry.lifecycleState === 'present');
  if (keyVaults.length !== 1) fail('verification-bootstrap-key-vault-count-invalid');
  if (manifest.inventory.entries.some((entry) => entry.classification === 'created'
    && entry.id.toLowerCase().includes('/providers/microsoft.cognitiveservices/accounts/'))) {
    fail('verification-bootstrap-created-foundry-forbidden');
  }
  return Object.freeze({
    manifestDigest: manifest.canonicalDigest,
    readbackDigest: readback.canonicalDigest,
    agreementDigest: preview.canonicalDigest,
    resourceGroupId: resourceGroup.id,
    keyVaultId: keyVaults[0].id,
    stage: 'bootstrap',
  });
}

function phaseTargets(preview, phase) {
  switch (phase) {
    case 'resource-delete': return preview.delete.resources;
    case 'entra-cleanup': return preview.delete.entraObjects;
    case 'entra-purge': return preview.purgeEligible.entraApplications;
    case 'apim-purge': return preview.purgeEligible.apiManagement;
    case 'key-vault-purge': return preview.purgeEligible.keyVault;
    default: fail('approval-phase-invalid', phase);
  }
}

export function validateApproval(preview, approval, now = new Date()) {
  requireObject(preview, 'preview');
  if (preview.schemaVersion !== schemaVersions.preview) fail('preview-schema-version-invalid');
  assertCanonicalDigest(preview, 'preview');
  if (preview.status !== 'ready') fail('preview-blocked');
  const evaluatedAt = requireClock(now);
  const freshness = requireObject(preview.readbackFreshness, 'preview.readbackFreshness');
  requireOnlyKeys(freshness, ['observedAt', 'validUntil', 'maximumAgeSeconds'], 'preview.readbackFreshness');
  if (freshness.maximumAgeSeconds !== readbackMaximumAgeSeconds) fail('preview-readback-freshness-invalid');
  const readbackObservedAt = requireTimestamp(freshness.observedAt, 'preview.readbackFreshness.observedAt');
  const readbackValidUntil = requireTimestamp(freshness.validUntil, 'preview.readbackFreshness.validUntil');
  if (readbackValidUntil.valueOf() !== readbackObservedAt.valueOf() + readbackMaximumAgeMilliseconds) {
    fail('preview-readback-freshness-invalid');
  }
  if (evaluatedAt < readbackObservedAt) fail('preview-readback-future');
  if (evaluatedAt > readbackValidUntil) fail('preview-readback-stale');

  requireObject(approval, 'approval');
  requireOnlyKeys(approval, [
    'schemaVersion',
    'phase',
    'approvalId',
    'approvedByObjectId',
    'approvedAt',
    'expiresAt',
    'manifestDigest',
    'approvedPlanDigest',
    'readbackDigest',
    'previewDigest',
    'targetIds',
    'targetDigest',
    'canonicalDigest',
  ], 'approval');
  if (approval.schemaVersion !== schemaVersions.approval) fail('approval-schema-version-invalid');
  if (!approvalPhases.has(approval.phase)) fail('approval-phase-invalid', approval.phase);
  requireString(approval.approvalId, 'approval.approvalId');
  requireGuid(approval.approvedByObjectId, 'approval.approvedByObjectId');
  const approvedAt = requireTimestamp(approval.approvedAt, 'approval.approvedAt');
  const expiresAt = requireTimestamp(approval.expiresAt, 'approval.expiresAt');
  if (expiresAt <= approvedAt || evaluatedAt > expiresAt) fail('approval-window-invalid');
  if (approvedAt > evaluatedAt) fail('approval-time-future');
  if (approvedAt < readbackObservedAt) fail('approval-before-readback');
  if (approvedAt > readbackValidUntil) fail('approval-readback-stale');
  for (const [field, expected] of Object.entries({
    manifestDigest: preview.manifestDigest,
    approvedPlanDigest: preview.approvedPlanDigest,
    readbackDigest: preview.readbackDigest,
    previewDigest: preview.canonicalDigest,
  })) {
    if (approval[field] !== expected) fail('approval-evidence-mismatch', field);
  }
  const targetIds = assertStringSet(approval.targetIds, 'approval.targetIds');
  const expectedTargets = phaseTargets(preview, approval.phase);
  if (canonicalJson(targetIds) !== canonicalJson(expectedTargets)) fail('approval-target-mismatch');
  if (approval.targetDigest !== digest(targetIds)) fail('approval-target-digest-mismatch');
  if (approval.phase === 'key-vault-purge' && preview.pendingRetention.keyVault.length > 0) {
    fail('key-vault-purge-protection-retention-active');
  }
  assertCanonicalDigest(approval, 'approval');

  const authorization = {
    schemaVersion: schemaVersions.authorization,
    phase: approval.phase,
    approvalId: approval.approvalId,
    manifestDigest: preview.manifestDigest,
    readbackDigest: preview.readbackDigest,
    previewDigest: preview.canonicalDigest,
    targetIds,
    targetDigest: approval.targetDigest,
    approvalValidated: true,
    mutationImplemented: false,
  };
  authorization.canonicalDigest = digest(authorization);
  return normalized(authorization);
}

function readJson(path, name) {
  requireString(path, `${name}Path`);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail('contract-json-read-failed', `${name}: ${error.message}`);
  }
}

function writeJson(path, value) {
  const text = `${JSON.stringify(normalized(value), null, 2)}\n`;
  if (path) writeFileSync(path, text, { encoding: 'utf8', flag: 'wx' });
  else process.stdout.write(text);
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) fail('argument-invalid', token);
    const key = token.slice(2);
    if (key === 'self-test') {
      options[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail('argument-value-required', key);
    options[key] = value;
    index += 1;
  }
  return options;
}

function selfTest() {
  const verificationIdentity = Object.freeze({
    tenantId: '00000000-0000-4000-8000-000000000001',
    subscriptionId: '00000000-0000-4000-8000-000000000002',
    environmentName: 'verification',
    resourceGroupName: 'rg-test-verification',
    resourceGroupId: ['', 'subscriptions', '00000000-0000-4000-8000-000000000002', 'resourceGroups', 'rg-test-verification'].join('/'),
    location: 'example-region',
  });
  const foundryGroup = `/subscriptions/${verificationIdentity.subscriptionId}/resourceGroups/rg-test-foundry`;
  const foundryRoot = `${foundryGroup}/providers/Microsoft.CognitiveServices/accounts/test-foundry-account`;
  const requiredProtectedTargets = Object.freeze([
    foundryGroup,
    foundryRoot,
    `${foundryRoot}/projects/test-project`,
    `${foundryRoot}/deployments/test-model`,
    '/providers/Microsoft.Graph/protectedPreexisting',
  ]);
  const receiptDigest = digest({ receipt: 'created' });
  const candidate = {
    schemaVersion: schemaVersions.candidate,
    manifestVersion: 1,
    header: {
      identity: verificationIdentity,
      sourceCommit: '0123456789abcdef0123456789abcdef01234567',
      artifactDigest: digest({ artifact: true }),
      creationOperationId: 'operation-1',
      deploymentNames: ['main-verification'],
      createdAt: '2026-09-03T06:00:00.000Z',
    },
    inventory: {
      entries: [
        {
          id: verificationIdentity.resourceGroupId,
          kind: 'azure-resource',
          type: 'Microsoft.Resources/resourceGroups',
          scope: `/subscriptions/${verificationIdentity.subscriptionId}`,
          classification: 'created',
          creation: {
            operationId: 'operation-1',
            deploymentId: '/subscriptions/example/providers/Microsoft.Resources/deployments/main-verification',
            correlationId: 'correlation-1',
            receiptDigest,
          },
        },
        {
          id: `${verificationIdentity.resourceGroupId}/providers/Microsoft.KeyVault/vaults/kv-verification`,
          kind: 'azure-resource',
          type: 'Microsoft.KeyVault/vaults',
          scope: verificationIdentity.resourceGroupId,
          classification: 'created',
          purgeProtectionEnabled: true,
          softDeleteRetentionInDays: 7,
          creation: {
            operationId: 'operation-1',
            deploymentId: '/subscriptions/example/providers/Microsoft.Resources/deployments/main-verification',
            correlationId: 'correlation-1',
            receiptDigest,
          },
        },
        ...[
          foundryRoot,
          `${foundryRoot}/projects/test-project`,
          `${foundryRoot}/deployments/test-model`,
        ].map((id) => ({
          id,
          kind: 'azure-resource',
          type: id.includes('/projects/') ? 'Microsoft.CognitiveServices/accounts/projects'
            : id.includes('/deployments/') ? 'Microsoft.CognitiveServices/accounts/deployments'
              : 'Microsoft.CognitiveServices/accounts',
          scope: foundryRoot,
          classification: 'external-reference',
        })),
      ],
    },
    evidence: {
      approvedPlanDigest: digest({ plan: true }),
      previewDigest: digest({ preview: true }),
      readbackDigest: digest({ creationReadback: true }),
    },
    protectedTargets: requiredProtectedTargets,
    protectedTargetsDigest: digest(requiredProtectedTargets),
  };
  const manifest = sealManifest(candidate);
  verifyManifest(manifest);
  const state = {
    schemaVersion: schemaVersions.state,
    identity: verificationIdentity,
    manifestVersion: manifest.manifestVersion,
    manifestDigest: manifest.canonicalDigest,
    approvedPlanDigest: manifest.evidence.approvedPlanDigest,
    inventoryDigest: digest(manifest.inventory.entries.map(entryIdentity)),
    entries: manifest.inventory.entries.map(entryIdentity),
    deletedEntryIds: [],
  };
  state.canonicalDigest = digest(state);
  const readback = {
    schemaVersion: schemaVersions.readback,
    identity: verificationIdentity,
    manifestVersion: manifest.manifestVersion,
    manifestDigest: manifest.canonicalDigest,
    approvedPlanDigest: manifest.evidence.approvedPlanDigest,
    protectedTargetsDigest: manifest.protectedTargetsDigest,
    observedAt: '2026-09-03T06:05:00.000Z',
    entries: manifest.inventory.entries.map((entry) => ({
      ...entryIdentity(entry),
      lifecycleState: 'present',
      ...(entry.classification === 'created' ? {} : { unchanged: true }),
    })),
  };
  readback.canonicalDigest = digest(readback);
  const selfTestNow = new Date('2026-09-03T06:07:00.000Z');
  const preview = createRemovalPreview(manifest, state, readback, selfTestNow);
  if (preview.status !== 'ready' || preview.delete.resources.length !== 2 || preview.mutationImplemented !== false) {
    fail('self-test-preview-failed');
  }
  const environment = {
    AZURE_TENANT_ID: verificationIdentity.tenantId,
    AZURE_SUBSCRIPTION_ID: verificationIdentity.subscriptionId,
    AZURE_ENV_NAME: verificationIdentity.environmentName,
    AZURE_LOCATION: verificationIdentity.location,
    GATEWAY_RESOURCE_GROUP_NAME: verificationIdentity.resourceGroupName,
    CREATE_FOUNDRY: 'false',
    FOUNDRY_RESOURCE_GROUP_NAME: 'rg-test-foundry',
    FOUNDRY_ACCOUNT_NAME: 'test-foundry-account',
    FOUNDRY_PROJECT_NAME: 'test-project',
    FOUNDRY_DEFAULT_MODEL_DEPLOYMENT: 'test-model',
  };
  const preflight = {
    schemaVersion: schemaVersions.preflight,
    identity: verificationIdentity,
    approvedPlanDigest: manifest.evidence.approvedPlanDigest,
    sourceCommit: manifest.header.sourceCommit,
    previewDigest: manifest.evidence.previewDigest,
    creationOperationId: manifest.header.creationOperationId,
    stage: 'postprovision',
    observedAt: '2026-09-03T05:55:00.000Z',
    validUntil: '2026-09-03T06:25:00.000Z',
    resourceGroup: {
      id: verificationIdentity.resourceGroupId,
      exists: false,
    },
    foundry: {
      resourceGroupName: 'rg-test-foundry',
      accountName: 'test-foundry-account',
      projectName: 'test-project',
      deploymentName: 'test-model',
      classification: 'external-reference',
    },
    activeNameCollisions: [],
    softDeletedNameCollisions: [],
    entraCollisions: [],
    protectedTargets: requiredProtectedTargets,
    protectedTargetsDigest: digest(requiredProtectedTargets),
  };
  preflight.canonicalDigest = digest(preflight);
  validateCreateOnlyPreflight(
    preflight,
    environment,
    manifest.evidence.approvedPlanDigest,
    new Date('2026-09-03T06:00:00.000Z'),
  );
  validateVerificationContinuation(preflight, manifest, state, readback, selfTestNow);

  const approval = {
    schemaVersion: schemaVersions.approval,
    phase: 'resource-delete',
    approvalId: 'approval-1',
    approvedByObjectId: '11111111-1111-4111-8111-111111111111',
    approvedAt: '2026-09-03T06:06:00.000Z',
    expiresAt: '2026-09-03T06:16:00.000Z',
    manifestDigest: preview.manifestDigest,
    approvedPlanDigest: preview.approvedPlanDigest,
    readbackDigest: preview.readbackDigest,
    previewDigest: preview.canonicalDigest,
    targetIds: preview.delete.resources,
    targetDigest: digest(preview.delete.resources),
  };
  approval.canonicalDigest = digest(approval);
  const authorization = validateApproval(preview, approval, selfTestNow);
  if (!authorization.approvalValidated || authorization.mutationImplemented) fail('self-test-approval-failed');

  const duplicate = structuredClone(candidate);
  duplicate.inventory.entries.push(structuredClone(duplicate.inventory.entries[0]));
  try {
    sealManifest(duplicate);
    fail('self-test-duplicate-not-rejected');
  } catch (error) {
    if (!error.message.startsWith('contract-duplicate-entry-id')) throw error;
  }
  return {
    result: 'pass',
    manifestDigest: manifest.canonicalDigest,
    previewDigest: preview.canonicalDigest,
    mutationImplemented: false,
  };
}

function main(argv) {
  const [command, ...rest] = argv;
  const options = parseArguments(rest);
  if (command === 'self-test') {
    writeJson(options.output, selfTest());
    return;
  }
  if (command === 'seal') {
    writeJson(options.output, sealManifest(readJson(options.candidate, 'candidate')));
    return;
  }
  if (command === 'validate-preflight') {
    const environment = readJson(options.environment, 'environment');
    const plan = readFileSync(options.plan);
    writeJson(options.output, validateCreateOnlyPreflight(
      readJson(options.preflight, 'preflight'),
      environment,
      `sha256:${createHash('sha256').update(plan).digest('hex')}`,
    ));
    return;
  }
  if (command === 'preview') {
    const preview = createRemovalPreview(
      readJson(options.manifest, 'manifest'),
      readJson(options.state, 'state'),
      readJson(options.readback, 'readback'),
    );
    writeJson(options.output, preview);
    if (preview.status !== 'ready') process.exitCode = 2;
    return;
  }
  if (command === 'authorize') {
    const preview = createRemovalPreview(
      readJson(options.manifest, 'manifest'),
      readJson(options.state, 'state'),
      readJson(options.readback, 'readback'),
    );
    const approval = readJson(options.approval, 'approval');
    if (options.phase && approval.phase !== options.phase) fail('approval-phase-parameter-mismatch');
    writeJson(options.output, validateApproval(preview, approval));
    return;
  }
  fail('command-invalid', command ?? '');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
