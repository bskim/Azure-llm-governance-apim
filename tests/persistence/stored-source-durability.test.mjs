// Durability coverage for the stored read source. Requires COSMOS_TEST_ENDPOINT and
// COSMOS_TEST_KEY, which the PowerShell entry point provides.
//
// The claim being made here is not that the projections are correct — the default
// suite proves that against an in-memory store. It is that what a screen reads is what
// a different process wrote, which only a store that outlives the writer can show.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createCosmosClient, createGovernanceStore } from '../../app/persistence/cosmos-governance-store.mjs';
import { createStoredGovernanceSource } from '../../app/control-api/stored-governance-source.mjs';
import { ReadSourceUnavailableError } from '../../app/control-api/governance-read-source.mjs';
import { governanceSnapshotDocument } from '../../app/governance-domain/policy/governance-snapshot-document.mjs';
import { getDeterministicGovernanceSnapshots } from '../../app/local-adapters/deterministic-governance-snapshots.mjs';
import { containersForProfile } from '../../app/persistence/container-topology.mjs';

const endpoint = process.env.COSMOS_TEST_ENDPOINT;
const key = process.env.COSMOS_TEST_KEY;
const databaseId = process.env.COSMOS_TEST_DATABASE ?? 'governance-integration';

if (!endpoint || !key) {
  throw new Error('COSMOS_TEST_ENDPOINT and COSMOS_TEST_KEY are required for integration tests.');
}

const client = createCosmosClient({ endpoint, key });
const { database } = await client.databases.createIfNotExists({ id: databaseId });
for (const container of containersForProfile('always')) {
  await database.containers.createIfNotExists({
    id: container.id,
    partitionKey: { paths: [...container.partitionKeyPaths] },
    defaultTtl: container.defaultTimeToLiveSeconds ?? undefined,
  });
}

const EVALUATION_TIME = '2026-07-24T10:00:00.000Z';
const clock = { nowIso: () => EVALUATION_TIME };

let sequence = 0;
const uniqueScope = () => `stored-source-${Date.now().toString(36)}-${(sequence += 1)}`;

/** A fresh handle per role, as two processes would have. */
function store() {
  return createGovernanceStore({ client, databaseId });
}

function source(scopeGroupId) {
  return createStoredGovernanceSource({
    store: store(),
    scopeGroupId,
    clock,
    lifecycleViewer: 'governance-administrator',
    readProviderQuota: null,
  });
}

test('a governance set written by one handle is read by another', async () => {
  const scopeGroupId = uniqueScope();
  const writer = store();
  const expected = getDeterministicGovernanceSnapshots();
  const kinds = {
    assignment: expected.assignmentSnapshot,
    entitlement: expected.entitlementSnapshot,
    modelRegistry: expected.modelRegistrySnapshot,
    fallbackPolicy: expected.fallbackPolicySnapshot,
    budget: expected.budgetSnapshot,
  };
  for (const [kind, snapshot] of Object.entries(kinds)) {
    await writer.putGovernanceSnapshot(
      governanceSnapshotDocument({ scopeGroupId, kind, snapshot }),
      { ifMatch: null, evaluationTime: EVALUATION_TIME },
    );
  }

  assert.deepEqual(await source(scopeGroupId).readGovernanceSnapshots(), expected);
});

test('a set that is not yet complete refuses rather than partly governing', async () => {
  const scopeGroupId = uniqueScope();
  const writer = store();
  const snapshots = getDeterministicGovernanceSnapshots();
  await writer.putGovernanceSnapshot(
    governanceSnapshotDocument({ scopeGroupId, kind: 'budget', snapshot: snapshots.budgetSnapshot }),
    { ifMatch: null, evaluationTime: EVALUATION_TIME },
  );

  await assert.rejects(
    () => source(scopeGroupId).readGovernanceSnapshots(),
    (error) => error instanceof ReadSourceUnavailableError,
  );
});

test('a scope nothing was written for refuses rather than reading as empty', async () => {
  const scopeGroupId = uniqueScope();
  await assert.rejects(
    () => source(scopeGroupId).readUsersGroups(),
    (error) => error.code === 'directory-snapshot-absent',
  );
  // An unobserved window publishes no counts, which is the same conclusion the
  // in-memory run reaches and the one a real empty container must also reach.
  const usage = await source(scopeGroupId).readUsageRecords();
  assert.equal(usage.window.completeness.state, 'degraded');
  assert.deepEqual(usage.records, []);
});

test('a directory written by one handle drives the screen read by another', async () => {
  const scopeGroupId = uniqueScope();
  await store().putDirectorySnapshot({
    contractVersion: 'v1',
    documentType: 'directory-snapshot',
    id: `directory-snapshot|${scopeGroupId}`,
    scopeGroupId,
    configurationVersion: 'cfg-integration-001',
    sourceRevision: 'directory-run-001',
    observedAt: '2026-07-24T09:59:00.000Z',
    asOf: EVALUATION_TIME,
    completeness: { state: 'complete', reason: 'source-confirmed', maxObservationAgeSeconds: 3600 },
    users: [
      {
        recordKey: 'directory-user-integration-1',
        subjectId: 'user-integration-1',
        displayCode: 'integration-user',
        entityKind: 'user',
        teamCode: 'platform-engineering',
        lifecycleState: 'active',
        resolutionState: 'complete',
        directRelationCount: 1,
        inheritedRelationCount: 0,
      },
    ],
    groups: [
      // The validator refuses a user claiming a team no group in the same snapshot
      // provides, so the team the user belongs to is written with them.
      {
        recordKey: 'directory-group-integration-1',
        displayCode: 'integration-group',
        entityKind: 'group',
        teamCode: 'platform-engineering',
        lifecycleState: 'active',
        resolutionState: 'complete',
        directRelationCount: 1,
        inheritedRelationCount: 0,
        // Who is in the group, so a self-scoped reader can be told whether they are.
        memberSubjectIds: ['user-integration-1'],
      },
    ],
  });

  const fixture = await source(scopeGroupId).readUsersGroups();
  assert.equal(fixture.quality.state, 'fresh');
  assert.equal(fixture.configurationVersion, 'cfg-integration-001');
  assert.deepEqual(fixture.users.map((record) => record.displayCode), ['integration-user']);
});
