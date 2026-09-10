const BASE_METRICS = Object.freeze([
  {
    id: 'requests',
    value: 18_420,
    unit: 'count',
    quality: 'reported',
    freshness: 'fresh',
    source: 'local-request-ledger',
  },
  {
    id: 'tokens',
    value: 9_432_100,
    unit: 'tokens',
    quality: 'estimated',
    freshness: 'partial',
    source: 'local-usage-projection',
  },
  {
    id: 'rejections',
    value: 0.034,
    unit: 'ratio',
    quality: 'reported',
    freshness: 'fresh',
    source: 'local-decision-log',
  },
  {
    id: 'latency',
    value: 842,
    unit: 'milliseconds',
    quality: 'reported',
    freshness: 'fresh',
    source: 'local-request-ledger',
  },
  {
    id: 'errors',
    value: 0.012,
    unit: 'ratio',
    quality: 'reported',
    freshness: 'fresh',
    source: 'local-request-ledger',
  },
]);

const BASE_MODEL_USAGE = Object.freeze([
  {
    id: 'model-coding-primary',
    model: 'coding-primary',
    version: 'v2026-03',
    requests: 14_220,
    totalTokens: 7_810_340,
    quotaPercent: 42,
    errors: 128,
    observedAt: '2026-07-24T09:58:00.000Z',
    quality: 'reported',
    freshness: 'fresh',
  },
  {
    id: 'model-coding-fast',
    model: 'coding-fast',
    version: 'v2026-02',
    requests: 4_200,
    totalTokens: 1_621_760,
    quotaPercent: 18,
    errors: 39,
    observedAt: '2026-07-24T09:54:00.000Z',
    quality: 'estimated',
    freshness: 'partial',
  },
]);

const BASE_ATTENTION = Object.freeze([
  {
    id: 'attention-membership',
    severity: 'warning',
    titleCode: 'membership-snapshot-expiring',
    reasonCode: 'membership-snapshot-expiring-detail',
    reasonParams: { minutes: 12 },
    occurredAt: '2026-07-24T09:52:00.000Z',
    correlationId: 'attention-membership-001',
  },
  {
    id: 'attention-reconciliation',
    severity: 'info',
    titleCode: 'reconciliation-delayed',
    reasonCode: 'reconciliation-delayed-detail',
    reasonParams: { minutes: 8 },
    occurredAt: '2026-07-24T09:48:00.000Z',
    correlationId: 'attention-reconcile-001',
  },
]);

const BASE_ACTIVITY = Object.freeze([
  {
    requestId: 'request-local-1042',
    scopeCode: 'platform-engineering',
    requestedModel: 'coding-primary',
    effectiveModel: 'coding-primary',
    outcome: 'allowed',
    tokenQuality: 'reported',
    configVersion: 'cfg-local-003',
    occurredAt: '2026-07-24T09:59:12.000Z',
  },
  {
    requestId: 'request-local-1041',
    scopeCode: 'developer-experience',
    requestedModel: 'coding-fast',
    effectiveModel: 'coding-fast',
    outcome: 'allowed',
    tokenQuality: 'estimated',
    configVersion: 'cfg-local-003',
    occurredAt: '2026-07-24T09:57:46.000Z',
  },
  {
    requestId: 'request-local-1040',
    scopeCode: 'platform-engineering',
    requestedModel: 'coding-primary',
    effectiveModel: null,
    outcome: 'denied-model-policy',
    tokenQuality: 'unknown',
    configVersion: 'cfg-local-003',
    occurredAt: '2026-07-24T09:54:03.000Z',
  },
]);

export const OVERVIEW_FIXTURE_NAMES = Object.freeze([
  'complete',
  'stale',
  'partial',
  'empty',
  'denied',
  'error',
]);

function applyScope(base, scope, teamKey) {
  if (scope === 'global') return base;

  if (scope === 'team') {
    base.metrics = base.metrics.map((metric) => ({
      ...metric,
      value:
        metric.value === null
          ? null
          : metric.unit === 'ratio'
            ? metric.value
            : Math.round(metric.value * 0.37),
    }));
    base.modelUsage = base.modelUsage.map((model) => ({
      ...model,
      requests: Math.round(model.requests * 0.37),
      totalTokens: Math.round(model.totalTokens * 0.37),
      errors: Math.round(model.errors * 0.37),
    }));
    base.attention = base.attention.filter((item) => item.id === 'attention-membership');
    base.recentActivity = base.recentActivity.filter(
      (item) => item.scopeCode === teamKey,
    );
    return base;
  }

  if (scope === 'self') {
    base.metrics = base.metrics.map((metric) => ({
      ...metric,
      value:
        metric.value === null
          ? null
          : metric.unit === 'ratio'
            ? metric.value
            : Math.max(1, Math.round(metric.value * 0.018)),
    }));
    base.modelUsage = base.modelUsage.map((model) => ({
      ...model,
      requests: Math.max(1, Math.round(model.requests * 0.018)),
      totalTokens: Math.max(1, Math.round(model.totalTokens * 0.018)),
      errors: Math.round(model.errors * 0.018),
    }));
    base.attention = [];
    base.recentActivity = [
      {
        requestId: 'request-local-self-001',
        scopeCode: 'my-usage',
        requestedModel: 'coding-primary',
        effectiveModel: 'coding-primary',
        outcome: 'allowed',
        tokenQuality: 'reported',
        configVersion: 'cfg-local-003',
        occurredAt: '2026-07-24T09:59:12.000Z',
      },
    ];
    return base;
  }

  throw new TypeError(`Unsupported overview scope: ${scope}.`);
}

export function getOverviewFixture(
  name,
  { scope = 'global', teamKey = 'platform-engineering' } = {},
) {
  if (!OVERVIEW_FIXTURE_NAMES.includes(name)) {
    throw new TypeError(`Unsupported overview fixture: ${name}.`);
  }

  const base = {
    name,
    generatedAt: '2026-07-24T10:00:00.000Z',
    configuration: {
      activeVersion: 'cfg-local-003',
      state: 'active',
      publishedAt: '2026-07-24T09:30:00.000Z',
    },
    freshness: {
      reportedAt: '2026-07-24T09:58:00.000Z',
      ingestedAt: '2026-07-24T09:59:00.000Z',
      lagSeconds: 60,
      state: 'fresh',
      aggregation: 'complete',
      reconciliation: 'current',
      quotaSource: 'local-deterministic-provider',
    },
    operatingState: [
      { id: 'project-routing', valueCode: 'enabled', tone: 'success' },
      { id: 'governance-configuration', valueCode: 'active', tone: 'success' },
      { id: 'usage-aggregation', valueCode: 'complete', tone: 'success' },
      { id: 'reconciliation', valueCode: 'current', tone: 'success' },
      { id: 'body-retention', valueCode: 'disabled', tone: 'neutral' },
    ],
    metrics: structuredClone(BASE_METRICS),
    modelUsage: structuredClone(BASE_MODEL_USAGE),
    attention: structuredClone(BASE_ATTENTION),
    recentActivity: structuredClone(BASE_ACTIVITY),
  };

  if (name === 'stale') {
    base.freshness.state = 'stale';
    base.freshness.lagSeconds = 1_140;
    base.freshness.reconciliation = 'delayed';
    base.operatingState[2] = { id: 'usage-aggregation', valueCode: 'stale', tone: 'warning' };
    base.operatingState[3] = { id: 'reconciliation', valueCode: 'delayed', tone: 'warning' };
    for (const metric of base.metrics) metric.freshness = 'stale';
  }
  if (name === 'partial') {
    base.freshness.state = 'stale';
    base.freshness.aggregation = 'partial';
    base.freshness.reconciliation = 'delayed';
    base.freshness.lagSeconds = 480;
    base.operatingState[2] = { id: 'usage-aggregation', valueCode: 'partial', tone: 'warning' };
    base.operatingState[3] = { id: 'reconciliation', valueCode: 'delayed', tone: 'warning' };


  }
  if (name === 'empty') {
    base.freshness.aggregation = 'complete';
    base.metrics = base.metrics.map((metric) => ({
      ...metric,
      value: null,
      quality: 'unknown',
      freshness: 'fresh',
    }));
    base.modelUsage = [];
    base.attention = [];
    base.recentActivity = [];
  }

  return applyScope(base, scope, teamKey);
}