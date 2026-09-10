import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MODEL_CAPTURE_REASONS,
  ModelCaptureRefusedError,
  addModel,
  captureModel,
  recaptureModels,
  removeModel,
} from '../../app/governance-domain/registry/model-capture.mjs';
import { assertModelRegistrySnapshotV1 } from '../../app/governance-domain/registry/model-registry-validator.mjs';
import { REGISTRY_CAPTURE_RETENTION_SECONDS } from '../../app/governance-domain/registry/registry-capture-retention.mjs';
import { getDeterministicGovernanceSnapshots } from '../../app/local-adapters/deterministic-governance-snapshots.mjs';

const AT = '2026-07-24T10:00:00.000Z';

const DEPLOYMENT = Object.freeze({
  deploymentName: 'deploy-fictional-grok',
  modelName: 'grok-fictional-01',
  modelFormat: 'xAI',
  capabilities: Object.freeze({ chatCompletion: true, responses: false }),
});

function registrySnapshot() {
  return getDeterministicGovernanceSnapshots().modelRegistrySnapshot;
}

function entitlementSnapshot() {
  return getDeterministicGovernanceSnapshots().entitlementSnapshot;
}

test('maturity follows the name the publisher chose, and is a label rather than a gate', () => {
  assert.equal(captureModel({ deployment: DEPLOYMENT }).lifecycle, 'generally-available');

  for (const marked of [
    { ...DEPLOYMENT, modelName: 'grok-fictional-01-preview' },
    { ...DEPLOYMENT, modelVersion: '2026-03-17-preview' },
  ]) {
    assert.equal(captureModel({ deployment: marked }).lifecycle, 'preview');
  }
});

test('the wire contracts are read from the deployment, not assumed from the backend', () => {
  const chatOnly = captureModel({ deployment: DEPLOYMENT });
  assert.deepEqual(chatOnly.apiFamilies, ['openai-chat-completions']);

  const both = captureModel({
    deployment: { ...DEPLOYMENT, capabilities: { chatCompletion: true, responses: true } }
  });
  assert.deepEqual(both.apiFamilies, ['openai-chat-completions', 'openai-responses']);
});

test('a deployment advertising no wire contract this gateway serves is refused', () => {
  assert.throws(
    () =>
      captureModel({
        deployment: { ...DEPLOYMENT, capabilities: { chatCompletion: false, responses: false } }
      }),
    (error) =>
      error instanceof ModelCaptureRefusedError && error.code === MODEL_CAPTURE_REASONS.noApiFamily,
  );
});

test('an explicit modelKey overrides the deployment name as the routing alias', () => {
  const model = captureModel({
    deployment: DEPLOYMENT,
    modelKey: 'coding-grok',
  });

  assert.equal(model.modelKey, 'coding-grok');
  assert.equal(model.providerDeploymentName, 'deploy-fictional-grok');
});

test('add produces the next version of the whole snapshot with the new model included', () => {
  const before = registrySnapshot();
  const model = captureModel({ deployment: DEPLOYMENT });

  const next = addModel({ snapshot: before, model, at: AT });

  assert.equal(next.version, before.version + 1);
  assert.equal(next.capturedAt, AT);
  assert.equal(
    Date.parse(next.expiresAt) - Date.parse(next.capturedAt),
    REGISTRY_CAPTURE_RETENTION_SECONDS * 1000,
  );
  assert.equal(next.models.length, before.models.length + 1);
  const captured = next.models.find((entry) => entry.modelKey === 'deploy-fictional-grok');
  assert.ok(captured);
  assert.equal(captured.lifecycle, 'generally-available');
  // The models untouched by this capture are carried, not rebuilt.
  const untouched = next.models.filter((entry) => entry.modelKey !== 'deploy-fictional-grok');
  assert.deepEqual(
    untouched.map((entry) => entry.modelKey),
    before.models.map((entry) => entry.modelKey),
  );
});

test('adding a model already in the registry is refused rather than duplicated', () => {
  const before = registrySnapshot();
  const duplicate = captureModel({
    deployment: {
      deploymentName: 'deploy-coding-fast',
      modelName: 'coding-fast',
      modelFormat: 'OpenAI',
      capabilities: { chatCompletion: true, responses: true },
    },
    modelKey: 'coding-fast',
  });

  assert.throws(
    () => addModel({ snapshot: before, model: duplicate, at: AT }),
    (error) => error instanceof ModelCaptureRefusedError && error.code === MODEL_CAPTURE_REASONS.duplicateModel,
  );
});

test('recapture refreshes every descriptor and the registry window from provider rows', () => {
  const before = registrySnapshot();
  const deployments = before.models.map((entry) => ({
    deploymentName: entry.providerDeploymentName,
    modelName: `${entry.modelKey}-preview`,
    modelVersion: '1',
    modelFormat: entry.providerKey === 'azure-openai' ? 'OpenAI' : 'Other',
    capabilities: { chatCompletion: true, responses: false },
    raiPolicyName: 'recaptured-policy',
  }));
  const next = recaptureModels({ snapshot: before, deployments, at: AT });

  assert.equal(next.version, before.version + 1);
  assert.equal(Date.parse(next.expiresAt) - Date.parse(AT), REGISTRY_CAPTURE_RETENTION_SECONDS * 1000);
  assert.ok(next.models.every((entry) => entry.lifecycle === 'preview'));
  assert.ok(next.models.every((entry) => entry.apiFamilies.length === 1));
  assert.ok(next.models.every((entry) => entry.safetyPolicy === 'recaptured-policy'));
});

test('recapture refuses when a registered provider deployment is absent', () => {
  const before = registrySnapshot();
  assert.throws(
    () => recaptureModels({ snapshot: before, deployments: [], at: AT }),
    (error) => error instanceof ModelCaptureRefusedError
      && error.code === MODEL_CAPTURE_REASONS.recaptureDeploymentAbsent,
  );
});

test('remove produces the next version of the whole snapshot without the named model', () => {
  const before = registrySnapshot();
  const next = removeModel({
    snapshot: before,
    modelKey: 'coding-fast',
    reasonCode: 'model-retired-by-operator',
    entitlementSnapshot: null,
    at: AT,
  });

  assert.equal(next.version, before.version + 1);
  assert.equal(
    Date.parse(next.expiresAt) - Date.parse(next.capturedAt),
    REGISTRY_CAPTURE_RETENTION_SECONDS * 1000,
  );
  assert.equal(next.models.length, before.models.length - 1);
  assert.ok(!next.models.some((entry) => entry.modelKey === 'coding-fast'));
  assert.ok(next.models.some((entry) => entry.modelKey === 'coding-primary'));
});

test('removing an unknown model is refused by name', () => {
  const before = registrySnapshot();

  assert.throws(
    () => removeModel({
      snapshot: before,
      modelKey: 'coding-imaginary',
      reasonCode: 'model-retired-by-operator',
      entitlementSnapshot: null,
      at: AT,
    }),
    (error) => error instanceof ModelCaptureRefusedError
      && error.code === MODEL_CAPTURE_REASONS.modelUnknown
      && error.detail === 'coding-imaginary',
  );
});

test('removing the last model is refused rather than publishing an empty registry', () => {
  const before = registrySnapshot();
  const downToOne = removeModel({
    snapshot: before,
    modelKey: 'coding-fast',
    reasonCode: 'model-retired-by-operator',
    entitlementSnapshot: null,
    at: AT,
  });
  assert.equal(downToOne.models.length, 1);

  assert.throws(
    () => removeModel({
      snapshot: downToOne,
      modelKey: 'coding-primary',
      reasonCode: 'model-retired-by-operator',
      entitlementSnapshot: null,
      at: AT,
    }),
    (error) => error instanceof ModelCaptureRefusedError && error.code === MODEL_CAPTURE_REASONS.lastModel,
  );
});

test('removing a model an entitlement still allows is refused by name, naming the binding', () => {
  const before = registrySnapshot();

  assert.throws(
    () => removeModel({
      snapshot: before,
      modelKey: 'coding-fast',
      reasonCode: 'model-retired-by-operator',
      entitlementSnapshot: entitlementSnapshot(),
      at: AT,
    }),
    (error) => error instanceof ModelCaptureRefusedError
      && error.code === MODEL_CAPTURE_REASONS.modelEntitled
      && error.detail.includes('binding-subject-local-admin-001'),
  );
});

test('removing without a reason code is refused', () => {
  const before = registrySnapshot();

  assert.throws(
    () => removeModel({
      snapshot: before,
      modelKey: 'coding-fast',
      reasonCode: 'Not A Reason Code',
      entitlementSnapshot: null,
      at: AT,
    }),
    (error) => error instanceof ModelCaptureRefusedError && error.code === MODEL_CAPTURE_REASONS.reasonRequired,
  );
});

test('omitting entitlementSnapshot on remove throws, distinct from supplying null', () => {
  const before = registrySnapshot();

  assert.throws(
    () => removeModel({ snapshot: before, modelKey: 'coding-fast', reasonCode: 'model-retired-by-operator', at: AT }),
    TypeError,
  );
});

test('the snapshot produced by add passes the real registry validator unchanged', () => {
  const before = registrySnapshot();
  const model = captureModel({ deployment: DEPLOYMENT });
  const next = addModel({ snapshot: before, model, at: AT });

  const revalidated = assertModelRegistrySnapshotV1(next, { evaluationTime: AT });
  assert.equal(revalidated.models.length, next.models.length);
});

test('the snapshot produced by remove passes the real registry validator unchanged', () => {
  const before = registrySnapshot();
  const next = removeModel({
    snapshot: before,
    modelKey: 'coding-fast',
    reasonCode: 'model-retired-by-operator',
    entitlementSnapshot: null,
    at: AT,
  });

  const revalidated = assertModelRegistrySnapshotV1(next, { evaluationTime: AT });
  assert.equal(revalidated.models.length, 1);
});
