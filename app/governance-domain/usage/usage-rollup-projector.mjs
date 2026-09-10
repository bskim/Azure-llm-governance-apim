import { assertUsageRollupDocument, usageRollupDocumentId } from './usage-rollup-validator.mjs';

/**
 * Projects diagnostic log rows into rollup documents.
 *
 * This is a pure function of its inputs so the aggregation can be exercised
 * without a log platform. Everything about how honest the result is comes from
 * here: the projector decides what a window is allowed to claim about itself,
 * and it never upgrades that claim to make a dashboard look better.
 */

const EMPTY_MEASURES = Object.freeze({
  requests: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  refusedRequests: 0,
  fallbackRequests: 0,
});

function fail(message) {
  throw new TypeError(message);
}

function newMeasures() {
  return { ...EMPTY_MEASURES, qualities: new Set() };
}

function accumulate(target, row) {
  target.requests += 1;
  target.promptTokens += row.promptTokens ?? 0;
  target.completionTokens += row.completionTokens ?? 0;
  target.totalTokens += (row.promptTokens ?? 0) + (row.completionTokens ?? 0);
  if (row.outcome === 'refused') target.refusedRequests += 1;
  if (row.effectiveModel !== row.requestedModel) target.fallbackRequests += 1;
  // A refused request never reached a model, so it has no usage to qualify. The
  // source is expected to say so, but a window's trustworthiness must not depend on
  // the source having remembered to.
  if (row.outcome !== 'refused') target.qualities.add(row.tokenQuality ?? 'unknown');
}

/**
 * A window is only as trustworthy as its weakest row. One estimated count makes
 * the whole aggregate mixed rather than reported.
 */
function resolveQuality(qualities) {
  if (qualities.size === 0) return 'unknown';
  if (qualities.size === 1) return [...qualities][0];
  const known = new Set([...qualities].filter((quality) => quality !== 'unknown'));
  if (known.size === 0) return 'unknown';
  return known.size === 1 ? [...known][0] : 'mixed';
}

function sealMeasures(measures) {
  const { qualities, ...counts } = measures;
  return { ...counts, tokenQuality: resolveQuality(qualities) };
}

/**
 * Completeness is derived, never supplied. A caller cannot assert that a window
 * is complete; it can only report what the source did, and this decides what
 * that permits the document to claim.
 */
function resolveCompleteness({ windowEnd, asOf, source }) {
  const truncated = source.rowCount >= source.rowLimit;

  if (source.state === 'unavailable') {
    return { state: 'degraded', reason: 'source-unavailable' };
  }
  if (truncated) {
    return {
      state: 'degraded',
      reason: 'source-truncated',
      observedRows: source.rowCount,
      rowLimit: source.rowLimit,
    };
  }
  if (Date.parse(asOf) < Date.parse(windowEnd)) {
    return { state: 'partial', reason: 'window-open' };
  }
  if (Date.parse(asOf) - Date.parse(windowEnd) < (source.ingestionLagSeconds ?? 0) * 1000) {
    return { state: 'partial', reason: 'ingestion-lag' };
  }
  return {
    state: 'complete',
    reason: 'window-closed',
    observedRows: source.rowCount,
    rowLimit: source.rowLimit,
  };
}

function assertWindow({ windowStart, windowEnd, asOf }) {
  for (const [name, value] of Object.entries({ windowStart, windowEnd, asOf })) {
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
      fail(`${name} must be an ISO-8601 instant.`);
    }
  }
  if (Date.parse(windowEnd) <= Date.parse(windowStart)) {
    fail('windowEnd must be after windowStart.');
  }
}

function assertSource(source) {
  if (source === null || typeof source !== 'object') fail('source is required.');
  if (!['complete', 'unavailable'].includes(source.state)) fail('source.state is unsupported.');
  if (!Number.isSafeInteger(source.rowCount) || source.rowCount < 0) {
    fail('source.rowCount must be a whole count.');
  }
  if (!Number.isSafeInteger(source.rowLimit) || source.rowLimit < 1) {
    fail('source.rowLimit must be a positive integer.');
  }
  if (typeof source.revision !== 'string' || source.revision.length === 0) {
    fail('source.revision is required.');
  }
}

/** Rows are grouped by grain; the organization grain has a single implicit group. */
const KEY_BY_GRAIN = Object.freeze({
  organization: () => null,
  team: (row) => row.teamKey,
  subject: (row) => row.subjectKey,
  application: (row) => row.applicationKey,
});

export function projectUsageRollups({
  rows,
  scopeGroupId,
  grains = ['organization', 'team', 'subject', 'application'],
  windowStart,
  windowEnd,
  asOf,
  source,
}) {
  if (!Array.isArray(rows)) fail('rows must be an array.');
  if (typeof scopeGroupId !== 'string' || scopeGroupId.length === 0) {
    fail('scopeGroupId is required.');
  }
  assertWindow({ windowStart, windowEnd, asOf });
  assertSource(source);

  const completeness = resolveCompleteness({ windowEnd, asOf, source });
  const documents = [];

  for (const grain of grains) {
    const keyOf = KEY_BY_GRAIN[grain];
    if (!keyOf) fail(`grain '${grain}' is unsupported.`);

    const groups = new Map();
    for (const row of rows) {
      const key = keyOf(row);
      // A row that cannot be attributed at this grain is excluded from it rather
      // than being folded into an arbitrary group.
      if (grain !== 'organization' && (typeof key !== 'string' || key.length === 0)) continue;

      const groupKey = key ?? '';
      if (!groups.has(groupKey)) groups.set(groupKey, { totals: newMeasures(), byModel: new Map() });
      const group = groups.get(groupKey);

      accumulate(group.totals, row);
      const model = row.effectiveModel;
      if (typeof model !== 'string' || model.length === 0) fail('A row must name its effective model.');
      if (!group.byModel.has(model)) group.byModel.set(model, newMeasures());
      accumulate(group.byModel.get(model), row);
    }

    // The organization grain reports a zero window rather than nothing, so a
    // dashboard can distinguish no traffic from no data.
    if (grain === 'organization' && groups.size === 0) {
      groups.set('', { totals: newMeasures(), byModel: new Map() });
    }

    for (const [groupKey, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const document = {
        contractVersion: 'v1',
        documentType: 'usage-rollup',
        id: usageRollupDocumentId({
          scopeGroupId,
          grain,
          grainKey: grain === 'organization' ? null : groupKey,
          windowStart,
        }),
        scopeGroupId,
        grain,
        windowStart,
        windowEnd,
        asOf,
        completeness,
        sourceRevision: source.revision,
        totals: sealMeasures(group.totals),
        byModel: [...group.byModel.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([model, measures]) => ({ model, measures: sealMeasures(measures) })),
      };
      if (grain !== 'organization') document.grainKey = groupKey;

      assertUsageRollupDocument(document);
      documents.push(Object.freeze(document));
    }
  }

  return Object.freeze(documents);
}
