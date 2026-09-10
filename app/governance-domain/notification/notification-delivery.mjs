/**
 * What happened to a notification after it was earned.
 *
 * Deciding that a threshold was crossed is a different job from getting somebody to
 * see it, and the second one fails in ways the first cannot describe: a channel is
 * down, a retry is pending, nobody has acknowledged it. Without a record of that, a
 * notification that was never delivered is indistinguishable from one that was.
 *
 * Delivery and acknowledgement are separate axes on purpose. An operator who reads a
 * failure on the dashboard has genuinely seen it, and must be able to close it —
 * but closing it must not claim the channel worked.
 */

const SAFE_CODE = /^[a-z][a-z0-9-]{2,63}$/;
const RAW_PRINCIPAL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DELIVERY_STATES = new Set(['pending', 'delivered', 'failed']);
const MAX_ATTEMPTS = 5;
const FIRST_BACKOFF_SECONDS = 60;

/**
 * The kinds the product defines. A typo would otherwise become a new kind that the
 * screen renders as a raw code and that nothing knows how to act on.
 */
export const NOTIFICATION_KINDS = Object.freeze([
  'budget-threshold-reached',
  'budget-exhausted',
  'budget-unenforceable',
  'aggregate-stale',
  'publish-failed',
  'usage-drift-detected',
  'usage-drift-unverifiable',
  'team-membership-ambiguous',
]);

/** Named because two producers raise it and a second spelling would be a second kind. */
export const TEAM_OVERLAP_KIND = 'team-membership-ambiguous';

const KNOWN_KINDS = new Set(NOTIFICATION_KINDS);

function fail(message) {
  throw new TypeError(message);
}

function assertInstant(value, name) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    fail(`${name} must be an ISO-8601 instant.`);
  }
  return value;
}

function assertCode(value, name) {
  if (typeof value !== 'string' || !SAFE_CODE.test(value)) {
    fail(`${name} must be a bounded lower-case code.`);
  }
  return value;
}

function assertActor(value, name) {
  assertCode(value, name);
  if (RAW_PRINCIPAL.test(value)) fail(`${name} must not be a directory object identifier.`);
  return value;
}

function assertKind(value) {
  assertCode(value, 'kind');
  if (!KNOWN_KINDS.has(value)) fail(`kind '${value}' is not a notification kind this product defines.`);
  return value;
}

export function notificationDocumentId({ scopeGroupId, key }) {
  if (typeof scopeGroupId !== 'string' || scopeGroupId.length === 0) fail('scopeGroupId is required.');
  if (typeof key !== 'string' || key.length === 0) fail('key is required.');
  return `governance-notification|${scopeGroupId}|${key}`;
}

function settle(notification, changes) {
  const next = { ...notification, ...changes };
  next.state = next.acknowledgedBy === null ? next.deliveryState : 'acknowledged';
  return Object.freeze({ ...next, attempts: Object.freeze(next.attempts) });
}

export function raiseNotification({ scopeGroupId, key, kind, severity, scope, scopeKey = null, periodStart, raisedAt }) {
  assertKind(kind);
  assertCode(severity, 'severity');
  assertCode(scope, 'scope');
  assertInstant(periodStart, 'periodStart');
  assertInstant(raisedAt, 'raisedAt');

  return settle(
    {
      contractVersion: 'v1',
      documentType: 'governance-notification',
      id: notificationDocumentId({ scopeGroupId, key }),
      scopeGroupId,
      key,
      kind,
      severity,
      // Already inside the key, but a reader that had to parse the key to filter by
      // scope would be depending on the key's shape staying a contract.
      scope,
      scopeKey: scopeKey === '' ? null : scopeKey,
      periodStart,
      raisedAt,
      deliveryState: 'pending',
      reasonCode: null,
      attempts: [],
      nextAttemptAt: raisedAt,
      acknowledgedBy: null,
      acknowledgedAt: null,
    },
    {},
  );
}

export function assertNotificationRecord(document) {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    fail('A notification record must be an object.');
  }
  if (document.contractVersion !== 'v1') fail('Unsupported notification contract version.');
  if (document.documentType !== 'governance-notification') {
    fail('documentType must be governance-notification.');
  }
  if (document.id !== notificationDocumentId(document)) fail('id must be derived from scopeGroupId and key.');
  if (!DELIVERY_STATES.has(document.deliveryState)) fail('deliveryState is unsupported.');
  assertKind(document.kind);
  assertCode(document.severity, 'severity');
  assertCode(document.scope, 'scope');
  if (!Array.isArray(document.attempts)) fail('attempts must be an array.');
  for (const attempt of document.attempts) {
    assertInstant(attempt.at, 'attempt.at');
    assertCode(attempt.channelCode, 'attempt.channelCode');
    assertCode(attempt.outcome, 'attempt.outcome');
    if (attempt.reasonCode !== null) assertCode(attempt.reasonCode, 'attempt.reasonCode');
  }
  if (document.acknowledgedBy !== null) assertActor(document.acknowledgedBy, 'acknowledgedBy');
  return document;
}

function refuse(reasonCode, notification) {
  return Object.freeze({ ok: false, reasonCode, notification });
}

/**
 * @param reasonCode - why the attempt failed, as a bounded code. The exception text
 *   would carry an endpoint, a host, or a credential into a record an operator reads.
 */
export function recordDeliveryAttempt({ notification, outcome, channelCode, reasonCode = null, at }) {
  assertNotificationRecord(notification);
  assertCode(outcome, 'outcome');
  assertCode(channelCode, 'channelCode');
  assertInstant(at, 'at');
  if (reasonCode !== null) assertCode(reasonCode, 'reasonCode');
  if (outcome !== 'delivered' && outcome !== 'failed') fail('outcome must be delivered or failed.');

  if (notification.acknowledgedBy !== null) return refuse('already-acknowledged', notification);
  if (notification.deliveryState === 'delivered') return refuse('already-delivered', notification);
  if (notification.deliveryState === 'failed') return refuse('delivery-attempts-exhausted', notification);

  const attempts = [...notification.attempts, Object.freeze({ at, channelCode, outcome, reasonCode })];

  if (outcome === 'delivered') {
    return Object.freeze({
      ok: true,
      reasonCode: 'delivery-recorded',
      notification: settle(notification, {
        attempts,
        deliveryState: 'delivered',
        reasonCode: null,
        nextAttemptAt: null,
      }),
    });
  }

  if (attempts.length >= MAX_ATTEMPTS) {
    // Retrying forever would hide the failure behind a queue nobody reads. It stays
    // on the record instead, with every attempt that was made.
    return Object.freeze({
      ok: true,
      reasonCode: 'delivery-attempts-exhausted',
      notification: settle(notification, {
        attempts,
        deliveryState: 'failed',
        reasonCode: 'delivery-attempts-exhausted',
        nextAttemptAt: null,
      }),
    });
  }

  const backoffSeconds = FIRST_BACKOFF_SECONDS * 2 ** (attempts.length - 1);
  return Object.freeze({
    ok: true,
    reasonCode: 'delivery-retry-scheduled',
    notification: settle(notification, {
      attempts,
      deliveryState: 'pending',
      reasonCode,
      nextAttemptAt: new Date(Date.parse(at) + backoffSeconds * 1000).toISOString(),
    }),
  });
}

export function acknowledgeNotification({ notification, actorCode, at }) {
  assertNotificationRecord(notification);
  assertActor(actorCode, 'actorCode');
  assertInstant(at, 'at');

  if (notification.acknowledgedBy !== null) return refuse('already-acknowledged', notification);
  if (notification.deliveryState === 'pending') {
    return refuse('nothing-delivered-to-acknowledge', notification);
  }

  return Object.freeze({
    ok: true,
    reasonCode: 'acknowledgement-recorded',
    notification: settle(notification, { acknowledgedBy: actorCode, acknowledgedAt: at }),
  });
}
