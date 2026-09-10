import assert from 'node:assert/strict';
import test from 'node:test';

import { ReadSourceUnavailableError } from '../../app/control-api/governance-read-source.mjs';
import { createLocalGovernanceSource } from '../../app/control-api/local-governance-source.mjs';
import { createStoredGovernanceSource } from '../../app/control-api/stored-governance-source.mjs';
import { projectUsersGroupsReadModel } from '../../app/control-api/users-groups-read-model-projector.mjs';
import { projectUsage } from '../../app/control-api/usage-read-model-projector.mjs';
import { governanceSnapshotDocument } from '../../app/governance-domain/policy/governance-snapshot-document.mjs';
import { createInMemoryGovernanceStore } from '../../app/persistence/in-memory-governance-store.mjs';

const EVALUATION_TIME = '2026-07-24T10:00:00.000Z';
const SCOPE_GROUP_ID = 'platform-engineering';

const clock = { nowIso: () => EVALUATION_TIME };

function development() {
  return createLocalGovernanceSource({ evaluationTime: EVALUATION_TIME });
}

function stored(store, overrides = {}) {
  return createStoredGovernanceSource({
    store,
    scopeGroupId: SCOPE_GROUP_ID,
    clock,
    lifecycleViewer: 'local-approver',
    readProviderQuota: null,
    ...overrides,
  });
}

function authorization() {
  return {
    contractVersion: 'v1',
    readAuthority: 'authoritative',
    decision: 'allow',
    permittedReadScopes: ['self', 'team', 'global'],
    permittedTeamKeys: ['platform-engineering', 'developer-experience'],
    reasonCode: 'authorized',
  };
}

/** The same governance set the development source serves, written into a store. */
async function withPublishedSnapshots(store) {
  const snapshots = development().readGovernanceSnapshots();
  const kinds = {
    assignment: snapshots.assignmentSnapshot,
    entitlement: snapshots.entitlementSnapshot,
    modelRegistry: snapshots.modelRegistrySnapshot,
    fallbackPolicy: snapshots.fallbackPolicySnapshot,
    budget: snapshots.budgetSnapshot,
  };
  for (const [kind, snapshot] of Object.entries(kinds)) {
    await store.putGovernanceSnapshot(
      governanceSnapshotDocument({ scopeGroupId: SCOPE_GROUP_ID, kind, snapshot }),
      { ifMatch: null, evaluationTime: EVALUATION_TIME },
    );
  }
  return snapshots;
}

test('the stored source satisfies the same contract and says it is durable', () => {
  const source = stored(createInMemoryGovernanceStore());
  assert.deepEqual(source.describe(), { sourceKind: 'stored', durability: 'durable' });
  // A deployment has no selectable states: a screen is whatever the evidence makes it.
  for (const capability of ['overviewFixtures', 'usageFixtures', 'auditFixtures', 'budgetsFixtures']) {
    assert.deepEqual(source.capabilities[capability], ['complete']);
  }
  assert.deepEqual(source.capabilities.overviewSources, ['rollup']);
});

test('a published set read from the store is the same governance the fixtures serve', async () => {
  const store = createInMemoryGovernanceStore();
  const expected = await withPublishedSnapshots(store);
  const actual = await stored(store).readGovernanceSnapshots();
  assert.deepEqual(actual, expected);
});

test('a partial set is refused rather than partly governing', async () => {
  const store = createInMemoryGovernanceStore();
  const snapshots = development().readGovernanceSnapshots();
  await store.putGovernanceSnapshot(
    governanceSnapshotDocument({
      scopeGroupId: SCOPE_GROUP_ID,
      kind: 'entitlement',
      snapshot: snapshots.entitlementSnapshot,
    }),
    { ifMatch: null, evaluationTime: EVALUATION_TIME },
  );
  await assert.rejects(
    () => stored(store).readGovernanceSnapshots(),
    (error) => error instanceof ReadSourceUnavailableError,
  );
});

test('nothing stored is a refusal, never an empty reading', async () => {
  const source = stored(createInMemoryGovernanceStore());
  // An absent directory and a directory with nobody in it are different facts, and a
  // screen that renders them alike says the organization is empty.
  await assert.rejects(
    () => source.readUsersGroups(),
    (error) => error instanceof ReadSourceUnavailableError && error.code === 'directory-snapshot-absent',
  );
  await assert.rejects(
    () => source.readGovernanceSnapshots(),
    (error) => error instanceof ReadSourceUnavailableError,
  );
});

test('a store that cannot be reached is reported as unreadable, not as absent', async () => {
  const broken = {
    ...createInMemoryGovernanceStore(),
    async readDirectorySnapshot() {
      throw new Error('connection reset');
    },
  };
  await assert.rejects(
    () => stored(broken).readUsersGroups(),
    (error) => error instanceof ReadSourceUnavailableError
      && error.code === 'directory-snapshot-unreadable',
  );
});

test('a directory nobody could observe is refused rather than shown short', async () => {
  const store = createInMemoryGovernanceStore();
  await store.putDirectorySnapshot({
    contractVersion: 'v1',
    documentType: 'directory-snapshot',
    id: `directory-snapshot|${SCOPE_GROUP_ID}`,
    scopeGroupId: SCOPE_GROUP_ID,
    configurationVersion: 'cfg-local-003',
    sourceRevision: 'directory-run-001',
    observedAt: '2026-07-24T09:00:00.000Z',
    asOf: EVALUATION_TIME,
    completeness: { state: 'degraded', reason: 'source-unavailable', maxObservationAgeSeconds: 3600 },
    users: [],
    groups: [],
  });
  await assert.rejects(
    () => stored(store).readUsersGroups(),
    (error) => error.code === 'directory-evidence-degraded',
  );
});

test('a stored directory drives the same screen the fixture does', async () => {
  const store = createInMemoryGovernanceStore();
  const snapshots = await withPublishedSnapshots(store);
  const fixture = development().readUsersGroups({ fixtureName: 'complete' });
  await store.putDirectorySnapshot({
    contractVersion: 'v1',
    documentType: 'directory-snapshot',
    id: `directory-snapshot|${SCOPE_GROUP_ID}`,
    scopeGroupId: SCOPE_GROUP_ID,
    configurationVersion: fixture.configurationVersion,
    sourceRevision: 'directory-run-001',
    observedAt: '2026-07-24T09:59:00.000Z',
    asOf: EVALUATION_TIME,
    completeness: { state: 'complete', reason: 'source-confirmed', maxObservationAgeSeconds: 3600 },
    users: fixture.users,
    groups: fixture.groups,
  });

  const context = {
    contractVersion: 'v1',
    tenant: { tenantId: 'tenant-local-demo' },
    subject: { subjectId: 'user-local-admin' },
    memberships: [],
  };
  const selection = { scope: 'global', view: 'users', teamKey: null };
  const model = projectUsersGroupsReadModel({
    context,
    authorization: authorization(),
    entitlementSnapshot: snapshots.entitlementSnapshot,
    fixture: await stored(store).readUsersGroups(),
    selection,
  });

  assert.equal(model.readModelVersion, 'users-groups.v1');
  assert.equal(model.quality.state, 'fresh');
  assert.deepEqual(
    model.records.map((record) => record.displayCode),
    projectUsersGroupsReadModel({
      context,
      authorization: authorization(),
      entitlementSnapshot: snapshots.entitlementSnapshot,
      fixture,
      selection,
    }).records.map((record) => record.displayCode),
  );
});

test('a usage window with no rollup behind it publishes no counts', async () => {
  const store = createInMemoryGovernanceStore();
  const usage = await stored(store).readUsageRecords();

  assert.equal(usage.window.completeness.state, 'degraded');
  const model = projectUsage({
    authorization: authorization(),
    records: usage.records,
    window: usage.window,
    selection: { view: 'users', scope: 'global', teamKey: null, generatedAt: EVALUATION_TIME },
    viewer: { subjectKey: 'sk1-local-platform-engineering-1' },
  });
  // Nobody observed the period, so its counts are unknown rather than zero.
  assert.equal(model.quality.countsMeasured, false);
  assert.equal(model.totals, null);
});

test('the provider reading is answered from the provider, and a failed read is not a refusal', async () => {
  // Monitoring Reader on the account grants the per-deployment read; the subscription
  // allocation pool sits at a scope the identity does not hold, so half of this answer
  // legitimately arrives degraded rather than absent.
  const store = createInMemoryGovernanceStore();

  const reading = { deployments: [], region: 'eastus2' };
  assert.equal(await stored(store, { readProviderQuota: async () => reading }).readProviderQuota(), reading);

  // A provider that cannot be reached loses one column, not the models screen.
  const refused = stored(store, {
    readProviderQuota: async () => {
      throw new Error('arm-read-failed');
    },
  });
  assert.equal(await refused.readProviderQuota(), null);

  // A deployment that decided not to read the provider is an answer.
  assert.equal(await stored(store, { readProviderQuota: null }).readProviderQuota(), null);
});

test('a source that was never asked about the provider refuses to be built', () => {
  // Not reading the provider and never considering it produce the same empty column,
  // and only one of them is a decision.
  assert.throws(
    () => createStoredGovernanceSource({
      store: createInMemoryGovernanceStore(),
      scopeGroupId: SCOPE_GROUP_ID,
      clock,
      lifecycleViewer: 'local-approver',
    }),
    TypeError,
  );
  assert.throws(
    () => stored(createInMemoryGovernanceStore(), { readProviderQuota: 'yes' }),
    TypeError,
  );
});
