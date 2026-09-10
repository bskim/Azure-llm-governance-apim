// Durability coverage against the local emulator. Requires COSMOS_TEST_ENDPOINT and
// COSMOS_TEST_KEY, which the PowerShell entry point provides.
//
// These are the claims that cannot be made against an in-memory adapter. A checkpoint
// held in a process records what that process owes to itself; only a store that
// outlives the process can say anything about a restart or about a second runner.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createCosmosClient, createGovernanceStore } from '../../app/persistence/cosmos-governance-store.mjs';
import { createScheduledRollupProjector } from '../../app/control-api/scheduled-rollup-projector.mjs';
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

const WINDOW_SECONDS = 3600;
const WINDOW_MS = WINDOW_SECONDS * 1000;
const LAG_SECONDS = 0;

let sequence = 0;
const uniqueScope = () => `recovery-${Date.now().toString(36)}-${(sequence += 1)}`;
const aligned = (at) => new Date(Math.floor(Date.parse(at) / WINDOW_MS) * WINDOW_MS).toISOString();

/** One worker, as a deployment builds it: its own store handle and its own owner code. */
function worker({ scopeGroupId, startedFrom, ownerCode, clock, ran, failWindow = null }) {
  return createScheduledRollupProjector({
    projector: {
      async runWindow(window) {
        if (failWindow !== null && window.windowStart === failWindow) throw new Error('window-failed');
        ran.push({ ownerCode, windowStart: window.windowStart });
      },
    },
    store: createGovernanceStore({ client, databaseId }),
    clock,
    scopeGroupId,
    windowSeconds: WINDOW_SECONDS,
    ingestionLagSeconds: LAG_SECONDS,
    startedFrom,
    ownerCode,
    leaseSeconds: 600,
    maxBackfillWindows: 48,
  });
}

test('cosmos: windows that fell due while nothing was running are replayed after a restart', async () => {
  const scopeGroupId = uniqueScope();
  const startedFrom = aligned('2026-07-24T00:00:00.000Z');
  const ran = [];

  // First worker runs one window, then the process is gone. Nothing but the store
  // carries what it got through.
  let now = new Date(Date.parse(startedFrom) + WINDOW_MS).toISOString();
  await worker({ scopeGroupId, startedFrom, ownerCode: 'worker-first', clock: { nowIso: () => now }, ran }).tick();
  const afterFirst = ran.length;
  assert.ok(afterFirst >= 1, 'the first worker must have aggregated at least one window');

  // Four windows later a different worker starts. It has never seen the first one.
  now = new Date(Date.parse(startedFrom) + 5 * WINDOW_MS).toISOString();
  await worker({ scopeGroupId, startedFrom, ownerCode: 'worker-second', clock: { nowIso: () => now }, ran }).tick();

  const windows = ran.map((entry) => entry.windowStart);
  assert.equal(new Set(windows).size, windows.length, 'no window may be aggregated twice');
  const expected = [];
  for (let index = 0; index < 5; index += 1) {
    expected.push(new Date(Date.parse(startedFrom) + index * WINDOW_MS).toISOString());
  }
  assert.deepEqual([...windows].sort(), expected, 'every window that fell due is replayed, in full');
});

test('cosmos: the runner that loses the lease does no work rather than duplicating it', async () => {
  const scopeGroupId = uniqueScope();
  const startedFrom = aligned('2026-07-24T00:00:00.000Z');
  const now = new Date(Date.parse(startedFrom) + 3 * WINDOW_MS).toISOString();
  const ran = [];
  const clock = { nowIso: () => now };

  const [first, second] = await Promise.all([
    worker({ scopeGroupId, startedFrom, ownerCode: 'worker-a', clock, ran }).tick(),
    worker({ scopeGroupId, startedFrom, ownerCode: 'worker-b', clock, ran }).tick(),
  ]);

  const outcomes = [first, second];
  assert.equal(
    outcomes.filter((outcome) => outcome.outcome === 'skipped' && outcome.reasonCode === 'claim-lost').length,
    1,
    `exactly one runner must lose the claim: ${JSON.stringify(outcomes)}`,
  );

  const windows = ran.map((entry) => entry.windowStart);
  assert.equal(new Set(windows).size, windows.length, 'the loser must not have aggregated anything the winner did');
  assert.equal(new Set(ran.map((entry) => entry.ownerCode)).size, 1, 'only one owner does the work');
});

test('cosmos: a run that fails partway keeps what it finished and releases the lease', async () => {
  const scopeGroupId = uniqueScope();
  const startedFrom = aligned('2026-07-24T00:00:00.000Z');
  const now = new Date(Date.parse(startedFrom) + 3 * WINDOW_MS).toISOString();
  const ran = [];
  const clock = { nowIso: () => now };
  const secondWindow = new Date(Date.parse(startedFrom) + WINDOW_MS).toISOString();

  await worker({
    scopeGroupId,
    startedFrom,
    ownerCode: 'worker-failing',
    clock,
    ran,
    failWindow: secondWindow,
  }).tick();
  assert.deepEqual(ran.map((entry) => entry.windowStart), [startedFrom], 'only the window before the failure is kept');

  // A lease the failed run had not released would make this a no-op until it expired.
  await worker({ scopeGroupId, startedFrom, ownerCode: 'worker-resuming', clock, ran }).tick();
  const windows = ran.map((entry) => entry.windowStart);
  assert.ok(windows.includes(secondWindow), 'the next runner resumes at the window that failed');
  assert.equal(new Set(windows).size, windows.length, 'resuming must not repeat a completed window');
});
