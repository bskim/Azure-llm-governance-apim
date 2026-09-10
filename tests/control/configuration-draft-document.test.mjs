import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertConfigurationDraftDocument,
  assertPublishableContent,
  configurationDraftDocument,
  configurationDraftDocumentId,
  DRAFT_REASONS,
} from '../../app/governance-domain/lifecycle/configuration-draft-document.mjs';
import { getDeterministicGovernanceSnapshots } from '../../app/local-adapters/deterministic-governance-snapshots.mjs';

const SCOPE_GROUP_ID = 'platform-engineering';
const REVISION_ID = 'revision-0007';
const AUTHORED_AT = '2026-07-24T10:00:00.000Z';

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

function content(overrides = {}) {
  return {
    snapshots: getDeterministicGovernanceSnapshots(),
    memberships: [membership()],
    ...overrides,
  };
}

function draft(overrides = {}) {
  return configurationDraftDocument({
    scopeGroupId: SCOPE_GROUP_ID,
    revisionId: REVISION_ID,
    content: content(),
    authoredBy: 'governance-administrator',
    authoredAt: AUTHORED_AT,
    ...overrides,
  });
}

test('a draft is keyed by the revision it proposes for', () => {
  assert.equal(
    configurationDraftDocumentId({ scopeGroupId: SCOPE_GROUP_ID, revisionId: REVISION_ID }),
    `configuration-draft|${SCOPE_GROUP_ID}|${REVISION_ID}`,
  );
  assert.equal(assertConfigurationDraftDocument(draft()), true);
});

test('a draft whose id does not follow from its own fields is refused', () => {
  const tampered = { ...draft(), id: `configuration-draft|${SCOPE_GROUP_ID}|revision-0001` };
  assert.throws(() => assertConfigurationDraftDocument(tampered), /id must be derived/);
});

test('an author shaped like a directory object identifier never reaches a draft', () => {
  assert.throws(
    () => assertConfigurationDraftDocument(draft({ authoredBy: '11111111-1111-4111-8111-111111111111' })),
    /must not be a directory object identifier/,
  );
});

test('a draft missing one snapshot names which one, so it cannot publish a partial set', () => {
  const partial = content();
  delete partial.snapshots.budgetSnapshot;
  try {
    assertPublishableContent(partial);
    assert.fail('an incomplete set was accepted');
  } catch (error) {
    assert.equal(error.code, DRAFT_REASONS.contentIncomplete);
    assert.deepEqual([...error.absentProperties], ['budgetSnapshot']);
  }
});

test('a snapshot present but null is as absent as a missing one', () => {
  const nulled = content();
  nulled.snapshots.fallbackPolicySnapshot = null;
  try {
    assertPublishableContent(nulled);
    assert.fail('a null snapshot was accepted');
  } catch (error) {
    assert.equal(error.code, DRAFT_REASONS.contentIncomplete);
    assert.deepEqual([...error.absentProperties], ['fallbackPolicySnapshot']);
  }
});

test('a proposal that changes only policy need not republish membership evidence', () => {
  // Membership is directory-derived. Carrying a copy of it through a budget edit would
  // republish evidence that was already stale when the edit began.
  const policyOnly = content();
  delete policyOnly.memberships;
  assert.equal(assertPublishableContent(policyOnly), true);
});

test('memberships, when a proposal does carry them, must name a principal', () => {
  try {
    assertPublishableContent(content({ memberships: [] }));
    assert.fail('an empty membership list was accepted');
  } catch (error) {
    assert.equal(error.code, DRAFT_REASONS.contentIncomplete);
    assert.deepEqual([...error.absentProperties], ['memberships']);
  }
});

test('content carrying anything beyond the publishable set is refused', () => {
  assert.throws(() => assertPublishableContent(content({ throttleTiers: [] })), /carries unknown throttleTiers/);
  const extra = content();
  extra.snapshots.somethingElse = {};
  assert.throws(() => assertPublishableContent(extra), /carries unknown somethingElse/);
});

test('a draft carries the proposal and nothing about what happened to it', () => {
  const document = draft();
  assert.deepEqual(Object.keys(document).sort(), [
    'authoredAt',
    'authoredBy',
    'content',
    'documentType',
    'id',
    'revisionId',
    'scopeGroupId',
  ]);
  // Outcome fields belong to the revision. A draft that could also carry them would let
  // two documents disagree about what happened.
  assert.throws(
    () => assertConfigurationDraftDocument({ ...document, approvedBy: 'someone' }),
    /carries unknown approvedBy/,
  );
});
