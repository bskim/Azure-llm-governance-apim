import assert from 'node:assert/strict';
import test from 'node:test';

import { createModelChangeHandler } from '../../app/functions/handlers/admin-model-edit.mjs';
import { createGovernancePublisher } from '../../app/control-api/governance-publisher.mjs';
import { createPublishedPolicySource } from '../../app/control-api/published-policy-source.mjs';
import { createPublishGovernanceHandler } from '../../app/functions/handlers/publish-governance.mjs';
import { createInMemoryGovernanceStore } from '../../app/persistence/in-memory-governance-store.mjs';
import { getDeterministicGovernanceSnapshots } from '../../app/local-adapters/deterministic-governance-snapshots.mjs';
import { createPrincipalKeyDeriver } from '../../app/governance-domain/identity/principal-key-derivation.mjs';

const NOW = '2026-07-24T10:00:00.000Z';
const SCOPE_GROUP_ID = 'platform-engineering';
const AUDIENCE = 'api://control-plane';
const DERIVER = createPrincipalKeyDeriver({ secret: 'a'.repeat(32) + '-administrator-actor-test-secret' });
const clock = { nowIso: () => NOW };
const invocation = { invocationId: 'invocation-1', error: () => {}, warn: () => {} };

// Shaped as the provider quota reading projects a deployment, because that reading is
// what the deployed handler is given.
const NEW_DEPLOYMENT = Object.freeze({
  deploymentName: 'deploy-coding-swift',
  modelName: 'coding-swift',
  modelVersion: '2026-05-01',
  modelFormat: 'OpenAI',
  skuName: 'GlobalStandard',
  capabilities: Object.freeze({ chatCompletion: true, responses: true }),
  residencyArea: 'US',
  raiPolicyName: 'local-default-policy',
  capacity: 100,
  requestsPerMinute: 100,
  tokensPerMinute: 100_000,
  provisioningState: 'Succeeded',
  pool: null,
  poolReasonCode: 'pool-not-matched',
});

function principalHeader(roles, { tenantId = 'tenant-admin-0001', objectId = 'object-admin-0001' } = {}) {
  const principal = {
    auth_typ: 'aad',
    role_typ: 'roles',
    claims: [
      { typ: 'aud', val: AUDIENCE },
      ...(tenantId === null ? [] : [{ typ: 'tid', val: tenantId }]),
      ...(objectId === null ? [] : [{ typ: 'oid', val: objectId }]),
      ...roles.map((role) => ({ typ: 'roles', val: role })),
    ],
  };
  return Buffer.from(JSON.stringify(principal), 'utf8').toString('base64');
}

function requestWith({ roles = ['Governance.Administer'], body = {}, tenantId, objectId } = {}) {
  const headers = new Map([['x-ms-client-principal', principalHeader(roles, { tenantId, objectId })]]);
  return {
    headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

async function publishedStore() {
  const store = createInMemoryGovernanceStore();
  const response = await createPublishGovernanceHandler({
    store,
    publisher: createGovernancePublisher({ store, scopeGroupId: SCOPE_GROUP_ID, clock }),
    clock,
    scopeGroupId: SCOPE_GROUP_ID,
    expectedAudience: AUDIENCE,
    deriver: DERIVER,
  })(
    requestWith({
      body: {
        initialOnly: true,
        content: {
          snapshots: getDeterministicGovernanceSnapshots(),
          // Without a membership target the seed revision stays mid-publish, and every
          // later change is refused as publish-in-progress rather than judged.
          memberships: [
            {
              snapshotId: 'membership-0001',
              status: 'complete',
              source: 'control-plane',
              tenantId: 'tenant-local-demo',
              subjectId: 'user-local-admin',
              resolvedAt: '2026-07-24T09:58:00.000Z',
              expiresAt: '2026-07-24T10:03:00.000Z',
              maxAgeSeconds: 300,
              sourceRevision: 'directory-0001',
              groups: [{ groupId: 'group-governance-admin', membership: 'direct', authorizationRelevant: true }],
            },
          ],
        },
      },
    }),
    invocation,
  );
  assert.equal(response.status, 200, 'the fixture must start from a genuinely published set');
  return store;
}

function handlerFor(store, overrides = {}) {
  return createModelChangeHandler({
    readPublishedSnapshots: createPublishedPolicySource({ store, scopeGroupId: SCOPE_GROUP_ID, clock }),
    clock,
    expectedAudience: AUDIENCE,
    store,
    publisher: createGovernancePublisher({ store, scopeGroupId: SCOPE_GROUP_ID, clock }),
    scopeGroupId: SCOPE_GROUP_ID,
    deriver: DERIVER,
    readProviderDeployments: async () => ({ deployments: [NEW_DEPLOYMENT] }),
    ...overrides,
  });
}

async function readPublished(store) {
  return createPublishedPolicySource({ store, scopeGroupId: SCOPE_GROUP_ID, clock })();
}

async function createHeldDraft(store) {
  const snapshots = await readPublished(store);
  const response = await createPublishGovernanceHandler({
    store,
    publisher: createGovernancePublisher({ store, scopeGroupId: SCOPE_GROUP_ID, clock }),
    clock,
    scopeGroupId: SCOPE_GROUP_ID,
    expectedAudience: AUDIENCE,
    deriver: DERIVER,
  })(
    requestWith({ body: { content: { snapshots } }, objectId: 'object-admin-0002' }),
    invocation,
  );
  assert.equal(response.status, 409);
  assert.equal(response.jsonBody.reasonCode, 'separation-of-duties');
}

test('adding a model captures it from the provider reading, with nothing supplied by hand', async () => {
  const store = await publishedStore();
  const before = await readPublished(store);

  const response = await handlerFor(store)(
    requestWith({ roles: ['Governance.Own'], body: { command: 'add', deploymentName: 'deploy-coding-swift' } }),
    invocation,
  );

  assert.equal(response.status, 200);
  const after = await readPublished(store);
  assert.equal(after.modelRegistrySnapshot.models.length, before.modelRegistrySnapshot.models.length + 1);

  const captured = after.modelRegistrySnapshot.models.find((entry) => entry.modelKey === 'deploy-coding-swift');
  assert.ok(captured, 'the deployment must be in the published registry');
  assert.deepEqual(captured.apiFamilies, ['openai-chat-completions', 'openai-responses']);
  assert.equal(captured.providerDeploymentName, 'deploy-coding-swift');
  assert.equal(captured.safetyPolicy, 'local-default-policy');
  assert.equal(captured.lifecycle, 'generally-available');
});

test('a deployment the provider does not serve is refused rather than invented', async () => {
  const store = await publishedStore();

  const response = await handlerFor(store)(
    requestWith({ body: { command: 'add', deploymentName: 'deploy-not-there' } }),
    invocation,
  );

  assert.equal(response.status, 409);
  assert.equal(response.jsonBody.reasonCode, 'model-capture-deployment-unknown');
});

test('a provider reading that fails refuses the add rather than publishing a guess', async () => {
  const store = await publishedStore();

  const response = await handlerFor(store, {
    readProviderDeployments: async () => {
      throw new Error('arm-read-failed');
    },
  })(requestWith({ body: { command: 'add', deploymentName: 'deploy-coding-swift' } }), invocation);

  assert.equal(response.status, 503);
  const after = await readPublished(store);
  assert.equal(after.modelRegistrySnapshot.models.some((entry) => entry.modelKey === 'deploy-coding-swift'), false);
});

test('recapture refreshes the whole published registry from provider deployments', async () => {
  const store = await publishedStore();
  const before = await readPublished(store);
  const deployments = before.modelRegistrySnapshot.models.map((entry) => ({
    deploymentName: entry.providerDeploymentName,
    modelName: `${entry.modelKey}-preview`,
    modelVersion: 'preview',
    modelFormat: 'OpenAI',
    capabilities: { chatCompletion: true, responses: false },
    raiPolicyName: 'recaptured-policy',
  }));

  const response = await handlerFor(store, {
    readProviderDeployments: async () => ({ deployments }),
  })(requestWith({ roles: ['Governance.Own'], body: { command: 'recapture' } }), invocation);

  assert.equal(response.status, 200);
  const after = await readPublished(store);
  assert.equal(after.modelRegistrySnapshot.version, before.modelRegistrySnapshot.version + 1);
  assert.ok(after.modelRegistrySnapshot.models.every((entry) => entry.lifecycle === 'preview'));
  assert.ok(after.modelRegistrySnapshot.models.every((entry) => entry.safetyPolicy === 'recaptured-policy'));
});

test('recapture refuses when any registered provider deployment is absent', async () => {
  const store = await publishedStore();
  const response = await handlerFor(store, {
    readProviderDeployments: async () => ({ deployments: [] }),
  })(requestWith({ body: { command: 'recapture' } }), invocation);

  assert.equal(response.status, 409);
  assert.equal(response.jsonBody.reasonCode, 'model-capture-recapture-deployment-absent');
});

test('removing a model an entitlement still allows is refused by name', async () => {
  const store = await publishedStore();
  const before = await readPublished(store);
  const entitled = before.entitlementSnapshot.bindings
    .flatMap((binding) => binding.modelAllowlist ?? [])
    .find((modelKey) => typeof modelKey === 'string');
  assert.ok(entitled, 'the fixture must entitle at least one model');

  const response = await handlerFor(store)(
    requestWith({
      body: { command: 'remove', modelKey: entitled, reasonCode: 'model-retired-by-operator' },
    }),
    invocation,
  );

  assert.equal(response.status, 409);
  assert.equal(response.jsonBody.reasonCode, 'model-capture-model-entitled');
});

test('a caller without the authoring capability cannot change the registry', async () => {
  const store = await publishedStore();

  const response = await handlerFor(store)(
    requestWith({
      roles: ['Governance.Read'],
      body: { command: 'add', deploymentName: 'deploy-coding-swift' },
    }),
    invocation,
  );

  assert.equal(response.status, 403);
  const after = await readPublished(store);
  assert.equal(after.modelRegistrySnapshot.models.some((entry) => entry.modelKey === 'deploy-coding-swift'), false);
});

test('a model write without a validated actor identity is refused before it reads or publishes', async () => {
  const store = await publishedStore();
  let read = 0;
  const handler = handlerFor(store, {
    readPublishedSnapshots: async () => {
      read += 1;
      return createPublishedPolicySource({ store, scopeGroupId: SCOPE_GROUP_ID, clock })();
    },
  });

  const response = await handler(
    requestWith({ objectId: null, body: { command: 'add', deploymentName: 'deploy-coding-swift' } }),
    invocation,
  );
  assert.equal(response.status, 403);
  assert.equal(response.jsonBody.error.code, 'caller_not_identifiable');
  assert.equal(read, 0);
});

test('a model resume uses the held proposal without reading the provider or published snapshots', async () => {
  const store = await publishedStore();
  await createHeldDraft(store);
  let snapshotsRead = 0;
  let providerReads = 0;
  const handler = handlerFor(store, {
    readPublishedSnapshots: async () => {
      snapshotsRead += 1;
      throw new Error('a resume must not create new snapshots');
    },
    readProviderDeployments: async () => {
      providerReads += 1;
      throw new Error('a resume must not read the provider');
    },
  });

  const response = await handler(
    requestWith({ body: { resume: true, revisionId: 'revision-0002' }, objectId: 'object-admin-0003' }),
    invocation,
  );
  assert.equal(response.status, 200);
  assert.equal(response.jsonBody.state, 'active');
  assert.equal(snapshotsRead, 0);
  assert.equal(providerReads, 0);
});

test('a model resume carrying an edit field is refused before source reads', async () => {
  const store = await publishedStore();
  let snapshotsRead = 0;
  let providerReads = 0;
  const handler = handlerFor(store, {
    readPublishedSnapshots: async () => { snapshotsRead += 1; throw new Error('unexpected'); },
    readProviderDeployments: async () => { providerReads += 1; throw new Error('unexpected'); },
  });

  const response = await handler(
    requestWith({ body: { resume: true, revisionId: 'revision-0002', deploymentName: 'deploy-coding-swift' } }),
    invocation,
  );
  assert.equal(response.status, 400);
  assert.equal(response.jsonBody.error.code, 'resume_mutation_not_allowed');
  assert.equal(snapshotsRead, 0);
  assert.equal(providerReads, 0);
});

test('the route refuses to be built without the provider reading it depends on', () => {
  assert.throws(
    () =>
      createModelChangeHandler({
        readPublishedSnapshots: async () => ({}),
        clock,
        expectedAudience: AUDIENCE,
        store: createInMemoryGovernanceStore(),
        publisher: () => {},
        scopeGroupId: SCOPE_GROUP_ID,
        deriver: DERIVER,
      }),
    TypeError,
  );
});
