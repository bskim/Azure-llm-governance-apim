import assert from 'node:assert/strict';
import test from 'node:test';

import { createInMemoryGovernanceStore } from '../../app/persistence/in-memory-governance-store.mjs';
import { createNotificationLedger } from '../../app/control-api/notification-ledger.mjs';
import { createPublishFailureSweep } from '../../app/control-api/publish-failure-sweep.mjs';
import { applyLifecycleCommand, createRevision } from '../../app/governance-domain/lifecycle/configuration-lifecycle.mjs';

const SCOPE = 'platform-engineering';
const NOW = '2026-08-10T12:00:00.000Z';

function publishing(revisionId, at = '2026-08-10T10:00:00.000Z') {
  const draft = createRevision({
    revisionId,
    scopeGroupId: SCOPE,
    revisionNumber: 7,
    authoredBy: 'admin-a',
    authoredAt: '2026-08-10T09:00:00.000Z',
    targets: ['gateway-policy'],
  });
  const approved = applyLifecycleCommand({
    revision: draft,
    command: 'approve',
    actor: 'admin-b',
    at: '2026-08-10T09:30:00.000Z',
    expectedRevisionNumber: 7,
    reasonCode: 'change-reviewed',
  }).revision;
  return applyLifecycleCommand({
    revision: approved,
    command: 'publish',
    actor: 'admin-b',
    at,
    expectedRevisionNumber: 7,
    reasonCode: 'publish-approved',
    publishingRevisionId: null,
  }).revision;
}

function failed(revisionId, at = '2026-08-10T10:00:00.000Z') {
  return applyLifecycleCommand({
    revision: publishing(revisionId, at),
    command: 'fail',
    actor: 'admin-b',
    at: '2026-08-10T10:05:00.000Z',
    expectedRevisionNumber: 7,
    reasonCode: 'gateway-write-rejected',
  }).revision;
}

function sweep(store) {
  return createPublishFailureSweep({
    store,
    ledger: createNotificationLedger({ store, scopeGroupId: SCOPE }),
    clock: { nowIso: () => NOW },
    scopeGroupId: SCOPE,
  });
}

async function notifications(store) {
  return createNotificationLedger({ store, scopeGroupId: SCOPE }).list({
    sinceRaisedAt: '1970-01-01T00:00:00.000Z',
  });
}

test('a recorded publish failure becomes a notification somebody can be told about', async () => {
  const store = createInMemoryGovernanceStore();
  await store.putConfigurationRevision(failed('revision-0001'), { ifMatch: null });

  const result = await sweep(store).run();

  assert.equal(result.raised, 1);
  const raised = await notifications(store);
  assert.equal(raised[0].kind, 'publish-failed');
  assert.equal(raised[0].severity, 'critical');
});

test('sweeping again does not raise the same failure twice', async () => {
  const store = createInMemoryGovernanceStore();
  await store.putConfigurationRevision(failed('revision-0001'), { ifMatch: null });

  await sweep(store).run();
  const second = await sweep(store).run();

  assert.equal(second.raised, 0);
  assert.equal((await notifications(store)).length, 1);
});

test('revisions that are healthy or still publishing raise nothing', async () => {
  const store = createInMemoryGovernanceStore();
  await store.putConfigurationRevision(publishing('revision-0002'), { ifMatch: null });

  const result = await sweep(store).run();

  assert.equal(result.raised, 0);
  assert.deepEqual(await notifications(store), []);
});

test('two sweeps running together raise each failure once', async () => {
  // The store decides. Without that, a second worker would double every alert.
  const store = createInMemoryGovernanceStore();
  await store.putConfigurationRevision(failed('revision-0003'), { ifMatch: null });

  const [first, second] = await Promise.all([sweep(store).run(), sweep(store).run()]);

  assert.equal(first.raised + second.raised, 1);
  assert.equal((await notifications(store)).length, 1);
});

test('a second failure after a retry is raised even though the first was already sent', async () => {
  const store = createInMemoryGovernanceStore();
  const first = failed('revision-0004');
  await store.putConfigurationRevision(first, { ifMatch: null });
  await sweep(store).run();

  const retried = applyLifecycleCommand({
    revision: first,
    command: 'retry',
    actor: 'admin-b',
    at: '2026-08-10T11:00:00.000Z',
    expectedRevisionNumber: 7,
    reasonCode: 'publish-retried',
  }).revision;
  const failedAgain = applyLifecycleCommand({
    revision: retried,
    command: 'fail',
    actor: 'admin-b',
    at: '2026-08-10T11:05:00.000Z',
    expectedRevisionNumber: 7,
    reasonCode: 'gateway-write-rejected',
  }).revision;
  const held = await store.readConfigurationRevision({ scopeGroupId: SCOPE, revisionId: 'revision-0004' });
  await store.putConfigurationRevision(failedAgain, { ifMatch: held.etag });

  const result = await sweep(store).run();

  assert.equal(result.raised, 1);
  assert.equal((await notifications(store)).length, 2);
});
