/**
 * Where a budget period begins, and the same clock rounding a rollup window uses.
 *
 * Extracted from the scheduled budget comparison so a live read of the same question
 * (the budgets screen) uses the identical rule rather than a second copy of it. Two
 * copies of "what period is this" are how a screen and a notification schedule end up
 * disagreeing about the same budget.
 */

const WINDOW_MILLISECONDS = 1000;

function fail(message) {
  throw new TypeError(message);
}

export function floorToWindow(instantMs, windowSeconds) {
  const size = windowSeconds * WINDOW_MILLISECONDS;
  return new Date(Math.floor(instantMs / size) * size).toISOString();
}

/** UTC, because a window boundary and a rollup identifier are both UTC. */
export function startOfPeriod(period, instantIso) {
  const at = new Date(instantIso);
  switch (period) {
    case 'Hourly':
      return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), at.getUTCHours())).toISOString();
    case 'Daily':
      return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate())).toISOString();
    case 'Weekly': {
      const midnight = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
      // Monday, so a week does not restart mid-working-week.
      const sinceMonday = (new Date(midnight).getUTCDay() + 6) % 7;
      return new Date(midnight - sinceMonday * 86_400_000).toISOString();
    }
    case 'Monthly':
      return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)).toISOString();
    case 'Yearly':
      return new Date(Date.UTC(at.getUTCFullYear(), 0, 1)).toISOString();
    default:
      return fail(`period '${period}' is unsupported.`);
  }
}

export function scopeKeysInPeriod(rollups, grain, periodStart, periodEnd) {
  const keys = new Set();
  for (const document of rollups) {
    if (document.grain !== grain) continue;
    if (document.windowStart < periodStart || document.windowStart >= periodEnd) continue;
    if (typeof document.grainKey === 'string') keys.add(document.grainKey);
  }
  return [...keys].sort();
}
