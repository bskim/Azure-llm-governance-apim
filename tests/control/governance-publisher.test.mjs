import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createGovernancePublisher,
  governancePublicationTargets,
  MEMBERSHIP_TARGET_CODE,
  PUBLISH_REASONS,
  snapshotTargetCode,
} from '../../app/control-api/governance-publisher.mjs';
import { createPublishedPolicySource } from '../../app/control-api/published-policy-source.mjs';
import {
  applyLifecycleCommand,
  createRevision,
} from '../../app/governance-domain/lifecycle/configuration-lifecycle.mjs';
import {
  GOVERNANCE_SNAPSHOT_KINDS,
  GOVERNANCE_SNAPSHOT_PROPERTIES,
} from '../../app/governance-domain/policy/governance-snapshot-document.mjs';
import { createInMemoryGovernanceStore } from '../../app/persistence/in-memory-governance-store.mjs';
import { getDeterministicGovernanceSnapshots } from '../../app/local-adapters/deterministic-governance-snapshots.mjs';

const NOW = '2026-07-24T10:00:00.000Z';
const SCOPE_GROUP_ID = 'platform-engineering';
const TENANT_ID = 'tenant-local-demo';
const clock = { nowIso: () => NOW };

function membership(subjectId, groups = [{ groupId: 'group-governance-admin', membership: 'direct', authorizationRelevant: true }]) {
  return {
    snapshotId: 'membership-0001',
    status: groups.length === 0 ? 'empty-complete' : 'complete',
    source: 'control-plane',
    tenantId: TENANT_ID,
    subjectId,
    resolvedAt: '2026-07-24T09:58:00.000Z',
    expiresAt: '2026-07-24T10:03:00.000Z',
    maxAgeSeconds: 300,
    sourceRevision: 'directory-0001',
    groups,
  };
}

function content(overrides = {}) {
  return {
    snapshots: getDeterministicGovernanceSnapshots(),
    memberships: [membership('user-local-admin')],
    ...overrides,
  };
}

function revisionFor(targets = governancePublicationTargets()) {
  // A target outcome is only meaningful while a publish is in flight, so the revision
  // is driven through the same reducer an operator would.
  const draft = createRevision({
    revisionId: 'revision-0001',
    scopeGroupId: SCOPE_GROUP_ID,
    revisionNumber: 1,
    authoredBy: 'author-1',
    authoredAt: '2026-07-24T09:00:00.000Z',
    targets,
  });

  const step = (revision, command, extra = {}) => {
    const applied = applyLifecycleCommand({
      revision,
      command,
      actor: 'approver-1',
      at: NOW,
      expectedRevisionNumber: revision.revisionNumber,
      publishingRevisionId: null,
      ...extra,
    });
    assert.equal(applied.ok, true, `${command}: ${applied.code}`);
    return applied.revision;
  };

  return step(step(draft, 'approve'), 'publish');
}

const publisherFor = (store) => createGovernancePublisher({ store, scopeGroupId: SCOPE_GROUP_ID, clock });

test('a full publish verifies every target and makes governance resolvable', async () => {
  const store = createInMemoryGovernanceStore();
  const result = await publisherFor(store).publish({
    revision: revisionFor(),
    content: content(),
    actor: 'publisher-1',
  });

  assert.deepEqual(
    result.revision.targets.map((target) => target.outcome),
    result.revision.targets.map(() => 'verified'),
  );

  const source = createPublishedPolicySource({ store, scopeGroupId: SCOPE_GROUP_ID, clock });
  const published = await source();
  for (const property of Object.values(GOVERNANCE_SNAPSHOT_PROPERTIES)) {
    assert.ok(published[property], property);
  }
});

test('the targets a complete set needs are exactly one per kind plus membership', () => {
  const targets = governancePublicationTargets();
  assert.equal(targets.length, GOVERNANCE_SNAPSHOT_KINDS.length + 1);
  for (const kind of GOVERNANCE_SNAPSHOT_KINDS) assert.ok(targets.includes(snapshotTargetCode(kind)), kind);
  assert.ok(targets.includes(MEMBERSHIP_TARGET_CODE));
  assert.deepEqual(governancePublicationTargets({ includeMembership: false }).length, GOVERNANCE_SNAPSHOT_KINDS.length);
});

test('a target whose content is absent fails and names why', async () => {
  const store = createInMemoryGovernanceStore();
  const partial = content();
  delete partial.snapshots.budgetSnapshot;

  const result = await publisherFor(store).publish({
    revision: revisionFor(),
    content: partial,
    actor: 'publisher-1',
  });

  const budget = result.revision.targets.find((target) => target.targetCode === snapshotTargetCode('budget'));
  assert.equal(budget.outcome, 'failed');
  assert.equal(budget.reasonCode, PUBLISH_REASONS.contentAbsent);
  assert.ok(
    result.revision.targets.some((target) => target.outcome === 'verified'),
    'the other targets still publish, so an operator can see what is missing',
  );
});

test('a write that succeeds but reads back as something else fails the target', async () => {
  // The store is the last thing that touched the document, so a successful write says
  // nothing about what the next reader will find.
  const store = createInMemoryGovernanceStore();
  const tampering = {
    ...store,
    async readGovernanceSnapshot(selection) {
      const held = await store.readGovernanceSnapshot(selection);
      if (held === null || selection.kind !== 'budget') return held;
      return { ...held, document: { ...held.document, scopeGroupId: 'somebody-else' } };
    },
  };

  const result = await publisherFor(tampering).publish({
    revision: revisionFor(),
    content: content(),
    actor: 'publisher-1',
  });

  const budget = result.revision.targets.find((target) => target.targetCode === snapshotTargetCode('budget'));
  assert.equal(budget.outcome, 'failed');
  assert.equal(budget.reasonCode, PUBLISH_REASONS.readBackDiffers);
});

test('a write that never lands fails rather than reporting verified', async () => {
  const store = createInMemoryGovernanceStore();
  const swallowing = {
    ...store,
    async putGovernanceSnapshot() {
      return { document: null, etag: '"pretend"' };
    },
  };

  const result = await publisherFor(swallowing).publish({
    revision: revisionFor([snapshotTargetCode('budget')]),
    content: content(),
    actor: 'publisher-1',
  });
  assert.equal(result.revision.targets[0].outcome, 'failed');
  assert.equal(result.revision.targets[0].reasonCode, PUBLISH_REASONS.readBackAbsent);
});

test('a refused write is a failed target, not an exception the caller has to catch', async () => {
  const store = createInMemoryGovernanceStore();
  const refusing = {
    ...store,
    async putPrincipalMembership() {
      throw new Error('ConcurrencyConflict');
    },
  };

  const result = await publisherFor(refusing).publish({
    revision: revisionFor([MEMBERSHIP_TARGET_CODE]),
    content: content(),
    actor: 'publisher-1',
  });
  assert.equal(result.revision.targets[0].outcome, 'failed');
  assert.equal(result.revision.targets[0].reasonCode, PUBLISH_REASONS.writeRefused);
});

test('publishing again leaves verified targets alone and retries the rest', async () => {
  // A failed target is terminal within its attempt, so getting back to it goes through
  // the operator's retry, which resets exactly the targets that did not verify.
  const store = createInMemoryGovernanceStore();
  const publisher = publisherFor(store);
  const partial = content();
  delete partial.snapshots.budgetSnapshot;

  const first = await publisher.publish({ revision: revisionFor(), content: partial, actor: 'publisher-1' });
  assert.ok(first.revision.targets.some((target) => target.outcome === 'failed'));

  const failed = applyLifecycleCommand({
    revision: first.revision,
    command: 'fail',
    actor: 'approver-1',
    at: NOW,
    expectedRevisionNumber: first.revision.revisionNumber,
    publishingRevisionId: null,
    reasonCode: 'publish-content-absent',
  });
  assert.equal(failed.ok, true, failed.code);

  const retried = applyLifecycleCommand({
    revision: failed.revision,
    command: 'retry',
    actor: 'approver-1',
    at: NOW,
    expectedRevisionNumber: failed.revision.revisionNumber,
    publishingRevisionId: null,
  });
  assert.equal(retried.ok, true, retried.code);

  const second = await publisher.publish({ revision: retried.revision, content: content(), actor: 'publisher-1' });

  assert.deepEqual(
    second.attempted.map((entry) => entry.targetCode),
    [snapshotTargetCode('budget')],
    'only the target that had not verified is attempted again',
  );
  assert.ok(second.revision.targets.every((target) => target.outcome === 'verified'));
});

test('one principal failing fails the whole membership target', async () => {
  const store = createInMemoryGovernanceStore();
  const result = await publisherFor(store).publish({
    revision: revisionFor([MEMBERSHIP_TARGET_CODE]),
    content: content({
      memberships: [membership('user-one'), { ...membership('user-two'), status: 'complete', groups: [] }],
    }),
    actor: 'publisher-1',
  });

  assert.equal(result.revision.targets[0].outcome, 'failed');
  assert.equal(
    result.revision.targets[0].reasonCode,
    PUBLISH_REASONS.contentInvalid,
    'content the store would refuse must fail the target, not escape the publish',
  );
});

test('an undeclared target code fails rather than being silently skipped', async () => {
  const store = createInMemoryGovernanceStore();
  const result = await publisherFor(store).publish({
    revision: revisionFor(['gateway-named-values']),
    content: content(),
    actor: 'publisher-1',
  });
  assert.equal(result.revision.targets[0].outcome, 'failed');
  assert.equal(result.revision.targets[0].reasonCode, PUBLISH_REASONS.targetUnknown);
});

test('a stored set that has gone stale can still be replaced', async () => {
  // Validation on read is what keeps an altered document from reaching a caller. Applied
  // to the read that fetches a concurrency token, it deadlocks: the document that most
  // needs replacing is the one that can no longer be read. Found against a live store.
  const store = createInMemoryGovernanceStore();
  let offsetMs = 0;
  const movingClock = { nowIso: () => new Date(Date.parse(NOW) + offsetMs).toISOString() };
  const publisher = createGovernancePublisher({ store, scopeGroupId: SCOPE_GROUP_ID, clock: movingClock });

  const first = await publisher.publish({ revision: revisionFor(), content: content(), actor: 'publisher-1' });
  assert.ok(first.revision.targets.every((target) => target.outcome === 'verified'));

  // Past the window the published snapshots declared.
  offsetMs = 45 * 60 * 1000;
  await assert.rejects(
    () =>
      store.readGovernanceSnapshot({
        scopeGroupId: SCOPE_GROUP_ID,
        kind: 'budget',
        evaluationTime: movingClock.nowIso(),
      }),
    (error) => error instanceof RangeError,
    'the stored snapshot must genuinely be unservable, or this proves nothing',
  );

  const at = new Date(Date.parse(movingClock.nowIso()));
  const freshSnapshots = Object.fromEntries(
    Object.entries(getDeterministicGovernanceSnapshots()).map(([property, snapshot]) => [
      property,
      {
        ...structuredClone(snapshot),
        capturedAt: new Date(at.getTime() - 60_000).toISOString(),
        expiresAt: new Date(at.getTime() + 1_800_000).toISOString(),
      },
    ]),
  );
  const replacement = {
    snapshots: freshSnapshots,
    memberships: content().memberships.map((evidence) => ({
      ...evidence,
      resolvedAt: new Date(at.getTime() - 60_000).toISOString(),
      expiresAt: new Date(at.getTime() + 240_000).toISOString(),
    })),
  };
  const second = await publisher.publish({
    revision: revisionFor(),
    content: replacement,
    actor: 'publisher-1',
  });
  assert.ok(
    second.revision.targets.every((target) => target.outcome === 'verified'),
    `replacing a stale set must succeed: ${JSON.stringify(second.attempted)}`,
  );
});

test('the publisher refuses to be built without what it writes through', () => {
  const store = createInMemoryGovernanceStore();
  assert.throws(() => createGovernancePublisher({ scopeGroupId: SCOPE_GROUP_ID, clock }), TypeError);
  assert.throws(() => createGovernancePublisher({ store, clock }), TypeError);
  assert.throws(() => createGovernancePublisher({ store, scopeGroupId: SCOPE_GROUP_ID }), TypeError);
  assert.throws(() => createGovernancePublisher({ store: {}, scopeGroupId: SCOPE_GROUP_ID, clock }), TypeError);
});

test('an actor is required, because a publish is an act somebody performed', async () => {
  const store = createInMemoryGovernanceStore();
  await assert.rejects(
    () => publisherFor(store).publish({ revision: revisionFor(), content: content() }),
    TypeError,
  );
});
