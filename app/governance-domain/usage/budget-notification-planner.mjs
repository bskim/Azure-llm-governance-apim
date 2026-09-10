/**
 * Decides which governance notifications a period has earned.
 *
 * The hard part is not noticing that a threshold was crossed; it is noticing it
 * exactly once. A scheduler re-runs, a window is re-read, an operator triggers a
 * backfill, and every one of those sees the same crossing again. So the planner
 * derives a stable key per crossing and compares it with what has already been
 * sent, rather than emitting on every observation and asking the delivery layer
 * to sort it out.
 *
 * The other half is refusing to notify from evidence that cannot support it. An
 * incomplete window is not a quiet one, and treating it as low consumption would
 * suppress the warning the period actually earned.
 */

import { NOTIFICATION_KINDS as KNOWN_KINDS } from '../notification/notification-delivery.mjs';
import { matchesBudgetObservation } from './period-consumption.mjs';

const NOTIFICATION_KINDS = new Set([
  'budget-threshold-reached',
  'budget-exhausted',
  'budget-unenforceable',
  'aggregate-stale',
]);

for (const kind of NOTIFICATION_KINDS) {
  // The record refuses a kind the product does not define, so a kind this planner can
  // emit but the ledger would reject is a defect nobody would see until it fired.
  if (!KNOWN_KINDS.includes(kind)) throw new TypeError(`${kind} is not a defined notification kind.`);
}

const SEVERITY_BY_KIND = Object.freeze({
  'budget-threshold-reached': 'warning',
  'budget-exhausted': 'critical',
  'budget-unenforceable': 'warning',
  'aggregate-stale': 'warning',
});

const EXHAUSTED_BASIS_POINTS = 10_000;

function fail(message) {
  throw new TypeError(message);
}

function assertInstant(value, name) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    fail(`${name} must be an ISO-8601 instant.`);
  }
  return value;
}

/**
 * A version is part of the key because a republished budget warns about a
 * different number. Keeping the old key would mean the new threshold is crossed
 * and nobody hears about it.
 */
export function notificationKey({ scopeGroupId, kind, budgetId, budgetVersion, periodStart, scope, scopeKey, atBasisPoints }) {
  if (!NOTIFICATION_KINDS.has(kind)) fail(`kind '${kind}' is unsupported.`);
  return [
    'notification',
    scopeGroupId,
    kind,
    budgetId ?? '',
    budgetVersion ?? '',
    periodStart,
    scope ?? '',
    scopeKey ?? '',
    atBasisPoints ?? '',
  ].join('|');
}

function consumedBasisPoints(consumedTokens, quota) {
  if (!Number.isFinite(quota) || quota <= 0) return null;
  return Math.floor((consumedTokens / quota) * EXHAUSTED_BASIS_POINTS);
}

/**
 * The thresholds one budget can earn a notification for, highest first.
 *
 * Exhaustion is listed separately from the warning rather than treated as a
 * hundred-percent warning, because they are different events to a reader: one
 * says traffic is about to be affected and the other says it already is.
 */
function thresholdsFor(entry) {
  const thresholds = [];
  if (entry.enforcedTokenQuota !== null) {
    thresholds.push({
      kind: 'budget-exhausted',
      atBasisPoints: EXHAUSTED_BASIS_POINTS,
    });
    if (entry.warnThresholdPercent !== null && entry.warnThresholdPercent < 100) {
      thresholds.push({
        kind: 'budget-threshold-reached',
        atBasisPoints: entry.warnThresholdPercent * 100,
      });
    }
  }
  return thresholds;
}

function observationFor(observations, entry) {
  return observations.find((candidate) => matchesBudgetObservation(candidate, entry));
}

export function planBudgetNotifications({
  scopeGroupId,
  publication,
  observations,
  periodStart,
  evaluationTime,
  alreadyNotified = new Set(),
}) {
  if (typeof scopeGroupId !== 'string' || scopeGroupId.length === 0) fail('scopeGroupId is required.');
  if (publication === null || typeof publication !== 'object') fail('publication is required.');
  if (!Array.isArray(observations)) fail('observations must be an array.');
  assertInstant(periodStart, 'periodStart');
  assertInstant(evaluationTime, 'evaluationTime');

  const planned = [];
  const suppressed = [];

  const emit = (notification) => {
    if (alreadyNotified.has(notification.key)) {
      suppressed.push({ key: notification.key, reasonCode: 'already-notified' });
      return;
    }
    // A single evaluation can reach the same crossing twice when two observations
    // map onto one budget, and that is still one crossing.
    if (planned.some((candidate) => candidate.key === notification.key)) return;
    planned.push(Object.freeze(notification));
  };

  const base = (kind, entry, extra) =>
    Object.freeze({
      contractVersion: 'v1',
      documentType: 'governance-notification',
      key: notificationKey({
        scopeGroupId,
        kind,
        budgetId: entry?.budgetId ?? null,
        budgetVersion: entry?.budgetVersion ?? null,
        periodStart,
        scope: entry?.scope ?? extra?.scope ?? null,
        scopeKey: entry?.scopeKey ?? extra?.scopeKey ?? null,
        atBasisPoints: extra?.atBasisPoints ?? null,
      }),
      kind,
      severity: SEVERITY_BY_KIND[kind],
      scopeGroupId,
      periodStart,
      raisedAt: evaluationTime,
      ...extra,
    });

  if (publication.state !== 'published') {
    // Nothing to compare consumption against, and saying nothing would read as a
    // period that earned no warnings.
    return Object.freeze({
      planned: Object.freeze([
        base('budget-unenforceable', null, { reasonCode: publication.reasonCode }),
      ].filter((notification) => !alreadyNotified.has(notification.key))),
      suppressed: Object.freeze([]),
    });
  }

  for (const entry of publication.entries) {
    if (entry.state !== 'enforceable') {
      emit(
        base('budget-unenforceable', entry, {
          budgetId: entry.budgetId,
          scope: entry.scope,
          scopeKey: entry.scopeKey ?? null,
          reasonCode: entry.reasonCode,
        }),
      );
      continue;
    }

    const observation = observationFor(observations, entry);
    if (observation === undefined) {
      suppressed.push({ budgetId: entry.budgetId, reasonCode: 'no-observation' });
      continue;
    }
    // An incomplete window is not a quiet one. Reading it as low consumption would
    // suppress exactly the warning the period earned.
    if (observation.completeness !== 'complete') {
      emit(
        base('aggregate-stale', entry, {
          budgetId: entry.budgetId,
          scope: entry.scope,
          scopeKey: entry.scopeKey ?? null,
          reasonCode: observation.completenessReason ?? 'aggregate-incomplete',
        }),
      );
      continue;
    }

    const consumed = consumedBasisPoints(observation.consumedTokens, entry.enforcedTokenQuota);
    if (consumed === null) {
      suppressed.push({ budgetId: entry.budgetId, reasonCode: 'no-quota-to-measure' });
      continue;
    }

    for (const threshold of thresholdsFor(entry)) {
      if (consumed < threshold.atBasisPoints) continue;
      emit(
        base(threshold.kind, entry, {
          budgetId: entry.budgetId,
          scope: entry.scope,
          // Which team or subject crossed, not only which budget: the dedup key
          // separates them, but a reader filters on the record.
          scopeKey: entry.scopeKey ?? null,
          action: entry.action,
          atBasisPoints: threshold.atBasisPoints,
          consumedBasisPoints: consumed,
          enforcedTokenQuota: entry.enforcedTokenQuota,
        }),
      );
    }
  }

  return Object.freeze({
    planned: Object.freeze(planned),
    suppressed: Object.freeze(suppressed),
  });
}
