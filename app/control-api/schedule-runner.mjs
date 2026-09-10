import {
  completeScheduleRun,
  createScheduleCheckpoint,
  planScheduleRun,
} from '../governance-domain/scheduling/schedule-recovery.mjs';

/**
 * Running a schedule against a checkpoint that outlives the process.
 *
 * The lease is claimed by writing it, not by holding it in memory: two processes that
 * both decided to run have to be separated by something they can both see, and the
 * store is the only such thing. The loser learns it lost before doing any work, which
 * is the whole point — after the work, the damage is already written.
 *
 * Windows are completed one at a time. A run that dies halfway keeps what it finished
 * and releases the lease, so the next runner resumes rather than waiting out an
 * expiry nobody is coming back for.
 */

function fail(message) {
  throw new TypeError(message);
}

export function createScheduleRunner({
  store,
  scopeGroupId,
  scheduleId,
  intervalSeconds,
  startedFrom,
  leaseSeconds,
  ownerCode,
  run,
  maxBackfillWindows,
  onWindowFailed = null,
}) {
  if (typeof store?.readScheduleCheckpoint !== 'function' || typeof store?.putScheduleCheckpoint !== 'function') {
    fail('store must be able to read and write schedule checkpoints.');
  }
  if (typeof run !== 'function') fail('run must be a function.');

  const seed = createScheduleCheckpoint({ scopeGroupId, scheduleId, intervalSeconds, startedFrom });

  function skipped(reasonCode, plan) {
    return Object.freeze({ outcome: 'skipped', reasonCode, windows: 0, skipped: plan?.skipped ?? null });
  }

  async function tick(now) {
    const held = await store.readScheduleCheckpoint({ scopeGroupId, scheduleId });
    const checkpoint = held?.document ?? seed;

    const plan = planScheduleRun({
      checkpoint,
      now,
      ownerCode,
      leaseSeconds,
      ...(maxBackfillWindows === undefined ? {} : { maxBackfillWindows }),
    });
    if (plan.ok !== true) {
      // Nothing due and nothing stored is not the same as nothing due: the origin is
      // still only in this process, and a host that restarts between ticks derives a
      // later one every time, so no window is ever due and the schedule idles for
      // good. Recording the origin is what lets the next tick have work.
      if (held === null) {
        try {
          await store.putScheduleCheckpoint(seed, { ifMatch: null });
        } catch (error) {
          if (error?.name !== 'ConcurrencyConflictError') throw error;
        }
      }
      return skipped(plan.reasonCode, plan);
    }

    let claimed;
    try {
      claimed = await store.putScheduleCheckpoint(plan.checkpoint, {
        ifMatch: held === null ? null : held.etag,
      });
    } catch (error) {
      if (error?.name !== 'ConcurrencyConflictError') throw error;
      // Somebody else wrote between the read and the claim. Their plan covers these
      // windows, so doing the work anyway would double it.
      return skipped('claim-lost', plan);
    }

    let completedThrough = null;
    let completed = 0;
    let failure = null;
    for (const window of plan.windows) {
      try {
        await run(window);
      } catch (error) {
        failure = error;
        break;
      }
      completedThrough = window.windowEnd;
      completed += 1;
    }

    if (completedThrough !== null) {
      const recorded = completeScheduleRun({
        checkpoint: claimed.document,
        ownerCode,
        through: completedThrough,
        at: now,
      });
      if (recorded.ok === true) {
        await store.putScheduleCheckpoint(recorded.checkpoint, { ifMatch: claimed.etag });
      }
    } else {
      // Nothing finished, so there is nothing to record — but the lease must still go,
      // or one failure blocks the schedule until it expires.
      await store.putScheduleCheckpoint(
        { ...claimed.document, lease: null },
        { ifMatch: claimed.etag },
      );
    }

    if (failure !== null) {
      onWindowFailed?.(failure);
      return Object.freeze({
        outcome: 'incomplete',
        reasonCode: 'run-interrupted',
        windows: completed,
        skipped: plan.skipped,
      });
    }

    return Object.freeze({
      outcome: 'ran',
      reasonCode: 'run-recorded',
      windows: completed,
      skipped: plan.skipped,
    });
  }

  return Object.freeze({ tick });
}
