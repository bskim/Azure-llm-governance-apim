import assert from 'node:assert/strict';
import test from 'node:test';

import { addFallbackPlan, editFallbackPlan } from '../../app/governance-domain/policy/fallback-plan-edit.mjs';
import { compileFallbackPlan } from '../../app/governance-domain/policy/fallback-plan-compiler.mjs';
import { createFallbackChangeHandler } from '../../app/functions/handlers/admin-governance-edit.mjs';
import { createPublishGovernanceHandler } from '../../app/functions/handlers/publish-governance.mjs';
import { createGovernancePublisher } from '../../app/control-api/governance-publisher.mjs';
import { createPublishedPolicySource } from '../../app/control-api/published-policy-source.mjs';
import { createInMemoryGovernanceStore } from '../../app/persistence/in-memory-governance-store.mjs';
import { getDeterministicGovernanceSnapshots } from '../../app/local-adapters/deterministic-governance-snapshots.mjs';
import { createPrincipalKeyDeriver } from '../../app/governance-domain/identity/principal-key-derivation.mjs';

const NOW = '2026-07-24T10:00:00.000Z';
const clock = { nowIso: () => NOW };
const scopeGroupId = 'platform-engineering';
const expectedAudience = 'api://control-plane';
const deriver = createPrincipalKeyDeriver({ secret: 'a'.repeat(32) + '-administrator-actor-test-secret' });
const invocation = { invocationId: 'fallback-creation-test', error: () => {} };
const edge = { from: 'coding-secondary', to: 'coding-primary' };
const plan = { planId: 'plan-global-new', target: { kind: 'global', key: null }, edges: [edge] };

function snapshots() {
  const result = structuredClone(getDeterministicGovernanceSnapshots());
  result.fallbackPolicySnapshot.plans = [];
  const secondary = structuredClone(result.modelRegistrySnapshot.models.find((model) => model.modelKey === 'coding-fast'));
  secondary.modelKey = 'coding-secondary';
  secondary.providerDeploymentName = 'deploy-coding-secondary';
  result.modelRegistrySnapshot.models.push(secondary);
  result.modelRegistrySnapshot.models.sort((left, right) => left.modelKey.localeCompare(right.modelKey));
  return result;
}

function add(input = {}, source = snapshots()) {
  return addFallbackPlan({
    snapshot: source.fallbackPolicySnapshot,
    registry: source.modelRegistrySnapshot,
    teamCatalog: source.entitlementSnapshot.teamCatalog,
    issuedBy: { kind: 'subject', key: 'local-admin' },
    at: NOW,
    plan: { ...structuredClone(plan), ...input },
  });
}

test('creation uses safe defaults and retains the source snapshot and entitlements', () => {
  const source = snapshots();
  const original = structuredClone(source);
  const next = add({}, source);
  const created = next.plans[0];
  assert.equal(next.version, source.fallbackPolicySnapshot.version + 1);
  assert.equal(created.planVersion, 1);
  assert.equal(created.enabled, false);
  assert.equal(created.modelSelectionIntent, 'pinned');
  assert.equal(created.substitutionNotice, 'header');
  assert.equal(created.state, 'active');
  assert.equal(created.validFrom, NOW);
  assert.equal(created.validUntil, null);
  assert.deepEqual(created.issuedBy, { kind: 'subject', key: 'local-admin' });
  assert.equal(created.reasonCode, 'fallback-plan-created');
  assert.deepEqual(source, original);
});

test('creation supports existing target namespaces and rejects duplicate identifiers or conflicting targets', () => {
  for (const target of [
    { kind: 'global', key: null },
    { kind: 'team', key: 'platform-engineering' },
    { kind: 'subject', key: 'gateway-subject-001' },
    { kind: 'application', key: 'client-id-001' },
  ]) {
    const source = snapshots();
    source.fallbackPolicySnapshot = add({ target }, source);
    assert.deepEqual(source.fallbackPolicySnapshot.plans[0].target, target);
    assert.throws(() => add({ target }, source), { code: 'fallback-add-plan-exists' });
    for (const state of ['active', 'revoked', 'expired']) {
      source.fallbackPolicySnapshot.plans[0].state = state;
      assert.throws(() => add({ planId: 'another-plan', target }, source), { code: 'fallback-add-target-already-governed' });
    }
  }
  assert.throws(() => add({ target: { kind: 'team', key: 'unknown-team' } }), { code: 'fallback-add-team-unknown' });
  for (const target of [{ kind: 'organization', key: null }, { kind: 'global', key: 'not-null' }, { kind: 'subject', key: '' }]) {
    assert.throws(() => add({ target }), { code: 'fallback-edit-result-invalid' });
  }
});

test('the existing snapshot validator enforces edge and model invariants before creation', () => {
  for (const edges of [
    [{ from: edge.from, to: edge.from }],
    [edge, edge],
    [edge, { from: edge.to, to: edge.from }],
    Array.from({ length: 33 }, (_, index) => ({ from: `model-${index}`, to: edge.to })),
    [{ ...edge, extra: true }],
    null,
  ]) {
    assert.throws(() => add({ edges }), { code: 'fallback-edit-result-invalid' });
  }
  assert.throws(() => add({ edges: [{ from: 'not-registered', to: edge.to }] }), { code: 'fallback-add-model-unregistered' });
  for (const property of ['issuedBy', 'validFrom', 'validUntil', 'state', 'planVersion', 'reasonCode', 'onExhausted', 'modelAllowlist']) {
    assert.throws(() => add({ [property]: 'caller-supplied' }), { code: 'fallback-edit-field-unknown' });
  }
  assert.throws(() => add({ substitutionNotice: 'inline' }), { code: 'fallback-edit-notice-requires-preferred' });
  assert.throws(() => add({ enabled: null }), { code: 'fallback-edit-result-invalid' });
});

test('creation and later editing reuse compilation without widening model entitlement', () => {
  const source = snapshots();
  const created = add({ enabled: true, modelSelectionIntent: 'preferred', substitutionNotice: 'inline' }, source);
  const compile = (allowedModels) => compileFallbackPlan({
    plan: created.plans[0], registry: source.modelRegistrySnapshot, allowedModels,
    evaluationTime: NOW, apiFamily: 'openai-chat-completions',
  });
  assert.deepEqual(compile([edge.from, edge.to]).chain, [edge]);
  assert.equal(compile([edge.to]).chain.length, 0);
  assert.equal(compile([edge.to]).rejections[0].blockedBy, 'fallback-source-not-entitled');
  const edited = editFallbackPlan({
    snapshot: created, planId: plan.planId,
    changes: { modelSelectionIntent: 'pinned', substitutionNotice: 'header' }, at: NOW,
  });
  assert.equal(edited.plans[0].planVersion, 2);
  assert.deepEqual(edited.plans[0].target, plan.target);
  assert.deepEqual(edited.plans[0].issuedBy, created.plans[0].issuedBy);
});

function request(body, { roles = ['Governance.Administer'], objectId = 'admin-1' } = {}) {
  const principal = Buffer.from(JSON.stringify({
    auth_typ: 'aad', role_typ: 'roles',
    claims: [
      { typ: 'aud', val: expectedAudience }, { typ: 'tid', val: 'test-tenant' },
      { typ: 'oid', val: objectId }, ...roles.map((val) => ({ typ: 'roles', val })),
    ],
  })).toString('base64');
  return { headers: { get: (name) => name === 'x-ms-client-principal' ? principal : null }, text: async () => JSON.stringify(body) };
}

async function setup() {
  const store = createInMemoryGovernanceStore();
  const durable = createGovernancePublisher({ store, scopeGroupId, clock });
  let writes = 0;
  const shared = {
    store, scopeGroupId, clock, expectedAudience, deriver,
    publisher: { publish: async (input) => { writes += 1; return durable.publish(input); } },
    readPublishedSnapshots: createPublishedPolicySource({ store, scopeGroupId, clock }),
  };
  const initialized = await createPublishGovernanceHandler(shared)(
    request({ initialOnly: true, content: { snapshots: snapshots() } }), invocation,
  );
  assert.equal(initialized.jsonBody.state, 'active');
  writes = 0;
  return { store, shared, handler: createFallbackChangeHandler(shared), writes: () => writes };
}

test('an empty-plan installation creates a draft without writes, then the same or another admin explicitly publishes', async () => {
  for (const approver of ['admin-1', 'admin-2']) {
    const { store, shared, handler, writes } = await setup();
    const before = await shared.readPublishedSnapshots();
    const proposed = await handler(request({ command: 'add', plan, issuedBy: { key: 'forged' } }), invocation);
    assert.equal(proposed.status, 201);
    assert.equal(proposed.jsonBody.state, 'draft');
    assert.equal(proposed.jsonBody.targets.length, 5);
    assert.ok(proposed.jsonBody.targets.every((target) => target.outcome === 'pending'));
    assert.equal(writes(), 0);
    assert.deepEqual(await shared.readPublishedSnapshots(), before);
    const revisionId = proposed.jsonBody.revisionId;
    const draft = await store.readConfigurationDraft({ scopeGroupId, revisionId });
    assert.ok(draft);
    const mutated = await handler(request({ resume: true, revisionId, plan: { ...plan, edges: [] } }), invocation);
    assert.equal(mutated.status, 400);
    const active = await handler(request({ resume: true, revisionId }, { objectId: approver }), invocation);
    assert.equal(active.status, 200);
    assert.equal(active.jsonBody.state, 'active');
    assert.ok(active.jsonBody.targets.every((target) => target.outcome === 'verified'));
    assert.equal(writes(), 1);
    assert.deepEqual(await store.readConfigurationDraft({ scopeGroupId, revisionId }), draft);
    const published = await shared.readPublishedSnapshots();
    assert.deepEqual(published.entitlementSnapshot, before.entitlementSnapshot);
    assert.deepEqual(published.fallbackPolicySnapshot.plans[0].edges, [edge]);
    assert.equal(published.fallbackPolicySnapshot.plans[0].enabled, false);
    const actor = deriver.deriveActorCode({ tenantId: 'test-tenant', subjectId: 'admin-1' });
    assert.deepEqual(published.fallbackPolicySnapshot.plans[0].issuedBy, { kind: 'subject', key: actor });
    const revision = (await store.readConfigurationRevision({ scopeGroupId, revisionId })).document;
    assert.equal(revision.history.some((entry) => entry.reasonCode === 'self-approval-granted'), approver === 'admin-1');

    const edit = await handler(request({
      planId: plan.planId, changes: { enabled: true, modelSelectionIntent: 'preferred', substitutionNotice: 'inline' },
    }), invocation);
    assert.equal(edit.status, 201);
    assert.equal(writes(), 1);
    assert.equal((await shared.readPublishedSnapshots()).fallbackPolicySnapshot.plans[0].modelSelectionIntent, 'pinned');
    const resumed = await handler(request({ resume: true, revisionId: edit.jsonBody.revisionId }), invocation);
    assert.equal(resumed.jsonBody.state, 'active');
    const updated = (await shared.readPublishedSnapshots()).fallbackPolicySnapshot.plans[0];
    assert.equal(updated.enabled, true);
    assert.equal(updated.modelSelectionIntent, 'preferred');
    assert.equal(updated.substitutionNotice, 'inline');
  }
});

test('readers, unknown roles, unsupported commands, and invalid creation never write a draft or publish', async () => {
  const { store, handler, writes } = await setup();
  for (const roles of [['Governance.Read'], ['Unknown.Role']]) {
    for (const body of [{ command: 'add', plan }, { resume: true, revisionId: 'revision-0002' }]) {
      assert.equal((await handler(request(body, { roles }), invocation)).status, 403);
    }
  }
  for (const body of [{ command: 'add' }, { command: 'add', plan: null }, { command: 'delete', plan }]) {
    assert.equal((await handler(request(body), invocation)).status, 400);
  }
  const invalid = await handler(request({ command: 'add', plan: { ...plan, edges: [{ from: edge.from, to: edge.from }] } }), invocation);
  assert.equal(invalid.status, 409);
  assert.equal((await store.queryConfigurationRevisions({ scopeGroupId })).length, 1);
  assert.equal(writes(), 0);
});
