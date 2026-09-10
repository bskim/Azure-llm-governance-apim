import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assembleGovernanceSnapshots,
  assertGovernanceSnapshotDocument,
  governanceSnapshotDocument,
  governanceSnapshotDocumentId,
  GOVERNANCE_SNAPSHOT_KINDS,
  GOVERNANCE_SNAPSHOT_PROPERTIES,
  hydratePersistedGovernanceSnapshotDocument,
} from '../../app/governance-domain/policy/governance-snapshot-document.mjs';
import { getDeterministicGovernanceSnapshots } from '../../app/local-adapters/deterministic-governance-snapshots.mjs';

const EVALUATION_TIME = '2026-07-24T10:00:00.000Z';
const SCOPE_GROUP_ID = 'platform-engineering';

function documentFor(kind, scopeGroupId = SCOPE_GROUP_ID) {
  const snapshots = getDeterministicGovernanceSnapshots();
  return governanceSnapshotDocument({
    scopeGroupId,
    kind,
    snapshot: snapshots[GOVERNANCE_SNAPSHOT_PROPERTIES[kind]],
  });
}

const allDocuments = () => GOVERNANCE_SNAPSHOT_KINDS.map((kind) => documentFor(kind));

test('there are five kinds, each with a property the application already passes around', () => {
  assert.equal(GOVERNANCE_SNAPSHOT_KINDS.length, 5);
  const resolved = getDeterministicGovernanceSnapshots();
  for (const kind of GOVERNANCE_SNAPSHOT_KINDS) {
    const property = GOVERNANCE_SNAPSHOT_PROPERTIES[kind];
    assert.ok(property, kind);
    assert.ok(resolved[property], `${kind} must name a snapshot the application produces`);
  }
});

test('the identifier is derived, so two kinds can never share a document', () => {
  const identifiers = GOVERNANCE_SNAPSHOT_KINDS.map((kind) =>
    governanceSnapshotDocumentId({ scopeGroupId: SCOPE_GROUP_ID, kind }),
  );
  assert.equal(new Set(identifiers).size, identifiers.length);
  assert.throws(() => governanceSnapshotDocumentId({ scopeGroupId: SCOPE_GROUP_ID, kind: 'pricing' }), TypeError);
  assert.throws(() => governanceSnapshotDocumentId({ scopeGroupId: '', kind: 'budget' }), TypeError);
});

test('every kind validates through its own validator', () => {
  for (const kind of GOVERNANCE_SNAPSHOT_KINDS) {
    const document = documentFor(kind);
    assert.equal(
      assertGovernanceSnapshotDocument(document, { evaluationTime: EVALUATION_TIME }),
      document,
      kind,
    );
  }
});

test('a governance snapshot document remains strict about an authored accounting basis', () => {
  const legacy = structuredClone(documentFor('budget'));
  delete legacy.snapshot.budgets[0].accountingBasis;

  assert.throws(
    () => assertGovernanceSnapshotDocument(legacy, { evaluationTime: EVALUATION_TIME }),
    /accountingBasis/,
  );
});

test('a persisted legacy token budget is upgraded only at the persistence-read boundary', () => {
  const legacy = structuredClone(documentFor('budget'));
  delete legacy.snapshot.budgets[0].accountingBasis;

  const hydrated = hydratePersistedGovernanceSnapshotDocument(legacy, { evaluationTime: EVALUATION_TIME });

  assert.equal(hydrated.snapshot.budgets[0].accountingBasis, 'apim-estimated-total-tokens');
  assert.equal(Object.hasOwn(legacy.snapshot.budgets[0], 'accountingBasis'), false);
});

test('a snapshot body that belongs to another kind is refused', () => {
  const budget = documentFor('budget');
  const registry = documentFor('modelRegistry');
  assert.throws(
    () =>
      assertGovernanceSnapshotDocument(
        { ...budget, snapshot: registry.snapshot },
        { evaluationTime: EVALUATION_TIME },
      ),
    (error) => error instanceof TypeError,
  );
});

test('the envelope admits exactly its own fields', () => {
  const document = documentFor('budget');
  for (const key of ['id', 'documentType', 'scopeGroupId', 'kind', 'snapshot']) {
    const missing = { ...document };
    delete missing[key];
    assert.throws(
      () => assertGovernanceSnapshotDocument(missing, { evaluationTime: EVALUATION_TIME }),
      (error) => error instanceof TypeError && error.message.includes(key),
      `omitting ${key} must be refused`,
    );
  }
  assert.throws(
    () =>
      assertGovernanceSnapshotDocument(
        { ...document, publishedBy: 'someone' },
        { evaluationTime: EVALUATION_TIME },
      ),
    (error) => error instanceof TypeError && error.message.includes('publishedBy'),
  );
});

test('a document whose identifier disagrees with its own fields is refused', () => {
  const document = documentFor('budget');
  assert.throws(
    () =>
      assertGovernanceSnapshotDocument({ ...document, kind: 'assignment' }, { evaluationTime: EVALUATION_TIME }),
    (error) => error instanceof TypeError,
  );
  assert.throws(
    () =>
      assertGovernanceSnapshotDocument(
        { ...document, scopeGroupId: 'another-team' },
        { evaluationTime: EVALUATION_TIME },
      ),
    (error) => error instanceof TypeError,
  );
});

test('validation needs a clock, and says so rather than skipping', () => {
  const document = documentFor('budget');
  for (const evaluationTime of [undefined, null, '', 'soon', 20260724]) {
    assert.throws(
      () => assertGovernanceSnapshotDocument(document, { evaluationTime }),
      (error) => error instanceof TypeError,
      `evaluationTime ${String(evaluationTime)} must be refused`,
    );
  }
  assert.throws(() => assertGovernanceSnapshotDocument(document), TypeError);
});

test('a complete set assembles into what the resolver already consumes', () => {
  const assembled = assembleGovernanceSnapshots(allDocuments());
  const resolved = getDeterministicGovernanceSnapshots();
  for (const kind of GOVERNANCE_SNAPSHOT_KINDS) {
    const property = GOVERNANCE_SNAPSHOT_PROPERTIES[kind];
    assert.deepEqual(assembled[property], resolved[property], property);
  }
  assert.deepEqual(Object.keys(assembled).sort(), Object.values(GOVERNANCE_SNAPSHOT_PROPERTIES).sort());
});

test('an incomplete set is unavailable, and names what is missing', () => {
  // A request governed by some of the rules and not others is indistinguishable from
  // one governed by all of them, which is worse than a request governed conservatively.
  for (const absentKind of GOVERNANCE_SNAPSHOT_KINDS) {
    const partial = allDocuments().filter((document) => document.kind !== absentKind);
    assert.throws(
      () => assembleGovernanceSnapshots(partial),
      (error) =>
        error.code === 'published-policy-source-incomplete' &&
        error.absentKinds.includes(absentKind) &&
        error.absentKinds.length === 1,
      `a set without ${absentKind} must be refused`,
    );
  }
  assert.throws(
    () => assembleGovernanceSnapshots([]),
    (error) => error.absentKinds.length === GOVERNANCE_SNAPSHOT_KINDS.length,
  );
});

test('two documents claiming one kind are refused rather than one silently winning', () => {
  const duplicated = [...allDocuments(), documentFor('budget')];
  assert.throws(
    () => assembleGovernanceSnapshots(duplicated),
    (error) => error instanceof TypeError && error.message.includes('budget'),
  );
});
