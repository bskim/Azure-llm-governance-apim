import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RETENTION_DAYS,
  planNotificationRetention,
} from '../../app/governance-domain/notification/notification-retention.mjs';
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

function raised(raisedAt, atBasisPoints = 8000) {
  return raiseNotification({
    scopeGroupId: SCOPE,
    key: `notification|${SCOPE}|budget-threshold-reached|budget-1|3|2026-01-01T00:00:00.000Z|team|platform|${atBasisPoints}`,
    kind: 'budget-threshold-reached',
    severity: 'warning',
    scope: 'team',
    scopeKey: 'platform-engineering',
    periodStart: '2026-01-01T00:00:00.000Z',
    raisedAt,
  });
}

function delivered(raisedAt, atBasisPoints) {
  return recordDeliveryAttempt({
    notification: raised(raisedAt, atBasisPoints),
    outcome: 'delivered',
    channelCode: 'operations-mail',
    at: raisedAt,
  }).notification;
}

function acknowledged(raisedAt, acknowledgedAt, atBasisPoints) {
  return acknowledgeNotification({
    notification: delivered(raisedAt, atBasisPoints),
    actorCode: 'local-auditor',
    at: acknowledgedAt,
  }).notification;
}

function exhausted(raisedAt, atBasisPoints) {
  let notification = raised(raisedAt, atBasisPoints);
  let at = raisedAt;
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
  return notification;
}

function plan(records) {
  return planNotificationRetention({ records, now: NOW });
}

test('an acknowledged notification past its retention is expired', () => {
  const result = plan([acknowledged(daysBefore(200), daysBefore(120))]);

  assert.equal(result.expiring.length, 1);
  assert.equal(result.expiring[0].reasonCode, 'retention-elapsed');
  assert.deepEqual(result.retained, []);
});

test('an acknowledged notification inside its retention is kept', () => {
  const result = plan([acknowledged(daysBefore(100), daysBefore(89))]);

  assert.deepEqual(result.expiring, []);
  assert.equal(result.retained[0].reasonCode, 'within-retention');
});

test('a notification nobody acknowledged is kept however old it is', () => {
  // Retention must never be the reason a warning disappears unseen. Age is not
  // evidence that anyone saw it.
  const result = plan([delivered(daysBefore(3000)), exhausted(daysBefore(3000), 9000)]);

  assert.deepEqual(result.expiring, []);
  assert.deepEqual(
    result.retained.map((entry) => entry.reasonCode),
    ['not-acknowledged', 'not-acknowledged'],
  );
});

test('a notification still awaiting delivery is kept', () => {
  const result = plan([raised(daysBefore(500))]);

  assert.deepEqual(result.expiring, []);
  assert.equal(result.retained[0].reasonCode, 'not-acknowledged');
});

test('retention is measured from acknowledgement, not from when it was raised', () => {
  // Something raised long ago but only just acknowledged has only just become
  // closed, and the record of closing it is the part worth keeping.
  const result = plan([acknowledged(daysBefore(1000), daysBefore(1))]);

  assert.deepEqual(result.expiring, []);
  assert.equal(result.retained[0].reasonCode, 'within-retention');
});

test('the boundary day is retained rather than removed', () => {
  const exactly = plan([acknowledged(daysBefore(200), daysBefore(RETENTION_DAYS))]);
  const past = plan([acknowledged(daysBefore(200), daysBefore(RETENTION_DAYS + 1))]);

  assert.deepEqual(exactly.expiring, [], 'the day it becomes eligible is not the day it goes');
  assert.equal(past.expiring.length, 1);
});

test('the retention period is the one the product decided', () => {
  assert.equal(RETENTION_DAYS, 90);
});

test('a record whose acknowledgement is unreadable is kept rather than guessed at', () => {
  const record = { ...acknowledged(daysBefore(200), daysBefore(120)), acknowledgedAt: null };

  const result = plan([record]);
  assert.deepEqual(result.expiring, []);
  assert.equal(result.retained[0].reasonCode, 'acknowledgement-time-unknown');
});
