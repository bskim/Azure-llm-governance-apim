import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPublishedPolicySource,
  PUBLISHED_POLICY_REASONS,
} from '../../app/control-api/published-policy-source.mjs';
import {
  governanceSnapshotDocument,
  GOVERNANCE_SNAPSHOT_KINDS,
  GOVERNANCE_SNAPSHOT_PROPERTIES,
} from '../../app/governance-domain/policy/governance-snapshot-document.mjs';
import { createInMemoryGovernanceStore } from '../../app/persistence/in-memory-governance-store.mjs';
import { createLocalPolicyResolver } from '../../app/functions/composition-root.mjs';
import { createSequenceIdGenerator } from '../../app/local-adapters/deterministic-time.mjs';
import { getDeterministicGovernanceSnapshots } from '../../app/local-adapters/deterministic-governance-snapshots.mjs';

const EVALUATION_TIME = '2026-07-24T10:00:00.000Z';
const SCOPE_GROUP_ID = 'platform-engineering';
const clock = { nowIso: () => EVALUATION_TIME };

async function storeWith(kinds) {
  const store = createInMemoryGovernanceStore();
  const snapshots = getDeterministicGovernanceSnapshots();
  for (const kind of kinds) {
    await store.putGovernanceSnapshot(
      governanceSnapshotDocument({
        scopeGroupId: SCOPE_GROUP_ID,
        kind,
        snapshot: snapshots[GOVERNANCE_SNAPSHOT_PROPERTIES[kind]],
      }),
      { ifMatch: null, evaluationTime: EVALUATION_TIME },
    );
  }
  return store;
}

const source = (store) => createPublishedPolicySource({ store, scopeGroupId: SCOPE_GROUP_ID, clock });

test('a complete published set resolves to what the resolver already consumes', async () => {
  const read = await source(await storeWith(GOVERNANCE_SNAPSHOT_KINDS))();
  const expected = getDeterministicGovernanceSnapshots();
  for (const property of Object.values(GOVERNANCE_SNAPSHOT_PROPERTIES)) {
    assert.deepEqual(read[property], expected[property], property);
  }
});

test('any missing kind is unavailable, never partially governing', async () => {
  for (const absent of GOVERNANCE_SNAPSHOT_KINDS) {
    const store = await storeWith(GOVERNANCE_SNAPSHOT_KINDS.filter((kind) => kind !== absent));
    await assert.rejects(
      () => source(store)(),
      (error) =>
        error.name === 'PolicySourceUnavailableError' &&
        error.message === 'published-policy-source-unavailable' &&
        error.reasonCode === PUBLISHED_POLICY_REASONS.incomplete &&
        error.absentKinds.includes(absent),
      `a set without ${absent} must be unavailable`,
    );
  }
});

test('nothing published is the ordinary starting state and reports every kind absent', async () => {
  await assert.rejects(
    () => source(createInMemoryGovernanceStore())(),
    (error) =>
      error.reasonCode === PUBLISHED_POLICY_REASONS.incomplete &&
      error.absentKinds.length === GOVERNANCE_SNAPSHOT_KINDS.length,
  );
});

test('an unreachable store and an invalid document are told apart', async () => {
  const unreachable = {
    async queryGovernanceSnapshots() {
      throw new Error('ECONNREFUSED');
    },
  };
  await assert.rejects(
    () => source(unreachable)(),
    (error) => error.reasonCode === PUBLISHED_POLICY_REASONS.unreadable,
  );

  const invalid = {
    async queryGovernanceSnapshots() {
      throw new TypeError('Snapshot document carries unknown publishedBy.');
    },
  };
  await assert.rejects(
    () => source(invalid)(),
    (error) => error.reasonCode === PUBLISHED_POLICY_REASONS.invalid,
  );
});

test('the failure carries no snapshot content, because it crosses into telemetry', async () => {
  const store = await storeWith(['budget']);
  await assert.rejects(
    () => source(store)(),
    (error) => {
      const serialised = JSON.stringify({
        message: error.message,
        reasonCode: error.reasonCode,
        absentKinds: error.absentKinds,
      });
      return !/tenant|subjectKey|applicationKey|price|token/i.test(serialised);
    },
  );
});

test('the source refuses to be built without a store, a scope, or a clock', () => {
  const store = createInMemoryGovernanceStore();
  assert.throws(() => createPublishedPolicySource({ scopeGroupId: SCOPE_GROUP_ID, clock }), TypeError);
  assert.throws(() => createPublishedPolicySource({ store, clock }), TypeError);
  assert.throws(() => createPublishedPolicySource({ store, scopeGroupId: SCOPE_GROUP_ID }), TypeError);
  assert.throws(
    () => createPublishedPolicySource({ store: {}, scopeGroupId: SCOPE_GROUP_ID, clock }),
    TypeError,
  );
});

test('the clock is read per resolution, not captured once', async () => {
  const store = await storeWith(GOVERNANCE_SNAPSHOT_KINDS);
  const seen = [];
  const movingClock = {
    nowIso: () => {
      const at = new Date(Date.parse(EVALUATION_TIME) + seen.length * 1000).toISOString();
      seen.push(at);
      return at;
    },
  };
  const reader = createPublishedPolicySource({ store, scopeGroupId: SCOPE_GROUP_ID, clock: movingClock });
  await reader();
  await reader();
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1]);
});

test('a published set resolves an actual policy document, not merely its inputs', async () => {
  // The seam is only proven at the far end: snapshots read from a store must produce
  // the same governed answer the resolver produces from the ones held in memory.
  const store = await storeWith(GOVERNANCE_SNAPSHOT_KINDS);
  const published = createLocalPolicyResolver(
    'governance-admin',
    createSequenceIdGenerator('published'),
    source(store),
  );
  const inMemory = createLocalPolicyResolver(
    'governance-admin',
    createSequenceIdGenerator('published'),
  );

  const fromStore = await published.resolve({ persona: 'governance-admin' });
  const fromFixture = await inMemory.resolve({ persona: 'governance-admin' });

  assert.equal(fromStore.status, 200);
  assert.equal(fromStore.document.resolution, 'resolved');
  assert.ok(fromStore.document.allowedModels.length > 0);
  assert.deepEqual(fromStore.document, fromFixture.document);
});

test('an incomplete set degrades resolution rather than resolving from what is there', async () => {
  const store = await storeWith(['assignment', 'entitlement', 'modelRegistry']);
  const resolver = createLocalPolicyResolver(
    'governance-admin',
    createSequenceIdGenerator('published'),
    source(store),
  );
  await assert.rejects(
    () => resolver.resolve({ persona: 'governance-admin' }),
    (error) => error.name === 'PolicySourceUnavailableError',
    'three of five snapshots must not produce a document at all',
  );
});
