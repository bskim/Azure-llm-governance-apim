import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertRouteServesClient,
  clientApplicationDescriptors,
  clientsNeedingExternalRefresh,
  listClientProfiles,
  resolveClientProfile,
} from '../../app/governance-domain/identity/client-integration-profiles.mjs';
import { assertModelRegistrySnapshotV1, resolveApplicationAttribution } from '../../app/governance-domain/registry/model-registry-validator.mjs';

const REQUIRED_CLIENTS = ['codex-cli', 'copilot-cli', 'copilot-vscode-byok', 'claude-code', 'opencode'];

test('every publication-blocking client has a profile', () => {
  const profiles = listClientProfiles();
  assert.deepEqual(profiles.map((profile) => profile.clientId).sort(), [...REQUIRED_CLIENTS].sort());
  // A client is never closed as unsupported, so an absent profile is a gap rather
  // than a decision.
  for (const clientId of REQUIRED_CLIENTS) assert.notEqual(resolveClientProfile(clientId), null);
});

test('every profile reaches the gateway with the gateway scope', () => {
  for (const profile of listClientProfiles()) {
    assert.equal(profile.requiresGatewayScope, true, profile.clientId);
  }
});

test('no profile depends on a shared gateway secret standing in for a caller', () => {
  const serialized = JSON.stringify(listClientProfiles()).toLowerCase();

  // A subscription key authenticates the deployment, not the person, so a profile
  // built on one makes per-caller entitlement, quota, and revocation unenforceable
  // while still appearing to work.
  for (const forbidden of ['subscription-key', 'subscription key', 'ocp-apim', 'api_key', 'apikey']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test('a client whose protocol is fixed cannot be served by another protocol', () => {
  const codex = assertRouteServesClient({
    clientId: 'codex-cli',
    routeWireFormat: 'openai-chat-completions',
    routeProviderKey: 'azure-openai',
  });
  assert.deepEqual(codex, { serves: false, reasonCode: 'wire-format-fixed' });

  assert.equal(
    assertRouteServesClient({
      clientId: 'codex-cli',
      routeWireFormat: 'openai-responses',
      routeProviderKey: 'azure-openai',
    }).serves,
    true,
  );
});

test('Claude Code is not served by a non-Claude model however capable it is', () => {
  const substituted = assertRouteServesClient({
    clientId: 'claude-code',
    routeWireFormat: 'anthropic-messages',
    routeProviderKey: 'azure-openai',
  });

  // Translation makes this run. It also makes every attribution and compatibility
  // claim about the client false, which is why the route is refused rather than
  // accepted with a caveat.
  assert.deepEqual(substituted, { serves: false, reasonCode: 'provider-substitution-refused' });

  assert.equal(
    assertRouteServesClient({
      clientId: 'claude-code',
      routeWireFormat: 'anthropic-messages',
      routeProviderKey: 'anthropic',
    }).serves,
    true,
  );
});

test('an OpenAI-shaped route cannot quietly serve the Anthropic client', () => {
  const result = assertRouteServesClient({
    clientId: 'claude-code',
    routeWireFormat: 'openai-chat-completions',
    routeProviderKey: 'anthropic',
  });

  assert.deepEqual(result, { serves: false, reasonCode: 'wire-format-fixed' });
});

test('an unregistered client is refused rather than served by default', () => {
  const result = assertRouteServesClient({
    clientId: 'some-other-agent',
    routeWireFormat: 'openai-chat-completions',
    routeProviderKey: 'azure-openai',
  });

  assert.deepEqual(result, { serves: false, reasonCode: 'client-unregistered' });
});

test('a client authenticating through a shared tool is attributed generically', () => {
  const shared = listClientProfiles().filter((profile) => profile.attributionQuality === 'generic');

  assert.ok(shared.length > 0);
  for (const profile of shared) {
    // Presenting a shared developer tool as a specific coding agent would make the
    // per-application view describe callers it cannot actually distinguish.
    assert.equal(profile.attributionReason, 'token-helper-is-a-shared-tool');
  }
});

test('the catalogue entries are derived from the profiles rather than maintained beside them', () => {
  const descriptors = clientApplicationDescriptors();
  const registry = assertModelRegistrySnapshotV1(
    {
      contractVersion: 'v1',
      snapshotId: 'model-registry-clients',
      tenantId: 'tenant-local-demo',
      version: 1,
      status: 'complete',
      capturedAt: '2026-08-06T23:55:00.000Z',
      expiresAt: '2026-08-07T00:30:00.000Z',
      sourceRevision: 'client-profiles-001',
      models: [],
      applications: [...descriptors],
    },
    { evaluationTime: '2026-08-07T00:00:00.000Z', principalTenantId: 'tenant-local-demo' },
  );

  for (const profile of listClientProfiles()) {
    const resolved = resolveApplicationAttribution(registry, profile.clientId);
    assert.equal(resolved.quality, profile.attributionQuality, profile.clientId);
    assert.equal(resolved.displayCode, profile.displayCode, profile.clientId);
  }
});

test('every profile records what the client requires, not only that it is supported', () => {
  for (const profile of listClientProfiles()) {
    assert.ok(profile.notes.length > 0, profile.clientId);
    assert.ok(Object.isFrozen(profile));
    assert.ok(Object.isFrozen(profile.notes));
  }
});

test('refresh behaviour is only claimed for a client that was actually exercised', () => {
  for (const profile of listClientProfiles()) {
    if (profile.evidence === 'planned') {
      assert.equal(profile.refreshBehaviour, 'unknown', profile.clientId);
    }
  }
});

test('the clients that cannot re-acquire are named, because they need the token from outside', () => {
  // A session that outlives its token has no way back on its own: the request is
  // retried, the same expired value goes out again, and the caller sees a failure it
  // cannot act on. Naming them is what makes the helper's job explicit.
  assert.deepEqual([...clientsNeedingExternalRefresh()].sort(), ['claude-code', 'copilot-cli']);

  const opencode = resolveClientProfile('opencode');
  assert.equal(opencode.refreshBehaviour, 'client-reacquires');
  assert.equal(opencode.tokenInjection, 'fetch-wrapper');
});
