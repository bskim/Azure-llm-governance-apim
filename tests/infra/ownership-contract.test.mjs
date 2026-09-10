import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  canonicalJson,
  createRemovalPreview,
  digest,
  sealManifest,
  validateApproval,
  validateCreateOnlyPreflight,
  validateVerificationContinuation,
} from '../../tools/deployment/ownership-contract.mjs';
import { validateDeploymentInputs } from '../../tools/distribution/Validate-DeploymentInputs.mjs';
import {
  createApproval,
  createEnvironment,
  createFixture,
  createPreflight,
  ids,
  markSoftDeleted,
  requiredProtectedTargets,
  resign,
  verificationIdentity,
} from './fixtures/ownership-contract-fixture.mjs';

const repositoryRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const cleanupScript = path.join(repositoryRoot, 'tools', 'distribution', 'Remove-Deployment.ps1');
const fixtureNow = new Date('2026-09-03T06:07:00.000Z');

function makeTestDirectory(prefix) {
  const parent = path.join(repositoryRoot, 'tests', 'distribution', '.test-work');
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(path.join(parent, prefix));
}

test('offline preflight rejects wrong tenant, subscription, environment, and resource group', () => {
  const { manifest } = createFixture();
  const preflight = createPreflight(manifest);
  const cases = [
    ['AZURE_TENANT_ID', 'wrong-tenant'],
    ['AZURE_SUBSCRIPTION_ID', 'wrong-subscription'],
    ['AZURE_ENV_NAME', 'wrong-environment'],
    ['GATEWAY_RESOURCE_GROUP_NAME', 'wrong-resource-group'],
  ];
  for (const [name, value] of cases) {
    assert.throws(
      () => validateCreateOnlyPreflight(
        preflight,
        { ...createEnvironment(), [name]: value },
        manifest.evidence.approvedPlanDigest,
        new Date('2026-09-03T06:00:00.000Z'),
      ),
      new RegExp(`preflight-environment-mismatch: ${name}`),
    );
  }
});

test('legacy external preflight defaults to postprovision but fresh mode must bind its stage', () => {
  const { manifest } = createFixture();
  const preflight = createPreflight(manifest);
  delete preflight.stage;
  resign(preflight);
  const environment = createEnvironment();
  assert.doesNotThrow(() => validateCreateOnlyPreflight(
    preflight, environment, manifest.evidence.approvedPlanDigest,
    new Date('2026-09-03T06:00:00.000Z'),
  ));
  assert.throws(() => validateCreateOnlyPreflight(
    preflight, { ...environment, OWNERSHIP_VALIDATION_STAGE: 'bootstrap' },
    manifest.evidence.approvedPlanDigest, new Date('2026-09-03T06:00:00.000Z'),
  ), /preflight-environment-mismatch: OWNERSHIP_VALIDATION_STAGE/);
  preflight.foundry.freshFoundry = true;
  resign(preflight);
  assert.throws(() => validateCreateOnlyPreflight(
    preflight, environment, manifest.evidence.approvedPlanDigest,
    new Date('2026-09-03T06:00:00.000Z'),
  ), /preflight-stage-invalid/);
});

test('create-only preprovision validates complete manifest, state, and readback continuity', () => {
  const directory = makeTestDirectory('ownership-preprovision-');
  try {
    const planPath = path.join(directory, 'approved-plan.md');
    writeFileSync(planPath, 'synthetic customer-approved plan\n');
    const approvedPlanDigest = `sha256:${createHash('sha256').update(readFileSync(planPath)).digest('hex')}`;
    const fixture = createFixture({ approvedPlanDigest });
    const files = {
      preflight: path.join(directory, 'preflight.json'),
      manifest: path.join(directory, 'manifest.json'),
      state: path.join(directory, 'state.json'),
      readback: path.join(directory, 'readback.json'),
    };
    writeFileSync(files.preflight, JSON.stringify(createPreflight(fixture.manifest)));
    writeFileSync(files.manifest, JSON.stringify(fixture.manifest));
    writeFileSync(files.state, JSON.stringify(fixture.state));
    writeFileSync(files.readback, JSON.stringify(fixture.readback));
    const environment = {
      ...createEnvironment(),
      CREATE_ONLY_OWNERSHIP_VALIDATION: 'true',
      PRINCIPAL_KEY_MODE: 'existing',
      PRINCIPAL_KEY_STORE_NAME: 'kv-verification-fixture',
      PRINCIPAL_KEY_SECRET_NAME: 'principal-derivation-key',
      OWNERSHIP_PREFLIGHT_FILE: files.preflight,
      OWNERSHIP_PLAN_FILE: planPath,
      OWNERSHIP_MANIFEST_FILE: files.manifest,
      OWNERSHIP_STATE_FILE: files.state,
      OWNERSHIP_READBACK_FILE: files.readback,
    };

    const result = validateDeploymentInputs(environment, fixtureNow);
    assert.equal(result.mode, 'existing');
    assert.equal(result.configured, true);
    assert.equal(result.createOnly.mode, 'verification-create-only-external-foundry');
    assert.equal(result.createOnly.manifestDigest, fixture.manifest.canonicalDigest);
    assert.equal(result.createOnly.readbackDigest, fixture.readback.canonicalDigest);

    for (const [name, expected] of [
      ['OWNERSHIP_MANIFEST_FILE', /create-only-manifest-required/],
      ['OWNERSHIP_STATE_FILE', /create-only-state-required/],
      ['OWNERSHIP_READBACK_FILE', /create-only-readback-required/],
    ]) {
      const incomplete = { ...environment };
      delete incomplete[name];
      assert.throws(() => validateDeploymentInputs(incomplete, fixtureNow), expected);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('fresh bootstrap requires owned RG and vault receipts but defers Foundry receipts until postprovision', () => {
  const directory = makeTestDirectory('ownership-bootstrap-');
  try {
    const planPath = path.join(directory, 'approved-plan.md');
    const preflightPath = path.join(directory, 'preflight.json');
    writeFileSync(planPath, 'synthetic customer-approved plan\n');
    const approvedPlanDigest = `sha256:${createHash('sha256').update(readFileSync(planPath)).digest('hex')}`;
    const fixture = createFixture({ approvedPlanDigest, freshFoundry: true });
    const bootstrapCandidate = structuredClone(fixture.candidate);
    bootstrapCandidate.inventory.entries = bootstrapCandidate.inventory.entries.filter(
      (entry) => !entry.id.includes('/providers/Microsoft.CognitiveServices/accounts/'),
    );
    const bootstrapManifest = sealManifest(bootstrapCandidate);
    const bootstrapState = structuredClone(fixture.state);
    bootstrapState.manifestDigest = bootstrapManifest.canonicalDigest;
    bootstrapState.entries = bootstrapManifest.inventory.entries.map((entry) => {
      const copy = structuredClone(entry); delete copy.creation; return copy;
    });
    bootstrapState.inventoryDigest = digest(bootstrapState.entries);
    resign(bootstrapState);
    const bootstrapReadback = structuredClone(fixture.readback);
    bootstrapReadback.manifestDigest = bootstrapManifest.canonicalDigest;
    bootstrapReadback.entries = bootstrapManifest.inventory.entries.map((entry) => {
      const copy = structuredClone(entry);
      delete copy.creation;
      copy.lifecycleState = 'present';
      if (copy.classification !== 'created') copy.unchanged = true;
      return copy;
    });
    resign(bootstrapReadback);
    const files = {
      manifest: path.join(directory, 'manifest.json'),
      state: path.join(directory, 'state.json'),
      readback: path.join(directory, 'readback.json'),
    };
    writeFileSync(files.manifest, JSON.stringify(bootstrapManifest));
    writeFileSync(files.state, JSON.stringify(bootstrapState));
    writeFileSync(files.readback, JSON.stringify(bootstrapReadback));
    writeFileSync(preflightPath, JSON.stringify(createPreflight(
      fixture.manifest,
      { freshFoundry: true, stage: 'bootstrap' },
    )));

    const result = validateDeploymentInputs({
      ...createEnvironment({ freshFoundry: true }),
      CREATE_ONLY_OWNERSHIP_VALIDATION: 'true',
      OWNERSHIP_VALIDATION_STAGE: 'bootstrap',
      PRINCIPAL_KEY_MODE: 'existing',
      PRINCIPAL_KEY_STORE_NAME: 'kv-verification-fixture',
      PRINCIPAL_KEY_SECRET_NAME: 'principal-derivation-key',
      OWNERSHIP_PREFLIGHT_FILE: preflightPath,
      OWNERSHIP_PLAN_FILE: planPath,
      OWNERSHIP_MANIFEST_FILE: files.manifest,
      OWNERSHIP_STATE_FILE: files.state,
      OWNERSHIP_READBACK_FILE: files.readback,
    }, fixtureNow);
    assert.equal(result.createOnly.stage, 'bootstrap');
    assert.equal(result.createOnly.freshFoundry, true);

    writeFileSync(files.manifest, JSON.stringify(fixture.manifest));
    writeFileSync(files.state, JSON.stringify(fixture.state));
    writeFileSync(files.readback, JSON.stringify(fixture.readback));
    assert.throws(
      () => validateDeploymentInputs({
        ...createEnvironment({ freshFoundry: true }),
        CREATE_ONLY_OWNERSHIP_VALIDATION: 'true',
        OWNERSHIP_VALIDATION_STAGE: 'bootstrap',
        PRINCIPAL_KEY_MODE: 'existing',
        PRINCIPAL_KEY_STORE_NAME: 'kv-verification-fixture',
        PRINCIPAL_KEY_SECRET_NAME: 'principal-derivation-key',
        OWNERSHIP_PREFLIGHT_FILE: preflightPath,
        OWNERSHIP_PLAN_FILE: planPath,
        OWNERSHIP_MANIFEST_FILE: files.manifest,
        OWNERSHIP_STATE_FILE: files.state,
        OWNERSHIP_READBACK_FILE: files.readback,
      }, fixtureNow),
      /verification-bootstrap-created-foundry-forbidden/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('fresh Foundry is create-only, receipt-backed, removable, and isolated to the verification group', () => {
  const secondModelDeployments = [{
    deploymentName: 'test-second-model',
    modelName: 'test-model',
    modelVersion: '1',
    modelFormat: 'OpenAI',
    skuName: 'GlobalStandard',
    capacity: 1,
  }];
  const fixture = createFixture({ freshFoundry: true, secondModelDeployments });
  const preflight = createPreflight(fixture.manifest, { freshFoundry: true, secondModelDeployments });
  const environment = createEnvironment({ freshFoundry: true, secondModelDeployments });

  const preflightResult = validateCreateOnlyPreflight(
    preflight,
    environment,
    fixture.manifest.evidence.approvedPlanDigest,
    new Date('2026-09-03T06:00:00.000Z'),
  );
  assert.equal(preflightResult.freshFoundry, true);
  assert.equal(preflightResult.mode, 'verification-create-only-fresh-foundry');

  const continuation = validateVerificationContinuation(
    preflight,
    fixture.manifest,
    fixture.state,
    fixture.readback,
    fixtureNow,
  );
  assert.equal(continuation.freshFoundry, true);
  const preview = createRemovalPreview(fixture.manifest, fixture.state, fixture.readback, fixtureNow);
  assert.equal(preview.delete.resources.some((id) => id.includes('/accounts/test-foundry-account')), true);
  assert.equal(preview.delete.resources.some((id) => id.endsWith('/deployments/test-second-model')), true);

  const missingReceipt = structuredClone(fixture.candidate);
  delete missingReceipt.inventory.entries.find((entry) => entry.type === 'Microsoft.CognitiveServices/accounts').creation;
  assert.throws(() => sealManifest(missingReceipt), /contract-object-required: inventory\.entries\[\d+\]\.creation/);

  const mismatchedReceipt = structuredClone(fixture.candidate);
  mismatchedReceipt.inventory.entries.find((entry) => entry.type === 'Microsoft.CognitiveServices/accounts')
    .creation.operationId = 'unrelated-operation';
  assert.throws(() => sealManifest(mismatchedReceipt), /contract-creation-operation-mismatch/);

  const protectedCollision = structuredClone(fixture.candidate);
  const foundryAccount = protectedCollision.inventory.entries.find((entry) => entry.type === 'Microsoft.CognitiveServices/accounts').id;
  protectedCollision.protectedTargets.push(foundryAccount);
  protectedCollision.protectedTargetsDigest = digest(protectedCollision.protectedTargets);
  assert.throws(() => sealManifest(protectedCollision), /contract-created-target-is-protected/);

  const unexpectedCandidate = structuredClone(fixture.candidate);
  unexpectedCandidate.inventory.entries.push({
    ...structuredClone(unexpectedCandidate.inventory.entries.find((entry) => entry.type === 'Microsoft.CognitiveServices/accounts')),
    id: `${fixture.manifest.header.identity.resourceGroupId}/providers/Microsoft.CognitiveServices/accounts/undeclared`,
  });
  const unexpectedManifest = sealManifest(unexpectedCandidate);
  const unexpectedState = structuredClone(fixture.state);
  unexpectedState.manifestDigest = unexpectedManifest.canonicalDigest;
  unexpectedState.entries = unexpectedManifest.inventory.entries.map((entry) => {
    const copy = structuredClone(entry); delete copy.creation; return copy;
  });
  unexpectedState.inventoryDigest = digest(unexpectedState.entries);
  resign(unexpectedState);
  const unexpectedReadback = structuredClone(fixture.readback);
  unexpectedReadback.manifestDigest = unexpectedManifest.canonicalDigest;
  unexpectedReadback.entries = unexpectedManifest.inventory.entries.map((entry) => {
    const copy = structuredClone(entry);
    delete copy.creation;
    copy.lifecycleState = 'present';
    if (copy.classification !== 'created') copy.unchanged = true;
    return copy;
  });
  resign(unexpectedReadback);
  assert.throws(
    () => validateVerificationContinuation(preflight, unexpectedManifest, unexpectedState, unexpectedReadback, fixtureNow),
    /verification-continuation-unexpected-created-foundry/,
  );

  const nestedRoleCandidate = structuredClone(fixture.candidate);
  const nestedRoleId = `${foundryAccount}/providers/Microsoft.Authorization/roleAssignments/11111111-2222-4333-8444-555555555555`;
  nestedRoleCandidate.inventory.entries.push({
    id: nestedRoleId,
    kind: 'azure-role-assignment',
    type: 'Microsoft.Authorization/roleAssignments',
    scope: foundryAccount,
    classification: 'created',
    creation: structuredClone(
      nestedRoleCandidate.inventory.entries.find((entry) => entry.classification === 'created').creation,
    ),
    principalId: '33333333-3333-4333-8333-333333333333',
    roleDefinitionId: `/subscriptions/${verificationIdentity.subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/44444444-4444-4444-8444-444444444444`,
  });
  const nestedRoleManifest = sealManifest(nestedRoleCandidate);
  const nestedRoleState = structuredClone(fixture.state);
  nestedRoleState.manifestDigest = nestedRoleManifest.canonicalDigest;
  nestedRoleState.entries = nestedRoleManifest.inventory.entries.map((entry) => {
    const copy = structuredClone(entry); delete copy.creation; return copy;
  });
  nestedRoleState.inventoryDigest = digest(nestedRoleState.entries);
  resign(nestedRoleState);
  const nestedRoleReadback = structuredClone(fixture.readback);
  nestedRoleReadback.manifestDigest = nestedRoleManifest.canonicalDigest;
  nestedRoleReadback.entries = nestedRoleManifest.inventory.entries.map((entry) => {
    const copy = structuredClone(entry);
    delete copy.creation;
    copy.lifecycleState = 'present';
    if (copy.classification !== 'created') copy.unchanged = true;
    return copy;
  });
  resign(nestedRoleReadback);
  assert.doesNotThrow(
    () => validateVerificationContinuation(preflight, nestedRoleManifest, nestedRoleState, nestedRoleReadback, fixtureNow),
  );
  assert.equal(
    createRemovalPreview(nestedRoleManifest, nestedRoleState, nestedRoleReadback, fixtureNow).delete.resources.includes(nestedRoleId),
    true,
  );
  nestedRoleReadback.entries = nestedRoleReadback.entries.filter((entry) => entry.id !== nestedRoleId);
  resign(nestedRoleReadback);
  assert.throws(
    () => validateVerificationContinuation(preflight, nestedRoleManifest, nestedRoleState, nestedRoleReadback, fixtureNow),
    /verification-continuation-agreement-blocked/,
  );
});

test('Graph default-role assignments accept only the explicit nil app-role ID exception', () => {
  const fixture = createFixture({ freshFoundry: true });
  const candidate = structuredClone(fixture.candidate);
  const assignment = {
    id: '/providers/Microsoft.Graph/appRoleAssignedTo/default-role-assignment',
    kind: 'graph-assignment',
    type: 'Microsoft.Graph/appRoleAssignedTo',
    scope: '/providers/Microsoft.Graph',
    classification: 'created',
    creation: structuredClone(
      candidate.inventory.entries.find((entry) => entry.classification === 'created').creation,
    ),
    principalId: '/providers/Microsoft.Graph/directoryObjects/33333333-3333-4333-8333-333333333333',
    resourceId: '/providers/Microsoft.Graph/servicePrincipals/44444444-4444-4444-8444-444444444444',
    appRoleId: '00000000-0000-0000-0000-000000000000',
  };
  candidate.inventory.entries.push(assignment);
  assert.doesNotThrow(() => sealManifest(candidate));

  assignment.appRoleId = '00000000-0000-0000-0000-000000000001';
  assert.throws(() => sealManifest(candidate), /contract-guid-invalid: inventory\.entries\[\d+\]\.appRoleId/);

  const application = candidate.inventory.entries.find((entry) => entry.kind === 'entra-application');
  application.appId = '00000000-0000-0000-0000-000000000000';
  assignment.appRoleId = '00000000-0000-4000-8000-000000000001';
  assert.throws(() => sealManifest(candidate), /contract-guid-invalid: inventory\.entries\[\d+\]\.appId/);
});

test('Foundry mode and identity tampering fails closed while external Foundry remains preserved', () => {
  const external = createFixture();
  const externalPreflight = createPreflight(external.manifest);
  assert.equal(
    createRemovalPreview(external.manifest, external.state, external.readback, fixtureNow).preserve
      .some((entry) => entry.id === ids.foundryAccount && entry.classification === 'external-reference'),
    true,
  );
  const externalPreview = createRemovalPreview(external.manifest, external.state, external.readback, fixtureNow);
  for (const id of [ids.foundryAccount, ids.foundryProject, ids.foundryDeployment]) {
    assert.equal(externalPreview.delete.resources.includes(id), false);
  }

  const modeTamper = structuredClone(externalPreflight);
  modeTamper.foundry.freshFoundry = true;
  modeTamper.foundry.classification = 'created';
  resign(modeTamper);
  assert.throws(
    () => validateCreateOnlyPreflight(
      modeTamper,
      createEnvironment(),
      external.manifest.evidence.approvedPlanDigest,
      new Date('2026-09-03T06:00:00.000Z'),
    ),
    /preflight-environment-mismatch: CREATE_FOUNDRY/,
  );

  const invalidFresh = createPreflight(external.manifest, { freshFoundry: true });
  invalidFresh.foundry.resourceGroupName = 'rg-other';
  resign(invalidFresh);
  assert.throws(
    () => validateCreateOnlyPreflight(
      invalidFresh,
      createEnvironment({ freshFoundry: true }),
      external.manifest.evidence.approvedPlanDigest,
      new Date('2026-09-03T06:00:00.000Z'),
    ),
    /preflight-foundry-mismatch: resourceGroupName/,
  );

  const escapedIsolation = createPreflight(external.manifest, { freshFoundry: true });
  escapedIsolation.foundry.resourceGroupName = 'rg-other';
  resign(escapedIsolation);
  assert.throws(
    () => validateCreateOnlyPreflight(
      escapedIsolation,
      { ...createEnvironment({ freshFoundry: true }), FOUNDRY_RESOURCE_GROUP_NAME: 'rg-other' },
      external.manifest.evidence.approvedPlanDigest,
      new Date('2026-09-03T06:00:00.000Z'),
    ),
    /preflight-fresh-foundry-resource-group-mismatch/,
  );

  const secondDeploymentMismatch = createPreflight(external.manifest);
  secondDeploymentMismatch.foundry.secondModelDeployments = [{
    deploymentName: 'unexpected-second',
    modelName: 'test-model',
    modelVersion: '1',
    modelFormat: 'OpenAI',
    skuName: 'GlobalStandard',
    capacity: 1,
  }];
  resign(secondDeploymentMismatch);
  assert.throws(
    () => validateCreateOnlyPreflight(
      secondDeploymentMismatch,
      createEnvironment(),
      external.manifest.evidence.approvedPlanDigest,
      new Date('2026-09-03T06:00:00.000Z'),
    ),
    /preflight-foundry-mismatch: secondModelDeployments/,
  );

  const missingFoundryNames = structuredClone(externalPreflight);
  missingFoundryNames.foundry.accountName = '';
  resign(missingFoundryNames);
  assert.throws(
    () => validateCreateOnlyPreflight(
      missingFoundryNames,
      { ...createEnvironment(), FOUNDRY_ACCOUNT_NAME: '' },
      external.manifest.evidence.approvedPlanDigest,
      new Date('2026-09-03T06:00:00.000Z'),
    ),
    /contract-string-required: preflight\.foundry\.accountName/,
  );

  const identityTamper = structuredClone(externalPreflight);
  identityTamper.identity.location = 'other-region';
  resign(identityTamper);
  assert.throws(
    () => validateVerificationContinuation(identityTamper, external.manifest, external.state, external.readback, fixtureNow),
    /contract-identity-mismatch: manifest\.header\.identity\.location/,
  );
});

test('protected resource groups and C0 resources can never become created ownership', () => {
  for (const protectedId of [requiredProtectedTargets[0], requiredProtectedTargets.at(-1)]) {
    const { candidate } = createFixture();
    candidate.inventory.entries.push({
      ...structuredClone(candidate.inventory.entries[0]),
      id: protectedId,
    });
    assert.throws(() => sealManifest(candidate), /contract-created-target-is-protected/);
  }
});

test('created role-assignment GUIDs and resource names containing incidental "c0" are not falsely protected', () => {
  const incidentalIds = [
    // Role-assignment GUID containing the substring "c0" that is not the C0 token, under the
    // (non-protected) verification resource group being created by this manifest.
    `${ids.resourceGroup}/providers/Microsoft.Authorization/roleAssignments/1c05a2f0-abcd-4e12-9f34-c0ffee123456`,
    // Resource name containing "c0" as an incidental substring, not the exact protected APIM name.
    `${ids.resourceGroup}/providers/Microsoft.ApiManagement/service/apim-account0-eus2`,
  ];
  for (const id of incidentalIds) {
    const { candidate } = createFixture();
    candidate.inventory.entries.push({
      ...structuredClone(candidate.inventory.entries[0]),
      id,
    });
    assert.doesNotThrow(() => sealManifest(candidate));
  }
});

test('ownership mismatch, missing state, stale state, duplicate ownership, and contradictions fail closed', () => {
  const fixture = createFixture();
  assert.throws(
    () => createRemovalPreview(fixture.manifest, null, fixture.readback, fixtureNow),
    /contract-object-required: state/,
  );

  const stale = structuredClone(fixture.state);
  stale.manifestVersion += 1;
  resign(stale);
  assert.throws(
    () => createRemovalPreview(fixture.manifest, stale, fixture.readback, fixtureNow),
    /state-manifest-version-mismatch/,
  );

  const duplicate = structuredClone(fixture.candidate);
  duplicate.inventory.entries.push(structuredClone(duplicate.inventory.entries[0]));
  assert.throws(() => sealManifest(duplicate), /contract-duplicate-entry-id/);

  const ambiguous = structuredClone(fixture.candidate);
  const external = ambiguous.inventory.entries.find((entry) => entry.id === ids.foundryAccount);
  external.classification = 'created';
  assert.throws(() => sealManifest(ambiguous), /contract-object-required: inventory\.entries\[\d+\]\.creation/);

  const mismatch = structuredClone(fixture.readback);
  mismatch.entries.find((entry) => entry.id === ids.resourceGroup).type = 'Microsoft.Resources/unknown';
  resign(mismatch);
  const mismatchPreview = createRemovalPreview(fixture.manifest, fixture.state, mismatch, fixtureNow);
  assert.equal(mismatchPreview.status, 'blocked');
  assert.deepEqual(mismatchPreview.blocked, [`identity-mismatch:${ids.resourceGroup}`]);

  const contradictoryState = structuredClone(fixture.state);
  contradictoryState.deletedEntryIds = [ids.resourceGroup];
  resign(contradictoryState);
  const contradictoryPreview = createRemovalPreview(fixture.manifest, contradictoryState, fixture.readback, fixtureNow);
  assert.equal(contradictoryPreview.status, 'blocked');
  assert.deepEqual(contradictoryPreview.blocked, [`deleted-state-present:${ids.resourceGroup}`]);
});

test('readback freshness rejects invalid, future, predating, and older-than-30-minute evidence', () => {
  const fixture = createFixture();
  const freshPreview = createRemovalPreview(fixture.manifest, fixture.state, fixture.readback, fixtureNow);
  assert.equal(freshPreview.status, 'ready');
  assert.deepEqual(freshPreview.readbackFreshness, {
    observedAt: '2026-09-03T06:05:00.000Z',
    validUntil: '2026-09-03T06:35:00.000Z',
    maximumAgeSeconds: 1800,
  });
  assert.equal(
    createRemovalPreview(
      fixture.manifest,
      fixture.state,
      fixture.readback,
      new Date('2026-09-03T06:35:00.000Z'),
    ).status,
    'ready',
  );
  assert.throws(
    () => createRemovalPreview(
      fixture.manifest,
      fixture.state,
      fixture.readback,
      new Date('2026-09-03T06:35:00.001Z'),
    ),
    /readback-stale/,
  );

  for (const [observedAt, expected] of [
    ['not-a-timestamp', /contract-timestamp-invalid: readback\.observedAt/],
    ['2026-09-03T06:08:00.000Z', /readback-observed-at-future/],
    ['2026-09-03T05:59:59.999Z', /readback-observed-before-manifest/],
  ]) {
    const changed = structuredClone(fixture.readback);
    changed.observedAt = observedAt;
    resign(changed);
    assert.throws(
      () => createRemovalPreview(fixture.manifest, fixture.state, changed, fixtureNow),
      expected,
    );
  }

  assert.equal(
    freshPreview.preserve.some((entry) => entry.id === ids.foundryAccount),
    true,
  );
});

test('approval time is bound to the fresh readback and rechecked when the preview is used', () => {
  const fixture = createFixture();
  const preview = createRemovalPreview(fixture.manifest, fixture.state, fixture.readback, fixtureNow);
  const targets = preview.delete.resources;

  const futureApproval = createApproval(preview, 'resource-delete', targets);
  futureApproval.approvedAt = '2026-09-03T06:08:00.000Z';
  resign(futureApproval);
  assert.throws(
    () => validateApproval(preview, futureApproval, fixtureNow),
    /approval-time-future/,
  );

  const preObservationApproval = createApproval(preview, 'resource-delete', targets);
  preObservationApproval.approvedAt = '2026-09-03T06:04:59.999Z';
  resign(preObservationApproval);
  assert.throws(
    () => validateApproval(preview, preObservationApproval, fixtureNow),
    /approval-before-readback/,
  );

  const invalidApproval = createApproval(preview, 'resource-delete', targets);
  invalidApproval.approvedAt = 'invalid';
  resign(invalidApproval);
  assert.throws(
    () => validateApproval(preview, invalidApproval, fixtureNow),
    /contract-timestamp-invalid: approval\.approvedAt/,
  );

  const validApproval = createApproval(preview, 'resource-delete', targets);
  validApproval.expiresAt = '2026-09-03T06:36:00.000Z';
  resign(validApproval);
  assert.equal(
    validateApproval(preview, validApproval, new Date('2026-09-03T06:35:00.000Z')).approvalValidated,
    true,
  );
  assert.throws(
    () => validateApproval(preview, validApproval, new Date('2026-09-03T06:35:00.001Z')),
    /preview-readback-stale/,
  );
});

test('dry-run output is canonical and excludes external Foundry and pre-existing Entra objects', () => {
  const fixture = createFixture();
  const first = createRemovalPreview(fixture.manifest, fixture.state, fixture.readback, fixtureNow);

  const reorderedState = structuredClone(fixture.state);
  reorderedState.entries.reverse();
  resign(reorderedState);
  const reorderedReadback = structuredClone(fixture.readback);
  reorderedReadback.entries.reverse();
  resign(reorderedReadback);
  const second = createRemovalPreview(fixture.manifest, reorderedState, reorderedReadback, fixtureNow);

  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.equal(first.status, 'ready');
  assert.equal(first.mutationImplemented, false);
  assert.deepEqual(first.blocked, []);
  assert.deepEqual(first.missing, []);
  assert.deepEqual(first.unknown, []);

  for (const preservedId of [
    ids.foundryAccount,
    ids.foundryProject,
    ids.foundryDeployment,
    ids.protectedApplication,
  ]) {
    assert.equal(first.preserve.some((entry) => entry.id === preservedId), true);
    assert.equal(first.delete.resources.includes(preservedId), false);
    assert.equal(first.delete.entraObjects.includes(preservedId), false);
  }
});

test('resource deletion, Entra cleanup, APIM purge, and Key Vault purge require independent approvals', () => {
  const fixture = createFixture();
  markSoftDeleted(fixture, ids.apiManagement, { purgeEligible: true });
  markSoftDeleted(fixture, ids.keyVault, {
    purgeEligible: true,
    retentionUntil: '2026-09-02T06:00:00.000Z',
  });
  const preview = createRemovalPreview(fixture.manifest, fixture.state, fixture.readback, fixtureNow);
  const phases = new Map([
    ['resource-delete', preview.delete.resources],
    ['entra-cleanup', preview.delete.entraObjects],
    ['apim-purge', preview.purgeEligible.apiManagement],
    ['key-vault-purge', preview.purgeEligible.keyVault],
  ]);

  for (const [phase, targets] of phases) {
    const authorization = validateApproval(
      preview,
      createApproval(preview, phase, targets),
      new Date('2026-09-03T06:07:00.000Z'),
    );
    assert.equal(authorization.phase, phase);
    assert.deepEqual(authorization.targetIds, targets);
    assert.equal(authorization.approvalValidated, true);
    assert.equal(authorization.mutationImplemented, false);
  }

  const resourceApproval = createApproval(preview, 'resource-delete', phases.get('resource-delete'));
  resourceApproval.phase = 'apim-purge';
  resign(resourceApproval);
  assert.throws(
    () => validateApproval(preview, resourceApproval, new Date('2026-09-03T06:07:00.000Z')),
    /approval-target-mismatch/,
  );
});

test('purge-protected Key Vault reports deferred retention and rejects purge approval', () => {
  const fixture = createFixture();
  markSoftDeleted(fixture, ids.keyVault, {
    purgeEligible: false,
    retentionUntil: '2026-09-10T06:00:00.000Z',
  });
  const preview = createRemovalPreview(fixture.manifest, fixture.state, fixture.readback, fixtureNow);
  assert.deepEqual(preview.purgeEligible.keyVault, []);
  assert.deepEqual(preview.pendingRetention.keyVault, [{
    id: ids.keyVault,
    retentionUntil: '2026-09-10T06:00:00.000Z',
    state: 'DeletedPendingRetention',
  }]);
  assert.throws(
    () => validateApproval(
      preview,
      createApproval(preview, 'key-vault-purge', []),
      new Date('2026-09-03T06:07:00.000Z'),
    ),
    /key-vault-purge-protection-retention-active/,
  );
});

test('PowerShell removal preview executes the real local engine with zero Azure calls', () => {
  const observedAt = new Date();
  const fixture = createFixture({
    createdAt: new Date(observedAt.valueOf() - 60_000).toISOString(),
    readbackObservedAt: observedAt.toISOString(),
  });
  const directory = makeTestDirectory('ownership-cleanup-');
  try {
    const files = {
      manifest: path.join(directory, 'manifest.json'),
      state: path.join(directory, 'state.json'),
      readback: path.join(directory, 'readback.json'),
      output: path.join(directory, 'preview.json'),
    };
    writeFileSync(files.manifest, JSON.stringify(fixture.manifest));
    writeFileSync(files.state, JSON.stringify(fixture.state));
    writeFileSync(files.readback, JSON.stringify(fixture.readback));
    const result = spawnSync('pwsh', [
      '-NoProfile',
      '-File',
      cleanupScript,
      '-ManifestPath',
      files.manifest,
      '-StatePath',
      files.state,
      '-ReadbackPath',
      files.readback,
      '-Preview',
      '-OutputPath',
      files.output,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const preview = JSON.parse(readFileSync(files.output, 'utf8'));
    assert.equal(preview.status, 'ready');
    assert.equal(preview.mutationImplemented, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('PowerShell removal self-test executes the real local engine with zero Azure calls', () => {
  const result = spawnSync('pwsh', [
    '-NoProfile',
    '-File',
    cleanupScript,
    '-SelfTest',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    manifestDigest: JSON.parse(result.stdout).manifestDigest,
    mutationImplemented: false,
    previewDigest: JSON.parse(result.stdout).previewDigest,
    result: 'pass',
  });
});
