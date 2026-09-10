import assert from 'node:assert/strict';
import test from 'node:test';

import { createInMemoryGovernanceStore } from '../../app/persistence/in-memory-governance-store.mjs';
import { createNotificationLedger } from '../../app/control-api/notification-ledger.mjs';
import {
  MAXIMUM_NOTIFICATION_DELAY_SECONDS,
  createNotificationDispatcher,
} from '../../app/control-api/notification-dispatcher.mjs';

const SCOPE = 'platform-engineering';

function planned(atBasisPoints = 8000, raisedAt = '2026-08-10T00:00:00.000Z') {
  return {
    key: `notification|${SCOPE}|budget-threshold-reached|budget-1|3|2026-08-01T00:00:00.000Z|team|platform|${atBasisPoints}`,
    kind: 'budget-threshold-reached',
    severity: 'warning',
    scope: 'team',
    scopeKey: 'platform-engineering',
    periodStart: '2026-08-01T00:00:00.000Z',
    raisedAt,
  };
}

function channel({ failFor = [] } = {}) {
  const sent = [];
  return {
    sent,
    channelCode: 'operations-mail',
    async send(notification) {
      sent.push(notification.key);
      if (failFor.includes(notification.key)) {
        const error = new Error('the channel said no');
        error.reasonCode = 'channel-rejected';
        throw error;
      }
    },
  };
}

function dispatcher(store, transport, overrides = {}) {
  return createNotificationDispatcher({
    ledger: createNotificationLedger({ store, scopeGroupId: SCOPE }),
    channel: transport,
    ...overrides,
  });
}

test('a notification that is due is delivered and recorded as delivered', async () => {
  const store = createInMemoryGovernanceStore();
  const ledger = createNotificationLedger({ store, scopeGroupId: SCOPE });
  await ledger.raise([planned()]);
  const transport = channel();

  const result = await dispatcher(store, transport).dispatch({ now: '2026-08-10T00:00:10.000Z' });

  assert.deepEqual(transport.sent, [planned().key]);
  assert.equal(result.delivered, 1);
  assert.equal(result.failed, 0);

  const [record] = await ledger.list({ sinceRaisedAt: '2026-08-01T00:00:00.000Z' });
  assert.equal(record.state, 'delivered');
  assert.equal(record.attempts[0].channelCode, 'operations-mail');
});

test('a channel failure is recorded as an attempt, not swallowed', async () => {
  const store = createInMemoryGovernanceStore();
  const ledger = createNotificationLedger({ store, scopeGroupId: SCOPE });
  await ledger.raise([planned()]);
  const transport = channel({ failFor: [planned().key] });

  const result = await dispatcher(store, transport).dispatch({ now: '2026-08-10T00:00:10.000Z' });

  assert.equal(result.failed, 1);
  const [record] = await ledger.list({ sinceRaisedAt: '2026-08-01T00:00:00.000Z' });
  assert.equal(record.deliveryState, 'pending');
  assert.equal(record.attempts[0].reasonCode, 'channel-rejected');
  assert.ok(record.nextAttemptAt > '2026-08-10T00:00:10.000Z');
});

test('a channel that throws without a reason still records a bounded one', async () => {
  // The exception text would carry a host, a URL, or a credential into a record an
  // operator reads.
  const store = createInMemoryGovernanceStore();
  const ledger = createNotificationLedger({ store, scopeGroupId: SCOPE });
  await ledger.raise([planned()]);

  await dispatcher(store, {
    channelCode: 'operations-mail',
    async send() {
      throw new Error('connect ECONNREFUSED 10.0.0.4:443 token=abc');
    },
  }).dispatch({ now: '2026-08-10T00:00:10.000Z' });

  const [record] = await ledger.list({ sinceRaisedAt: '2026-08-01T00:00:00.000Z' });
  assert.equal(record.attempts[0].reasonCode, 'channel-unreachable');
  assert.doesNotMatch(JSON.stringify(record), /ECONNREFUSED|token=abc/);
});

test('one failing notification does not stop the rest of the batch', async () => {
  const store = createInMemoryGovernanceStore();
  const ledger = createNotificationLedger({ store, scopeGroupId: SCOPE });
  await ledger.raise([planned(8000), planned(9000), planned(10000)]);
  const transport = channel({ failFor: [planned(9000).key] });

  const result = await dispatcher(store, transport).dispatch({ now: '2026-08-10T00:00:10.000Z' });

  assert.equal(transport.sent.length, 3);
  assert.equal(result.delivered, 2);
  assert.equal(result.failed, 1);
});

test('a notification whose retry is not yet due is left alone', async () => {
  const store = createInMemoryGovernanceStore();
  const ledger = createNotificationLedger({ store, scopeGroupId: SCOPE });
  await ledger.raise([planned()]);
  const transport = channel({ failFor: [planned().key] });
  const dispatch = dispatcher(store, transport);

  await dispatch.dispatch({ now: '2026-08-10T00:00:10.000Z' });
  const second = await dispatch.dispatch({ now: '2026-08-10T00:00:20.000Z' });

  assert.equal(second.delivered + second.failed, 0);
  assert.equal(transport.sent.length, 1);
});

test('the dispatch interval is inside the delay the product promises', async () => {
  // A schedule slower than the promise would satisfy every test here and still miss
  // the bound, and nothing else in the system would notice.
  const store = createInMemoryGovernanceStore();
  const dispatch = dispatcher(store, channel());

  assert.ok(dispatch.intervalSeconds <= MAXIMUM_NOTIFICATION_DELAY_SECONDS);
  assert.equal(MAXIMUM_NOTIFICATION_DELAY_SECONDS, 300);

  assert.throws(
    () => dispatcher(store, channel(), { intervalSeconds: 600 }),
    /intervalSeconds/,
  );
});

test('nothing due is a quiet answer rather than a channel call', async () => {
  const store = createInMemoryGovernanceStore();
  const transport = channel();

  const result = await dispatcher(store, transport).dispatch({ now: '2026-08-10T00:00:10.000Z' });

  assert.deepEqual(transport.sent, []);
  assert.equal(result.delivered, 0);
  assert.equal(result.considered, 0);
});
