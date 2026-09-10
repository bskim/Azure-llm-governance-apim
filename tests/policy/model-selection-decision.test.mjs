import assert from 'node:assert/strict';
import test from 'node:test';

import { decideModelSelection } from '../../app/governance-domain/policy/model-selection-decision.mjs';
import { assertModelRegistrySnapshotV1 } from '../../app/governance-domain/registry/model-registry-validator.mjs';

const evaluationTime = '2026-08-07T00:00:00.000Z';
const tenantId = 'tenant-local-demo';
const applicationKey = 'ak1-abcdefghijklmnop';

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

function registry({ models, status = 'complete', applications } = {}) {
  const degraded = status !== 'complete';
  return assertModelRegistrySnapshotV1(
    {
      contractVersion: 'v1',
      snapshotId: 'model-registry-001',
      tenantId,
      version: 3,
      status,
      ...(degraded ? { reason: 'catalogue publisher behind' } : {}),
      capturedAt: '2026-08-06T23:55:00.000Z',
      expiresAt: '2026-08-07T00:30:00.000Z',
      sourceRevision: 'model-registry-source-001',
      models: degraded
        ? []
        : (models ?? [
            model('coding-fast', {
            }),
            model('coding-primary'),
          ]),
      applications: degraded
        ? []
        : (applications ?? [
            { applicationId: 'azure-cli', attributionQuality: 'generic', displayCode: 'application.azure-cli' },
            { applicationId: 'codex-adapter', attributionQuality: 'strong', displayCode: 'application.codex' },
          ]),
    },
    { evaluationTime, principalTenantId: tenantId },
  );
}

function effectivePolicy({ chain = [{ from: 'coding-primary', to: 'coding-fast' }], enabled = true, modelSelectionIntent = 'preferred' } = {}) {
  return {
    configVersion: 7,
    resolution: 'resolved',
    allowedModels: ['coding-fast', 'coding-primary'],
    warnThresholdPercent: 80,
    modelSelectionIntent,
    limits: [{ scope: 'organization', modelScope: 'all-models', tokenQuota: 1_000, quotaPeriod: 'Daily' }],
    fallback: { enabled, maxDepth: 1, chain },
  };
}

function decide(overrides = {}) {
  return decideModelSelection({
    requestedModel: 'coding-primary',
    effectivePolicy: effectivePolicy(),
    remainingTokensByScope: { organization: 1_000 },
    registry: registry(),
    applicationId: 'codex-adapter',
    applicationKey,
    evaluationTime,
    ...overrides,
  });
}

test('a request served unchanged records both provider identities and no downgrade', () => {
  const decision = decide();

  assert.equal(decision.decision, 'selected');
  assert.equal(decision.hops, 0);
  assert.deepEqual(decision.requested, { modelKey: 'coding-primary', providerKey: 'azure-openai' });
  assert.deepEqual(decision.effective, { modelKey: 'coding-primary', providerKey: 'azure-openai' });
  assert.equal(decision.trigger.kind, 'none');
});

test('a downgrade records the requested and effective model with the same provider', () => {
  const decision = decide({ remainingTokensByScope: { organization: 0 } });

  assert.equal(decision.decision, 'selected');
  assert.equal(decision.hops, 1);
  assert.equal(decision.requested.modelKey, 'coding-primary');
  assert.equal(decision.effective.modelKey, 'coding-fast');
  assert.equal(decision.effective.providerKey, decision.requested.providerKey);
  assert.equal(decision.trigger.kind, 'threshold-breach');
  assert.deepEqual(decision.trigger.breachedScopes, ['organization']);
  assert.equal(decision.trigger.warnThresholdPercent, 80);
});

test('a reviewed client keeps strong attribution and a shared tool keeps generic', () => {
  assert.equal(decide().applicationAttribution.quality, 'strong');
  assert.equal(decide({ applicationId: 'azure-cli' }).applicationAttribution.quality, 'generic');
});

test('an unregistered client is attributed as unavailable and never as a specific agent', () => {
  const decision = decide({ applicationId: 'unknown-client' });

  assert.equal(decision.applicationAttribution.quality, null);
  assert.equal(decision.applicationAttribution.reasonCode, 'application-unregistered');
  assert.equal(decision.applicationAttribution.applicationKey, applicationKey);
  // Attribution being unavailable does not make the model selection unavailable.
  assert.equal(decision.decision, 'selected');
});

test('attribution is present on every branch, including a denial', () => {
  const denied = decide({
    requestedModel: 'coding-fast',
    remainingTokensByScope: { organization: 0 },
    onExhausted: 'deny',
  });

  assert.equal(denied.decision, 'denied');
  assert.equal(denied.effective, null);
  assert.equal(denied.applicationAttribution.quality, 'strong');
  assert.equal(denied.exhausted.unenforcedPolicy, null, 'an applied denial is not unenforced.');
});

test('a configured denial the request path cannot carry out is recorded as unenforced', () => {
  // No enabled plan reaches the selector, so the configured denial cannot be applied.
  // The record says the request was served and that the policy went unenforced.
  const decision = decide({
    requestedModel: 'coding-primary',
    effectivePolicy: effectivePolicy({ chain: [], enabled: false }),
    remainingTokensByScope: { organization: 0 },
    onExhausted: 'deny',
    fallbackRejections: [
      { from: 'coding-primary', to: 'coding-fast', blockedBy: 'fallback-target-not-entitled' },
    ],
  });

  assert.equal(decision.decision, 'selected');
  assert.deepEqual(decision.exhausted, {
    modelKey: 'coding-primary',
    providerKey: 'azure-openai',
    blockedBy: 'fallback-target-not-entitled',
    unenforcedPolicy: 'deny',
  });
});

test('a pin is recorded as the reason no substitute was taken', () => {
  const decision = decide({
    effectivePolicy: effectivePolicy({ modelSelectionIntent: 'pinned' }),
    remainingTokensByScope: { organization: 0 },
    onExhausted: 'deny',
    fallbackRejections: [
      { from: 'coding-primary', to: 'coding-fast', blockedBy: 'fallback-target-not-entitled' },
    ],
  });

  assert.equal(decision.modelSelectionIntent, 'pinned');
  assert.equal(decision.effective.modelKey, 'coding-primary');
  assert.equal(decision.exhausted.blockedBy, 'model-pinned');
  // Fallback was never consulted, so it was never exhausted. Calling the denial
  // unenforced would send an administrator hunting a defect instead of reading the
  // caller's declared intent. A compiler rejection is also not the reason here, even
  // though one was supplied.
  assert.equal(decision.exhausted.unenforcedPolicy, null);
});

test('every decision carries the intent it was made under, including an unavailable one', () => {
  const unavailable = decide({
    effectivePolicy: effectivePolicy({ modelSelectionIntent: 'pinned' }),
    requestedModel: 'not-in-catalogue',
  });

  assert.equal(unavailable.decision, 'unavailable');
  assert.equal(unavailable.modelSelectionIntent, 'pinned');
  assert.equal(decide().modelSelectionIntent, 'preferred');
});

test('serving the requested model under pressure still records why no downgrade happened', () => {
  const decision = decide({
    effectivePolicy: effectivePolicy({ chain: [], enabled: false }),
    remainingTokensByScope: { organization: 0 },
    fallbackRejections: [
      { from: 'coding-primary', to: 'coding-fast', blockedBy: 'fallback-not-cheaper' },
    ],
  });

  assert.equal(decision.decision, 'selected');
  assert.equal(decision.hops, 0);
  assert.equal(decision.trigger.kind, 'threshold-breach');
  assert.equal(decision.exhausted.blockedBy, 'fallback-not-cheaper');
  assert.equal(decision.exhausted.unenforcedPolicy, null);
});

test('an exhausted downgrade with no recorded rejection still states that it was exhausted', () => {
  const decision = decide({
    requestedModel: 'coding-fast',
    remainingTokensByScope: { organization: 0 },
  });

  assert.equal(decision.hops, 0);
  assert.equal(decision.exhausted.blockedBy, 'fallback-no-configured-target');
  assert.equal(decision.exhausted.unenforcedPolicy, null);
});

test('a degraded catalogue reports the record as unavailable rather than as a complete decision', () => {
  // The request may well have been served. What is unavailable is the governed
  // record: without the catalogue there is no provider identity to state, and a
  // decision missing provider identity is not a decision this product will emit.
  const decision = decide({ registry: registry({ status: 'stale' }) });

  assert.equal(decision.decision, 'unavailable');
  assert.equal(decision.reasonCode, 'model-registry-unavailable');
  assert.equal(decision.requested.providerKey, null);
  assert.equal(decision.effective, null);
  assert.equal(decision.applicationAttribution.quality, null);
});

test('an unregistered requested model is unavailable rather than assumed', () => {
  const decision = decide({ requestedModel: 'never-published' });

  assert.equal(decision.decision, 'unavailable');
  assert.equal(decision.reasonCode, 'requested-model-unregistered');
  assert.equal(decision.requested.providerKey, null);
});

test('the decision carries its policy and catalogue provenance', () => {
  const decision = decide();

  assert.equal(decision.configVersion, 7);
  assert.equal(decision.registrySnapshotId, 'model-registry-001');
  assert.equal(decision.registrySnapshotVersion, 3);
  assert.equal(decision.evaluationTime, evaluationTime);
});

test('the decision is body-free and carries no raw identifier', () => {
  const serialized = JSON.stringify(decide({ applicationId: 'codex-adapter' })).toLowerCase();

  assert.ok(!serialized.includes('codex-adapter'), 'the raw application identifier must not appear.');
  assert.ok(!serialized.includes(tenantId));
  for (const term of ['prompt', 'completion', 'messages', 'authorization']) {
    assert.ok(!serialized.includes(term), `${term} must not appear.`);
  }
});

test('the decision document is frozen through its nested records', () => {
  const decision = decide();

  assert.ok(Object.isFrozen(decision));
  assert.ok(Object.isFrozen(decision.requested));
  assert.ok(Object.isFrozen(decision.trigger));
  assert.ok(Object.isFrozen(decision.trigger.breachedScopes));
  assert.ok(Object.isFrozen(decision.applicationAttribution));
});
