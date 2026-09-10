import assert from 'node:assert/strict';
import test from 'node:test';

import { createInMemoryGovernanceStore } from '../../app/persistence/in-memory-governance-store.mjs';
import { createNotificationLedger } from '../../app/control-api/notification-ledger.mjs';
import { createNotificationRetentionSweep } from '../../app/control-api/notification-retention-sweep.mjs';
import {
  acknowledgeNotification,
  raiseNotification,
  recordDeliveryAttempt,
} from '../../app/governance-domain/notification/notification-delivery.mjs';

const SCOPE = 'platform-engineering';
const NOW = '2026-08-10T00:00:00.000Z';

function daysBefore(days) {
  return new Date(Date.parse(NOW) - days * 86_400_000).toISOString();
}

function raised(raisedAt, discriminator) {
  return raiseNotification({
    scopeGroupId: SCOPE,
    key: `notification|${SCOPE}|budget-threshold-reached|budget-1|3|2026-01-01T00:00:00.000Z|team|platform|${discriminator}`,
    kind: 'budget-threshold-reached',
    severity: 'warning',
    scope: 'team',
    scopeKey: 'platform-engineering',
    periodStart: '2026-01-01T00:00:00.000Z',
    raisedAt,
  });
}

function acknowledged(raisedAt, acknowledgedAt, discriminator) {
  const sent = recordDeliveryAttempt({
    notification: raised(raisedAt, discriminator),
    outcome: 'delivered',
    channelCode: 'operations-mail',
    at: raisedAt,
  }).notification;
  return acknowledgeNotification({ notification: sent, actorCode: 'local-auditor', at: acknowledgedAt })
    .notification;
}

function sweep(store, ownerCode = 'worker-a', overrides = {}) {
  return createNotificationRetentionSweep({
    store,
    ledger: createNotificationLedger({ store, scopeGroupId: SCOPE }),
    clock: { nowIso: () => overrides.now ?? NOW },
    scopeGroupId: SCOPE,
    startedFrom: '2026-08-01T00:00:00.000Z',
    ownerCode,
    leaseSeconds: 300,
    ...overrides,
  });
}

async function remaining(store) {
  return createNotificationLedger({ store, scopeGroupId: SCOPE }).list({
    sinceRaisedAt: '1970-01-01T00:00:00.000Z',
  });
}

test('a closed notification past its retention is removed, and the rest are left', async () => {
  const store = createInMemoryGovernanceStore();
  await store.putNotification(acknowledged(daysBefore(200), daysBefore(120), 8000), { ifMatch: null });
  await store.putNotification(acknowledged(daysBefore(100), daysBefore(10), 9000), { ifMatch: null });
  await store.putNotification(raised(daysBefore(400), 10000), { ifMatch: null });

  const result = await sweep(store).tick();

  assert.equal(result.outcome, 'ran');
  assert.equal(result.removed, 1);
  assert.equal(result.retained, 2);
  const left = await remaining(store);
  assert.equal(left.length, 2);
  assert.equal(
    left.some((record) => record.key.endsWith('|10000')),
    true,
    'the one nobody acknowledged is still there',
  );
});

test('a long outage runs the sweep once rather than once per missed day', async () => {
  // Retention is a state of the world, not a per-day event. Replaying a month of
  // missed days would repeat the same pass thirty times for the same answer.
  const store = createInMemoryGovernanceStore();
  await store.putNotification(acknowledged(daysBefore(200), daysBefore(120), 8000), { ifMatch: null });
  let passes = 0;
  const counted = {
    ...store,
    async queryNotifications(selection) {
      passes += 1;
      return store.queryNotifications(selection);
    },
  };

  const result = await sweep(counted, 'worker-a', { now: '2026-09-15T00:00:00.000Z' }).tick();

  assert.equal(result.outcome, 'ran');
  assert.equal(passes, 1);
  assert.ok(result.skipped !== null, 'the days it did not replay are still reported');
});

test('two sweeps running together remove the record once', async () => {
  const store = createInMemoryGovernanceStore();
  await store.putNotification(acknowledged(daysBefore(200), daysBefore(120), 8000), { ifMatch: null });

  const [first, second] = await Promise.all([
    sweep(store, 'worker-a').tick(),
    sweep(store, 'worker-b').tick(),
  ]);

  assert.deepEqual([first.outcome, second.outcome].sort(), ['ran', 'skipped']);
  assert.deepEqual(await remaining(store), []);
});

test('a record acknowledged again while the sweep was deciding is not removed', async () => {
  // The sweep read one version and the store holds another; removing it would
  // discard a change nobody compared against.
  const store = createInMemoryGovernanceStore();
  const record = acknowledged(daysBefore(200), daysBefore(120), 8000);
  await store.putNotification(record, { ifMatch: null });

  const racing = {
    ...store,
    async deleteNotification(selection, options) {
      const held = await store.readNotification(selection);
      if (held !== null) await store.putNotification(held.document, { ifMatch: held.etag });
      return store.deleteNotification(selection, options);
    },
  };

  const result = await sweep(racing, 'worker-a').tick();

  assert.equal(result.removed, 0);
  assert.equal(result.contended, 1);
  assert.equal((await remaining(store)).length, 1);
});

test('a sweep with nothing to remove is not a write', async () => {
  const store = createInMemoryGovernanceStore();
  await store.putNotification(raised(daysBefore(400), 10000), { ifMatch: null });

  const result = await sweep(store).tick();

  assert.equal(result.removed, 0);
  assert.equal(result.retained, 1);
  assert.equal((await remaining(store)).length, 1);
});
