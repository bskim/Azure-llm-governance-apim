import assert from 'node:assert/strict';
import test from 'node:test';

import { createLocalAdminServer } from '../../app/control-api/local-admin-server.mjs';
import { createLocalGovernanceSource } from '../../app/control-api/local-governance-source.mjs';
import {
  createRemovalPlanHandler,
  createRemovalProposalHandler,
} from '../../app/functions/handlers/admin-removal.mjs';

async function withServer(action) {
  const source = createLocalGovernanceSource({ evaluationTime: '2026-07-24T10:00:00.000Z' });
  const server = createLocalAdminServer({
    source: { ...source, readConfigurationRevisions: async () => [] },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await action(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function post(origin, path, body) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, payload: await response.json() };
}

function functionRequest(roles, body) {
  const principal = Buffer.from(JSON.stringify({
    auth_typ: 'aad',
    role_typ: 'roles',
    claims: [
      { typ: 'aud', val: 'api://control-plane' },
      { typ: 'tid', val: 'tenant-1' },
      { typ: 'oid', val: 'object-1' },
      ...roles.map((role) => ({ typ: 'roles', val: role })),
    ],
  })).toString('base64');
  const text = JSON.stringify(body);
  return {
    headers: {
      get(name) {
        if (name.toLowerCase() === 'x-ms-client-principal') return principal;
        if (name.toLowerCase() === 'content-length') return String(Buffer.byteLength(text));
        return null;
      },
    },
    async text() { return text; },
  };
}

test('local removal routes enforce authoring authority and exact server-planned acknowledgments', async () => {
  await withServer(async (origin) => {
    const input = {
      target: { kind: 'team', key: 'developer-experience' },
      reasonCode: 'team-dissolved',
    };
    const denied = await post(origin, '/api/local/removal-plan?persona=auditor', input);
    assert.equal(denied.status, 403);
    assert.equal(denied.payload.reasonCode, 'not-a-governance-author');

    const plan = await post(origin, '/api/local/removal-plan?persona=governance-admin', input);
    assert.equal(plan.status, 200);
    assert.equal(plan.payload.canPropose, true);
    assert.ok(plan.payload.references.length > 0);
    assert.doesNotMatch(JSON.stringify(plan.payload), /group-end-user/);

    const modelPlan = await post(origin, '/api/local/removal-plan?persona=governance-admin', {
      target: { kind: 'model', key: 'coding-fast' },
      reasonCode: 'retired-by-provider',
    });
    assert.equal(modelPlan.status, 200);
    assert.equal(modelPlan.payload.canPropose, false);
    assert.deepEqual(
      modelPlan.payload.blockers,
      [{ reasonCode: 'removal-empty-model-allowlist' }],
    );

    const forged = await post(origin, '/api/local/removal-proposals?persona=governance-admin', {
      ...input,
      planDigest: plan.payload.planDigest,
      selectedReferenceIds: ['forged'],
    });
    assert.equal(forged.status, 409);
    assert.equal(forged.payload.reasonCode, 'removal-selection-incomplete');

    const proposed = await post(origin, '/api/local/removal-proposals?persona=governance-admin', {
      ...input,
      planDigest: plan.payload.planDigest,
      selectedReferenceIds: plan.payload.references.map((entry) => entry.referenceId),
    });
    assert.equal(proposed.status, 201);
    assert.deepEqual(
      Object.fromEntries(['outcome', 'state'].map((key) => [key, proposed.payload[key]])),
      { outcome: 'proposed', state: 'draft' },
    );

    const stillActive = await (
      await fetch(`${origin}/api/local/access-options?persona=governance-admin`)
    ).json();
    assert.ok(stillActive.teams.some((team) => team.teamCode === input.target.key));

    const held = await (
      await fetch(`${origin}/api/local/lifecycle/revision?revisionId=${proposed.payload.revisionId}`)
    ).json();
    const approved = await post(origin, '/api/local/lifecycle/save', {
      revisionId: held.revisionId,
      etag: held.etag,
      expectedRevisionNumber: held.revisionNumber,
      loaded: held.revision,
      command: 'approve',
      actor: 'local-auditor',
    });
    assert.equal(approved.status, 200);

    const published = await post(origin, '/api/local/lifecycle/publish', {
      revisionId: proposed.payload.revisionId,
      actor: 'local-auditor',
    });
    assert.equal(published.status, 200, JSON.stringify(published.payload));

    const after = await (
      await fetch(`${origin}/api/local/access-options?persona=governance-admin`)
    ).json();
    assert.equal(after.teams.some((team) => team.teamCode === input.target.key), false);
    assert.equal(
      after.bindings.some(
        (binding) => binding.targetKind === 'team' && binding.targetCode === input.target.key,
      ),
      false,
    );
  });
});

test('stale removal plan cannot create a draft after another proposal is published', async () => {
  await withServer(async (origin) => {
    const input = {
      target: { kind: 'team', key: 'developer-experience' },
      reasonCode: 'team-dissolved',
    };
    const firstPlan = (await post(origin, '/api/local/removal-plan', input)).payload;

    const entitlement = await post(origin, '/api/local/entitlements/propose', {
      actor: 'local-admin',
      bindingId: 'binding-global-local-001',
      changes: { modelAllowlist: ['coding-fast', 'coding-primary'] },
    });
    assert.equal(entitlement.status, 201);
    const held = await (
      await fetch(`${origin}/api/local/lifecycle/revision?revisionId=${entitlement.payload.revisionId}`)
    ).json();
    assert.equal((await post(origin, '/api/local/lifecycle/save', {
      revisionId: held.revisionId,
      etag: held.etag,
      expectedRevisionNumber: held.revisionNumber,
      loaded: held.revision,
      command: 'approve',
      actor: 'local-auditor',
    })).status, 200);
    assert.equal((await post(origin, '/api/local/lifecycle/publish', {
      revisionId: entitlement.payload.revisionId,
      actor: 'local-auditor',
    })).status, 200);

    const stale = await post(origin, '/api/local/removal-proposals', {
      ...input,
      planDigest: firstPlan.planDigest,
      selectedReferenceIds: firstPlan.references.map((entry) => entry.referenceId),
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.payload.reasonCode, 'removal-plan-stale');
  });
});

test('deployed handlers deny read-only roles before disclosure and attribute proposals server-side', async () => {
  let planCalls = 0;
  let proposedInput = null;
  const plan = {
    readModelVersion: 'removal-plan.v1',
    target: { kind: 'model', key: 'model-a' },
    reasonCode: 'retired-by-provider',
    planDigest: 'digest',
    references: [{
      referenceId: 'model-budget:budget-a',
      kind: 'model-budget',
      code: 'budget-a',
      state: 'active',
      action: 'remove-budget',
    }],
    blockers: [],
    canPropose: true,
  };
  const service = {
    async plan() {
      planCalls += 1;
      return plan;
    },
    async propose(input) {
      proposedInput = input;
      return { outcome: 'proposed', revisionId: 'revision-0001', revisionNumber: 1, state: 'draft' };
    },
  };
  const common = {
    service,
    clock: { nowIso: () => '2026-07-24T10:00:00.000Z' },
    expectedAudience: 'api://control-plane',
  };
  const invocation = { invocationId: 'request-1', error: () => {} };
  const planHandler = createRemovalPlanHandler(common);
  const denied = await planHandler(functionRequest(['Governance.Read'], plan), invocation);
  assert.equal(denied.status, 403);
  assert.equal(planCalls, 0);

  const allowed = await planHandler(functionRequest(['Governance.Administer'], plan), invocation);
  assert.equal(allowed.status, 200);
  assert.equal(planCalls, 1);

  const proposalHandler = createRemovalProposalHandler({
    ...common,
    deriver: { deriveActorCode: () => 'server-derived-actor' },
  });
  const proposed = await proposalHandler(functionRequest(['Governance.Administer'], {
    target: plan.target,
    reasonCode: plan.reasonCode,
    planDigest: plan.planDigest,
    selectedReferenceIds: [plan.references[0].referenceId],
    authoredBy: 'client-forgery',
  }), invocation);
  assert.equal(proposed.status, 201);
  assert.equal(proposedInput.authoredBy, 'server-derived-actor');
});
