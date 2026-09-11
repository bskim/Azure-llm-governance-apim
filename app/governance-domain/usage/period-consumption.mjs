/**
 * What a budget period actually consumed, and whether the answer can be trusted.
 *
 * The trap is arithmetic that succeeds. A period missing an hour still produces a
 * total, and that total is lower than the truth — so a budget that was in fact
 * breached looks comfortable, and the warning the period earned is never sent. So
 * the count and the coverage travel together, and a scope with nothing at all is
 * reported as absent rather than omitted: an omitted observation is suppressed
 * downstream as "nothing to compare", which is silence by another name.
 */

const GRAIN_BY_SCOPE = Object.freeze({
  organization: 'organization',
  team: 'team',
  subject: 'subject',
  application: 'application',
});
const MAX_EXPLICIT_WINDOWS = 744;

function fail(message) {
  throw new TypeError(message);
}

function assertInstant(value, name) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    fail(`${name} must be an ISO-8601 instant.`);
  }
  return value;
}

export function budgetObservationSelector(entry) {
  return {
    budgetId: entry.budgetId,
    budgetVersion: entry.budgetVersion,
    scope: entry.scope,
    scopeKey: entry.scopeKey ?? null,
    period: entry.period,
    modelScope: entry.modelScope ?? 'all-models',
    ...(entry.modelScope === 'per-model' ? { modelKey: entry.modelKey } : {}),
  };
}

export function matchesBudgetObservation(observation, entry) {
  return typeof observation.budgetId === 'string'
    && observation.budgetId === entry.budgetId
    && observation.budgetVersion === entry.budgetVersion
    && observation.scope === entry.scope
    && (observation.scopeKey ?? null) === (entry.scopeKey ?? null)
    && observation.period === entry.period
    && (observation.modelScope ?? 'all-models') === (entry.modelScope ?? 'all-models')
    && (observation.modelKey ?? null) === (entry.modelKey ?? null);
}

export function observePeriodConsumption({ rollups, periodStart, periodEnd, windowSeconds, scopes }) {
  if (!Array.isArray(rollups)) fail('rollups must be an array.');
  assertInstant(periodStart, 'periodStart');
  assertInstant(periodEnd, 'periodEnd');
  if (!Number.isSafeInteger(windowSeconds) || windowSeconds < 1) {
    fail('windowSeconds must be a positive integer.');
  }
  if (!Array.isArray(scopes) || scopes.length === 0) fail('scopes must name at least one scope.');

  const span = Date.parse(periodEnd) - Date.parse(periodStart);
  if (span <= 0) fail('periodEnd must follow periodStart.');
  if (span % (windowSeconds * 1000) !== 0) {
    // Rounding would silently drop or invent part of a window, and the coverage
    // count is the only thing standing between a gap and a false total.
    fail('The period must divide into whole windows.');
  }
  const expected = span / (windowSeconds * 1000);

  return Object.freeze(
    scopes.map((selector) => {
      const { scope, scopeKey = null, modelScope = 'all-models', modelKey } = selector;
      const grain = GRAIN_BY_SCOPE[scope];
      if (grain === undefined) fail(`scope '${scope}' is unsupported.`);
      if (!['all-models', 'per-model'].includes(modelScope)) fail(`modelScope '${modelScope}' is unsupported.`);
      if (modelScope === 'per-model' && (typeof modelKey !== 'string' || modelKey.length === 0)) {
        fail('A per-model observation must name its modelKey.');
      }
      if (modelScope === 'all-models' && modelKey !== undefined) {
        fail('An all-models observation cannot name a modelKey.');
      }

      const covered = new Map();
      const periodStartMs = Date.parse(periodStart);
      const periodEndMs = Date.parse(periodEnd);
      for (const document of rollups) {
        if (document.grain !== grain) continue;
        if ((document.grainKey ?? null) !== scopeKey) continue;
        const windowStartMs = Date.parse(document.windowStart);
        if (!Number.isFinite(windowStartMs)) fail('A selected rollup must have a valid windowStart.');
        if (windowStartMs < periodStartMs || windowStartMs >= periodEndMs) continue;
        if ((windowStartMs - periodStartMs) % (windowSeconds * 1000) !== 0
          || Date.parse(document.windowEnd) !== windowStartMs + windowSeconds * 1000) {
          fail('A selected rollup must align to one complete observation window.');
        }
        // A re-projected window is written again under the same identifier, so the
        // same window can arrive twice and must count once.
        covered.set(windowStartMs, document);
      }

      const windows = [...covered.values()];
      const orderedWindows = [...windows].sort((left, right) => Date.parse(left.windowStart) - Date.parse(right.windowStart));
      const latestClosed = orderedWindows
        .filter((document) => document.completeness.state === 'complete')
        .at(-1);
      const explicitCoverage = expected <= MAX_EXPLICIT_WINDOWS;
      const coveredStarts = new Set(orderedWindows.map((document) => Date.parse(document.windowStart)));
      const missingWindows = explicitCoverage
        ? Array.from({ length: expected }, (unused, index) => periodStartMs + index * windowSeconds * 1000)
          .filter((windowStart) => !coveredStarts.has(windowStart))
          .map((windowStart) => new Date(windowStart).toISOString())
        : null;
      const consumedTokens = windows.reduce((total, document) => {
        if (modelScope === 'all-models') return total + document.totals.totalTokens;
        if (!Array.isArray(document.byModel)) fail('A per-model observation requires rollup byModel data.');
        const model = document.byModel.find((entry) => entry.model === modelKey);
        if (model === undefined) return total;
        const tokens = model.measures?.totalTokens;
        if (!Number.isSafeInteger(tokens) || tokens < 0) fail('Model totalTokens must be a non-negative integer.');
        return total + tokens;
      }, 0);
      const incomplete = windows.some((document) => document.completeness.state !== 'complete');
      const missing = expected - windows.length;

      const completenessReason =
        windows.length === 0
          ? 'aggregate-missing'
          : missing > 0
            ? 'window-missing'
            : incomplete
              ? 'window-incomplete'
              : null;

      return Object.freeze({
        scope,
        scopeKey,
        ...Object.fromEntries(
          ['budgetId', 'budgetVersion', 'period', 'modelScope', 'modelKey']
            .filter((field) => Object.hasOwn(selector, field))
            .map((field) => [field, selector[field]]),
        ),
        consumedTokens,
        completeness: completenessReason === null ? 'complete' : 'partial',
        completenessReason,
        windowsExpected: expected,
        windowsCovered: windows.length,
        windowsMissing: missing,
        requestedWindow: Object.freeze({ start: periodStart, end: periodEnd }),
        latestClosedWindow: latestClosed === undefined
          ? null
          : Object.freeze({ start: latestClosed.windowStart, end: latestClosed.windowEnd }),
        coverageDetailState: explicitCoverage ? 'listed' : 'summary-only',
        coveredWindows: explicitCoverage ? Object.freeze(orderedWindows.map((document) =>
          Object.freeze({ start: document.windowStart, end: document.windowEnd }),
        )) : null,
        missingWindows: missingWindows === null ? null : Object.freeze(missingWindows),
        // Usage-rollup.v1 has no applied-policy-version field. An arbitrary
        // extension is not evidence of the policy a gateway applied.
        policyVersionEvidence: Object.freeze({ state: 'not-collected', value: null, reasonCode: 'usage-rollup-policy-version-not-collected' }),
      });
    }),
  );
}
