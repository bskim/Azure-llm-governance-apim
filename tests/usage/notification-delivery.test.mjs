import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acknowledgeNotification,
  notificationDocumentId,
  raiseNotification,
  recordDeliveryAttempt,
} from '../../app/governance-domain/notification/notification-delivery.mjs';

const SCOPE = 'platform-engineering';

function raised(overrides = {}) {
  return raiseNotification({
    scopeGroupId: SCOPE,
    key: 'notification|platform-engineering|budget-threshold-reached|budget-1|3|2026-08-01T00:00:00.000Z|team|platform|8000',
    kind: 'budget-threshold-reached',
    severity: 'warning',
    scope: 'team',
    scopeKey: 'platform-engineering',
    periodStart: '2026-08-01T00:00:00.000Z',
    raisedAt: '2026-08-10T00:00:00.000Z',
    ...overrides,
  });
}

test('a notification starts owed rather than sent', () => {
  const notification = raised();
  assert.equal(notification.state, 'pending');
  assert.deepEqual(notification.attempts, []);
  assert.equal(notification.acknowledgedBy, null);
  assert.equal(notification.id, notificationDocumentId({ scopeGroupId: SCOPE, key: notification.key }));
});

test('a delivered notification is recorded with what carried it', () => {
  const delivered = recordDeliveryAttempt({
    notification: raised(),
    outcome: 'delivered',
    channelCode: 'operations-mail',
    at: '2026-08-10T00:00:30.000Z',
  });

  assert.equal(delivered.ok, true);
  assert.equal(delivered.notification.state, 'delivered');
  assert.equal(delivered.notification.attempts.length, 1);
  assert.equal(delivered.notification.attempts[0].channelCode, 'operations-mail');
  assert.equal(delivered.notification.nextAttemptAt, null);
});

test('a failed delivery is retried later, and every attempt stays on the record', () => {
  const first = recordDeliveryAttempt({
    notification: raised(),
    outcome: 'failed',
    channelCode: 'operations-mail',
    reasonCode: 'channel-unreachable',
    at: '2026-08-10T00:00:30.000Z',
  });

  assert.equal(first.notification.state, 'pending');
  assert.ok(Date.parse(first.notification.nextAttemptAt) > Date.parse('2026-08-10T00:00:30.000Z'));

  const second = recordDeliveryAttempt({
    notification: first.notification,
    outcome: 'failed',
    channelCode: 'operations-mail',
    reasonCode: 'channel-unreachable',
    at: first.notification.nextAttemptAt,
  });

  assert.equal(second.notification.attempts.length, 2);
  assert.ok(
    Date.parse(second.notification.nextAttemptAt) - Date.parse(second.notification.attempts[1].at) >
      Date.parse(first.notification.nextAttemptAt) - Date.parse(first.notification.attempts[0].at),
    'each failure waits longer than the last',
  );
});

test('retries stop, and the notification is left visible as failed rather than dropped', () => {
  let notification = raised();
  let at = '2026-08-10T00:00:30.000Z';
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const result = recordDeliveryAttempt({
      notification,
      outcome: 'failed',
      channelCode: 'operations-mail',
      reasonCode: 'channel-unreachable',
      at,
    });
    if (result.ok !== true) break;
    notification = result.notification;
    at = notification.nextAttemptAt ?? at;
  }

  assert.equal(notification.state, 'failed');
  assert.equal(notification.nextAttemptAt, null);
  assert.ok(notification.attempts.length >= 3, 'the attempts that were made are still readable');
  assert.equal(notification.reasonCode, 'delivery-attempts-exhausted');
});

test('an attempt after the record is settled is refused rather than reopening it', () => {
  const delivered = recordDeliveryAttempt({
    notification: raised(),
    outcome: 'delivered',
    channelCode: 'operations-mail',
    at: '2026-08-10T00:00:30.000Z',
  }).notification;

  const again = recordDeliveryAttempt({
    notification: delivered,
    outcome: 'delivered',
    channelCode: 'operations-mail',
    at: '2026-08-10T00:01:00.000Z',
  });

  assert.equal(again.ok, false);
  assert.equal(again.reasonCode, 'already-delivered');
  assert.deepEqual(again.notification, delivered);
});

test('what was never sent cannot be acknowledged', () => {
  const result = acknowledgeNotification({
    notification: raised(),
    actorCode: 'local-auditor',
    at: '2026-08-10T00:05:00.000Z',
  });

  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'nothing-delivered-to-acknowledge');
});

test('a failed notification can still be acknowledged, or it could never be cleared', () => {
  // The operator saw it on the dashboard. Requiring a successful delivery first would
  // leave every failed channel with a record nobody can ever close.
  let notification = raised();
  let at = '2026-08-10T00:00:30.000Z';
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const result = recordDeliveryAttempt({
      notification,
      outcome: 'failed',
      channelCode: 'operations-mail',
      reasonCode: 'channel-unreachable',
      at,
    });
    if (result.ok !== true) break;
    notification = result.notification;
    at = notification.nextAttemptAt ?? at;
  }

  const acknowledged = acknowledgeNotification({
    notification,
    actorCode: 'local-auditor',
    at: '2026-08-10T01:00:00.000Z',
  });

  assert.equal(acknowledged.ok, true);
  assert.equal(acknowledged.notification.state, 'acknowledged');
  assert.equal(acknowledged.notification.acknowledgedBy, 'local-auditor');
  assert.equal(acknowledged.notification.deliveryState, 'failed', 'acknowledging does not claim it was delivered');
});

test('acknowledging twice does not overwrite who saw it first', () => {
  const delivered = recordDeliveryAttempt({
    notification: raised(),
    outcome: 'delivered',
    channelCode: 'operations-mail',
    at: '2026-08-10T00:00:30.000Z',
  }).notification;
  const once = acknowledgeNotification({
    notification: delivered,
    actorCode: 'local-auditor',
    at: '2026-08-10T00:05:00.000Z',
  }).notification;

  const twice = acknowledgeNotification({
    notification: once,
    actorCode: 'local-admin',
    at: '2026-08-10T00:06:00.000Z',
  });

  assert.equal(twice.ok, false);
  assert.equal(twice.reasonCode, 'already-acknowledged');
  assert.equal(twice.notification.acknowledgedBy, 'local-auditor');
});

test('an attempt carries a bounded reason code, never the failure it came from', () => {
  assert.throws(
    () =>
      recordDeliveryAttempt({
        notification: raised(),
        outcome: 'failed',
        channelCode: 'operations-mail',
        reasonCode: 'connect ECONNREFUSED 10.0.0.4:443 while POSTing https://hooks.example/x?token=abc',
        at: '2026-08-10T00:00:30.000Z',
      }),
    /reasonCode/,
  );
});

test('an actor shaped like a directory object identifier never reaches the record', () => {
  const delivered = recordDeliveryAttempt({
    notification: raised(),
    outcome: 'delivered',
    channelCode: 'operations-mail',
    at: '2026-08-10T00:00:30.000Z',
  }).notification;

  assert.throws(
    () =>
      acknowledgeNotification({
        notification: delivered,
        actorCode: '4f2a7c11-8f0e-4a2f-9d3b-1c5e6a7b8c9d',
        at: '2026-08-10T00:05:00.000Z',
      }),
    /actorCode/,
  );
});

test('the record carries no body, principal, or credential vocabulary', () => {
  const delivered = recordDeliveryAttempt({
    notification: raised(),
    outcome: 'delivered',
    channelCode: 'operations-mail',
    at: '2026-08-10T00:00:30.000Z',
  }).notification;

  const serialized = JSON.stringify(delivered);
  for (const forbidden of ['prompt', 'completion', 'message', 'secret', 'authorization', 'subjectKey', 'recipient']) {
    assert.doesNotMatch(serialized, new RegExp(forbidden, 'i'));
  }
});
