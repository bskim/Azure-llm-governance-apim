import { createScheduleRunner } from './schedule-runner.mjs';

/**
 * The rollup projector, bound to a checkpoint that survives the process.
 *
 * On its own the projector only ever summarises the window that just closed, so an
 * hour during which nothing was running is simply never aggregated — and the
 * dashboard reads that hour as quiet rather than absent. The checkpoint turns "what
 * time is it" into "what is still owed".
 *
 * The lag is subtracted before the schedule decides what has closed. A window the
 * log source has not finished delivering would otherwise be summarised early and
 * then never revisited, which is worse than being late.
 */

function fail(message) {
  throw new TypeError(message);
}

export function createScheduledRollupProjector({
  projector,
  store,
  clock,
  scopeGroupId,
  windowSeconds = 3600,
  ingestionLagSeconds = 300,
  startedFrom,
  ownerCode,
  leaseSeconds,
  maxBackfillWindows,
  scheduleId = 'usage-rollup',
}) {
  if (typeof projector?.runWindow !== 'function') fail('projector must be able to run a named window.');
  if (typeof clock?.nowIso !== 'function') fail('clock is required.');
  if (Date.parse(startedFrom) % (windowSeconds * 1000) !== 0) {
    // Unaligned windows would produce different document identifiers for the same
    // period depending on when the schedule was first created.
    fail('startedFrom must sit on a window boundary.');
  }

  const runner = createScheduleRunner({
    store,
    scopeGroupId,
    scheduleId,
    intervalSeconds: windowSeconds,
    startedFrom,
    leaseSeconds,
    ownerCode,
    maxBackfillWindows,
    run: (window) => projector.runWindow(window),
  });

  async function tick() {
    const delivered = new Date(Date.parse(clock.nowIso()) - ingestionLagSeconds * 1000).toISOString();
    return runner.tick(delivered);
  }

  return Object.freeze({ tick });
}
