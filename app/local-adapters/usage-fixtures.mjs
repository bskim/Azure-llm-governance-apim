import { getLocalUsageRecords } from './rollup-fixtures.mjs';

/**
 * The states the usage dashboard has to be readable in, produced from the same
 * records the screen shows in its healthy state.
 *
 * Each state is a real input rather than a rendered outcome: a stale window is
 * genuinely read late, an empty one genuinely has no visible record, and a degraded
 * one genuinely refuses to publish counts. Shaping the read model directly would
 * demonstrate the styling and prove nothing about the projection.
 */

export const USAGE_FIXTURE_NAMES = Object.freeze([
  'complete',
  'stale',
  'partial',
  'degraded',
  'empty',
  'denied',
  'error',
]);

// The model catalogue lists what is published rather than what was used, so a window
// with no traffic is not an empty screen. Its emptiness would be the catalogue being
// unavailable, which is a different state and already reported as one.
export const MODELS_FIXTURE_NAMES = Object.freeze(
  USAGE_FIXTURE_NAMES.filter((name) => name !== 'empty'),
);

const FRESH_LAG_SECONDS = 300;
// Three hours behind, so the label is a description of the data rather than a claim
// laid on top of it.
const STALE_LAG_SECONDS = 10_800;

function describeFreshness({ asOf, windowEnd, state }) {
  return {
    state,
    reportedAt: windowEnd,
    lagSeconds: Math.round((Date.parse(asOf) - Date.parse(windowEnd)) / 1000),
  };
}

export function getUsageFixture(name, { asOf, registry }) {
  if (!USAGE_FIXTURE_NAMES.includes(name)) {
    throw new TypeError(`Unsupported usage fixture: ${name}.`);
  }

  const stale = name === 'stale';
  const { records, window } = getLocalUsageRecords({
    asOf,
    registry,
    ingestionLagSeconds: stale ? STALE_LAG_SECONDS : FRESH_LAG_SECONDS,
  });

  const fixture = {
    records,
    window: {
      ...window,
      freshness: describeFreshness({
        asOf,
        windowEnd: window.windowEnd,
        state: stale ? 'stale' : 'fresh',
      }),
    },
  };

  if (name === 'partial') {
    fixture.window.completeness = { state: 'partial', reason: 'ingestion-lag' };
  }

  // Nothing was observed, so nothing is counted. The records stay out of the fixture
  // rather than being counted and then hidden, because a degraded window that still
  // carried rows would let a later change publish them.
  if (name === 'degraded') {
    fixture.records = [];
    fixture.window.completeness = { state: 'degraded', reason: 'source-unavailable' };
  }

  // Observed, and there was nothing in it. This is the state that must not read as
  // an outage, so its completeness is left alone.
  if (name === 'empty') {
    fixture.records = [];
  }

  return fixture;
}
