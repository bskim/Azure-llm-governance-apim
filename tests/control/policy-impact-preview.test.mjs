import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPolicyImpactPreview,
  PolicyImpactPreviewError,
} from '../../app/control-api/policy-impact-preview.mjs';
import { createLocalPolicyResolver } from '../../app/functions/composition-root.mjs';
import { createDraftAuthor } from '../../app/control-api/draft-authoring.mjs';
import { createGovernancePublisher, governancePublicationTargets } from '../../app/control-api/governance-publisher.mjs';
import { createProposalPublisher } from '../../app/control-api/proposal-publication.mjs';
import { applyLifecycleCommand } from '../../app/governance-domain/lifecycle/configuration-lifecycle.mjs';
import { assembleGovernanceSnapshots } from '../../app/governance-domain/policy/governance-snapshot-document.mjs';
import { createInMemoryGovernanceStore } from '../../app/persistence/in-memory-governance-store.mjs';
import { createSequenceIdGenerator } from '../../app/local-adapters/deterministic-time.mjs';
import { getDeterministicGovernanceSnapshots } from '../../app/local-adapters/deterministic-governance-snapshots.mjs';

const NOW = '2026-07-24T10:00:00.000Z';

function revision(overrides = {}) {
  return {
    revisionId: 'revision-0042',
    revisionNumber: 42,
    state: 'draft',
    ...overrides,
  };
}

function allowingBothModels() {
  const snapshots = structuredClone(getDeterministicGovernanceSnapshots());
  for (const binding of snapshots.entitlementSnapshot.bindings) {
    if (binding.target.kind === 'global') {
      binding.modelAllowlist = ['coding-fast', 'coding-primary'];
    }
  }
  snapshots.entitlementSnapshot.version += 1;
  return snapshots;
}

function harness({
  active = getDeterministicGovernanceSnapshots(),
  proposed = active,
  resolvePolicy = null,
} = {}) {
  let activeSnapshots = active;
  let heldRevision = revision();
  let readCount = 0;
  let writes = 0;
  const idGenerator = createSequenceIdGenerator('impact-test');
  const preview = createPolicyImpactPreview({
    clock: { nowIso: () => NOW },
    readActiveSnapshots: async () => {
      readCount += 1;
      return activeSnapshots;
    },
    readDraft: async () => ({ content: { snapshots: proposed } }),
    readRevision: async () => heldRevision,
    readActiveRevision: async () => ({ revisionId: 'revision-active-0041', revisionNumber: 41 }),
    resolvePolicy: resolvePolicy ?? (({ snapshots, request }) =>
      createLocalPolicyResolver('governance-admin', idGenerator, async () => snapshots).resolve(request)),
  });
  return {
    preview,
    get reads() { return readCount; },
    get writes() { return writes; },
    setActive(value) { activeSnapshots = value; },
    setRevision(value) { heldRevision = value; },
    recordWrite() { writes += 1; },
  };
}

function request(overrides = {}) {
  return {
    revisionId: 'revision-0042',
    expectedRevisionNumber: 42,
    apiFamily: 'openai-responses',
    target: { kind: 'current-caller' },
    targetContext: { persona: 'governance-admin' },
    ...overrides,
  };
}

test('identical stored and active policy produces no-change with zero writes', async () => {
  const state = harness();
  const result = await state.preview.preview(request());

  assert.equal(result.state, 'no-change');
  assert.deepEqual(result.changes, []);
  assert.equal(result.before.state, 'resolved');
  assert.equal(result.after.state, 'resolved');
  assert.equal(state.reads, 2);
  assert.equal(state.writes, 0);
});

test('a saved allowlist and fallback change is compared without activating it', async () => {
  const active = getDeterministicGovernanceSnapshots();
  const proposed = allowingBothModels();
  const state = harness({ active, proposed });
  const result = await state.preview.preview(request());

  assert.equal(result.state, 'changed');
  assert.ok(result.changes.some((change) => change.category === 'allowedModels'));
  assert.ok(result.changes.some((change) => change.category === 'fallback'));
  assert.ok(result.changes.some((change) => change.category === 'fallbackRestrictions'));
  assert.equal(
    result.before.policy.fallbackRestrictions.rejections[0].blockedBy,
    'fallback-target-not-entitled',
  );
  assert.deepEqual(result.before.policy.allowedModels, ['coding-primary']);
  assert.deepEqual(result.after.policy.allowedModels, ['coding-fast', 'coding-primary']);
  assert.deepEqual(active.entitlementSnapshot.bindings.find(
    (binding) => binding.target.kind === 'global',
  ).modelAllowlist, ['coding-primary']);
  assert.equal(state.writes, 0);
});

test('budget limits and actions are compared through their effective limit projection', async () => {
  const proposed = structuredClone(getDeterministicGovernanceSnapshots());
  const budget = proposed.budgetSnapshot.budgets[0];
  budget.action = 'HARD_BLOCK';
  budget.limit.amount = 10_000_000;
  budget.thresholds = {};
  budget.budgetVersion += 1;
  proposed.budgetSnapshot.version += 1;

  const state = harness({ proposed });
  const result = await state.preview.preview(request());
  const limitChange = result.changes.find((change) => change.category === 'limits');

  assert.ok(limitChange);
  assert.equal(limitChange.before[0].budgetAction, 'SOFT_WARNING');
  assert.equal(limitChange.before[0].budgetThresholds.graceBasisPoints, 1_000);
  assert.equal(limitChange.after[0].budgetAction, 'HARD_BLOCK');
  assert.deepEqual(limitChange.after[0].budgetThresholds, {});
  assert.equal(limitChange.after[0].tokenQuota, 10_000_000);
  assert.equal(state.writes, 0);
});

test('a proposed policy refusal is shown as an outcome rather than a successful resolution', async () => {
  const active = getDeterministicGovernanceSnapshots();
  const proposed = allowingBothModels();
  const state = harness({
    active,
    proposed,
    resolvePolicy: ({ snapshots, request: policyRequest }) => (
      snapshots === proposed
        ? { status: 403, reasonCode: 'model-not-entitled', document: null }
        : createLocalPolicyResolver(
            'governance-admin',
            createSequenceIdGenerator('refusal-test'),
            async () => snapshots,
          ).resolve(policyRequest)
    ),
  });
  const result = await state.preview.preview(request());

  assert.equal(result.before.state, 'resolved');
  assert.equal(result.after.state, 'refused');
  assert.equal(result.after.policy, null);
  assert.equal(result.changes[0].category, 'resolution');
  assert.equal(state.writes, 0);
});

test('an unresolved proposed policy is shown as unavailable without hiding the active result', async () => {
  const active = getDeterministicGovernanceSnapshots();
  const proposed = allowingBothModels();
  const state = harness({
    active,
    proposed,
    resolvePolicy: ({ snapshots, request: policyRequest }) => (
      snapshots === proposed
        ? { status: 503, reasonCode: 'membership-unresolved', document: null }
        : createLocalPolicyResolver(
            'governance-admin',
            createSequenceIdGenerator('unavailable-test'),
            async () => snapshots,
          ).resolve(policyRequest)
    ),
  });
  const result = await state.preview.preview(request());

  assert.equal(result.before.state, 'resolved');
  assert.equal(result.after.state, 'unavailable');
  assert.equal(result.after.reasonCode, 'membership-unresolved');
  assert.equal(state.writes, 0);
});

test('two unavailable outcomes aggregate to unavailable, never no-change', async () => {
  const state = harness({
    resolvePolicy: async () => ({
      status: 503,
      reasonCode: 'membership-unresolved',
      document: null,
    }),
  });
  const result = await state.preview.preview(request());

  assert.equal(result.before.state, 'unavailable');
  assert.equal(result.after.state, 'unavailable');
  assert.equal(result.state, 'unavailable');
  assert.deepEqual(result.changes, []);
  assert.notEqual(result.state, 'no-change');
});

test('two refused outcomes aggregate to refused and are explicitly not compared', async () => {
  const state = harness({
    resolvePolicy: async () => ({
      status: 403,
      reasonCode: 'principal-not-entitled',
      document: null,
    }),
  });
  const result = await state.preview.preview(request());

  assert.equal(result.before.state, 'refused');
  assert.equal(result.after.state, 'refused');
  assert.equal(result.state, 'refused');
  assert.deepEqual(result.changes, []);
  assert.notEqual(result.state, 'no-change');
});

test('missing draft and changed revision are explicit unavailable and stale outcomes', async () => {
  const missing = createPolicyImpactPreview({
    clock: { nowIso: () => NOW },
    readActiveSnapshots: async () => getDeterministicGovernanceSnapshots(),
    readDraft: async () => null,
    readRevision: async () => revision(),
    readActiveRevision: async () => null,
    resolvePolicy: async () => assert.fail('resolver must not run without a draft'),
  });
  await assert.rejects(
    missing.preview(request()),
    (error) => error instanceof PolicyImpactPreviewError && error.code === 'draft-content-absent',
  );

  let reads = 0;
  const stale = harness();
  const original = stale.preview;
  const active = getDeterministicGovernanceSnapshots();
  const changed = allowingBothModels();
  const preview = createPolicyImpactPreview({
    clock: { nowIso: () => NOW },
    readActiveSnapshots: async () => (++reads === 1 ? active : changed),
    readDraft: async () => ({ content: { snapshots: active } }),
    readRevision: async () => revision(),
    readActiveRevision: async () => ({ revisionId: 'revision-active-0041' }),
    resolvePolicy: ({ snapshots, request: policyRequest }) =>
      createLocalPolicyResolver(
        'governance-admin',
        createSequenceIdGenerator('stale-test'),
        async () => snapshots,
      ).resolve(policyRequest),
  });
  assert.ok(original);
  await assert.rejects(
    preview.preview(request()),
    (error) => error instanceof PolicyImpactPreviewError && error.code === 'preview-stale',
  );
});

test('proposed preview uses the same resolver semantics as the policy after publication', async () => {
  const store = createInMemoryGovernanceStore();
  const scopeGroupId = 'platform-engineering';
  const clock = { nowIso: () => NOW };
  const drafts = createDraftAuthor({
    store,
    scopeGroupId,
    clock,
    targets: governancePublicationTargets({ includeMembership: false }),
  });
  const publisher = createProposalPublisher({
    store,
    publisher: createGovernancePublisher({ store, scopeGroupId, clock }),
    drafts,
    scopeGroupId,
    clock,
  });
  async function approveAndPublish(revisionId) {
    const held = await store.readConfigurationRevision({ scopeGroupId, revisionId });
    const approved = applyLifecycleCommand({
      revision: held.document,
      command: 'approve',
      actor: 'test-approver',
      at: NOW,
      expectedRevisionNumber: held.document.revisionNumber,
      selfApprovalGranted: false,
    });
    assert.equal(approved.ok, true);
    await store.putConfigurationRevision(approved.revision, { ifMatch: held.etag });
    return publisher.publish({ revisionId, actor: 'test-approver', inFlightRevisionId: null });
  }

  const initial = await drafts.propose({
    content: { snapshots: getDeterministicGovernanceSnapshots() },
    authoredBy: 'test-author',
  });
  assert.equal((await approveAndPublish(initial.revision.revisionId)).outcome, 'published');

  const proposed = allowingBothModels();
  const candidate = await drafts.propose({
    content: { snapshots: proposed },
    authoredBy: 'test-author',
  });
  const resolver = ({ snapshots, request: policyRequest }) =>
    createLocalPolicyResolver(
      'governance-admin',
      createSequenceIdGenerator('consistency-test'),
      async () => snapshots,
    ).resolve(policyRequest);
  const preview = createPolicyImpactPreview({
    clock,
    readActiveSnapshots: async () => assembleGovernanceSnapshots(
      await store.queryGovernanceSnapshots({ scopeGroupId, evaluationTime: NOW }),
    ),
    readDraft: async ({ revisionId }) =>
      (await store.readConfigurationDraft({ scopeGroupId, revisionId }))?.document ?? null,
    readRevision: async ({ revisionId }) =>
      (await store.readConfigurationRevision({ scopeGroupId, revisionId }))?.document ?? null,
    readActiveRevision: async () => initial.revision,
    resolvePolicy: resolver,
  });
  const previewed = await preview.preview(request({
    revisionId: candidate.revision.revisionId,
    expectedRevisionNumber: candidate.revision.revisionNumber,
  }));

  assert.equal((await approveAndPublish(candidate.revision.revisionId)).outcome, 'published');
  const publishedSnapshots = assembleGovernanceSnapshots(
    await store.queryGovernanceSnapshots({ scopeGroupId, evaluationTime: NOW }),
  );
  const published = await createLocalPolicyResolver(
    'governance-admin',
    createSequenceIdGenerator('published-test'),
    async () => publishedSnapshots,
  ).resolve({ apiFamily: 'openai-responses' });

  const expected = Object.fromEntries([
    'allowedModels',
    'modelDeployments',
    'limits',
    'warnThresholdPercent',
    'throttleTiers',
    'fallback',
    'fallbackRestrictions',
    'modelSelectionIntent',
    'substitutionNotice',
  ].filter((key) => key === 'fallbackRestrictions' || Object.hasOwn(published.document, key)).map(
    (key) => [
      key,
      key === 'fallbackRestrictions'
        ? {
            disposition: published.evaluation.fallback.disposition,
            reasonCode: published.evaluation.fallback.reasonCode,
            rejections: structuredClone(published.evaluation.fallback.rejections),
          }
        : published.document[key],
    ],
  ));
  assert.deepEqual(previewed.after.policy, expected);
});

test('only the server-defined current caller target is accepted', async () => {
  const state = harness();
  await assert.rejects(
    state.preview.preview(request({ target: { kind: 'subject', key: 'somebody-else' } })),
    (error) => error.code === 'target-not-supported',
  );
});

test('control-plane identity is labelled without claiming inference-token identity', async () => {
  const state = harness();
  const result = await state.preview.preview(request({
    targetContext: {
      evidence: 'verified-control-plane-token',
      authenticationFlow: 'application',
      subjectId: 'must-not-be-projected',
      applicationId: 'must-not-be-projected-either',
      audience: 'must-not-be-projected',
    },
  }));

  assert.deepEqual(result.target, {
    kind: 'current-caller',
    evidence: 'verified-control-plane-token',
    identityBasis: 'control-plane-token',
    authenticationFlow: 'application',
  });
  assert.ok(result.limitations.includes('inference-token-identity-not-established'));
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('must-not-be-projected'), false);
  assert.equal(Object.hasOwn(result.target, 'subjectId'), false);
  assert.equal(Object.hasOwn(result.target, 'applicationId'), false);
  assert.equal(Object.hasOwn(result.target, 'audience'), false);

  const local = await state.preview.preview(request({
    targetContext: { evidence: 'local-deterministic-persona' },
  }));
  assert.deepEqual(local.target, {
    kind: 'current-caller',
    evidence: 'local-deterministic-persona',
  });
  assert.equal(local.limitations.includes('inference-token-identity-not-established'), false);
});
