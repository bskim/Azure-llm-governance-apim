/**
 * Builds the overview read model's input from usage rollup documents.
 *
 * Rollups are the only aggregate the default deployment profile produces, and
 * they carry requests, tokens, refusals, fallbacks, and a per-model breakdown.
 * They carry nothing about latency, errors, or price. Those measures are
 * reported as absent with a source that says why, because a dashboard that
 * renders a confident zero for something nobody measured is worse than one that
 * admits the gap.
 */

const NOT_COLLECTED = 'not-collected';
const ROLLUP_SOURCE = 'gateway-usage-rollup';

const RANGE_SECONDS = Object.freeze({
  '24h': 86_400,
  '7d': 604_800,
  '30d': 2_592_000,
});

function fail(message) {
  throw new TypeError(message);
}

/** The window a reader is shown is the worst of the windows it is built from. */
const COMPLETENESS_RANK = Object.freeze({ complete: 0, partial: 1, degraded: 2 });

function worstCompleteness(documents) {
  let worst = 'complete';
  for (const document of documents) {
    if (COMPLETENESS_RANK[document.completeness.state] > COMPLETENESS_RANK[worst]) {
      worst = document.completeness.state;
    }
  }
  return worst;
}

function combineQuality(qualities) {
  const known = new Set([...qualities].filter((quality) => quality !== 'unknown'));
  if (known.size === 0) return 'unknown';
  return known.size === 1 ? [...known][0] : 'estimated';
}

function sumMeasures(documents) {
  const totals = { requests: 0, totalTokens: 0, refusedRequests: 0, fallbackRequests: 0 };
  const qualities = new Set();
  for (const document of documents) {
    totals.requests += document.totals.requests;
    totals.totalTokens += document.totals.totalTokens;
    totals.refusedRequests += document.totals.refusedRequests;
    totals.fallbackRequests += document.totals.fallbackRequests;
    qualities.add(document.totals.tokenQuality);
  }
  return { totals, quality: combineQuality(qualities) };
}

function sumByModel(documents) {
  const models = new Map();
  for (const document of documents) {
    for (const entry of document.byModel) {
      if (!models.has(entry.model)) {
        models.set(entry.model, { requests: 0, totalTokens: 0, qualities: new Set() });
      }
      const model = models.get(entry.model);
      model.requests += entry.measures.requests;
      model.totalTokens += entry.measures.totalTokens;
      model.qualities.add(entry.measures.tokenQuality);
    }
  }
  return models;
}

/** Absent because it was never collected, not because it happened to be zero. */
function absentMetric(id, unit) {
  return { id, value: null, unit, quality: 'unknown', freshness: 'unknown', source: NOT_COLLECTED };
}

function freshnessFor(completeness) {
  return completeness === 'complete' ? 'fresh' : completeness === 'partial' ? 'partial' : 'stale';
}

function selectDocuments({ documents, scope, teamKey, range, asOf }) {
  const grain = scope === 'global' ? 'organization' : scope === 'team' ? 'team' : 'subject';
  const horizon = Date.parse(asOf) - RANGE_SECONDS[range] * 1000;

  return documents.filter((document) => {
    if (document.grain !== grain) return false;
    if (grain === 'team' && document.grainKey !== teamKey) return false;
    return Date.parse(document.windowStart) >= horizon;
  });
}

function attentionFor(completeness, windows, asOf) {
  if (completeness === 'complete') return [];
  const degraded = completeness === 'degraded';
  return [
    {
      id: `attention-usage-${completeness}`,
      severity: degraded ? 'warning' : 'info',
      titleCode: degraded ? 'usage-window-degraded' : 'usage-window-partial',
      reasonCode: degraded ? 'usage-window-degraded-detail' : 'usage-window-partial-detail',
      reasonParams: { windows },
      occurredAt: asOf,
      correlationId: `usage-${completeness}`,
    },
  ];
}

export function buildOverviewFromRollups({
  documents,
  scope = 'global',
  teamKey = null,
  range = '24h',
  asOf,
  configuration,
}) {
  if (!Array.isArray(documents)) fail('documents must be an array.');
  if (!Object.hasOwn(RANGE_SECONDS, range)) fail(`range '${range}' is unsupported.`);
  if (typeof asOf !== 'string' || Number.isNaN(Date.parse(asOf))) {
    fail('asOf must be an ISO-8601 instant.');
  }
  if (configuration === null || typeof configuration !== 'object') fail('configuration is required.');

  const selected = selectDocuments({ documents, scope, teamKey, range, asOf });
  const completeness = selected.length === 0 ? 'degraded' : worstCompleteness(selected);
  const freshness = freshnessFor(completeness);
  const { totals, quality } = sumMeasures(selected);

  const latest = selected.reduce(
    (newest, document) => (newest === null || document.windowEnd > newest.windowEnd ? document : newest),
    null,
  );
  const reportedAt = latest?.windowEnd ?? null;
  const lagSeconds = reportedAt === null ? null : Math.max(0, Math.round((Date.parse(asOf) - Date.parse(reportedAt)) / 1000));

  // A degraded window did not observe zero requests, it failed to observe. Its
  // counts are unknown, not zero, or a dashboard reports an outage as a quiet hour.
  const measured = selected.length > 0 && completeness !== 'degraded';

  const metrics = [
    {
      id: 'requests',
      value: measured ? totals.requests : null,
      unit: 'count',
      quality: measured ? 'reported' : 'unknown',
      freshness,
      source: ROLLUP_SOURCE,
    },
    {
      id: 'tokens',
      value: measured ? totals.totalTokens : null,
      unit: 'tokens',
      quality: measured ? quality : 'unknown',
      freshness,
      source: ROLLUP_SOURCE,
    },
    {
      id: 'rejections',
      value: measured && totals.requests > 0 ? totals.refusedRequests / totals.requests : null,
      unit: 'ratio',
      quality: measured && totals.requests > 0 ? 'reported' : 'unknown',
      freshness,
      source: ROLLUP_SOURCE,
    },
    absentMetric('latency', 'milliseconds'),
    absentMetric('errors', 'ratio'),
  ];

  const modelUsage = [...sumByModel(selected).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([model, measures]) => ({
      id: `model-${model}`,
      model,
      version: null,
      requests: measures.requests,
      totalTokens: measures.totalTokens,
      quotaPercent: null,
      errors: null,
      observedAt: reportedAt,
      quality: combineQuality(measures.qualities),
      freshness,
    }));

  return {
    name: ROLLUP_SOURCE,
    generatedAt: asOf,
    configuration: structuredClone(configuration),
    freshness: {
      reportedAt,
      ingestedAt: asOf,
      lagSeconds,
      state: freshness === 'fresh' ? 'fresh' : 'stale',
      aggregation: completeness === 'complete' ? 'complete' : selected.length === 0 ? 'unavailable' : 'partial',
      reconciliation: completeness === 'complete' ? 'current' : 'delayed',
      quotaSource: ROLLUP_SOURCE,
    },
    operatingState: [
      { id: 'project-routing', valueCode: 'enabled', tone: 'success' },
      {
        id: 'governance-configuration',
        valueCode: configuration.state,
        tone: configuration.state === 'active' ? 'success' : 'warning',
      },
      {
        id: 'usage-aggregation',
        valueCode: completeness === 'complete' ? 'complete' : 'partial',
        tone: completeness === 'complete' ? 'success' : 'warning',
      },
      {
        id: 'reconciliation',
        valueCode: completeness === 'complete' ? 'current' : 'delayed',
        tone: completeness === 'complete' ? 'success' : 'warning',
      },
      { id: 'body-retention', valueCode: 'disabled', tone: 'neutral' },
    ],
    metrics,
    modelUsage,
    attention: attentionFor(completeness, selected.length, asOf),
    // Rollups are aggregates. Per-request activity needs the event-stream profile,
    // so an empty list here is the truth rather than a rendering gap.
    recentActivity: [],
  };
}
