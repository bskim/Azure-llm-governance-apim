import { assertAuthorizedReadScope } from './admin-read-authorization.mjs';
import { assertBodyFreeReadModel } from './admin-read-model-projector.mjs';

/**
 * The notifications screen: what a period earned, and what happened to it since.
 *
 * Delivery and acknowledgement are shown as separate columns because they answer
 * different questions. "Nobody has acknowledged this" and "this never left the
 * building" call for different actions, and a single status word would merge them.
 */

const SAFE_READ_MODEL_KEYS = new Set([
  'readModelVersion',
  'generatedAt',
  'readModelId',
  'quality',
  'summary',
  'records',
]);

// An organization crossing applies to every caller and names no other principal, so
// it stays visible at every scope. A team or subject crossing does not.
const VISIBLE_SCOPES = Object.freeze({
  global: Object.freeze(['organization', 'team', 'subject', 'application']),
  team: Object.freeze(['organization', 'team']),
  self: Object.freeze(['organization', 'subject', 'application']),
});

function assertSelection(selection) {
  if (!Object.hasOwn(VISIBLE_SCOPES, selection.scope)) {
    const error = new Error('scope-not-supported');
    error.code = 'scope-not-supported';
    throw error;
  }
}

function projectRecord(record) {
  const lastAttempt = record.attempts.at(-1) ?? null;
  return {
    notificationCode: record.key,
    kind: record.kind,
    severity: record.severity,
    scopeKind: record.scope,
    scopeCode: record.scopeKey,
    periodStart: record.periodStart,
    raisedAt: record.raisedAt,
    state: record.state,
    deliveryState: record.deliveryState,
    reasonCode: record.reasonCode,
    attemptCount: record.attempts.length,
    lastAttemptAt: lastAttempt?.at ?? null,
    lastChannelCode: lastAttempt?.channelCode ?? null,
    lastReasonCode: lastAttempt?.reasonCode ?? null,
    nextAttemptAt: record.nextAttemptAt,
    acknowledgedByCode: record.acknowledgedBy,
    acknowledgedAt: record.acknowledgedAt,
  };
}

export function projectNotifications({ authorization, records, selection }) {
  assertAuthorizedReadScope({
    authorization,
    scope: selection.scope,
    teamKey: selection.teamKey,
  });
  assertSelection(selection);

  // A source that could not be read is not a period without notifications, and the
  // difference is the whole reason this screen exists.
  const unavailable = !Array.isArray(records);
  const visible = VISIBLE_SCOPES[selection.scope];
  const rows = unavailable
    ? []
    : records
        .filter((record) => visible.includes(record.scope))
        .map(projectRecord)
        .sort(
          (left, right) =>
            right.raisedAt.localeCompare(left.raisedAt) ||
            left.notificationCode.localeCompare(right.notificationCode),
        );

  const countOf = (state) => rows.filter((row) => row.state === state).length;

  const readModel = {
    readModelVersion: 'notifications.v1',
    generatedAt: selection.generatedAt,
    readModelId: `notifications-${selection.scope}-${selection.teamKey ?? 'none'}`,
    quality: {
      state: unavailable ? 'unavailable' : 'complete',
      reasonCode: unavailable ? 'notification-source-unavailable' : 'notifications-read',
    },
    // Counts nobody could measure are absent rather than zero, because a zero here
    // reads as "nothing outstanding".
    summary: unavailable
      ? null
      : {
          total: rows.length,
          pending: countOf('pending'),
          delivered: countOf('delivered'),
          failed: countOf('failed'),
          acknowledged: countOf('acknowledged'),
        },
    records: rows,
  };

  assertBodyFreeReadModel(readModel, SAFE_READ_MODEL_KEYS);
  return Object.freeze(readModel);
}
