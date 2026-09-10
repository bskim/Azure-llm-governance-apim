import assert from 'node:assert/strict';
import test from 'node:test';

import { projectNotifications } from '../../app/control-api/notifications-read-model-projector.mjs';
import {
  acknowledgeNotification,
  raiseNotification,
  recordDeliveryAttempt,
} from '../../app/governance-domain/notification/notification-delivery.mjs';

const SCOPE = 'platform-engineering';

const AUTHORIZATION = Object.freeze({
  contractVersion: 'v1',
  readAuthority: 'authoritative',
  permittedReadScopes: Object.freeze(['self', 'team', 'global']),
  permittedTeamKeys: Object.freeze(['platform-engineering']),
  effectiveRoles: Object.freeze(['governance-admin']),
  reasonCode: 'authorized',
});

function authorization(overrides = {}) {
  return { ...AUTHORIZATION, ...overrides };
}

function record({ scope = 'team', scopeKey = 'platform-engineering', atBasisPoints = 8000, kind = 'budget-threshold-reached' } = {}) {
  return raiseNotification({
    scopeGroupId: SCOPE,
    key: `notification|${SCOPE}|${kind}|budget-1|3|2026-08-01T00:00:00.000Z|${scope}|${scopeKey}|${atBasisPoints}`,
    kind,
    severity: kind === 'budget-exhausted' ? 'critical' : 'warning',
    scope,
    scopeKey,
    periodStart: '2026-08-01T00:00:00.000Z',
    raisedAt: '2026-08-10T00:00:00.000Z',
  });
}

function failedTwice(notification) {
  const first = recordDeliveryAttempt({
    notification,
    outcome: 'failed',
    channelCode: 'operations-mail',
    reasonCode: 'channel-unreachable',
    at: '2026-08-10T00:00:30.000Z',
  }).notification;
  return recordDeliveryAttempt({
    notification: first,
    outcome: 'failed',
    channelCode: 'operations-mail',
    reasonCode: 'channel-unreachable',
    at: first.nextAttemptAt,
  }).notification;
}

function project(records, overrides = {}) {
  return projectNotifications({
    authorization: authorization(),
    records,
    selection: {
      scope: 'global',
      teamKey: null,
      generatedAt: '2026-08-10T01:00:00.000Z',
      ...overrides,
    },
  });
}

test('a notification says whether it was delivered, and how many times it was tried', () => {
  const model = project([failedTwice(record())]);

  const [row] = model.records;
  assert.equal(row.state, 'pending');
  assert.equal(row.deliveryState, 'pending');
  assert.equal(row.attemptCount, 2);
  assert.equal(row.lastAttemptAt, '2026-08-10T00:01:30.000Z');
  assert.equal(row.lastReasonCode, 'channel-unreachable');
  assert.equal(row.nextAttemptAt, '2026-08-10T00:03:30.000Z');
});

test('an undelivered notification is not shown as an acknowledged one', () => {
  const delivered = recordDeliveryAttempt({
    notification: record(),
    outcome: 'delivered',
    channelCode: 'operations-mail',
    at: '2026-08-10T00:00:30.000Z',
  }).notification;
  const acknowledged = acknowledgeNotification({
    notification: delivered,
    actorCode: 'local-auditor',
    at: '2026-08-10T00:05:00.000Z',
  }).notification;

  const model = project([record({ atBasisPoints: 9000 }), acknowledged]);

  const rows = new Map(model.records.map((row) => [row.state, row]));
  assert.equal(rows.get('pending').acknowledgedByCode, null);
  assert.equal(rows.get('acknowledged').acknowledgedByCode, 'local-auditor');
  assert.equal(rows.get('acknowledged').deliveryState, 'delivered');
});

test('outstanding work is counted so an empty screen is not read as a healthy one', () => {
  const model = project([record(), failedTwice(record({ atBasisPoints: 9000 }))]);

  assert.equal(model.quality.state, 'complete');
  assert.equal(model.summary.pending, 2);
  assert.equal(model.summary.failed, 0);
  assert.equal(model.summary.acknowledged, 0);
  assert.equal(model.summary.total, 2);
});

test('an unreadable notification source is stated rather than shown as no notifications', () => {
  const model = projectNotifications({
    authorization: authorization(),
    records: null,
    selection: { scope: 'global', teamKey: null, generatedAt: '2026-08-10T01:00:00.000Z' },
  });

  assert.equal(model.quality.state, 'unavailable');
  assert.equal(model.quality.reasonCode, 'notification-source-unavailable');
  assert.deepEqual(model.records, []);
  assert.equal(model.summary, null, 'a count nobody could measure is absent, not zero');
});

test('a self scope sees the crossings that apply to everyone, not another team', () => {
  const model = projectNotifications({
    authorization: authorization({ permittedReadScopes: ['self'], permittedTeamKeys: [] }),
    records: [
      record({ scope: 'organization', scopeKey: '' }),
      record({ scope: 'team', scopeKey: 'developer-experience' }),
    ],
    selection: { scope: 'self', teamKey: null, generatedAt: '2026-08-10T01:00:00.000Z' },
  });

  assert.equal(model.records.length, 1);
  assert.equal(model.records[0].scopeKind, 'organization');
});

test('a scope the caller may not read is refused rather than filtered to nothing', () => {
  assert.throws(
    () =>
      projectNotifications({
        authorization: authorization({ permittedReadScopes: ['self'], permittedTeamKeys: [] }),
        records: [record()],
        selection: { scope: 'global', teamKey: null, generatedAt: '2026-08-10T01:00:00.000Z' },
      }),
    (error) => error.code === 'scope-denied',
  );
});

test('the read model carries no body, credential, or raw principal vocabulary', () => {
  const model = project([failedTwice(record())]);
  const serialized = JSON.stringify(model);
  for (const forbidden of ['prompt', 'completion', 'secret', 'authorization', 'recipient', 'subjectKey']) {
    assert.doesNotMatch(serialized, new RegExp(forbidden, 'i'));
  }
});
