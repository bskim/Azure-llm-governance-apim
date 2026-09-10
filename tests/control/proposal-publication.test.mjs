import assert from 'node:assert/strict';
import test from 'node:test';

import { createDraftAuthor } from '../../app/control-api/draft-authoring.mjs';
import { createGovernancePublisher, governancePublicationTargets } from '../../app/control-api/governance-publisher.mjs';
import { createProposalPublisher } from '../../app/control-api/proposal-publication.mjs';
import { createInMemoryGovernanceStore } from '../../app/persistence/in-memory-governance-store.mjs';
import { getDeterministicGovernanceSnapshots } from '../../app/local-adapters/deterministic-governance-snapshots.mjs';
import { applyLifecycleCommand } from '../../app/governance-domain/lifecycle/configuration-lifecycle.mjs';

const SCOPE_GROUP_ID = 'platform-engineering';
const NOW = '2026-07-24T10:00:00.000Z';
const OWNER = 'governance-owner';
const clock = { nowIso: () => NOW };

function membership(subjectId = 'user-local-admin') {
  return {
    snapshotId: 'membership-0001',
    status: 'complete',
    source: 'control-plane',
    tenantId: 'tenant-local-demo',
    subjectId,
    resolvedAt: '2026-07-24T09:58:00.000Z',
    expiresAt: '2026-07-24T10:03:00.000Z',
    maxAgeSeconds: 300,
    sourceRevision: 'directory-0001',
    groups: [{ groupId: 'group-governance-admin', membership: 'direct', authorizationRelevant: true }],
  };
}

const content = () => ({ snapshots: getDeterministicGovernanceSnapshots(), memberships: [membership()] });

function harness(store = createInMemoryGovernanceStore()) {
  const drafts = createDraftAuthor({
    store,
    scopeGroupId: SCOPE_GROUP_ID,
    clock,
    targets: governancePublicationTargets(),
  });
  const proposals = createProposalPublisher({
    store,
    publisher: createGovernancePublisher({ store, scopeGroupId: SCOPE_GROUP_ID, clock }),
    drafts,
    scopeGroupId: SCOPE_GROUP_ID,
    clock,
  });
  return { store, drafts, proposals };
}

async function approved(harnessed, actor = OWNER) {
  const { revision } = await harnessed.drafts.propose({ content: content(), authoredBy: actor });
  const stored = await harnessed.store.readConfigurationRevision({
    scopeGroupId: SCOPE_GROUP_ID,
    revisionId: revision.revisionId,
  });
  const applied = applyLifecycleCommand({
    revision: stored.document,
    command: 'approve',
    actor,
    at: NOW,
    expectedRevisionNumber: stored.document.revisionNumber,
    publishingRevisionId: undefined,
    selfApprovalGranted: true,
  });
  assert.equal(applied.ok, true);
  await harnessed.store.putConfigurationRevision(applied.revision, { ifMatch: stored.etag });
  return revision.revisionId;
}

test('an approved proposal publishes the content that was approved', async () => {
  const harnessed = harness();
  const revisionId = await approved(harnessed);

  const result = await harnessed.proposals.publish({ revisionId, actor: OWNER, inFlightRevisionId: null });
  assert.equal(result.outcome, 'published');
  assert.equal(result.state, 'active');
  assert.ok(result.targets.every((target) => target.outcome === 'verified'));

  // The set is now readable as published policy, not merely recorded as published.
  const snapshots = await harnessed.store.queryGovernanceSnapshots({
    scopeGroupId: SCOPE_GROUP_ID,
    evaluationTime: NOW,
  });
  assert.deepEqual(
    snapshots.map((document) => document.kind).sort(),
    ['assignment', 'budget', 'entitlement', 'fallbackPolicy', 'modelRegistry'],
  );
});

test('content supplied by the caller is ignored in favour of what was approved', async () => {
  const harnessed = harness();
  const revisionId = await approved(harnessed);

  // Had the publisher taken content from its argument, an empty set would have failed
  // every target rather than publishing the approved one.
  const result = await harnessed.proposals.publish({
    revisionId,
    actor: OWNER,
    inFlightRevisionId: null,
    content: { snapshots: {}, memberships: [] },
  });
  assert.equal(result.outcome, 'published');

  const stored = await harnessed.store.readGovernanceSnapshot({
    scopeGroupId: SCOPE_GROUP_ID,
    kind: 'budget',
    evaluationTime: NOW,
  });
  assert.deepEqual(stored.document.snapshot, content().snapshots.budgetSnapshot);
});

test('a revision whose proposal is gone is refused before its state moves', async () => {
  const store = createInMemoryGovernanceStore();
  const harnessed = harness(store);
  const revisionId = await approved(harnessed);

  const withoutDraft = createProposalPublisher({
    store,
    publisher: createGovernancePublisher({ store, scopeGroupId: SCOPE_GROUP_ID, clock }),
    drafts: {
      proposedContent: async () => {
        throw Object.assign(new Error('absent'), { code: 'draft-content-absent' });
      },
    },
    scopeGroupId: SCOPE_GROUP_ID,
    clock,
  });

  const refused = await withoutDraft.publish({ revisionId, actor: OWNER, inFlightRevisionId: null });
  assert.equal(refused.outcome, 'refused');
  assert.equal(refused.reasonCode, 'draft-content-absent');

  const held = await store.readConfigurationRevision({ scopeGroupId: SCOPE_GROUP_ID, revisionId });
  assert.equal(held.document.state, 'approved', 'a refusal must not leave a revision stuck publishing');
});

test('a caller that never looked for another publisher is refused outright', async () => {
  const harnessed = harness();
  const revisionId = await approved(harnessed);
  await assert.rejects(
    () => harnessed.proposals.publish({ revisionId, actor: OWNER }),
    /inFlightRevisionId is required/,
  );
});

test('a second publisher is refused rather than interleaved with the first', async () => {
  const harnessed = harness();
  const revisionId = await approved(harnessed);

  const refused = await harnessed.proposals.publish({
    revisionId,
    actor: OWNER,
    inFlightRevisionId: 'revision-0099',
  });
  assert.equal(refused.outcome, 'refused');
  assert.equal(refused.reasonCode, 'publish-in-progress');
});

test('a revision nobody proposed is refused rather than treated as empty', async () => {
  const harnessed = harness();
  const refused = await harnessed.proposals.publish({
    revisionId: 'revision-0404',
    actor: OWNER,
    inFlightRevisionId: null,
  });
  assert.equal(refused.outcome, 'refused');
  assert.equal(refused.reasonCode, 'revision-absent');
});
