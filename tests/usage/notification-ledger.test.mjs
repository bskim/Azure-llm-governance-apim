import assert from 'node:assert/strict';
import test from 'node:test';

import { createInMemoryGovernanceStore } from '../../app/persistence/in-memory-governance-store.mjs';
import { createNotificationLedger } from '../../app/control-api/notification-ledger.mjs';

const SCOPE = 'platform-engineering';

function planned(atBasisPoints = 8000) {
  return {
    key: `notification|${SCOPE}|budget-threshold-reached|budget-1|3|2026-08-01T00:00:00.000Z|team|platform|${atBasisPoints}`,
    kind: 'budget-threshold-reached',
    severity: 'warning',
    scopeGroupId: SCOPE,
    scope: 'team',
    scopeKey: 'platform-engineering',
    periodStart: '2026-08-01T00:00:00.000Z',
    raisedAt: '2026-08-10T00:00:00.000Z',
  };
}

test('the same crossing seen again after a restart is not raised twice', async () => {
  // The in-process guard cannot survive the process, and the scheduler re-reading a
  // window is the normal case rather than the exception.
  const store = createInMemoryGovernanceStore();

  const first = await createNotificationLedger({ store, scopeGroupId: SCOPE }).raise([planned()]);
  const second = await createNotificationLedger({ store, scopeGroupId: SCOPE }).raise([planned()]);

  assert.deepEqual(first.raised, [planned().key]);
  assert.deepEqual(second.raised, []);
  assert.deepEqual(second.alreadyRaised, [planned().key]);
});

test('two workers that both saw the crossing raise it once, without an error', async () => {
  const store = createInMemoryGovernanceStore();

  const [a, b] = await Promise.all([
    createNotificationLedger({ store, scopeGroupId: SCOPE }).raise([planned()]),
    createNotificationLedger({ store, scopeGroupId: SCOPE }).raise([planned()]),
  ]);

  assert.equal(a.raised.length + b.raised.length, 1);
  assert.equal(a.alreadyRaised.length + b.alreadyRaised.length, 1);
});

test('what has already been raised is what the planner is told to suppress', async () => {
  const store = createInMemoryGovernanceStore();
  const ledger = createNotificationLedger({ store, scopeGroupId: SCOPE });
  await ledger.raise([planned(8000)]);

  const known = await ledger.alreadyNotified({ sinceRaisedAt: '2026-08-01T00:00:00.000Z' });

  assert.equal(known.has(planned(8000).key), true);
  assert.equal(known.has(planned(10000).key), false, 'exhaustion is a separate crossing');
});

test('a retry becomes due only when its backoff has passed', async () => {
  const store = createInMemoryGovernanceStore();
  const ledger = createNotificationLedger({ store, scopeGroupId: SCOPE });
  await ledger.raise([planned()]);

  await ledger.deliver({
    key: planned().key,
    outcome: 'failed',
    channelCode: 'operations-mail',
    reasonCode: 'channel-unreachable',
    at: '2026-08-10T00:00:30.000Z',
  });

  const tooEarly = await ledger.dueForDelivery({ now: '2026-08-10T00:01:00.000Z' });
  assert.deepEqual(tooEarly, []);

  const due = await ledger.dueForDelivery({ now: '2026-08-10T00:02:00.000Z' });
  assert.deepEqual(
    due.map((record) => record.key),
    [planned().key],
  );
});

test('a delivered notification stops being work and appears as delivered', async () => {
  const store = createInMemoryGovernanceStore();
  const ledger = createNotificationLedger({ store, scopeGroupId: SCOPE });
  await ledger.raise([planned()]);

  const result = await ledger.deliver({
    key: planned().key,
    outcome: 'delivered',
    channelCode: 'operations-mail',
    at: '2026-08-10T00:00:30.000Z',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(await ledger.dueForDelivery({ now: '2026-08-11T00:00:00.000Z' }), []);
  const [record] = await ledger.list({ sinceRaisedAt: '2026-08-01T00:00:00.000Z' });
  assert.equal(record.state, 'delivered');
});

test('acknowledging is written against the version it read', async () => {
  const store = createInMemoryGovernanceStore();
  const ledger = createNotificationLedger({ store, scopeGroupId: SCOPE });
  await ledger.raise([planned()]);
  await ledger.deliver({
    key: planned().key,
    outcome: 'delivered',
    channelCode: 'operations-mail',
    at: '2026-08-10T00:00:30.000Z',
  });

  const [first, second] = await Promise.all([
    ledger.acknowledge({ key: planned().key, actorCode: 'local-auditor', at: '2026-08-10T00:05:00.000Z' }),
    ledger.acknowledge({ key: planned().key, actorCode: 'local-admin', at: '2026-08-10T00:05:01.000Z' }),
  ]);

  assert.equal([first.ok, second.ok].filter(Boolean).length, 1, 'only one acknowledgement lands');
  const [record] = await ledger.list({ sinceRaisedAt: '2026-08-01T00:00:00.000Z' });
  assert.ok(['local-auditor', 'local-admin'].includes(record.acknowledgedBy));
  assert.equal(record.state, 'acknowledged');
});

test('delivering against a key that was never raised is refused, not invented', async () => {
  const store = createInMemoryGovernanceStore();
  const ledger = createNotificationLedger({ store, scopeGroupId: SCOPE });

  const result = await ledger.deliver({
    key: planned().key,
    outcome: 'delivered',
    channelCode: 'operations-mail',
    at: '2026-08-10T00:00:30.000Z',
  });

  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'notification-absent');
});
