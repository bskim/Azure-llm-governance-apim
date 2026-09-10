import assert from 'node:assert/strict';
import test from 'node:test';

import { observePeriodConsumption } from '../../app/governance-domain/usage/period-consumption.mjs';

const PERIOD_START = '2026-08-10T00:00:00.000Z';
const PERIOD_END = '2026-08-10T04:00:00.000Z';

function rollup({ windowStart, grain = 'organization', grainKey = null, totalTokens, state = 'complete' }) {
  const document = {
    grain,
    windowStart,
    windowEnd: new Date(Date.parse(windowStart) + 3600_000).toISOString(),
    completeness: { state, reason: state === 'complete' ? 'window-closed' : 'window-open' },
    totals: { totalTokens },
  };
  if (grainKey !== null) document.grainKey = grainKey;
  return document;
}

function hours(count, overrides = {}) {
  return Array.from({ length: count }, (unused, index) =>
    rollup({
      windowStart: new Date(Date.parse(PERIOD_START) + index * 3600_000).toISOString(),
      totalTokens: 100,
      ...overrides,
    }),
  );
}

function observe(rollups, scopes = [{ scope: 'organization', scopeKey: null }]) {
  return observePeriodConsumption({
    rollups,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    windowSeconds: 3600,
    scopes,
  });
}

test('a complete period sums every window it covers', () => {
  const [observation] = observe(hours(4));

  assert.equal(observation.consumedTokens, 400);
  assert.equal(observation.completeness, 'complete');
  assert.equal(observation.windowsCovered, 4);
});

test('a period missing a window is partial, not a smaller complete total', () => {
  // This is the whole point. A gap read as low consumption suppresses exactly the
  // warning the period earned.
  const [observation] = observe(hours(4).filter((window) => window.windowStart !== '2026-08-10T02:00:00.000Z'));

  assert.equal(observation.completeness, 'partial');
  assert.equal(observation.completenessReason, 'window-missing');
  assert.equal(observation.windowsMissing, 1);
  assert.equal(observation.consumedTokens, 300, 'what was measured is still reported');
});

test('a window the projector marked incomplete makes the period incomplete', () => {
  const windows = hours(4);
  windows[1] = rollup({ windowStart: '2026-08-10T01:00:00.000Z', totalTokens: 40, state: 'partial' });

  const [observation] = observe(windows);

  assert.equal(observation.completeness, 'partial');
  assert.equal(observation.completenessReason, 'window-incomplete');
});

test('a scope with no rollups at all is reported as absent, never omitted', () => {
  // An omitted observation is suppressed by the planner as "no observation", and a
  // team whose aggregate vanished would then earn no warning at all.
  const observations = observe(hours(4), [
    { scope: 'organization', scopeKey: null },
    { scope: 'team', scopeKey: 'developer-experience' },
  ]);

  const team = observations.find((observation) => observation.scope === 'team');
  assert.equal(team.completeness, 'partial');
  assert.equal(team.completenessReason, 'aggregate-missing');
  assert.equal(team.consumedTokens, 0);
  assert.equal(team.windowsCovered, 0);
});

test('each scope is summed from its own grain, not from the organization total', () => {
  const windows = [
    ...hours(4),
    ...hours(4, { grain: 'team', grainKey: 'platform-engineering' }).map((window) => ({
      ...window,
      totals: { totalTokens: 25 },
    })),
  ];

  const observations = observe(windows, [
    { scope: 'organization', scopeKey: null },
    { scope: 'team', scopeKey: 'platform-engineering' },
  ]);

  assert.equal(observations.find((entry) => entry.scope === 'organization').consumedTokens, 400);
  assert.equal(observations.find((entry) => entry.scope === 'team').consumedTokens, 100);
});

test('a window outside the period is not counted into it', () => {
  const windows = [
    ...hours(4),
    rollup({ windowStart: '2026-08-10T04:00:00.000Z', totalTokens: 999 }),
    rollup({ windowStart: '2026-08-09T23:00:00.000Z', totalTokens: 999 }),
  ];

  const [observation] = observe(windows);
  assert.equal(observation.consumedTokens, 400);
});

test('the same window seen twice is counted once', () => {
  // A re-projected window is written again under the same identifier, and a query
  // that returns both must not double the period.
  const windows = [...hours(4), rollup({ windowStart: '2026-08-10T01:00:00.000Z', totalTokens: 100 })];

  const [observation] = observe(windows);
  assert.equal(observation.consumedTokens, 400);
  assert.equal(observation.windowsCovered, 4);
});

test('a period that does not divide into whole windows is refused rather than rounded', () => {
  assert.throws(
    () =>
      observePeriodConsumption({
        rollups: [],
        periodStart: PERIOD_START,
        periodEnd: '2026-08-10T04:30:00.000Z',
        windowSeconds: 3600,
        scopes: [{ scope: 'organization', scopeKey: null }],
      }),
    /whole windows/,
  );
});

test('budget observations preserve identity and count only their effective model', () => {
  const windows = hours(4).map((window) => ({
    ...window,
    byModel: [
      { model: 'coding-fast', measures: { totalTokens: 25 } },
      { model: 'coding-primary', measures: { totalTokens: 75 } },
    ],
  }));
  const selector = {
    scope: 'organization',
    budgetId: 'budget-primary',
    budgetVersion: 3,
    period: 'Daily',
    modelScope: 'per-model',
    modelKey: 'coding-primary',
  };
  const [all, primary, fast] = observe(windows, [
    { scope: 'organization', modelScope: 'all-models' },
    selector,
    { ...selector, budgetId: 'budget-fast', modelKey: 'coding-fast' },
  ]);
  assert.equal(all.consumedTokens, 400);
  assert.equal(primary.consumedTokens, 300);
  assert.equal(fast.consumedTokens, 100);
  for (const [key, value] of Object.entries(selector)) assert.equal(primary[key], value);
  assert.equal(primary.completeness, 'complete');
  assert.equal(primary.windowsCovered, 4);
});

test('a model absent from complete breakdowns has zero usage, not all-model usage', () => {
  const windows = hours(4).map((window) => ({
    ...window,
    byModel: [{ model: 'coding-fast', measures: { totalTokens: 100 } }],
  }));
  const [observation] = observe(windows, [
    { scope: 'organization', modelScope: 'per-model', modelKey: 'coding-primary' },
  ]);
  assert.equal(observation.consumedTokens, 0);
  assert.equal(observation.completeness, 'complete');
});

test('per-model observations keep window gaps and reject missing model evidence', () => {
  const selector = { scope: 'organization', modelScope: 'per-model', modelKey: 'coding-primary' };
  const windows = hours(3).map((window) => ({
    ...window,
    byModel: [{ model: 'coding-primary', measures: { totalTokens: 25 } }],
  }));
  const [observation] = observe(windows, [selector]);
  assert.equal(observation.consumedTokens, 75);
  assert.equal(observation.completenessReason, 'window-missing');
  assert.equal(observation.windowsMissing, 1);
  assert.throws(() => observe(hours(4), [selector]), /requires rollup byModel data/);
  windows[0].byModel[0].measures.totalTokens = -1;
  assert.throws(() => observe(windows, [selector]), /Model totalTokens/);
});

test('ambiguous model selectors are refused', () => {
  assert.throws(() => observe([], [{ scope: 'organization', modelScope: 'per-model' }]), /must name its modelKey/);
  assert.throws(
    () => observe([], [{ scope: 'organization', modelScope: 'all-models', modelKey: 'coding-primary' }]),
    /cannot name a modelKey/,
  );
  assert.throws(() => observe([], [{ scope: 'organization', modelScope: 'unknown' }]), /modelScope.*unsupported/);
});
