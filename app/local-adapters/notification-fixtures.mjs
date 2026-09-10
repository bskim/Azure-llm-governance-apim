import {
  acknowledgeNotification,
  raiseNotification,
  recordDeliveryAttempt,
} from '../governance-domain/notification/notification-delivery.mjs';

/**
 * Notification records covering every state the screen has to be able to show.
 *
 * They are built by driving the real delivery rules rather than by writing the
 * finished shapes, so a state that has been rendered is a state that is reachable.
 */

const SCOPE_GROUP_ID = 'platform-engineering';
const PERIOD_START = '2026-07-01T00:00:00.000Z';

function key({ kind, scope, scopeKey, atBasisPoints }) {
  return [
    'notification',
    SCOPE_GROUP_ID,
    kind,
    'budget-platform-monthly',
    '3',
    PERIOD_START,
    scope,
    scopeKey,
    atBasisPoints,
  ].join('|');
}

function raise({ kind, severity, scope, scopeKey, atBasisPoints, raisedAt }) {
  return raiseNotification({
    scopeGroupId: SCOPE_GROUP_ID,
    key: key({ kind, scope, scopeKey, atBasisPoints }),
    kind,
    severity,
    scope,
    scopeKey,
    periodStart: PERIOD_START,
    raisedAt,
  });
}

function build() {
  const acknowledged = acknowledgeNotification({
    notification: recordDeliveryAttempt({
      notification: raise({
        kind: 'budget-threshold-reached',
        severity: 'warning',
        scope: 'organization',
        scopeKey: '',
        atBasisPoints: 8000,
        raisedAt: '2026-07-24T06:00:00.000Z',
      }),
      outcome: 'delivered',
      channelCode: 'operations-mail',
      at: '2026-07-24T06:00:20.000Z',
    }).notification,
    actorCode: 'local-auditor',
    at: '2026-07-24T06:12:00.000Z',
  }).notification;

  const delivered = recordDeliveryAttempt({
    notification: raise({
      kind: 'budget-exhausted',
      severity: 'critical',
      scope: 'team',
      scopeKey: 'platform-engineering',
      atBasisPoints: 10000,
      raisedAt: '2026-07-24T08:00:00.000Z',
    }),
    outcome: 'delivered',
    channelCode: 'operations-mail',
    at: '2026-07-24T08:00:15.000Z',
  }).notification;

  let retrying = raise({
    kind: 'aggregate-stale',
    severity: 'warning',
    scope: 'organization',
    scopeKey: '',
    atBasisPoints: '',
    raisedAt: '2026-07-24T09:00:00.000Z',
  });
  retrying = recordDeliveryAttempt({
    notification: retrying,
    outcome: 'failed',
    channelCode: 'operations-mail',
    reasonCode: 'channel-unreachable',
    at: '2026-07-24T09:00:10.000Z',
  }).notification;

  let exhausted = raise({
    kind: 'budget-unenforceable',
    severity: 'warning',
    scope: 'team',
    scopeKey: 'developer-experience',
    atBasisPoints: '',
    raisedAt: '2026-07-24T07:00:00.000Z',
  });
  let at = '2026-07-24T07:00:10.000Z';
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const result = recordDeliveryAttempt({
      notification: exhausted,
      outcome: 'failed',
      channelCode: 'operations-mail',
      reasonCode: 'channel-rejected',
      at,
    });
    if (result.ok !== true) break;
    exhausted = result.notification;
    at = exhausted.nextAttemptAt ?? at;
  }

  return Object.freeze([acknowledged, delivered, retrying, exhausted]);
}

const RECORDS = build();

export function getLocalNotifications() {
  return RECORDS;
}
