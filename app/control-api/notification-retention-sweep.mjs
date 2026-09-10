import { createScheduleRunner } from './schedule-runner.mjs';
import { planNotificationRetention } from '../governance-domain/notification/notification-retention.mjs';

/**
 * Removing notifications that have been closed for long enough.
 *
 * Retention is a state of the world rather than a per-day event, so a schedule that
 * missed a month runs one pass, not thirty identical ones — the backfill limit is
 * one window on purpose, and the days it declines are still reported.
 *
 * Each removal is written against the version the sweep read. A record acknowledged
 * again in between is left alone: it was not the record the decision was made about.
 */

const ONE_DAY_SECONDS = 86_400;

function fail(message) {
  throw new TypeError(message);
}

export function createNotificationRetentionSweep({
  store,
  ledger,
  clock,
  scopeGroupId,
  startedFrom,
  ownerCode,
  leaseSeconds,
  retentionDays,
  intervalSeconds = ONE_DAY_SECONDS,
  scheduleId = 'notification-retention',
}) {
  if (typeof store?.deleteNotification !== 'function') fail('store must be able to remove notifications.');
  if (typeof ledger?.list !== 'function') fail('ledger is required.');
  if (typeof clock?.nowIso !== 'function') fail('clock is required.');

  async function pass(counts) {
    const now = clock.nowIso();
    const records = await ledger.list({ sinceRaisedAt: '1970-01-01T00:00:00.000Z' });
    const plan = planNotificationRetention({
      records,
      now,
      ...(retentionDays === undefined ? {} : { retentionDays }),
    });
    counts.retained = plan.retained.length;

    for (const entry of plan.expiring) {
      const held = await store.readNotification({ scopeGroupId, key: entry.key });
      if (held === null) continue;
      try {
        if (await store.deleteNotification({ scopeGroupId, key: entry.key }, { ifMatch: held.etag })) {
          counts.removed += 1;
        }
      } catch (error) {
        if (error?.name !== 'ConcurrencyConflictError') throw error;
        counts.contended += 1;
      }
    }
  }

  async function tick() {
    // Counted per tick rather than on the sweep, so two ticks cannot add to each
    // other's totals.
    const counts = { removed: 0, retained: 0, contended: 0 };
    const runner = createScheduleRunner({
      store,
      scopeGroupId,
      scheduleId,
      intervalSeconds,
      startedFrom,
      leaseSeconds,
      ownerCode,
      // Retention is a state of the world, not a per-day event: replaying a month of
      // missed days would repeat the same pass for the same answer.
      maxBackfillWindows: 1,
      run: () => pass(counts),
    });
    const result = await runner.tick(clock.nowIso());
    return Object.freeze({ ...result, ...counts });
  }

  return Object.freeze({ tick });
}
