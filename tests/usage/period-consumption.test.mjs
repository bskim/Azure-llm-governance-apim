import assert from 'node:assert/strict';
import test from 'node:test';

import { observePeriodConsumption } from '../../app/governance-domain/usage/period-consumption.mjs';
import { getLocalRollups } from '../../app/local-adapters/rollup-fixtures.mjs';
import { assertUsageRollupDocument } from '../../app/governance-domain/usage/usage-rollup-validator.mjs';

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
  assert.deepEqual(observation.requestedWindow, { start: PERIOD_START, end: PERIOD_END });
  assert.equal(observation.latestClosedWindow.end, PERIOD_END);
  assert.equal(observation.coveredWindows.length, 4);
  assert.deepEqual(observation.missingWindows, []);
  assert.deepEqual(observation.policyVersionEvidence, { state: 'not-collected', value: null, reasonCode: 'usage-rollup-policy-version-not-collected' });
});

test('a period missing a window is partial, not a smaller complete total', () => {
  // This is the whole point. A gap read as low consumption suppresses exactly the
  // warning the period earned.
  const [observation] = observe(hours(4).filter((window) => window.windowStart !== '2026-08-10T02:00:00.000Z'));

  assert.equal(observation.completeness, 'partial');
  assert.equal(observation.completenessReason, 'window-missing');
  assert.equal(observation.windowsMissing, 1);
  assert.equal(observation.consumedTokens, 300, 'what was measured is still reported');
  assert.deepEqual(observation.missingWindows, ['2026-08-10T02:00:00.000Z']);
});

test('unrecorded policyVersion extensions are not treated as applied-policy evidence', () => {
  const stable = hours(4).map((window) => ({ ...window, policyVersion: 7 }));
  assert.deepEqual(observe(stable)[0].policyVersionEvidence, { state: 'not-collected', value: null, reasonCode: 'usage-rollup-policy-version-not-collected' });
  const changed = [...stable];
  changed[3] = { ...changed[3], policyVersion: 8 };
  assert.deepEqual(observe(changed)[0].policyVersionEvidence, { state: 'not-collected', value: null, reasonCode: 'usage-rollup-policy-version-not-collected' });
});

test('real projected rollups retain coverage and totals across requested budget versions without inventing applied policy', () => {
  const documents = getLocalRollups({ asOf: '2026-08-10T04:05:00.000Z', windows: 4 });
  for (const document of documents) assertUsageRollupDocument(document);
  const organizations = documents.filter((document) => document.grain === 'organization');
  const expectedTokens = organizations.reduce((sum, document) => sum + document.totals.totalTokens, 0);
  for (const budgetVersion of [1, 2]) {
    const [observation] = observe([...documents, ...documents], [{
      scope: 'organization', scopeKey: null, budgetId: 'budget-organization', budgetVersion, period: 'Daily',
    }]);
    assert.equal(observation.budgetVersion, budgetVersion);
    assert.equal(observation.consumedTokens, expectedTokens);
    assert.equal(observation.windowsCovered, 4);
    assert.equal(observation.completeness, 'complete');
    assert.equal(observation.policyVersionEvidence.state, 'not-collected');
    assert.equal(observation.latestClosedWindow.end, PERIOD_END);
  }
});

test('coverage lists are bounded at 744 windows while longer intervals retain exact summary counts', () => {
  for (const count of [744, 745, 8760]) {
    const [observation] = observePeriodConsumption({
      rollups: hours(4), periodStart: PERIOD_START,
      periodEnd: new Date(Date.parse(PERIOD_START) + count * 3600_000).toISOString(),
      windowSeconds: 3600, scopes: [{ scope: 'organization' }],
    });
    assert.equal(observation.windowsCovered, 4);
    assert.equal(observation.windowsMissing, count - 4);
    assert.equal(observation.consumedTokens, 400);
    assert.equal(observation.coverageDetailState, count === 744 ? 'listed' : 'summary-only');
    if (count === 744) {
      assert.equal(observation.missingWindows.length, 740);
      assert.equal(observation.coveredWindows.length, 4);
    } else {
      assert.equal(observation.missingWindows, null);
      assert.equal(observation.coveredWindows, null);
    }
  }
});

test('equivalent timestamp encodings identify the same window without double counting or inventing a gap', () => {
  const documents = hours(4);
  const alias = { ...documents[0], windowStart: '2026-08-10T00:00:00Z', windowEnd: '2026-08-10T01:00:00+00:00' };
  const [observation] = observe([...documents, alias]);
  assert.equal(observation.consumedTokens, 400);
  assert.equal(observation.windowsCovered, 4);
  assert.equal(observation.windowsMissing, 0);
  assert.deepEqual(observation.missingWindows, []);
});

test('misaligned, overlapping or invalid selected windows cannot claim complete coverage', () => {
  for (const overrides of [
    { windowStart: 'invalid' },
    { windowEnd: 'invalid' },
    { windowStart: '2026-08-10T00:30:00.000Z', windowEnd: '2026-08-10T01:30:00.000Z' },
    { windowEnd: '2026-08-10T02:00:00.000Z' },
  ]) {
    const documents = hours(4);
    documents[0] = { ...documents[0], ...overrides };
    assert.throws(() => observe(documents), /selected rollup must/);
  }
  const documents = hours(4);
  documents[3].completeness.state = 'partial';
  assert.equal(observe(documents)[0].latestClosedWindow.end, '2026-08-10T03:00:00.000Z');
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
