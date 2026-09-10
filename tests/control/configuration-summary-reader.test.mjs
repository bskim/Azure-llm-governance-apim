import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createConfigurationSummaryReader,
  createDeployedConfigurationSummaryReader,
} from '../../app/functions/composition-root.mjs';
import { createInMemoryGovernanceStore } from '../../app/persistence/in-memory-governance-store.mjs';
import { getDeterministicConfigurationRevisions } from '../../app/local-adapters/deterministic-configuration-revisions.mjs';

const SCOPE_GROUP_ID = 'platform-engineering';

async function storeWith(revisions) {
  const store = createInMemoryGovernanceStore();
  for (const revision of revisions) {
    await store.putConfigurationRevision(revision, { ifMatch: null });
  }
  return store;
}

test('an active revision is reported with its own version and instant', async () => {
  const store = await storeWith(getDeterministicConfigurationRevisions());
  const readConfigurationSummary = createConfigurationSummaryReader({ store, scopeGroupId: SCOPE_GROUP_ID });

  const summary = await readConfigurationSummary();

  assert.equal(summary.state, 'active');
  assert.equal(summary.activeVersion, 'revision-0007');
  assert.equal(summary.publishedAt, '2026-07-24T09:16:00.000Z');
});

test('nothing published is reported as nothing published, not as active', async () => {
  const revisions = getDeterministicConfigurationRevisions().filter((revision) => revision.state !== 'active');
  const store = await storeWith(revisions);
  const readConfigurationSummary = createConfigurationSummaryReader({ store, scopeGroupId: SCOPE_GROUP_ID });

  const summary = await readConfigurationSummary();

  assert.deepEqual(summary, { activeVersion: null, state: 'no-active-revision', publishedAt: null });
});

test('an empty store is also nothing published, not active', async () => {
  const store = createInMemoryGovernanceStore();
  const readConfigurationSummary = createConfigurationSummaryReader({ store, scopeGroupId: SCOPE_GROUP_ID });

  assert.deepEqual(await readConfigurationSummary(), {
    activeVersion: null,
    state: 'no-active-revision',
    publishedAt: null,
  });
});

test('a source that cannot be read is reported as unreadable, distinctly from nothing published', async () => {
  const store = {
    queryConfigurationRevisions: async () => {
      throw new Error('offline');
    },
  };
  const readConfigurationSummary = createConfigurationSummaryReader({ store, scopeGroupId: SCOPE_GROUP_ID });

  const summary = await readConfigurationSummary();

  assert.deepEqual(summary, { activeVersion: null, state: 'unavailable', publishedAt: null });
});

test('a deployment with no durable store answers unavailable without attempting a read', async () => {
  const readConfigurationSummary = createDeployedConfigurationSummaryReader({});

  assert.deepEqual(await readConfigurationSummary(), {
    activeVersion: null,
    state: 'unavailable',
    publishedAt: null,
  });
});

test('if more than one revision were ever left active, the most recent one is reported', async () => {
  const revisions = getDeterministicConfigurationRevisions();
  const active = revisions.find((revision) => revision.state === 'active');
  const olderActive = { ...active, revisionId: 'revision-0001', revisionNumber: 1, publishCompletedAt: '2026-07-24T09:01:00.000Z' };
  const store = await storeWith([...revisions, olderActive]);
  const readConfigurationSummary = createConfigurationSummaryReader({ store, scopeGroupId: SCOPE_GROUP_ID });

  const summary = await readConfigurationSummary();

  assert.equal(summary.activeVersion, active.revisionId);
});

test('construction refuses a missing store or scope group id', () => {
  const store = createInMemoryGovernanceStore();
  assert.throws(() => createConfigurationSummaryReader({ scopeGroupId: SCOPE_GROUP_ID }), TypeError);
  assert.throws(() => createConfigurationSummaryReader({ store }), TypeError);
});
