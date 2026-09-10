import { NOTIFICATION_KINDS } from '../notification/notification-delivery.mjs';

/**
 * Governance events that are not budget crossings but still owe somebody a warning.
 *
 * A publish that failed and a usage window the provider disagrees with are both
 * facts an operator has to act on, and both are re-observed every time a schedule
 * runs. So they get the same treatment as a budget crossing: a stable key per fact,
 * compared against what has already been raised.
 */

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

function assertKind(kind) {
  if (!KNOWN_KINDS.has(kind)) fail(`kind '${kind}' is not a notification kind this product defines.`);
  return kind;
}

function eventKey(parts) {
  return ['notification', ...parts.map((part) => part ?? '')].join('|');
}

function collect(candidates, alreadyNotified) {
  const planned = [];
  const suppressed = [];
  for (const candidate of candidates) {
    if (alreadyNotified.has(candidate.key)) {
      suppressed.push({ key: candidate.key, reasonCode: 'already-notified' });
      continue;
    }
    if (planned.some((existing) => existing.key === candidate.key)) continue;
    planned.push(Object.freeze(candidate));
  }
  return Object.freeze({ planned: Object.freeze(planned), suppressed: Object.freeze(suppressed) });
}

/**
 * @param revisions - the lifecycle revisions as they currently stand.
 */
export function planPublishNotifications({
  scopeGroupId,
  revisions,
  evaluationTime,
  alreadyNotified = new Set(),
  kind = 'publish-failed',
}) {
  if (typeof scopeGroupId !== 'string' || scopeGroupId.length === 0) fail('scopeGroupId is required.');
  if (!Array.isArray(revisions)) fail('revisions must be an array.');
  assertInstant(evaluationTime, 'evaluationTime');
  assertKind(kind);

  const candidates = revisions
    .filter((revision) => revision.state === 'failed' && revision.failure !== null)
    .map((revision) => ({
      // The attempt, not the revision: the revision number does not move when a
      // publish is retried, so a second failure would otherwise be silenced.
      key: eventKey([
        scopeGroupId,
        kind,
        revision.revisionId,
        revision.publishStartedAt,
        revision.failure.reasonCode,
      ]),
      kind,
      severity: 'critical',
      scopeGroupId,
      scope: 'organization',
      scopeKey: null,
      periodStart: revision.publishStartedAt,
      raisedAt: evaluationTime,
    }));

  return collect(candidates, alreadyNotified);
}

/**
 * @param drift - one `detectUsageDrift` result.
 */
export function planDriftNotifications({ scopeGroupId, drift, evaluationTime, alreadyNotified = new Set() }) {
  if (typeof scopeGroupId !== 'string' || scopeGroupId.length === 0) fail('scopeGroupId is required.');
  if (drift === null || typeof drift !== 'object') fail('drift is required.');
  assertInstant(evaluationTime, 'evaluationTime');

  // An indeterminate comparison is not agreement. Saying nothing would present an
  // unchecked window as a checked one.
  const kind =
    drift.state === 'disputed'
      ? 'usage-drift-detected'
      : drift.state === 'indeterminate'
        ? 'usage-drift-unverifiable'
        : null;
  if (kind === null) return collect([], alreadyNotified);

  return collect(
    [
      {
        key: eventKey([scopeGroupId, kind, drift.windowStart, drift.windowEnd, drift.reasonCode]),
        kind,
        severity: kind === 'usage-drift-detected' ? 'critical' : 'warning',
        scopeGroupId,
        scope: 'organization',
        scopeKey: null,
        periodStart: drift.windowStart,
        raisedAt: evaluationTime,
      },
    ],
    alreadyNotified,
  );
}
