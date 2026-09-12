import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAccessOptionsHandler,
  createEntitlementChangeHandler,
} from '../../app/functions/handlers/admin-access.mjs';
import {
  createAssignmentChangeHandler,
  createBudgetChangeHandler,
  createFallbackChangeHandler,
  createTeamChangeHandler,
} from '../../app/functions/handlers/admin-governance-edit.mjs';
import { createGovernancePublisher } from '../../app/control-api/governance-publisher.mjs';
import { createPolicyResolver } from '../../app/control-api/policy-resolution-endpoint.mjs';
import { createPublishedPolicySource } from '../../app/control-api/published-policy-source.mjs';
import { createPublishGovernanceHandler } from '../../app/functions/handlers/publish-governance.mjs';
import { createInMemoryGovernanceStore } from '../../app/persistence/in-memory-governance-store.mjs';
import { getDeterministicGovernanceSnapshots } from '../../app/local-adapters/deterministic-governance-snapshots.mjs';
import { createDeterministicMembershipResolver } from '../../app/local-adapters/deterministic-membership-resolver.mjs';
import { createFixedClock, createSequenceIdGenerator } from '../../app/local-adapters/deterministic-time.mjs';
import { createPrincipalKeyDeriver } from '../../app/governance-domain/identity/principal-key-derivation.mjs';
import { createPrincipalContextFactory } from '../../app/governance-domain/principal-context/principal-context-factory.mjs';

const NOW = '2026-07-24T10:00:00.000Z';
const SCOPE_GROUP_ID = 'platform-engineering';
const AUDIENCE = 'api://control-plane';
const DERIVER = createPrincipalKeyDeriver({ secret: 'a'.repeat(32) + '-administrator-actor-test-secret' });
const clock = { nowIso: () => NOW };
const invocation = { invocationId: 'invocation-1', error: () => {} };

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

/** A store with a governance set already published, through the product's own route. */
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

function handlersFor(store, overrides = {}) {
  const shared = {
    readPublishedSnapshots: createPublishedPolicySource({ store, scopeGroupId: SCOPE_GROUP_ID, clock }),
    clock,
    expectedAudience: AUDIENCE,
    store,
    publisher: createGovernancePublisher({ store, scopeGroupId: SCOPE_GROUP_ID, clock }),
    scopeGroupId: SCOPE_GROUP_ID,
    deriver: DERIVER,
    ...overrides,
  };
  return {
    options: createAccessOptionsHandler(shared),
    change: createEntitlementChangeHandler(shared),
    changeBudget: createBudgetChangeHandler(shared),
    changeFallbackPlan: createFallbackChangeHandler(shared),
    changeAssignment: createAssignmentChangeHandler(shared),
    changeTeam: createTeamChangeHandler(shared),
  };
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
    requestWith({
      body: { content: { snapshots } },
      objectId: 'object-admin-0002',
    }),
    invocation,
  );
  assert.equal(response.status, 201);
  assert.equal(response.jsonBody.state, 'draft');
}

async function approveSaved(store, saved) {
  assert.equal(saved.status, 201);
  assert.equal(saved.jsonBody.outcome, 'proposed');
  assert.equal(saved.jsonBody.state, 'draft');
  assert.ok(saved.jsonBody.targets.every((target) => target.outcome === 'pending'));
  return handlersFor(store).change(requestWith({
    body: { resume: true, revisionId: saved.jsonBody.revisionId },
  }), invocation);
}

async function readPublished(store) {
  return createPublishedPolicySource({ store, scopeGroupId: SCOPE_GROUP_ID, clock })();
}

test('the options name the bindings, assignments and models an edit may choose from', async () => {
  const store = await publishedStore();
  const response = await handlersFor(store).options(requestWith(), invocation);

  assert.equal(response.status, 200);
  assert.equal(response.jsonBody.readModelVersion, 'access-options.v1');
  assert.ok(response.jsonBody.models.length > 0);
  assert.deepEqual(response.jsonBody.budgetOptions, {
    throttleTierCodes: ['tier-reduced', 'tier-minimal'],
  });
  assert.ok(response.jsonBody.bindings.length > 0);
  assert.deepEqual(response.jsonBody.models, ['coding-fast', 'coding-primary']);
  assert.deepEqual(
    response.jsonBody.bindings.find((binding) => binding.targetKind === 'global').modelCodes,
    ['coding-primary'],
  );
  for (const binding of response.jsonBody.bindings) {
    assert.ok(typeof binding.bindingCode === 'string' && binding.bindingCode.length > 0);
    assert.equal(binding.state, 'active');
    assert.equal(binding.canRestore, false);
    assert.ok(Array.isArray(binding.modelCodes));
    assert.equal(typeof binding.limits, 'object');
  }
  assert.deepEqual(
    response.jsonBody.bindings.find((binding) => binding.bindingCode === 'binding-global-local-001').limits,
    {
      requestsPerMinute: 80,
      tokensPerMinute: 80_000,
      tokenQuota: 40_000_000,
      quotaPeriod: 'Monthly',
    },
  );
  assert.ok(response.jsonBody.assignments.length > 0);
  for (const assignment of response.jsonBody.assignments) {
    assert.ok(typeof assignment.assignmentCode === 'string' && assignment.assignmentCode.length > 0);
    assert.ok(typeof assignment.roleCode === 'string');
    assert.ok(typeof assignment.assigneeKind === 'string');
    assert.ok(typeof assignment.assigneeCode === 'string');
    assert.ok(typeof assignment.scopeKind === 'string');
  }
  assert.ok(response.jsonBody.assignmentGrantRules.some(
    (rule) => rule.roleCode === 'team-admin'
      && rule.assigneeKinds.includes('group')
      && rule.scopeKinds.includes('team'),
  ));
  assert.ok(response.jsonBody.revocationReasonCodes.length > 0);
});

test('reading the options is an authoring act, so a reader is refused', async () => {
  const store = await publishedStore();
  const response = await handlersFor(store).options(requestWith({ roles: ['Governance.Read'] }), invocation);

  assert.equal(response.status, 403);
  assert.equal(response.jsonBody.error.code, 'governance_access_denied');
  assert.equal(response.jsonBody.error.reasonCode, 'write-entitlements');
});

test('an unauthenticated caller never reaches the published set', async () => {
  const store = await publishedStore();
  let read = 0;
  const handler = createAccessOptionsHandler({
    readPublishedSnapshots: async () => {
      read += 1;
      return readPublished(store);
    },
    clock,
    expectedAudience: AUDIENCE,
  });

  const response = await handler({ headers: { get: () => null } }, invocation);
  assert.equal(response.status, 401);
  assert.equal(read, 0);
});

test('every governance authoring write refuses an administrator without a validated actor identity', async () => {
  const store = await publishedStore();
  const handlers = handlersFor(store);
  const attempts = [
    [handlers.change, { bindingId: 'binding-global', changes: { modelAllowlist: ['model-coding-primary'] } }],
    [handlers.changeBudget, { command: 'edit', budgetId: 'budget-organization-monthly', changes: { amount: 1 } }],
    [handlers.changeFallbackPlan, { planId: 'plan-global-cheaper-alternative-001', changes: { enabled: false } }],
    [handlers.changeAssignment, { command: 'revoke', assignmentId: 'assignment-auditor-local-001', reasonCode: 'access-review-removed' }],
    [handlers.changeTeam, { command: 'remove', teamKey: 'developer-experience', reasonCode: 'access-review-removed' }],
  ];

  for (const [handler, body] of attempts) {
    const response = await handler(requestWith({ body, objectId: null }), invocation);
    assert.equal(response.status, 403);
    assert.equal(response.jsonBody.error.code, 'caller_not_identifiable');
  }
  assert.equal((await store.queryConfigurationRevisions({ scopeGroupId: SCOPE_GROUP_ID })).length, 1);
});

test('every edit route resumes the held proposal before reading or applying a new edit', async () => {
  for (const handlerName of [
    'change',
    'changeBudget',
    'changeFallbackPlan',
    'changeAssignment',
    'changeTeam',
  ]) {
    const store = await publishedStore();
    await createHeldDraft(store);
    let reads = 0;
    const handlers = handlersFor(store, {
      readPublishedSnapshots: async () => {
        reads += 1;
        throw new Error('a resume must not derive a new proposal');
      },
    });
    const response = await handlers[handlerName](
      requestWith({ body: { resume: true, revisionId: 'revision-0002' }, objectId: 'object-admin-0003' }),
      invocation,
    );
    assert.equal(response.status, 200, handlerName);
    assert.equal(response.jsonBody.state, 'active', handlerName);
    assert.equal(reads, 0, handlerName);
  }
});

test('an edit-shaped resume is refused before the edit route reads or writes', async () => {
  for (const handlerName of [
    'change',
    'changeBudget',
    'changeFallbackPlan',
    'changeAssignment',
    'changeTeam',
  ]) {
    const store = await publishedStore();
    let reads = 0;
    const handler = handlersFor(store, {
      readPublishedSnapshots: async () => {
        reads += 1;
        throw new Error('mutation fields must be rejected before a source read');
      },
    })[handlerName];
    const response = await handler(
      requestWith({ body: { resume: true, revisionId: 'revision-0002', changes: { amount: 999_999 } } }),
      invocation,
    );
    assert.equal(response.status, 400, handlerName);
    assert.equal(response.jsonBody.error.code, 'resume_mutation_not_allowed', handlerName);
    assert.equal(reads, 0, handlerName);
    assert.equal((await store.queryConfigurationRevisions({ scopeGroupId: SCOPE_GROUP_ID })).length, 1, handlerName);
  }
});

test('a change to an allowlist is published and is what the next reader resolves', async () => {
  const store = await publishedStore();
  const { change } = handlersFor(store);
  const before = await readPublished(store);
  const binding = before.entitlementSnapshot.bindings.find((entry) => entry.state === 'active');
  const narrowed = [binding.modelAllowlist[0]];

  let response = await change(
    requestWith({ roles: ['Governance.Own'], body: { bindingId: binding.bindingId, changes: { modelAllowlist: narrowed } } }),
    invocation,
  );

  assert.deepEqual(await readPublished(store), before, 'saving must leave active access unchanged');
  response = await approveSaved(store, response);
  assert.equal(response.status, 200);
  assert.equal(response.jsonBody.state, 'active');
  assert.ok(response.jsonBody.targets.every((target) => target.outcome === 'verified'));

  const after = await readPublished(store);
  const changed = after.entitlementSnapshot.bindings.find((entry) => entry.bindingId === binding.bindingId);
  assert.deepEqual([...changed.modelAllowlist], narrowed);
  assert.ok(after.entitlementSnapshot.version > before.entitlementSnapshot.version);
});

test('retiring a non-global entitlement follows the existing draft lifecycle', async () => {
  const store = await publishedStore();
  const { change } = handlersFor(store);
  const before = await readPublished(store);
  const binding = before.entitlementSnapshot.bindings.find(
    (entry) => entry.state === 'active' && entry.target.kind === 'application',
  );

  const response = await change(requestWith({
    body: { bindingId: binding.bindingId, changes: { state: 'revoked' } },
  }), invocation);

  assert.equal(response.status, 201);
  assert.equal(response.jsonBody.state, 'draft');
  assert.equal(
    (await readPublished(store)).entitlementSnapshot.bindings
      .find((entry) => entry.bindingId === binding.bindingId).state,
    'active',
  );

  const draft = (await store.queryConfigurationRevisions({ scopeGroupId: SCOPE_GROUP_ID }))
    .find((revision) => revision.state === 'draft');
  const published = await change(requestWith({
    body: { resume: true, revisionId: draft.revisionId },
    objectId: 'object-admin-0002',
  }), invocation);
  assert.equal(published.status, 200, JSON.stringify(published.jsonBody));

  const options = await handlersFor(store).options(requestWith(), invocation);
  const retired = options.jsonBody.bindings.find(
    (entry) => entry.bindingCode === binding.bindingId,
  );
  assert.equal(retired.state, 'revoked');
  assert.equal(retired.canRestore, true);
});

test('the publication declares no membership target, because a change carries none', async () => {
  // Membership comes from the token's claim. Declaring a target the content cannot
  // satisfy would fail the publication and leave the revision unfinished.
  const store = await publishedStore();
  const { change } = handlersFor(store);
  const binding = (await readPublished(store)).entitlementSnapshot.bindings.find((entry) => entry.state === 'active');

  let response = await change(
    requestWith({ roles: ['Governance.Own'], body: { bindingId: binding.bindingId, changes: { modelAllowlist: [binding.modelAllowlist[0]] } } }),
    invocation,
  );

  assert.ok(response.jsonBody.targets.every((target) => target.targetCode !== 'principal-membership'));
  response = await approveSaved(store, response);
  assert.ok(response.jsonBody.targets.every((target) => target.outcome === 'verified'));
});

test('a refused edit is the administrator answer, not a fault, and publishes nothing', async () => {
  const store = await publishedStore();
  const { change } = handlersFor(store);
  const before = await readPublished(store);

  for (const [body, reasonCode] of [
    [{ bindingId: 'binding-that-does-not-exist', changes: { state: 'retired' } }, 'entitlement-edit-target-unknown'],
    [{ bindingId: before.entitlementSnapshot.bindings[0].bindingId, changes: { modelAllowlist: [] } }, 'entitlement-edit-allowlist-empty'],
    [{ bindingId: before.entitlementSnapshot.bindings[0].bindingId, changes: { modelAllowlist: ['model-nothing-serves'] } }, 'entitlement-edit-model-unregistered'],
    [{ bindingId: before.entitlementSnapshot.bindings[0].bindingId, changes: { deploymentName: 'x' } }, 'entitlement-edit-field-unknown'],
    [{ bindingId: before.entitlementSnapshot.bindings[0].bindingId, changes: {} }, 'entitlement-edit-no-change'],
  ]) {
    const response = await change(requestWith({ body }), invocation);
    assert.equal(response.status, 409, JSON.stringify(body));
    assert.equal(response.jsonBody.outcome, 'refused');
    assert.equal(response.jsonBody.reasonCode, reasonCode);
  }

  const after = await readPublished(store);
  assert.equal(after.entitlementSnapshot.version, before.entitlementSnapshot.version);
});

test('a change names a binding, and a body that does not is refused before anything is read', async () => {
  const store = await publishedStore();
  let read = 0;
  const handler = createEntitlementChangeHandler({
    readPublishedSnapshots: async () => {
      read += 1;
      return readPublished(store);
    },
    clock,
    expectedAudience: AUDIENCE,
    store,
    publisher: createGovernancePublisher({ store, scopeGroupId: SCOPE_GROUP_ID, clock }),
    scopeGroupId: SCOPE_GROUP_ID,
    deriver: DERIVER,
  });

  const response = await handler(requestWith({ body: { changes: { state: 'retired' } } }), invocation);
  assert.equal(response.status, 400);
  assert.equal(response.jsonBody.error.code, 'binding_required');
  assert.equal(read, 0);
});

test('nothing published is reported as unavailable rather than as an empty set', async () => {
  const store = createInMemoryGovernanceStore();
  const { options, change, changeBudget, changeFallbackPlan, changeAssignment } = handlersFor(store);

  for (const response of [
    await options(requestWith(), invocation),
    await change(requestWith({ body: { bindingId: 'binding-global', changes: { state: 'retired' } } }), invocation),
    await changeBudget(requestWith({ body: { command: 'edit', budgetId: 'budget-organization-monthly', changes: {} } }), invocation),
    await changeFallbackPlan(requestWith({ body: { planId: 'plan-global-cheaper-alternative-001', changes: {} } }), invocation),
    await changeAssignment(requestWith({ body: { command: 'revoke', assignmentId: 'assignment-auditor-local-001' } }), invocation),
  ]) {
    assert.equal(response.status, 503);
    assert.equal(response.jsonBody.error.code, 'governance_unavailable');
    assert.equal(response.jsonBody.error.reasonCode, 'published-policy-source-incomplete');
  }
});

test('the handlers refuse to be built without what they need', () => {
  const store = createInMemoryGovernanceStore();
  const publisher = createGovernancePublisher({ store, scopeGroupId: SCOPE_GROUP_ID, clock });
  const readPublishedSnapshots = createPublishedPolicySource({ store, scopeGroupId: SCOPE_GROUP_ID, clock });

  assert.throws(() => createAccessOptionsHandler({ clock, expectedAudience: AUDIENCE }), TypeError);
  assert.throws(() => createAccessOptionsHandler({ readPublishedSnapshots, clock }), TypeError);
  // A write needs a server-owned actor deriver; it may not accept a caller-selected code.
  assert.throws(
    () => createEntitlementChangeHandler({
      readPublishedSnapshots,
      clock,
      expectedAudience: AUDIENCE,
      store,
      publisher,
      scopeGroupId: SCOPE_GROUP_ID,
    }),
    TypeError,
  );
  assert.throws(
    () => createEntitlementChangeHandler({
      readPublishedSnapshots,
      clock,
      expectedAudience: AUDIENCE,
      store,
      publisher,
      scopeGroupId: SCOPE_GROUP_ID,
      deriver: { deriveActorCode: null },
    }),
    TypeError,
  );
  // The other three routes share the exact same dependency contract.
  for (const create of [createBudgetChangeHandler, createFallbackChangeHandler, createAssignmentChangeHandler]) {
    assert.throws(
      () => create({ readPublishedSnapshots, clock, expectedAudience: AUDIENCE, store, publisher, scopeGroupId: SCOPE_GROUP_ID }),
      TypeError,
    );
  }
});

test('a budget change is published and is what the next reader resolves', async () => {
  const store = await publishedStore();
  const { changeBudget } = handlersFor(store);
  const before = await readPublished(store);

  let response = await changeBudget(
    requestWith({
      roles: ['Governance.Own'],
      body: { command: 'edit', budgetId: 'budget-organization-monthly', changes: { amount: 30_000_000 } },
    }),
    invocation,
  );

  assert.deepEqual(await readPublished(store), before, 'saving must leave active budgets unchanged');
  response = await approveSaved(store, response);
  assert.equal(response.status, 200);
  assert.equal(response.jsonBody.state, 'active');
  assert.ok(response.jsonBody.targets.every((target) => target.outcome === 'verified'));
  assert.ok(response.jsonBody.targets.every((target) => target.targetCode !== 'principal-membership'));

  const after = await readPublished(store);
  const changed = after.budgetSnapshot.budgets.find((entry) => entry.budgetId === 'budget-organization-monthly');
  assert.equal(changed.limit.amount, 30_000_000);
  assert.ok(after.budgetSnapshot.version > before.budgetSnapshot.version);
});

test('a budget change is refused as the administrator answer, not a fault, and publishes nothing', async () => {
  const store = await publishedStore();
  const { changeBudget } = handlersFor(store);
  const before = await readPublished(store);

  for (const [body, reasonCode] of [
    [{ command: 'edit', budgetId: 'budget-that-does-not-exist', changes: { amount: 1 } }, 'budget-edit-target-unknown'],
    [{ command: 'edit', budgetId: 'budget-organization-monthly', changes: {} }, 'budget-edit-no-change'],
    [
      { command: 'add', budget: { budgetId: 'budget-organization-monthly', scope: 'organization', action: 'SOFT_WARNING', modelScope: 'all-models', accountingBasis: 'apim-estimated-total-tokens', limit: { unit: 'tokens', currency: null, amount: 1 }, period: 'Monthly', thresholds: { graceBasisPoints: 100 } } },
      'budget-edit-duplicate-budget',
    ],
    [
      {
        command: 'edit',
        budgetId: 'budget-organization-monthly',
        changes: {
          action: 'THROTTLE',
          thresholds: { tiers: [{ atBasisPoints: 8000, tierCode: 'tier-not-deployed' }] },
        },
      },
      'budget-edit-result-invalid',
    ],
  ]) {
    const response = await changeBudget(requestWith({ body }), invocation);
    assert.equal(response.status, 409, JSON.stringify(body));
    assert.equal(response.jsonBody.outcome, 'refused');
    assert.equal(response.jsonBody.reasonCode, reasonCode);
  }

  const after = await readPublished(store);
  assert.equal(after.budgetSnapshot.version, before.budgetSnapshot.version);
});

test('a budget change names a command and, for remove or edit, a budget, before anything is read', async () => {
  const store = await publishedStore();
  let read = 0;
  const handler = createBudgetChangeHandler({
    readPublishedSnapshots: async () => {
      read += 1;
      return readPublished(store);
    },
    clock,
    expectedAudience: AUDIENCE,
    store,
    publisher: createGovernancePublisher({ store, scopeGroupId: SCOPE_GROUP_ID, clock }),
    scopeGroupId: SCOPE_GROUP_ID,
    deriver: DERIVER,
  });

  for (const body of [{}, { command: 'not-a-real-command' }, { command: 'edit' }]) {
    const response = await handler(requestWith({ body }), invocation);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  assert.equal(read, 0);
});

test('changing a budget is an authoring act, so a reader is refused', async () => {
  const store = await publishedStore();
  const { changeBudget } = handlersFor(store);
  const response = await changeBudget(
    requestWith({ roles: ['Governance.Read'], body: { command: 'edit', budgetId: 'budget-organization-monthly', changes: { amount: 1 } } }),
    invocation,
  );
  assert.equal(response.status, 403);
  assert.equal(response.jsonBody.error.reasonCode, 'write-budgets');
});

test('a fallback graph replacement is published and becomes the effective compiled chain', async () => {
  const store = await publishedStore();
  const { change, changeFallbackPlan } = handlersFor(store);
  const before = await readPublished(store);
  const globalBinding = before.entitlementSnapshot.bindings.find(
    (binding) => binding.target.kind === 'global',
  );
  let widened = await change(requestWith({
    roles: ['Governance.Own'],
    body: {
      bindingId: globalBinding.bindingId,
      changes: { modelAllowlist: ['coding-fast', 'coding-primary'] },
    },
  }), invocation);
  widened = await approveSaved(store, widened);
  assert.equal(widened.status, 200);

  const beforeFallback = await readPublished(store);
  let response = await changeFallbackPlan(
    requestWith({
      roles: ['Governance.Own'],
      body: {
        planId: 'plan-global-cheaper-alternative-001',
        changes: { edges: [{ from: 'coding-fast', to: 'coding-primary' }] },
      },
    }),
    invocation,
  );

  assert.deepEqual(await readPublished(store), beforeFallback, 'saving must leave active fallback unchanged');
  response = await approveSaved(store, response);
  assert.equal(response.status, 200);
  assert.ok(response.jsonBody.targets.every((target) => target.outcome === 'verified'));

  const after = await readPublished(store);
  const changed = after.fallbackPolicySnapshot.plans.find(
    (entry) => entry.planId === 'plan-global-cheaper-alternative-001',
  );
  assert.deepEqual(changed.edges, [{ from: 'coding-fast', to: 'coding-primary' }]);
  const subjectId = 'user-local-admin';
  const identity = {
    source: 'local-deterministic',
    validationId: 'fallback-edit-resolution',
    validatedAt: '2026-07-24T09:55:00.000Z',
    credentialExpiresAt: '2026-07-24T11:00:00.000Z',
    validationState: 'local-trusted',
    subject: { tenantId: 'tenant-local-demo', subjectId, principalType: 'user' },
    application: { applicationId: 'app-local-console', authenticationFlow: 'delegated' },
  };
  const membershipResolver = createDeterministicMembershipResolver([{
    tenantId: 'tenant-local-demo',
    subjectId,
    memberships: {
      snapshotId: 'fallback-edit-membership',
      status: 'complete',
      source: 'local-fixture',
      tenantId: 'tenant-local-demo',
      subjectId,
      resolvedAt: '2026-07-24T09:55:00.000Z',
      expiresAt: '2026-07-24T10:30:00.000Z',
      maxAgeSeconds: 2_100,
      sourceRevision: 'fallback-edit-membership-source',
      groups: [{
        groupId: 'group-governance-admin',
        membership: 'direct',
        authorizationRelevant: true,
      }],
    },
  }]);
  const resolver = createPolicyResolver({
    deriver: DERIVER,
    scopeGroupId: SCOPE_GROUP_ID,
    snapshotProvider: () => after,
    principalContextFactory: createPrincipalContextFactory({
      membershipResolver,
      clock: createFixedClock(NOW),
      idGenerator: createSequenceIdGenerator('fallback-edit-resolution'),
    }),
    identityResolver: () => identity,
    clock: createFixedClock(NOW),
    config: { cacheTtlSeconds: 60, warnThresholdPercent: 80 },
  });
  const resolved = await resolver.resolve({ apiFamily: 'openai-responses' });
  assert.equal(resolved.status, 200);
  assert.deepEqual(resolved.document.fallback.chain, [
    { from: 'coding-fast', to: 'coding-primary' },
  ]);
  assert.ok(after.fallbackPolicySnapshot.version > before.fallbackPolicySnapshot.version);
});

test('a fallback plan change is refused as the administrator answer, not a fault, and publishes nothing', async () => {
  const store = await publishedStore();
  const { changeFallbackPlan } = handlersFor(store);
  const before = await readPublished(store);

  for (const [body, reasonCode] of [
    [{ planId: 'plan-that-does-not-exist', changes: { enabled: false } }, 'fallback-edit-target-unknown'],
    [{ planId: 'plan-global-cheaper-alternative-001', changes: {} }, 'fallback-edit-no-change'],
    [{ planId: 'plan-global-cheaper-alternative-001', changes: { deploymentName: 'x' } }, 'fallback-edit-field-unknown'],
  ]) {
    const response = await changeFallbackPlan(requestWith({ body }), invocation);
    assert.equal(response.status, 409, JSON.stringify(body));
    assert.equal(response.jsonBody.outcome, 'refused');
    assert.equal(response.jsonBody.reasonCode, reasonCode);
  }

  const after = await readPublished(store);
  assert.equal(after.fallbackPolicySnapshot.version, before.fallbackPolicySnapshot.version);
});

test('a fallback plan change names a plan, and a body that does not is refused before anything is read', async () => {
  const store = await publishedStore();
  let read = 0;
  const handler = createFallbackChangeHandler({
    readPublishedSnapshots: async () => {
      read += 1;
      return readPublished(store);
    },
    clock,
    expectedAudience: AUDIENCE,
    store,
    publisher: createGovernancePublisher({ store, scopeGroupId: SCOPE_GROUP_ID, clock }),
    scopeGroupId: SCOPE_GROUP_ID,
    deriver: DERIVER,
  });

  const response = await handler(requestWith({ body: { changes: { enabled: false } } }), invocation);
  assert.equal(response.status, 400);
  assert.equal(response.jsonBody.error.code, 'plan_required');
  assert.equal(read, 0);
});

test('an assignment grant is published and is what the next reader resolves', async () => {
  const store = await publishedStore();
  const { changeAssignment } = handlersFor(store);
  const before = await readPublished(store);

  let granted = await changeAssignment(
    requestWith({
      roles: ['Governance.Own'],
      body: {
        command: 'grant',
        assignmentId: 'assignment-new-auditor-local-001',
        roleCode: 'auditor',
        assignee: { kind: 'subject', key: 'user-new-auditor' },
        scope: { kind: 'global', key: null },
        reasonCode: 'access-review-removed',
      },
    }),
    invocation,
  );
  assert.deepEqual(await readPublished(store), before);
  granted = await approveSaved(store, granted);
  assert.equal(granted.status, 200);
  assert.ok(granted.jsonBody.targets.every((target) => target.outcome === 'verified'));

  const after = await readPublished(store);
  const newAssignment = after.assignmentSnapshot.assignments.find(
    (entry) => entry.assignmentId === 'assignment-new-auditor-local-001',
  );
  assert.equal(newAssignment.state, 'active');
  assert.ok(after.assignmentSnapshot.version > before.assignmentSnapshot.version);
});

test('an assignment revoke is published and is what the next reader resolves', async () => {
  // Against a fixture assignment granted well before the fixed clock's `now`, rather
  // than one granted and revoked at the same instant: a validity window of zero
  // width is correctly refused by the snapshot validator, and manufacturing that
  // refusal here would be testing the fixture's clock, not the revoke route.
  const store = await publishedStore();
  const { changeAssignment } = handlersFor(store);
  const before = await readPublished(store);

  let revoked = await changeAssignment(
    requestWith({
      roles: ['Governance.Own'],
      body: {
        command: 'revoke',
        assignmentId: 'assignment-governance-admin-local-001',
        reasonCode: 'access-review-removed',
      },
    }),
    invocation,
  );
  assert.deepEqual(await readPublished(store), before);
  revoked = await approveSaved(store, revoked);
  assert.equal(revoked.status, 200);
  assert.ok(revoked.jsonBody.targets.every((target) => target.outcome === 'verified'));

  const after = await readPublished(store);
  const revokedAssignment = after.assignmentSnapshot.assignments.find(
    (entry) => entry.assignmentId === 'assignment-governance-admin-local-001',
  );
  assert.equal(revokedAssignment.state, 'revoked');
  assert.ok(after.assignmentSnapshot.version > before.assignmentSnapshot.version);
});

test('an assignment change never lets the request name who issued it', async () => {
  // The authority behind a grant is the signed-in administrator route, not a value a
  // caller could put in the body - the same rule the local server states in comment.
  const store = await publishedStore();
  const { changeAssignment } = handlersFor(store);

  let response = await changeAssignment(
    requestWith({
      roles: ['Governance.Own'],
      body: {
        command: 'grant',
        assignmentId: 'assignment-spoofed-issuer-001',
        roleCode: 'auditor',
        assignee: { kind: 'subject', key: 'user-new-auditor' },
        scope: { kind: 'global', key: null },
        reasonCode: 'access-review-removed',
        issuedBy: { kind: 'subject', key: 'somebody-else' },
      },
    }),
    invocation,
  );

  response = await approveSaved(store, response);
  assert.equal(response.status, 200);
  const after = await readPublished(store);
  const created = after.assignmentSnapshot.assignments.find(
    (entry) => entry.assignmentId === 'assignment-spoofed-issuer-001',
  );
  assert.equal(
    created.issuedBy.key,
    DERIVER.deriveActorCode({ tenantId: 'tenant-admin-0001', subjectId: 'object-admin-0001' }),
  );
});

test('an assignment change is refused as the administrator answer, not a fault, and publishes nothing', async () => {
  const store = await publishedStore();
  const { changeAssignment } = handlersFor(store);
  const before = await readPublished(store);

  for (const [body, reasonCode] of [
    [{ command: 'revoke', assignmentId: 'assignment-that-does-not-exist', reasonCode: 'access-review-removed' }, 'assignment-edit-target-unknown'],
    [
      { command: 'grant', assignmentId: 'assignment-auditor-local-001', roleCode: 'auditor', assignee: { kind: 'group', key: 'group-auditor' }, scope: { kind: 'global', key: null }, reasonCode: 'access-review-removed' },
      'assignment-edit-duplicate-grant',
    ],
    [{ command: 'revoke', assignmentId: 'assignment-auditor-local-001' }, 'assignment-edit-reason-required'],
  ]) {
    const response = await changeAssignment(requestWith({ body }), invocation);
    assert.equal(response.status, 409, JSON.stringify(body));
    assert.equal(response.jsonBody.outcome, 'refused');
    assert.equal(response.jsonBody.reasonCode, reasonCode);
  }

  const after = await readPublished(store);
  assert.equal(after.assignmentSnapshot.version, before.assignmentSnapshot.version);
});

test('an assignment change names a command and an assignment, before anything is read', async () => {
  const store = await publishedStore();
  let read = 0;
  const handler = createAssignmentChangeHandler({
    readPublishedSnapshots: async () => {
      read += 1;
      return readPublished(store);
    },
    clock,
    expectedAudience: AUDIENCE,
    store,
    publisher: createGovernancePublisher({ store, scopeGroupId: SCOPE_GROUP_ID, clock }),
    scopeGroupId: SCOPE_GROUP_ID,
    deriver: DERIVER,
  });

  for (const body of [{}, { command: 'not-a-real-command', assignmentId: 'assignment-auditor-local-001' }, { command: 'revoke' }]) {
    const response = await handler(requestWith({ body }), invocation);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  assert.equal(read, 0);
});

test('changing an assignment is an authoring act, so a reader is refused', async () => {
  const store = await publishedStore();
  const { changeAssignment } = handlersFor(store);
  const response = await changeAssignment(
    requestWith({
      roles: ['Governance.Read'],
      body: { command: 'revoke', assignmentId: 'assignment-auditor-local-001', reasonCode: 'access-review-removed' },
    }),
    invocation,
  );
  assert.equal(response.status, 403);
  assert.equal(response.jsonBody.error.reasonCode, 'write-entitlements');
});
