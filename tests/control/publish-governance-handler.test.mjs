import assert from 'node:assert/strict';
import test from 'node:test';

import { createPublishGovernanceHandler } from '../../app/functions/handlers/publish-governance.mjs';
import { createGovernancePublisher } from '../../app/control-api/governance-publisher.mjs';
import { createPublishedPolicySource } from '../../app/control-api/published-policy-source.mjs';
import { createInMemoryGovernanceStore } from '../../app/persistence/in-memory-governance-store.mjs';
import { getDeterministicGovernanceSnapshots } from '../../app/local-adapters/deterministic-governance-snapshots.mjs';
import { createPrincipalKeyDeriver } from '../../app/governance-domain/identity/principal-key-derivation.mjs';
import { applyLifecycleCommand, createRevision } from '../../app/governance-domain/lifecycle/configuration-lifecycle.mjs';

const NOW = '2026-07-24T10:00:00.000Z';
const SCOPE_GROUP_ID = 'platform-engineering';
const AUDIENCE = 'api://control-plane';
const DERIVER = createPrincipalKeyDeriver({ secret: 'a'.repeat(32) + '-administrator-actor-test-secret' });
const clock = { nowIso: () => NOW };

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

function content() {
  return {
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
  };
}

function contentWithBudget(amount) {
  const proposed = structuredClone(content());
  proposed.snapshots.budgetSnapshot.budgets.find(
    (budget) => budget.budgetId === 'budget-organization-monthly',
  ).limit.amount = amount;
  return proposed;
}

function handlerFor(store, overrides = {}) {
  return createPublishGovernanceHandler({
    store,
    publisher: createGovernancePublisher({ store, scopeGroupId: SCOPE_GROUP_ID, clock }),
    clock,
    scopeGroupId: SCOPE_GROUP_ID,
    expectedAudience: AUDIENCE,
    deriver: DERIVER,
    ...overrides,
  });
}

const invocation = { invocationId: 'invocation-1', error: () => {} };

test('default administrators save without publication writes, then explicitly self-approve the immutable draft', async () => {
  for (const initialized of [false, true]) {
    const store = createInMemoryGovernanceStore();
    const handler = handlerFor(store);
    if (initialized) {
      await handler(requestWith({ body: { content: content(), initialOnly: true } }), invocation);
    }
    const priorRevisions = await store.queryConfigurationRevisions({ scopeGroupId: SCOPE_GROUP_ID });
    const priorSnapshots = await store.queryGovernanceSnapshots({ scopeGroupId: SCOPE_GROUP_ID, evaluationTime: NOW });
    let publications = 0;
    const durablePublisher = createGovernancePublisher({ store, scopeGroupId: SCOPE_GROUP_ID, clock });
    const traced = handlerFor(store, {
      publisher: { publish: async (input) => { publications += 1; return durablePublisher.publish(input); } },
    });
    const created = await traced(requestWith({
      body: { content: contentWithBudget(222_222), actorCode: 'not-the-author', selfApprovalGranted: false },
    }), invocation);
    assert.equal(created.status, 201);
    assert.equal(created.jsonBody.outcome, 'proposed');
    assert.equal(created.jsonBody.state, 'draft');
    assert.ok(created.jsonBody.etag);
    assert.equal(publications, 0, 'saving must never call the target publisher');
    assert.ok(created.jsonBody.targets.every((target) => target.outcome === 'pending'));
    assert.deepEqual(await store.queryGovernanceSnapshots({ scopeGroupId: SCOPE_GROUP_ID, evaluationTime: NOW }), priorSnapshots);
    const revisionId = created.jsonBody.revisionId;
    const draft = await store.readConfigurationRevision({ scopeGroupId: SCOPE_GROUP_ID, revisionId });
    const storedContent = await store.readConfigurationDraft({ scopeGroupId: SCOPE_GROUP_ID, revisionId });
    const actor = DERIVER.deriveActorCode({ tenantId: 'tenant-admin-0001', subjectId: 'object-admin-0001' });
    assert.equal(draft.document.authoredBy, actor);
    assert.equal(draft.document.approvedBy, null);
    assert.equal(draft.document.history.length, 1);

    for (const roles of [['Governance.Read'], ['Unknown.Role']]) {
      for (const body of [{ content: content() }, { resume: true, revisionId }]) {
        const denied = await traced(requestWith({ roles, body }), invocation);
        assert.equal(denied.status, 403);
      }
    }
    assert.deepEqual(await store.readConfigurationRevision({ scopeGroupId: SCOPE_GROUP_ID, revisionId }), draft);
    assert.equal(publications, 0);

    const resumed = await traced(requestWith({ body: { resume: true, revisionId } }), invocation);
    assert.equal(resumed.status, 200);
    assert.equal(resumed.jsonBody.state, 'active');
    assert.equal(publications, 1);
    assert.ok(resumed.jsonBody.targets.every((target) => target.outcome === 'verified'));
    const active = (await store.readConfigurationRevision({ scopeGroupId: SCOPE_GROUP_ID, revisionId })).document;
    assert.equal(active.authoredBy, actor);
    assert.equal(active.approvedBy, actor);
    assert.equal(active.publishedBy, actor);
    assert.deepEqual(active.history.slice(0, draft.document.history.length), draft.document.history);
    assert.equal(active.history.find((entry) => entry.command === 'approve').reasonCode, 'self-approval-granted');
    assert.ok(active.history.filter((entry) => entry.command !== 'target-outcome').every((entry) => entry.actor === actor));
    assert.ok(active.history.filter((entry) => entry.command === 'target-outcome')
      .every((entry) => active.targets.some((target) => target.targetCode === entry.actor)));
    assert.deepEqual(await store.readConfigurationDraft({ scopeGroupId: SCOPE_GROUP_ID, revisionId }), storedContent);
    for (const prior of priorRevisions) {
      const current = await store.readConfigurationRevision({ scopeGroupId: SCOPE_GROUP_ID, revisionId: prior.revisionId });
      assert.deepEqual(current.document.history.slice(0, prior.history.length), prior.history);
    }
    const published = await createPublishedPolicySource({ store, scopeGroupId: SCOPE_GROUP_ID, clock })();
    assert.equal(published.budgetSnapshot.budgets.find((entry) => entry.budgetId === 'budget-organization-monthly').limit.amount, 222_222);
  }
});

test('a default administrator retries a failed explicit self-publication without changing its approval or draft', async () => {
  const store = createInMemoryGovernanceStore();
  const created = await handlerFor(store)(requestWith({ body: { content: content() } }), invocation);
  assert.equal(created.status, 201);
  const revisionId = created.jsonBody.revisionId;
  const draft = await store.readConfigurationDraft({ scopeGroupId: SCOPE_GROUP_ID, revisionId });
  const failed = await handlerFor(store, {
    publisher: {
      publish: async ({ revision }) => ({
        revision: {
          ...revision,
          targets: revision.targets.map((target) => ({
            ...target, outcome: 'failed', reasonCode: 'gateway-unreachable',
          })),
        },
      }),
    },
  })(requestWith({ body: { resume: true, revisionId } }), invocation);
  assert.equal(failed.status, 200);
  assert.equal(failed.jsonBody.state, 'failed');
  const before = (await store.readConfigurationRevision({ scopeGroupId: SCOPE_GROUP_ID, revisionId })).document;
  const retry = await handlerFor(store)(requestWith({ body: { resume: true, revisionId } }), invocation);
  assert.equal(retry.status, 200);
  assert.equal(retry.jsonBody.state, 'active');
  assert.ok(retry.jsonBody.targets.every((target) => target.outcome === 'verified'));
  const active = (await store.readConfigurationRevision({ scopeGroupId: SCOPE_GROUP_ID, revisionId })).document;
  assert.deepEqual(active.history.slice(0, before.history.length), before.history);
  assert.equal(active.history.filter((entry) => entry.reasonCode === 'self-approval-granted').length, 1);
  assert.equal(active.approvedBy, before.approvedBy);
  assert.deepEqual(await store.readConfigurationDraft({ scopeGroupId: SCOPE_GROUP_ID, revisionId }), draft);
});

test('a completed publication does not treat multi-team membership as a catalogue fault', async () => {
  const store = createInMemoryGovernanceStore();
  const warned = [];
  const response = await createPublishGovernanceHandler({
    store,
    publisher: createGovernancePublisher({ store, scopeGroupId: SCOPE_GROUP_ID, clock }),
    clock,
    scopeGroupId: SCOPE_GROUP_ID,
    expectedAudience: AUDIENCE,
    deriver: DERIVER,
    overlapWarner: { warn: async (value) => { warned.push(value); return { warned: 0, reasonCode: null }; } },
  })(requestWith({ body: { content: content(), initialOnly: true } }), invocation);

  assert.equal(response.status, 200);
  assert.equal(warned.length, 0);
});

test('an administrator publishes a complete set and it becomes resolvable', async () => {
  const store = createInMemoryGovernanceStore();
  const response = await handlerFor(store)(requestWith({ body: { content: content(), initialOnly: true } }), invocation);

  assert.equal(response.status, 200);
  assert.equal(response.jsonBody.state, 'active');
  assert.ok(response.jsonBody.targets.every((target) => target.outcome === 'verified'));

  const published = await createPublishedPolicySource({ store, scopeGroupId: SCOPE_GROUP_ID, clock })();
  assert.ok(published.entitlementSnapshot);
});

test('token-claim membership mode bootstraps from five snapshots without raw subjects', async () => {
  const store = createInMemoryGovernanceStore();
  const withoutMembership = content();
  delete withoutMembership.memberships;

  const response = await handlerFor(store)(
    requestWith({ body: { content: withoutMembership, initialOnly: true } }),
    invocation,
  );

  assert.equal(response.status, 200);
  assert.equal(response.jsonBody.state, 'active');
  assert.equal(response.jsonBody.targets.length, 5);
  assert.ok(response.jsonBody.targets.every((target) => target.outcome === 'verified'));
});

test('an explicitly empty membership set is refused instead of silently selecting token-claim mode', async () => {
  const store = createInMemoryGovernanceStore();
  const emptyMembership = content();
  emptyMembership.memberships = [];

  const response = await handlerFor(store)(
    requestWith({ body: { content: emptyMembership } }),
    invocation,
  );

  assert.equal(response.status, 400);
  assert.equal(response.jsonBody.error.code, 'publication_membership_empty');
  assert.deepEqual(await store.queryConfigurationRevisions({ scopeGroupId: SCOPE_GROUP_ID }), []);
});

test('an incomplete proposal is refused before a draft or revision is stored', async () => {
  for (const proposed of [{ snapshots: {} }, (() => {
    const missingTarget = content();
    delete missingTarget.snapshots.budgetSnapshot;
    return missingTarget;
  })()]) {
    const store = createInMemoryGovernanceStore();
    const response = await handlerFor(store)(
      requestWith({ body: { content: proposed, initialOnly: true } }),
      invocation,
    );

    assert.equal(response.status, 400);
    assert.equal(response.jsonBody.error.code, 'publication_content_incomplete');
    assert.deepEqual(await store.queryConfigurationRevisions({ scopeGroupId: SCOPE_GROUP_ID }), []);
    assert.equal(
      await store.readConfigurationDraft({ scopeGroupId: SCOPE_GROUP_ID, revisionId: 'revision-0001' }),
      null,
    );
  }
});

test('an initial-only publication refuses to replace an existing active set', async () => {
  const store = createInMemoryGovernanceStore();
  const first = await handlerFor(store)(
    requestWith({ body: { content: content(), initialOnly: true } }),
    invocation,
  );
  assert.equal(first.jsonBody.state, 'active');

  const second = await handlerFor(store)(
    requestWith({ body: { content: content(), initialOnly: true } }),
    invocation,
  );
  assert.equal(second.status, 409);
  assert.equal(second.jsonBody.reasonCode, 'governance-already-initialized');
  assert.equal((await store.queryConfigurationRevisions({ scopeGroupId: SCOPE_GROUP_ID })).length, 1);
});

test('an interrupted initial publication resumes its stored proposal at a later time', async () => {
  const store = createInMemoryGovernanceStore();
  const t1 = { nowIso: () => '2026-07-24T10:00:00.000Z' };
  const t2 = { nowIso: () => '2026-07-24T11:00:00.000Z' };
  const durable = createGovernancePublisher({ store, scopeGroupId: SCOPE_GROUP_ID, clock: t1 });
  let attempts = 0;
  const publisher = {
    publish: async ({ revision, ...publication }) => {
      attempts += 1;
      if (attempts === 1) {
        const failed = structuredClone(revision);
        failed.targets = failed.targets.map((target) =>
          target.targetCode === 'governance-snapshot-budget'
            ? { ...target, outcome: 'failed', reasonCode: 'gateway-unreachable' }
            : target,
        );
        return { revision: failed };
      }
      return durable.publish({ revision, ...publication });
    },
  };
  const proposed = contentWithBudget(222_222);
  const first = await handlerFor(store, { clock: t1, publisher })(
    requestWith({ body: { content: proposed, initialOnly: true }, objectId: 'object-admin-0001' }),
    invocation,
  );
  assert.equal(first.jsonBody.state, 'failed', JSON.stringify(first.jsonBody));

  const replacement = await handlerFor(store, { clock: t2, publisher })(
    requestWith({ body: { content: contentWithBudget(999_999), initialOnly: true, resume: true, revisionId: 'revision-0001' } }),
    invocation,
  );
  assert.equal(replacement.status, 400);
  assert.equal(replacement.jsonBody.error.code, 'resume_mutation_not_allowed');

  const resumed = await handlerFor(store, { clock: t2, publisher })(
    requestWith({ body: { initialOnly: true, resume: true, revisionId: 'revision-0001' }, objectId: 'object-admin-0002' }),
    invocation,
  );
  assert.equal(resumed.status, 200);
  assert.equal(resumed.jsonBody.state, 'active');
  const published = await createPublishedPolicySource({ store, scopeGroupId: SCOPE_GROUP_ID, clock: t1 })();
  assert.equal(
    published.budgetSnapshot.budgets.find((budget) => budget.budgetId === 'budget-organization-monthly').limit.amount,
    222_222,
  );
  const [revision] = await store.queryConfigurationRevisions({ scopeGroupId: SCOPE_GROUP_ID });
  assert.equal(revision.authoredBy, 'bootstrap-import');
  assert.equal(revision.approvedBy, DERIVER.deriveActorCode({ tenantId: 'tenant-admin-0001', subjectId: 'object-admin-0001' }));
  assert.equal(revision.publishedBy, DERIVER.deriveActorCode({ tenantId: 'tenant-admin-0001', subjectId: 'object-admin-0002' }));
});

test('all target failures are recorded as failed and an approval-only retry publishes the stored proposal', async () => {
  const store = createInMemoryGovernanceStore();
  const failingPublisher = {
    publish: async ({ revision }) => ({
      revision: {
        ...revision,
        targets: revision.targets.map((target) => ({
          ...target,
          outcome: 'failed',
          reasonCode: 'gateway-unreachable',
        })),
      },
    }),
  };
  const failed = await handlerFor(store, { publisher: failingPublisher })(
    requestWith({ body: { content: content(), initialOnly: true } }),
    invocation,
  );
  assert.equal(failed.status, 200);
  assert.equal(failed.jsonBody.state, 'failed');
  assert.ok(failed.jsonBody.targets.every((target) => target.outcome === 'failed'));

  const retried = await handlerFor(store)(
    requestWith({ body: { initialOnly: true, resume: true, revisionId: 'revision-0001' }, objectId: 'object-admin-0002' }),
    invocation,
  );
  assert.equal(retried.status, 200);
  assert.equal(retried.jsonBody.state, 'active');
});

test('an owner cannot abandon a bootstrap proposal after its publisher has started target writes', async () => {
  const store = createInMemoryGovernanceStore();
  let targetWriteStarted = false;
  const failingPublisher = {
    publish: async ({ revision }) => ({
      revision: {
        ...revision,
        targets: revision.targets.map((target) => ({ ...target, outcome: 'failed', reasonCode: 'gateway-unreachable' })),
      },
    }),
  };
  const publisherWithStartedWrite = {
    publish: async (args) => {
      targetWriteStarted = true;
      return failingPublisher.publish(args);
    },
  };
  await handlerFor(store, { publisher: publisherWithStartedWrite })(
    requestWith({ body: { content: content(), initialOnly: true } }),
    invocation,
  );
  assert.equal(targetWriteStarted, true);

  const denied = await handlerFor(store)(
    requestWith({ body: { command: 'abandon', revisionId: 'revision-0001' }, objectId: 'object-admin-0002' }),
    invocation,
  );
  assert.equal(denied.status, 403);
  assert.equal(denied.jsonBody.error.reasonCode, 'recovery-abandonment-requires-owner');

  const abandoned = await handlerFor(store)(
    requestWith({ roles: ['Governance.Own'], body: { command: 'abandon', revisionId: 'revision-0001' }, objectId: 'object-admin-0002' }),
    invocation,
  );
  assert.equal(abandoned.status, 409);
  assert.equal(abandoned.jsonBody.reasonCode, 'proposal-abandonment-publish-started');
  const [revision] = await store.queryConfigurationRevisions({ scopeGroupId: SCOPE_GROUP_ID });
  assert.equal(revision.state, 'failed');
});

test('a proposal with a verified target cannot be abandoned', async () => {
  const store = createInMemoryGovernanceStore();
  const durable = createGovernancePublisher({ store, scopeGroupId: SCOPE_GROUP_ID, clock });
  const partialPublisher = {
    publish: async (args) => {
      const published = await durable.publish(args);
      return {
        revision: {
          ...published.revision,
          targets: published.revision.targets.map((target) =>
            target.targetCode === 'governance-snapshot-budget'
              ? { ...target, outcome: 'failed', reasonCode: 'gateway-unreachable' }
              : target,
          ),
        },
      };
    },
  };
  const failed = await handlerFor(store, { publisher: partialPublisher })(
    requestWith({ body: { content: content(), initialOnly: true } }),
    invocation,
  );
  assert.equal(failed.jsonBody.state, 'failed');

  const abandoned = await handlerFor(store)(
    requestWith({ roles: ['Governance.Own'], body: { command: 'abandon', revisionId: 'revision-0001' } }),
    invocation,
  );
  assert.equal(abandoned.status, 409);
  assert.equal(abandoned.jsonBody.reasonCode, 'proposal-abandonment-verified-targets');
});

test('a recovery abandonment cannot race a publisher after target writes begin', async () => {
  const store = createInMemoryGovernanceStore();
  let targetWrites = 0;
  let targetWriteStarted;
  const targetWriteStartedPromise = new Promise((resolve) => {
    targetWriteStarted = resolve;
  });
  let releasePublisher;
  const releasePublisherPromise = new Promise((resolve) => {
    releasePublisher = resolve;
  });
  const publisher = {
    publish: async ({ revision }) => {
      targetWrites += 1;
      targetWriteStarted();
      await releasePublisherPromise;
      return {
        revision: {
          ...revision,
          targets: revision.targets.map((target) => ({ ...target, outcome: 'verified', reasonCode: null })),
        },
      };
    },
  };

  const publishing = handlerFor(store, { publisher })(
    requestWith({ body: { content: content(), initialOnly: true } }),
    invocation,
  );
  await targetWriteStartedPromise;

  const abandoned = await handlerFor(store)(
    requestWith({ roles: ['Governance.Own'], body: { command: 'abandon', revisionId: 'revision-0001' } }),
    invocation,
  );
  releasePublisher();
  const published = await publishing;

  assert.equal(targetWrites, 1);
  assert.equal(abandoned.status, 409);
  assert.equal(abandoned.jsonBody.reasonCode, 'proposal-abandonment-publishing');
  assert.equal(published.status, 200);
  assert.equal(published.jsonBody.state, 'active');
});

test('recovery abandonment cannot overtake a publishing target write', async () => {
  const store = createInMemoryGovernanceStore();
  let releaseTargetWrite;
  let targetWriteStarted;
  const targetWriteStartedPromise = new Promise((resolve) => { targetWriteStarted = resolve; });
  const targetWriteReleased = new Promise((resolve) => { releaseTargetWrite = resolve; });
  const durable = createGovernancePublisher({ store, scopeGroupId: SCOPE_GROUP_ID, clock });
  const publisher = {
    publish: async (args) => {
      targetWriteStarted();
      await targetWriteReleased;
      return durable.publish(args);
    },
  };

  const publishing = handlerFor(store, { publisher })(
    requestWith({ body: { content: content(), initialOnly: true } }),
    invocation,
  );
  await targetWriteStartedPromise;

  const abandoned = await handlerFor(store)(
    requestWith({ roles: ['Governance.Own'], body: { command: 'abandon', revisionId: 'revision-0001' } }),
    invocation,
  );

  assert.equal(abandoned.status, 409);
  assert.equal(abandoned.jsonBody.reasonCode, 'proposal-abandonment-publishing');
  releaseTargetWrite();
  const completed = await publishing;
  assert.equal(completed.status, 200);
  assert.equal(completed.jsonBody.state, 'active');
});

test('an untouched legacy failed revision without its draft can be securely abandoned', async () => {
  const store = createInMemoryGovernanceStore();
  const draft = createRevision({
    revisionId: 'revision-0001',
    revisionNumber: 1,
    scopeGroupId: SCOPE_GROUP_ID,
    authoredBy: 'bootstrap-import',
    authoredAt: NOW,
    targets: ['assignment', 'budget', 'entitlement', 'fallback', 'model-registry'],
  });
  const failed = {
    ...draft,
    state: 'failed',
    failure: { reasonCode: 'gateway-unreachable', at: NOW },
  };
  await store.putConfigurationRevision(failed, { ifMatch: null });

  const resume = await handlerFor(store)(
    requestWith({ roles: ['Governance.Own'], body: { initialOnly: true, resume: true, revisionId: 'revision-0001' } }),
    invocation,
  );
  assert.equal(resume.status, 409);
  assert.equal(resume.jsonBody.reasonCode, 'legacy-recovery-abandon-required');

  const abandoned = await handlerFor(store)(
    requestWith({ roles: ['Governance.Own'], body: { command: 'abandon', revisionId: 'revision-0001' } }),
    invocation,
  );
  assert.equal(abandoned.status, 200);
  assert.equal(abandoned.jsonBody.state, 'withdrawn');
  const fresh = await handlerFor(store)(
    requestWith({ body: { content: content() }, objectId: 'object-admin-0003' }),
    invocation,
  );
  assert.equal(fresh.status, 201);
  assert.equal(fresh.jsonBody.state, 'draft');
  assert.equal((await store.queryConfigurationRevisions({ scopeGroupId: SCOPE_GROUP_ID }))[1].revisionId, 'revision-0002');
});

test('only a high-trust actor can clear a zero-verified legacy draft or approval', async () => {
  for (const authoredBy of ['bootstrap-import', 'governance-administrator']) {
    for (const state of ['draft', 'approved']) {
      const store = createInMemoryGovernanceStore();
      const active = await handlerFor(store)(
        requestWith({ body: { content: content(), initialOnly: true } }),
        invocation,
      );
      assert.equal(active.jsonBody.state, 'active');

      let legacy = createRevision({
        revisionId: 'revision-0002',
        revisionNumber: 2,
        scopeGroupId: SCOPE_GROUP_ID,
        authoredBy,
        authoredAt: NOW,
        targets: ['legacy-target'],
      });
      if (state === 'approved') {
        legacy = applyLifecycleCommand({
          revision: legacy,
          command: 'approve',
          actor: DERIVER.deriveActorCode({ tenantId: 'tenant-admin-0001', subjectId: 'object-admin-0002' }),
          at: NOW,
          expectedRevisionNumber: 2,
          selfApprovalGranted: false,
        }).revision;
      }
      await store.putConfigurationRevision(legacy, { ifMatch: null });

      const reader = await handlerFor(store)(
        requestWith({ roles: ['Governance.Read'], body: { command: 'abandon', revisionId: legacy.revisionId } }),
        invocation,
      );
      assert.equal(reader.status, 403, `${authoredBy}/${state}: reader`);
      const ordinaryWriter = await handlerFor(store)(
        requestWith({ body: { command: 'abandon', revisionId: legacy.revisionId }, objectId: 'object-admin-0003' }),
        invocation,
      );
      assert.equal(ordinaryWriter.status, 403, `${authoredBy}/${state}: ordinary writer`);
      assert.equal(ordinaryWriter.jsonBody.error.reasonCode, 'recovery-abandonment-requires-owner');

      const abandoned = await handlerFor(store)(
        requestWith({
          roles: ['Governance.Own'],
          body: { command: 'abandon', revisionId: legacy.revisionId },
          objectId: 'object-admin-0003',
        }),
        invocation,
      );
      assert.equal(abandoned.status, 200, `${authoredBy}/${state}: high-trust actor`);
      assert.equal(abandoned.jsonBody.state, 'withdrawn');
      assert.equal((await store.readConfigurationRevision({
        scopeGroupId: SCOPE_GROUP_ID,
        revisionId: legacy.revisionId,
      })).document.history.at(-1).command, 'abandon');

      const replacement = await handlerFor(store)(
        requestWith({ roles: ['Governance.Own'], body: { content: content() }, objectId: 'object-admin-0003' }),
        invocation,
      );
      assert.equal(replacement.status, 201, `${authoredBy}/${state}: replacement`);
      assert.equal(replacement.jsonBody.state, 'draft');
      assert.ok(replacement.jsonBody.targets.every((target) => target.outcome === 'pending'));
      assert.equal(replacement.jsonBody.revisionId, 'revision-0003');
    }
  }
});

test('a verified legacy draft cannot be abandoned even by a high-trust actor', async () => {
  const store = createInMemoryGovernanceStore();
  const draft = createRevision({
    revisionId: 'revision-0001',
    revisionNumber: 1,
    scopeGroupId: SCOPE_GROUP_ID,
    authoredBy: 'bootstrap-import',
    authoredAt: NOW,
    targets: ['legacy-target'],
  });
  await store.putConfigurationRevision({
    ...draft,
    targets: Object.freeze([{ targetCode: 'legacy-target', outcome: 'verified', reasonCode: null }]),
  }, { ifMatch: null });

  const abandoned = await handlerFor(store)(
    requestWith({ roles: ['Governance.Own'], body: { command: 'abandon', revisionId: 'revision-0001' } }),
    invocation,
  );
  assert.equal(abandoned.status, 409);
  assert.equal(abandoned.jsonBody.reasonCode, 'proposal-abandonment-verified-targets');
});

test('an incomplete initial-only proposal never blocks a corrected publication', async () => {
  const store = createInMemoryGovernanceStore();
  const partial = content();
  delete partial.snapshots.budgetSnapshot;
  const refused = await handlerFor(store)(
    requestWith({ body: { content: partial, initialOnly: true } }),
    invocation,
  );
  assert.equal(refused.status, 400);
  assert.equal(refused.jsonBody.error.code, 'publication_content_incomplete');

  const corrected = await handlerFor(store)(
    requestWith({ body: { content: content(), initialOnly: true } }),
    invocation,
  );
  assert.equal(corrected.status, 200);
  assert.equal(corrected.jsonBody.state, 'active');
});

test('initial-only resume cannot overwrite a later interrupted publication', async () => {
  const store = createInMemoryGovernanceStore();
  const first = await handlerFor(store)(requestWith({ body: { content: content(), initialOnly: true } }), invocation);
  assert.equal(first.jsonBody.state, 'active');
  const failingPublisher = {
    publish: async ({ revision }) => ({
      revision: {
        ...revision,
        targets: revision.targets.map((target) => ({
          ...target,
          outcome: 'failed',
          reasonCode: 'gateway-unreachable',
        })),
      },
    }),
  };

  const second = await handlerFor(store, { publisher: failingPublisher })(
    requestWith({ roles: ['Governance.Own'], body: { content: contentWithBudget(222_222) } }),
    invocation,
  );
  assert.equal(second.jsonBody.revisionId, 'revision-0002');
  assert.equal(second.jsonBody.state, 'draft');
  const interrupted = await handlerFor(store, { publisher: failingPublisher })(
    requestWith({ body: { resume: true, revisionId: second.jsonBody.revisionId } }), invocation,
  );
  assert.equal(interrupted.jsonBody.state, 'failed');

  const beforeRevisions = await store.queryConfigurationRevisions({ scopeGroupId: SCOPE_GROUP_ID });
  const beforeSnapshots = await store.queryGovernanceSnapshots({ scopeGroupId: SCOPE_GROUP_ID, evaluationTime: NOW });
  const refused = await handlerFor(store)(
    requestWith({ body: { initialOnly: true, resume: true, revisionId: 'revision-0002' } }),
    invocation,
  );
  const afterRevisions = await store.queryConfigurationRevisions({ scopeGroupId: SCOPE_GROUP_ID });
  const afterSnapshots = await store.queryGovernanceSnapshots({ scopeGroupId: SCOPE_GROUP_ID, evaluationTime: NOW });

  assert.equal(refused.status, 409);
  assert.equal(refused.jsonBody.reasonCode, 'governance-already-initialized');
  assert.deepEqual(afterRevisions, beforeRevisions);
  assert.deepEqual(afterSnapshots, beforeSnapshots);
});

test('the response carries the outcome and none of the content', async () => {
  const store = createInMemoryGovernanceStore();
  const response = await handlerFor(store)(requestWith({ body: { content: content() } }), invocation);
  const serialised = JSON.stringify(response.jsonBody);

  for (const forbidden of ['tenant-local-demo', 'user-local-admin', 'group-governance-admin', 'coding-primary']) {
    assert.ok(!serialised.includes(forbidden), `${forbidden} must not travel back out of the network`);
  }
});

test('a caller without the publish capability is refused', async () => {
  const store = createInMemoryGovernanceStore();
  const response = await handlerFor(store)(
    requestWith({ roles: ['Governance.Read'], body: { content: content() } }),
    invocation,
  );
  assert.equal(response.status, 403);
  assert.equal(response.jsonBody.error.code, 'governance_access_denied');
});

test('authorization is refused before actor derivation', async () => {
  let derivations = 0;
  const response = await handlerFor(createInMemoryGovernanceStore(), {
    deriver: { deriveActorCode: () => { derivations += 1; return 'actor1-0123456789abcdef0123456789abcdef'; } },
  })(
    requestWith({ roles: ['Governance.Read'], body: { content: content() } }),
    invocation,
  );

  assert.equal(response.status, 403);
  assert.equal(derivations, 0);
});

test('an unauthenticated caller never reaches the store', async () => {
  const store = createInMemoryGovernanceStore();
  const response = await handlerFor(store)(
    { headers: { get: () => null }, async json() { return {}; } },
    invocation,
  );
  assert.equal(response.status, 401);
  assert.deepEqual(await store.queryConfigurationRevisions({ scopeGroupId: SCOPE_GROUP_ID }), []);
});

test('a caller whose validated tenant or object identifier is absent is refused before persistence', async () => {
  for (const identity of [{ tenantId: null }, { objectId: null }]) {
    const store = createInMemoryGovernanceStore();
    const response = await handlerFor(store)(
      requestWith({ body: { content: content() }, ...identity }),
      invocation,
    );

    assert.equal(response.status, 403);
    assert.equal(response.jsonBody.error.code, 'caller_not_identifiable');
    assert.deepEqual(await store.queryConfigurationRevisions({ scopeGroupId: SCOPE_GROUP_ID }), []);
  }
});

test('bootstrap preserves its import author and another administrator may explicitly approve later drafts', async () => {
  const store = createInMemoryGovernanceStore();
  const first = await handlerFor(store)(
    requestWith({ body: { content: content(), initialOnly: true, actorCode: 'somebody-else' }, objectId: 'object-admin-0001' }),
    invocation,
  );
  assert.equal(first.status, 200);

  const second = await handlerFor(store)(
    requestWith({ body: { content: content(), actorCode: 'somebody-else' }, objectId: 'object-admin-0002' }),
    invocation,
  );
  assert.equal(second.status, 201);
  assert.equal(second.jsonBody.state, 'draft');

  let revisions = await store.queryConfigurationRevisions({ scopeGroupId: SCOPE_GROUP_ID });
  const bootstrapApprover = DERIVER.deriveActorCode({ tenantId: 'tenant-admin-0001', subjectId: 'object-admin-0001' });
  const author = DERIVER.deriveActorCode({ tenantId: 'tenant-admin-0001', subjectId: 'object-admin-0002' });
  assert.equal(revisions[0].authoredBy, 'bootstrap-import');
  assert.equal(revisions[0].approvedBy, bootstrapApprover);
  assert.equal(revisions[1].authoredBy, author);
  assert.equal(revisions[1].approvedBy, null);

  const approved = await handlerFor(store)(
    requestWith({ body: { resume: true, revisionId: 'revision-0002' }, objectId: 'object-admin-0003' }),
    invocation,
  );
  assert.equal(approved.status, 200);
  revisions = await store.queryConfigurationRevisions({ scopeGroupId: SCOPE_GROUP_ID });
  const approver = DERIVER.deriveActorCode({ tenantId: 'tenant-admin-0001', subjectId: 'object-admin-0003' });
  assert.equal(revisions[1].authoredBy, author);
  assert.equal(revisions[1].approvedBy, approver);
  assert.notEqual(revisions[1].authoredBy, revisions[1].approvedBy);
  assert.ok(!JSON.stringify(revisions).includes('somebody-else'));
  assert.ok(!JSON.stringify(revisions).includes('object-admin-0002'));
});

test('a non-import first write is attributed to its administrator, not bootstrap-import', async () => {
  const store = createInMemoryGovernanceStore();
  const response = await handlerFor(store)(
    requestWith({ body: { content: content() }, objectId: 'object-admin-0004' }),
    invocation,
  );

  assert.equal(response.status, 201);
  assert.equal(response.jsonBody.state, 'draft');
  const [revision] = await store.queryConfigurationRevisions({ scopeGroupId: SCOPE_GROUP_ID });
  assert.equal(
    revision.authoredBy,
    DERIVER.deriveActorCode({ tenantId: 'tenant-admin-0001', subjectId: 'object-admin-0004' }),
  );
  assert.notEqual(revision.authoredBy, 'bootstrap-import');
  assert.equal(revision.approvedBy, null);
});

test('a resuming administrator approves and publishes an immutable proposal from another author', async () => {
  const store = createInMemoryGovernanceStore();
  await handlerFor(store)(
    requestWith({ body: { content: content(), initialOnly: true }, objectId: 'object-admin-0001' }),
    invocation,
  );
  const proposed = contentWithBudget(222_222);
  const created = await handlerFor(store)(
    requestWith({ body: { content: proposed }, objectId: 'object-admin-0002' }),
    invocation,
  );
  assert.equal(created.status, 201);
  assert.equal(created.jsonBody.state, 'draft');

  const mismatch = await handlerFor(store)(
    requestWith({ body: { content: contentWithBudget(999_999), resume: true, revisionId: 'revision-0002' }, objectId: 'object-admin-0003' }),
    invocation,
  );
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.jsonBody.error.code, 'resume_mutation_not_allowed');

  const held = await store.readConfigurationRevision({ scopeGroupId: SCOPE_GROUP_ID, revisionId: 'revision-0002' });
  assert.equal(held.document.state, 'draft', 'a mismatched resume must not approve or publish');
  const approved = await handlerFor(store)(
    requestWith({ body: { resume: true, revisionId: 'revision-0002' }, objectId: 'object-admin-0003' }),
    invocation,
  );
  assert.equal(approved.status, 200);
  assert.equal(approved.jsonBody.state, 'active');

  const published = await createPublishedPolicySource({ store, scopeGroupId: SCOPE_GROUP_ID, clock })();
  assert.equal(
    published.budgetSnapshot.budgets.find((budget) => budget.budgetId === 'budget-organization-monthly').limit.amount,
    222_222,
  );
  const revision = (await store.queryConfigurationRevisions({ scopeGroupId: SCOPE_GROUP_ID }))[1];
  assert.equal(revision.authoredBy, DERIVER.deriveActorCode({ tenantId: 'tenant-admin-0001', subjectId: 'object-admin-0002' }));
  assert.equal(revision.approvedBy, DERIVER.deriveActorCode({ tenantId: 'tenant-admin-0001', subjectId: 'object-admin-0003' }));
  assert.equal(revision.history.some((entry) => entry.reasonCode === 'self-approval-granted'), false);
});

test('only the draft author can withdraw it, and a withdrawn draft no longer blocks a new proposal', async () => {
  const store = createInMemoryGovernanceStore();
  await handlerFor(store)(
    requestWith({ body: { content: content(), initialOnly: true }, objectId: 'object-admin-0001' }),
    invocation,
  );
  const proposed = contentWithBudget(222_222);
  await handlerFor(store)(
    requestWith({ body: { content: proposed }, objectId: 'object-admin-0002' }),
    invocation,
  );

  const reader = await handlerFor(store)(
    requestWith({ roles: ['Governance.Read'], body: { command: 'withdraw', revisionId: 'revision-0002' } }),
    invocation,
  );
  assert.equal(reader.status, 403);
  let revisions = await store.queryConfigurationRevisions({ scopeGroupId: SCOPE_GROUP_ID });
  assert.equal(revisions[1].state, 'draft');
  assert.equal(revisions[1].history.length, 1, 'a reader denial must not mutate the proposal');

  const unrelated = await handlerFor(store)(
    requestWith({ body: { command: 'withdraw', revisionId: 'revision-0002' }, objectId: 'object-admin-0003' }),
    invocation,
  );
  assert.equal(unrelated.status, 409);
  assert.equal(unrelated.jsonBody.reasonCode, 'proposal-withdrawal-denied');
  revisions = await store.queryConfigurationRevisions({ scopeGroupId: SCOPE_GROUP_ID });
  assert.equal(revisions[1].state, 'draft');
  assert.equal(revisions[1].history.length, 1, 'an unrelated administrator cannot erase a proposal');

  const withdrawn = await handlerFor(store)(
    requestWith({ body: { command: 'withdraw', revisionId: 'revision-0002' }, objectId: 'object-admin-0002' }),
    invocation,
  );
  assert.equal(withdrawn.status, 200);
  assert.equal(withdrawn.jsonBody.state, 'withdrawn');

  const second = await handlerFor(store)(
    requestWith({ body: { content: contentWithBudget(333_333) }, objectId: 'object-admin-0002' }),
    invocation,
  );
  assert.equal(second.status, 201);
  assert.equal(second.jsonBody.state, 'draft');
  revisions = await store.queryConfigurationRevisions({ scopeGroupId: SCOPE_GROUP_ID });
  assert.equal(revisions[1].state, 'withdrawn');
  assert.equal(revisions[1].history.at(-1).actor, revisions[1].authoredBy);
  assert.ok(revisions[1].targets.every((target) => target.outcome === 'pending'));
  assert.equal(revisions[2].revisionId, 'revision-0003');
  const published = await createPublishedPolicySource({ store, scopeGroupId: SCOPE_GROUP_ID, clock })();
  assert.notEqual(
    published.budgetSnapshot.budgets.find((budget) => budget.budgetId === 'budget-organization-monthly').limit.amount,
    222_222,
    'withdrawing never makes the abandoned proposal resolvable',
  );
});

test('a request with no content is refused before a revision is created', async () => {
  const store = createInMemoryGovernanceStore();
  const response = await handlerFor(store)(requestWith({ body: {} }), invocation);
  assert.equal(response.status, 400);
  assert.equal(response.jsonBody.error.code, 'publication_content_required');
  assert.deepEqual(await store.queryConfigurationRevisions({ scopeGroupId: SCOPE_GROUP_ID }), []);
});

test('a partial set is refused rather than being retained as an unfinished revision', async () => {
  const store = createInMemoryGovernanceStore();
  const partial = content();
  delete partial.snapshots.budgetSnapshot;

  const response = await handlerFor(store)(requestWith({ body: { content: partial, initialOnly: true } }), invocation);
  assert.equal(response.status, 400);
  assert.equal(response.jsonBody.error.code, 'publication_content_incomplete');
  assert.deepEqual(await store.queryConfigurationRevisions({ scopeGroupId: SCOPE_GROUP_ID }), []);

  await assert.rejects(
    () => createPublishedPolicySource({ store, scopeGroupId: SCOPE_GROUP_ID, clock })(),
    (error) => error.name === 'PolicySourceUnavailableError',
    'an unfinished publish must not leave a partially governing set resolvable',
  );
});

test('a rejected incomplete proposal leaves no in-flight revision', async () => {
  const store = createInMemoryGovernanceStore();
  const partial = content();
  delete partial.snapshots.budgetSnapshot;
  const refused = await handlerFor(store)(requestWith({ body: { content: partial, initialOnly: true } }), invocation);
  assert.equal(refused.status, 400);

  const second = await handlerFor(store)(requestWith({ body: { content: content() } }), invocation);
  assert.equal(second.status, 201);
  assert.equal(second.jsonBody.state, 'draft');
});

test('a resume request refuses replacement content even when no invalid draft was stored', async () => {
  const store = createInMemoryGovernanceStore();
  const partial = content();
  delete partial.snapshots.budgetSnapshot;
  const first = await handlerFor(store)(requestWith({ body: { content: partial, initialOnly: true } }), invocation);
  assert.equal(first.status, 400);

  const resumed = await handlerFor(store)(
    requestWith({ body: { content: content(), initialOnly: true, resume: true, revisionId: 'revision-0001' } }),
    invocation,
  );

  assert.equal(resumed.status, 400);
  assert.equal(resumed.jsonBody.error.code, 'resume_mutation_not_allowed');

  const revisions = await store.queryConfigurationRevisions({ scopeGroupId: SCOPE_GROUP_ID });
  assert.equal(revisions.length, 0, 'a rejected input must not leave a revision behind');
});

test('resuming when no held revision exists is refused rather than creating one', async () => {
  const store = createInMemoryGovernanceStore();
  const response = await handlerFor(store)(
    requestWith({ body: { initialOnly: true, resume: true, revisionId: 'revision-0001' } }),
    invocation,
  );
  assert.equal(response.status, 409);
  assert.equal(response.jsonBody.reasonCode, 'resume-revision-not-held');
  assert.deepEqual(await store.queryConfigurationRevisions({ scopeGroupId: SCOPE_GROUP_ID }), []);
});

test('a governance set larger than a resolution request is accepted, but not an unbounded one', async () => {
  // The default body limit is sized for policy resolution, and a real governance set
  // exceeds it by a couple of hundred bytes - the kind of limit that only shows up in
  // production. The route states its own, and it is still a limit.
  const overDefault = { content: content(), initialOnly: true, note: 'x'.repeat(16_384) };
  assert.ok(Buffer.byteLength(JSON.stringify(overDefault), 'utf8') > 8_192);
  const accepted = await handlerFor(createInMemoryGovernanceStore())(
    requestWith({ body: overDefault }),
    invocation,
  );
  assert.equal(accepted.status, 200);

  const oversized = { content: content(), note: 'x'.repeat(300_000) };
  const refused = await handlerFor(createInMemoryGovernanceStore())(
    requestWith({ body: oversized }),
    invocation,
  );
  assert.equal(refused.status, 400);
  assert.equal(refused.jsonBody.error.code, 'body_too_large');
});

test('the actor deriver is deployment-owned and required', () => {
  const store = createInMemoryGovernanceStore();
  const publisher = createGovernancePublisher({ store, scopeGroupId: SCOPE_GROUP_ID, clock });
  const base = { store, publisher, clock, scopeGroupId: SCOPE_GROUP_ID, expectedAudience: AUDIENCE };

  for (const invalid of [undefined, {}, { deriveActorCode: null }]) {
    assert.throws(() => createPublishGovernanceHandler({ ...base, deriver: invalid }), TypeError, String(invalid));
  }
});
