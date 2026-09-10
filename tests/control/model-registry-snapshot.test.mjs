import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertModelRegistrySnapshotV1,
  resolveApplicationAttribution,
  resolveModelDescriptor,
} from '../../app/governance-domain/registry/model-registry-validator.mjs';

const evaluationTime = '2026-08-07T00:00:00.000Z';
const tenantId = 'contoso.tenant.001';

function model(modelKey, overrides = {}) {
  return {
    modelKey,
    providerKey: 'azure-openai',
    apiFamilies: ['openai-chat-completions', 'openai-responses'],
    lifecycle: 'generally-available',
    safetyPolicy: 'local-default-policy',
    ...overrides,
  };
}

function application(applicationId, attributionQuality, overrides = {}) {
  return {
    applicationId,
    attributionQuality,
    displayCode: `application.${applicationId}`,
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    contractVersion: 'v1',
    snapshotId: 'model-registry-001',
    tenantId,
    version: 1,
    status: 'complete',
    capturedAt: '2026-08-06T23:55:00.000Z',
    expiresAt: '2026-08-07T00:30:00.000Z',
    sourceRevision: 'model-registry-source-001',
    models: [model('coding-fast'), model('coding-primary')],
    applications: [
      application('azure-cli', 'generic'),
      application('gateway-adapter', 'strong'),
    ],
    ...overrides,
  };
}

function assertRejected(build, expectation) {
  assert.throws(
    () => assertModelRegistrySnapshotV1(build(), { evaluationTime, principalTenantId: tenantId }),
    expectation,
  );
}

function accept(value = snapshot()) {
  return assertModelRegistrySnapshotV1(value, { evaluationTime, principalTenantId: tenantId });
}

test('a complete registry resolves provider identity for a registered model', () => {
  const registry = accept();
  const descriptor = resolveModelDescriptor(registry, 'coding-primary');

  assert.equal(descriptor.providerKey, 'azure-openai');
  assert.ok(Object.isFrozen(descriptor), 'a resolved descriptor must not be mutable.');
});

test('attribution quality distinguishes a shared developer tool from a reviewed adapter', () => {
  const registry = accept();

  assert.equal(resolveApplicationAttribution(registry, 'gateway-adapter').quality, 'strong');
  assert.equal(resolveApplicationAttribution(registry, 'azure-cli').quality, 'generic');
});

test('an unregistered application is unavailable rather than defaulted to generic', () => {
  const registry = accept();
  const resolved = resolveApplicationAttribution(registry, 'unknown-client');

  assert.equal(resolved.quality, null);
  assert.equal(resolved.reasonCode, 'application-unregistered');
});

test('an unregistered model resolves to null rather than a synthesised descriptor', () => {
  assert.equal(resolveModelDescriptor(accept(), 'never-published'), null);
});

test('the accepted snapshot is frozen through its nested records', () => {
  const registry = accept();

  assert.ok(Object.isFrozen(registry));
  assert.ok(Object.isFrozen(registry.models));
  assert.ok(Object.isFrozen(registry.models[0].apiFamilies));
});

test('a model key is bounded at 64 characters', () => {
  const longest = 'm'.repeat(64);
  accept(snapshot({ models: [model(longest)] }));

  assertRejected(() => snapshot({ models: [model('m'.repeat(65))] }), /modelKey/);
});

test('a model key may not use the colon that a safe identifier would allow', () => {
  // The effective policy document narrows model aliases further than safe identifiers,
  // so a composite key would validate here and fail when the document is composed.
  assertRejected(() => snapshot({ models: [model('azure-openai:coding-fast')] }), /modelKey/);
});

test('what a model can do is stated as the wire contracts it serves, and nothing else', () => {
  // The six capability flags and the residency block were withdrawn: the provider
  // states neither, so both were authored values standing in for captured ones.
  for (const withdrawn of ['capabilities', 'dataResidency']) {
    assertRejected(
      () => snapshot({ models: [model('coding-fast', { [withdrawn]: {} })] }),
      new RegExp(withdrawn),
    );
  }
});

test('context window and output ceilings are not registry facts', () => {
  // Removed deliberately: a smaller-context target reports an immediate, recoverable
  // error, so the registry no longer carries a ceiling nobody can capture.
  assertRejected(
    () => snapshot({ models: [model('coding-fast', { contextWindowTokens: 128000 })] }),
    /contextWindowTokens/,
  );
  assertRejected(
    () => snapshot({ models: [model('coding-fast', { maxOutputTokens: 16384 })] }),
    /maxOutputTokens/,
  );
});

test('the provider enum is closed so two spellings cannot defeat an equality comparison', () => {
  assertRejected(() => snapshot({ models: [model('coding-fast', { providerKey: 'AzureOpenAI' })] }), /providerKey/);
  assertRejected(() => snapshot({ models: [model('coding-fast', { providerKey: 'openai' })] }), /providerKey/);
});

test('an api family list must be non-empty, sorted, and unique', () => {
  assertRejected(() => snapshot({ models: [model('coding-fast', { apiFamilies: [] })] }), /apiFamilies/);
  assertRejected(
    () => snapshot({ models: [model('coding-fast', { apiFamilies: ['openai-responses', 'openai-chat-completions'] })] }),
    /sorted/,
  );
  assertRejected(
    () => snapshot({ models: [model('coding-fast', { apiFamilies: ['openai-responses', 'openai-responses'] })] }),
    /duplicate/i,
  );
});

test('the anthropic messages family is representable without a live deployment', () => {
  const registry = accept(
    snapshot({
      models: [
        model('claude-governed', {
          providerKey: 'anthropic',
          apiFamilies: ['anthropic-messages'],
        }),
      ],
    }),
  );

  assert.equal(resolveModelDescriptor(registry, 'claude-governed').providerKey, 'anthropic');
});

test('models and applications are sorted and unique by their own key', () => {
  assertRejected(
    () => snapshot({ models: [model('coding-primary'), model('coding-fast')] }),
    /sorted/,
  );
  assertRejected(
    () => snapshot({ models: [model('coding-fast'), model('coding-fast')] }),
    /duplicate/i,
  );
  assertRejected(
    () =>
      snapshot({
        applications: [application('gateway-adapter', 'strong'), application('azure-cli', 'generic')],
      }),
    /sorted/,
  );
});

test('attribution quality is limited to the two reviewed states', () => {
  assertRejected(
    () => snapshot({ applications: [application('azure-cli', 'unknown')] }),
    /attributionQuality/,
  );
});

test('every degraded status refuses to carry catalogue records', () => {
  for (const status of ['incomplete', 'stale', 'ambiguous', 'source-unavailable']) {
    assertRejected(() => snapshot({ status, reason: 'source refused' }), /cannot carry/);
    assertRejected(
      () => snapshot({ status, reason: 'source refused', models: [], applications: [application('azure-cli', 'generic')] }),
      /cannot carry/,
    );
  }
});

test('a degraded status must state why', () => {
  assertRejected(() => snapshot({ status: 'stale', models: [], applications: [] }), /reason/);
});

test('a degraded registry is accepted as evidence of its own unavailability', () => {
  const registry = accept(
    snapshot({ status: 'source-unavailable', reason: 'catalogue publisher unreachable', models: [], applications: [] }),
  );

  assert.equal(registry.status, 'source-unavailable');
  assert.equal(resolveModelDescriptor(registry, 'coding-primary'), null);
});

test('a registry captured for another tenant is refused', () => {
  assertRejected(() => snapshot({ tenantId: 'other.tenant.002' }), /tenant/i);
});

test('a registry captured in the future or already expired carries no authority', () => {
  assertRejected(() => snapshot({ capturedAt: '2026-08-07T00:05:00.000Z' }), /future/i);
  assertRejected(
    () => snapshot({ capturedAt: '2026-08-06T00:00:00.000Z', expiresAt: '2026-08-06T23:00:00.000Z' }),
    /expired/i,
  );
});

test('a catalogue identifier may not carry an endpoint', () => {
  assertRejected(
    () => snapshot({ applications: [application('azure-cli', 'generic', { displayCode: 'https://example.invalid' })] }),
    TypeError,
  );
});

test('free text may not smuggle an endpoint or credential', () => {
  assertRejected(
    () => snapshot({ status: 'stale', reason: 'publisher at https://example.invalid timed out', models: [], applications: [] }),
    /credential|URL/i,
  );
  assertRejected(
    () => snapshot({ status: 'stale', reason: 'refused with api-key rotation pending', models: [], applications: [] }),
    /credential|URL/i,
  );
});

test('unknown fields are refused at every level', () => {
  assertRejected(() => snapshot({ deploymentName: 'gpt-5-4-mini' }), /not allowed/);
  assertRejected(
    () => snapshot({ models: [model('coding-fast', { azureResourceId: '/subscriptions/x' })] }),
    /not allowed/,
  );
});

test('a lifecycle state outside the reviewed set is refused', () => {
  assertRejected(() => snapshot({ models: [model('coding-fast', { lifecycle: 'ga' })] }), /lifecycle/);
});

test('a safety policy is a bounded name, and stating none is allowed but not silent', () => {
  assertRejected(
    () => snapshot({ models: [model('coding-fast', { safetyPolicy: 'has spaces and /slashes' })] }),
    /safetyPolicy/,
  );
  // Null is a stated absence the compiler refuses to hop across, not a default.
  const accepted = accept(snapshot({ models: [model('coding-fast', { safetyPolicy: null })] }));
  assert.equal(accepted.models[0].safetyPolicy, null);
});
