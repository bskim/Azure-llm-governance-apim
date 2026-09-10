/**
 * How late a reading is, stated by whoever gathered it.
 *
 * Deriving it inside a projector would mean inventing the threshold at which a lag
 * becomes stale, and that belongs to the source that knows its own ingestion path.
 * Omitting it is refused rather than defaulted to fresh: a dashboard that quietly
 * claims currency it never measured is the failure this field exists to prevent.
 */

const FRESHNESS_STATES = Object.freeze(['fresh', 'stale']);

export function projectWindowFreshness(freshness) {
  if (freshness === undefined) {
    throw new TypeError('window.freshness is required; state how late the reading is.');
  }
  if (!FRESHNESS_STATES.includes(freshness?.state)) {
    throw new TypeError(`window.freshness.state must be one of: ${FRESHNESS_STATES.join(', ')}.`);
  }
  if (!Number.isInteger(freshness.lagSeconds) || freshness.lagSeconds < 0) {
    throw new TypeError('window.freshness.lagSeconds must be a whole number of seconds.');
  }
  if (typeof freshness.reportedAt !== 'string' || Number.isNaN(Date.parse(freshness.reportedAt))) {
    throw new TypeError('window.freshness.reportedAt must be an ISO-8601 instant.');
  }
  return {
    state: freshness.state,
    reportedAt: freshness.reportedAt,
    lagSeconds: freshness.lagSeconds,
  };
}

export const WINDOW_FRESHNESS_STATES = FRESHNESS_STATES;
