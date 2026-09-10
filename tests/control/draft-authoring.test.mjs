import assert from 'node:assert/strict';
import test from 'node:test';

import { createDraftAuthor, DraftUnavailableError } from '../../app/control-api/draft-authoring.mjs';
import { createInMemoryGovernanceStore } from '../../app/persistence/in-memory-governance-store.mjs';
import { getDeterministicGovernanceSnapshots } from '../../app/local-adapters/deterministic-governance-snapshots.mjs';
import { governancePublicationTargets } from '../../app/control-api/governance-publisher.mjs';
import { DRAFT_REASONS } from '../../app/governance-domain/lifecycle/configuration-draft-document.mjs';

const SCOPE_GROUP_ID = 'platform-engineering';
const NOW = '2026-07-24T10:00:00.000Z';
const AUTHOR = 'governance-owner';

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

const content = (overrides = {}) => ({
  snapshots: getDeterministicGovernanceSnapshots(),
  memberships: [membership()],
  ...overrides,
});

function author(store) {
  return createDraftAuthor({
    store,
    scopeGroupId: SCOPE_GROUP_ID,
    clock: { nowIso: () => NOW },
    targets: governancePublicationTargets(),
  });
}

test('a proposal becomes a draft revision and the content a publish will apply', async () => {
  const store = createInMemoryGovernanceStore();
  const proposed = await author(store).propose({ content: content(), authoredBy: AUTHOR });

  assert.equal(proposed.revision.revisionId, 'revision-0001');
  assert.equal(proposed.revision.state, 'draft');
  assert.equal(proposed.revision.authoredBy, AUTHOR);
  assert.deepEqual(
    proposed.revision.targets.map((target) => target.outcome),
    governancePublicationTargets().map(() => 'pending'),
  );

  const held = await author(store).proposedContent({ revisionId: 'revision-0001' });
  assert.deepEqual(Object.keys(held).sort(), ['memberships', 'snapshots']);
  assert.equal(held.snapshots.budgetSnapshot.snapshotId, content().snapshots.budgetSnapshot.snapshotId);
});

test('proposals take the next number rather than colliding with what is stored', async () => {
  const store = createInMemoryGovernanceStore();
  const first = await author(store).propose({ content: content(), authoredBy: AUTHOR });
  const second = await author(store).propose({ content: content(), authoredBy: AUTHOR });

  assert.equal(first.revision.revisionNumber, 1);
  assert.equal(second.revision.revisionNumber, 2);
  assert.equal(second.revision.revisionId, 'revision-0002');
  assert.notEqual(
    await author(store).proposedContent({ revisionId: 'revision-0002' }),
    null,
  );
});

test('an incomplete proposal never becomes a revision', async () => {
  const store = createInMemoryGovernanceStore();
  const partial = content();
  delete partial.snapshots.budgetSnapshot;

  await assert.rejects(
    () => author(store).propose({ content: partial, authoredBy: AUTHOR }),
    (error) => error instanceof DraftUnavailableError && error.code === DRAFT_REASONS.contentIncomplete,
  );

  // A revision created before the content was judged would sit in the lifecycle as a
  // draft nobody could publish.
  assert.deepEqual(await store.queryConfigurationRevisions({ scopeGroupId: SCOPE_GROUP_ID }), []);
});

test('a revision whose proposal is missing refuses by name instead of publishing nothing', async () => {
  const store = createInMemoryGovernanceStore();
  await assert.rejects(
    () => author(store).proposedContent({ revisionId: 'revision-0009' }),
    (error) => error instanceof DraftUnavailableError && error.code === DRAFT_REASONS.contentAbsent,
  );
});

test('a store that cannot answer is not reported as an absent proposal', async () => {
  // Absent means the operator never proposed anything; unreadable means the product
  // does not know. Publishing an empty set on either would be the same mistake twice.
  const store = createInMemoryGovernanceStore();
  const broken = {
    ...store,
    readConfigurationDraft: async () => {
      throw new Error('the store is unreachable');
    },
  };
  await assert.rejects(
    () => author(broken).proposedContent({ revisionId: 'revision-0001' }),
    (error) => error.code === DRAFT_REASONS.contentUnreadable,
  );
});

test('two proposals against the same number do not both become revisions', async () => {
  const store = createInMemoryGovernanceStore();
  await author(store).propose({ content: content(), authoredBy: AUTHOR });

  // Both authors read the same set of revisions, so both compute revision-0002.
  const racing = createDraftAuthor({
    store: {
      ...store,
      queryConfigurationRevisions: async () => [{ revisionNumber: 1 }],
    },
    scopeGroupId: SCOPE_GROUP_ID,
    clock: { nowIso: () => NOW },
    targets: governancePublicationTargets(),
  });
  await racing.propose({ content: content(), authoredBy: AUTHOR });

  await assert.rejects(
    () => racing.propose({ content: content(), authoredBy: 'other-owner' }),
    (error) => error.name === 'ConcurrencyConflictError',
    'the second author must lose rather than overwrite the first proposal',
  );
});
