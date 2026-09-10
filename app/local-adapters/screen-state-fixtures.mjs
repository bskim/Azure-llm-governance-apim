/**
 * Which states each remaining screen can actually be read in.
 *
 * The sets differ because the screens differ, and saying so is the point. A screen
 * that lists records has no partly-observed window to be in; one that reads a ledger
 * can fail to reach it, which is not the same as the ledger being empty. Declaring a
 * state a screen cannot produce would mean answering a selection with something else.
 */

// Records rather than measurements: present, absent, refused, or unreachable.
export const RECORD_SCREEN_FIXTURE_NAMES = Object.freeze(['complete', 'empty', 'denied', 'error']);

// The ledger read can fail while the screen still answers, and nothing outstanding
// must not be rendered the same way as no answer at all.
export const NOTIFICATION_FIXTURE_NAMES = Object.freeze([
  'complete',
  'empty',
  'degraded',
  'denied',
  'error',
]);

// A budget is read against a period, so it carries the period's freshness and gaps.
export const BUDGET_FIXTURE_NAMES = Object.freeze([
  'complete',
  'stale',
  'partial',
  'empty',
  'denied',
  'error',
]);
