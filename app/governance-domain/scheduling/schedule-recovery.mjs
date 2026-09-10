/**
 * Deciding what a schedule owes after a restart, and who is allowed to run it.
 *
 * A schedule that only ever runs "now" loses everything that fell due while the
 * process was down, and the loss is invisible: the dashboard reads as a quiet period
 * rather than an absent one. The checkpoint records how far the work actually got,
 * so the answer to "what is owed" survives the process that was supposed to do it.
 *
 * Two runners are assumed, not guarded against. A lease decides which one proceeds,
 * and it expires, because a runner that dies holding one would otherwise stop the
 * schedule permanently. Expiry means the same window can be attempted twice, so a run
 * is identified by its window rather than by the attempt.
 */

const SAFE_CODE = /^[a-z][a-z0-9-]{2,63}$/;
const RAW_PRINCIPAL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BACKFILL_WINDOWS = 48;

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
  if (RAW_PRINCIPAL.test(value)) fail(`${name} must not be a directory object identifier.`);
  return value;
}

function instantOf(value) {
  return new Date(value).toISOString();
}

function shift(instant, seconds) {
  return new Date(Date.parse(instant) + seconds * 1000).toISOString();
}

export function scheduleCheckpointDocumentId({ scopeGroupId, scheduleId }) {
  if (typeof scopeGroupId !== 'string' || scopeGroupId.length === 0) fail('scopeGroupId is required.');
  assertCode(scheduleId, 'scheduleId');
  return `schedule-checkpoint|${scopeGroupId}|${scheduleId}`;
}

export function createScheduleCheckpoint({ scopeGroupId, scheduleId, intervalSeconds, startedFrom }) {
  if (typeof scopeGroupId !== 'string' || scopeGroupId.length === 0) fail('scopeGroupId is required.');
  assertCode(scheduleId, 'scheduleId');
  if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < 1) {
    fail('intervalSeconds must be a positive integer.');
  }
  assertInstant(startedFrom, 'startedFrom');

  return Object.freeze({
    contractVersion: 'v1',
    documentType: 'schedule-checkpoint',
    id: scheduleCheckpointDocumentId({ scopeGroupId, scheduleId }),
    scopeGroupId,
    scheduleId,
    intervalSeconds,
    startedFrom: instantOf(startedFrom),
    completedThrough: null,
    lastCompletedAt: null,
    lease: null,
    skipped: null,
  });
}

export function assertScheduleCheckpoint(document) {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    fail('A schedule checkpoint must be an object.');
  }
  if (document.contractVersion !== 'v1') fail('Unsupported checkpoint contract version.');
  if (document.documentType !== 'schedule-checkpoint') fail('documentType must be schedule-checkpoint.');
  if (typeof document.scopeGroupId !== 'string' || document.scopeGroupId.length === 0) {
    fail('scopeGroupId is required.');
  }
  assertCode(document.scheduleId, 'scheduleId');
  if (document.id !== scheduleCheckpointDocumentId(document)) {
    fail('id must be derived from scopeGroupId and scheduleId.');
  }
  if (!Number.isSafeInteger(document.intervalSeconds) || document.intervalSeconds < 1) {
    fail('intervalSeconds must be a positive integer.');
  }
  assertInstant(document.startedFrom, 'startedFrom');
  if (document.completedThrough !== null) assertInstant(document.completedThrough, 'completedThrough');
  if (document.lastCompletedAt !== null) assertInstant(document.lastCompletedAt, 'lastCompletedAt');

  if (document.lease !== null) {
    assertCode(document.lease.ownerCode, 'lease.ownerCode');
    assertInstant(document.lease.acquiredAt, 'lease.acquiredAt');
    assertInstant(document.lease.expiresAt, 'lease.expiresAt');
    assertInstant(document.lease.plannedThrough, 'lease.plannedThrough');
  }

  if (document.skipped !== null) {
    if (!Number.isSafeInteger(document.skipped.count) || document.skipped.count < 1) {
      fail('skipped.count must be a positive integer.');
    }
    assertInstant(document.skipped.windowStart, 'skipped.windowStart');
    assertInstant(document.skipped.windowEnd, 'skipped.windowEnd');
    assertCode(document.skipped.reasonCode, 'skipped.reasonCode');
  }
  return document;
}

function refusal(reasonCode, checkpoint) {
  return Object.freeze({
    ok: false,
    reasonCode,
    windows: Object.freeze([]),
    skipped: checkpoint.skipped,
    checkpoint,
  });
}

/**
 * @param maxBackfillWindows - how much of a long outage one run will attempt. The
 *   remainder is reported rather than discarded; a gap nobody is told about is
 *   indistinguishable from a period with nothing in it.
 */
export function planScheduleRun({
  checkpoint,
  now,
  ownerCode,
  leaseSeconds,
  maxBackfillWindows = MAX_BACKFILL_WINDOWS,
}) {
  assertScheduleCheckpoint(checkpoint);
  assertInstant(now, 'now');
  assertCode(ownerCode, 'ownerCode');
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1) {
    fail('leaseSeconds must be a positive integer.');
  }
  if (!Number.isSafeInteger(maxBackfillWindows) || maxBackfillWindows < 1) {
    fail('maxBackfillWindows must be a positive integer.');
  }

  const { intervalSeconds } = checkpoint;
  const from = checkpoint.completedThrough ?? checkpoint.startedFrom;
  if (Date.parse(now) < Date.parse(from)) return refusal('clock-behind-checkpoint', checkpoint);

  if (
    checkpoint.lease !== null &&
    checkpoint.lease.ownerCode !== ownerCode &&
    Date.parse(now) < Date.parse(checkpoint.lease.expiresAt)
  ) {
    return refusal('lease-held', checkpoint);
  }

  const closed = Math.floor((Date.parse(now) - Date.parse(from)) / (intervalSeconds * 1000));
  if (closed < 1) return refusal('nothing-due', { ...checkpoint, lease: null });

  const runnable = Math.min(closed, maxBackfillWindows);
  // The newest windows are the ones run. A dashboard that is current matters more
  // than replaying a week nobody is waiting on, and the remainder is still reported.
  const firstIndex = closed - runnable;
  const windows = Object.freeze(
    Array.from({ length: runnable }, (unused, offset) => {
      const windowStart = shift(from, (firstIndex + offset) * intervalSeconds);
      return Object.freeze({
        windowStart,
        windowEnd: shift(windowStart, intervalSeconds),
        runId: `${checkpoint.id}|${windowStart}`,
      });
    }),
  );

  const skipped =
    firstIndex === 0
      ? checkpoint.skipped
      : Object.freeze({
          count: firstIndex,
          windowStart: from,
          windowEnd: windows[0].windowStart,
          reasonCode: 'backfill-limit-reached',
        });

  return Object.freeze({
    ok: true,
    reasonCode: 'run-planned',
    windows,
    skipped,
    checkpoint: Object.freeze({
      ...checkpoint,
      skipped,
      lease: Object.freeze({
        ownerCode,
        acquiredAt: instantOf(now),
        expiresAt: shift(now, leaseSeconds),
        plannedThrough: windows.at(-1).windowEnd,
      }),
    }),
  });
}

export function completeScheduleRun({ checkpoint, ownerCode, through, at }) {
  assertScheduleCheckpoint(checkpoint);
  assertCode(ownerCode, 'ownerCode');
  assertInstant(through, 'through');
  assertInstant(at, 'at');

  const { lease } = checkpoint;
  if (lease === null || lease.ownerCode !== ownerCode) {
    return Object.freeze({ ok: false, reasonCode: 'lease-not-held', checkpoint });
  }
  // A runner that ran past its lease may have been overtaken, so its result is no
  // longer the only one that touched these windows.
  if (Date.parse(at) >= Date.parse(lease.expiresAt)) {
    return Object.freeze({ ok: false, reasonCode: 'lease-expired', checkpoint });
  }
  if (Date.parse(through) > Date.parse(lease.plannedThrough)) {
    return Object.freeze({ ok: false, reasonCode: 'completion-beyond-plan', checkpoint });
  }
  const floor = checkpoint.completedThrough ?? checkpoint.startedFrom;
  if (Date.parse(through) < Date.parse(floor)) {
    return Object.freeze({ ok: false, reasonCode: 'completion-behind-checkpoint', checkpoint });
  }

  return Object.freeze({
    ok: true,
    reasonCode: 'run-recorded',
    checkpoint: Object.freeze({
      ...checkpoint,
      completedThrough: instantOf(through),
      lastCompletedAt: instantOf(at),
      lease: null,
    }),
  });
}
