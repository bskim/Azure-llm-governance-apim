import { assertAuthorizedReadScope } from './admin-read-authorization.mjs';
import { assertBodyFreeReadModel } from './admin-read-model-projector.mjs';
import { projectWindowFreshness } from './read-model-freshness.mjs';

/**
 * Projects usage records into the per-user and per-group dashboards.
 *
 * Records are the input rather than rollups because only a record carries a cost,
 * and a showback screen without one is the screen an administrator came for. The
 * rules that matter here are about what the aggregate is allowed to claim: a cost
 * appears with the reason it is missing rather than as a zero, a window nobody
 * finished observing never renders as a quiet one, and a caller sees an aggregate
 * only over principals its read scope already permits.
 */

const SAFE_READ_MODEL_KEYS = new Set([
  'readModelVersion',
  'generatedAt',
  'readModelId',
  'window',
  'quality',
  'totals',
  'records',
  'selection',
]);

const VIEWS = Object.freeze({ users: 'user', groups: 'group' });

// A group aggregate is built from other principals' requests, so it is not
// something a self-scoped caller may read at all. An empty list would be worse
// than a refusal: it reads as "you belong to no group".
const VISIBLE_VIEWS = Object.freeze({
  global: Object.freeze(['users', 'groups']),
  team: Object.freeze(['users', 'groups']),
  self: Object.freeze(['users']),
});

const OUTCOMES = Object.freeze(['served', 'refused', 'failed']);

function reject(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function assertSelection(selection) {
  if (!Object.hasOwn(VIEWS, selection.view)) throw reject('view-not-supported');
  if (!Object.hasOwn(VISIBLE_VIEWS, selection.scope)) throw reject('scope-not-supported');
  if (!VISIBLE_VIEWS[selection.scope].includes(selection.view)) {
    throw reject('view-not-permitted-for-scope');
  }
}

export function selectVisibleUsageRecords({ records, selection, viewer }) {
  if (selection.scope === 'global') return records;
  if (selection.scope === 'team') {
    return records.filter((record) => record.attribution.teamKey === selection.teamKey);
  }
  // Not knowing which principal the caller is, and the caller having no usage, are
  // different answers. Filtering on an absent key would silently return the second.
  if (typeof viewer?.subjectKey !== 'string' || viewer.subjectKey.length === 0) {
    throw reject('viewer-subject-key-unavailable');
  }
  return records.filter((record) => record.attribution.subjectKey === viewer.subjectKey);
}

/** An aggregate is only as trustworthy as its weakest record. */
function resolveQuality(qualities) {
  const known = new Set([...qualities].filter((quality) => quality !== 'unknown'));
  if (known.size === 0) return 'unknown';
  if (known.size > 1) return 'mixed';
  return qualities.size > known.size ? 'mixed' : [...known][0];
}

/**
 * How well the calling application is known, for the aggregate as a whole.
 *
 * The counts travel with the state because the state alone cannot answer what a reader
 * needs next. `strong` is claimed only when every request in the aggregate named its own
 * client; one request through a shared developer tool makes the aggregate `mixed`, and
 * a screen that showed a specific agent for it would be naming an application nobody
 * established.
 */
function sealAttribution({ strong, generic, unavailable, reasonCodes }) {
  const present = [['strong', strong], ['generic', generic], ['unavailable', unavailable]]
    .filter(([, count]) => count > 0);
  const state = present.length === 0 ? 'unavailable' : present.length > 1 ? 'mixed' : present[0][0];
  return {
    state,
    strongRequests: strong,
    genericRequests: generic,
    unavailableRequests: unavailable,
    reasonCodes: [...reasonCodes].sort(),
  };
}

// Built and merged through one pair of functions, because a per-entity bucket and the
// totals bucket were each constructing this shape and a field added to one was silently
// absent from the other.
function newModelEntry(providerCode) {
  return {
    providerCode,
    requests: 0,
    totalTokens: 0,
    qualities: new Set(),
    requestedKeys: new Set(),
    substitutedRequests: 0,
  };
}

function mergeModelEntry(target, source) {
  target.requests += source.requests;
  target.totalTokens += source.totalTokens;
  target.substitutedRequests += source.substitutedRequests;
  for (const quality of source.qualities) target.qualities.add(quality);
  for (const key of source.requestedKeys) target.requestedKeys.add(key);
}

export function newUsageBucket() {
  return {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    outcomes: { served: 0, refused: 0, failed: 0 },
    qualities: new Set(),
    attribution: { strong: 0, generic: 0, unavailable: 0, reasonCodes: new Set() },
    substitutedRequests: 0,
    byModel: new Map(),
  };
}

export function accumulateUsage(bucket, record) {
  bucket.requests += 1;
  bucket.promptTokens += record.usage.promptTokens;
  bucket.completionTokens += record.usage.completionTokens;
  bucket.totalTokens += record.usage.totalTokens;
  bucket.outcomes[record.outcome] += 1;
  bucket.qualities.add(record.usage.tokenQuality);

  // Which application a request came from is a different question from how well that
  // is known. A shared developer tool authenticates as itself, so counting it beside a
  // request that named its own client would present both as the same claim.
  const applicationQuality = record.attribution.applicationQuality;
  if (applicationQuality === null) {
    bucket.attribution.unavailable += 1;
    bucket.attribution.reasonCodes.add(record.attribution.applicationReasonCode);
  } else {
    bucket.attribution[applicationQuality] += 1;
  }

  if (record.requested.modelKey !== record.effective.modelKey) bucket.substitutedRequests += 1;

  const key = record.effective.modelKey;
  if (!bucket.byModel.has(key)) bucket.byModel.set(key, newModelEntry(record.effective.providerKey));
  const model = bucket.byModel.get(key);
  model.requests += 1;
  model.totalTokens += record.usage.totalTokens;
  model.qualities.add(record.usage.tokenQuality);
  model.requestedKeys.add(record.requested.modelKey);
  if (record.requested.modelKey !== key) model.substitutedRequests += 1;
}

export function sealUsageBucket(bucket) {
  return {
    requests: bucket.requests,
    promptTokens: bucket.promptTokens,
    completionTokens: bucket.completionTokens,
    totalTokens: bucket.totalTokens,
    outcomes: { ...bucket.outcomes },
    tokenQuality: resolveQuality(bucket.qualities),
    attribution: sealAttribution(bucket.attribution),
    substitutedRequests: bucket.substitutedRequests,
    byModel: [...bucket.byModel.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([modelKey, model]) => ({
        modelKey,
        providerCode: model.providerCode,
        requests: model.requests,
        totalTokens: model.totalTokens,
        tokenQuality: resolveQuality(model.qualities),
        requestedModelKeys: [...model.requestedKeys].sort(),
        substitutedRequests: model.substitutedRequests,
      })),
  };
}

const COMPLETENESS_QUALITY = Object.freeze({
  complete: 'complete',
  partial: 'partial',
  degraded: 'degraded',
});

export function projectUsage({
  authorization,
  records,
  window,
  selection,
  viewer = null,
}) {
  assertAuthorizedReadScope({
    authorization,
    scope: selection.scope,
    teamKey: selection.teamKey,
  });
  assertSelection(selection);
  if (!Array.isArray(records)) throw new TypeError('records must be an array.');

  const completenessState = window?.completeness?.state;
  if (!Object.hasOwn(COMPLETENESS_QUALITY, completenessState)) {
    throw new TypeError('window.completeness.state is unsupported.');
  }
  const freshness = projectWindowFreshness(window.freshness);
  // A window that failed to observe did not observe zero. Publishing counts from it
  // would let an ingestion outage read as a quiet afternoon.
  const countsMeasured = completenessState !== 'degraded';

  const entityKind = VIEWS[selection.view];
  const buckets = new Map();
  if (countsMeasured) {
    for (const record of selectVisibleUsageRecords({ records, selection, viewer })) {
      const key = entityKind === 'user' ? record.attribution.subjectKey : record.attribution.teamKey;
      if (typeof key !== 'string' || key.length === 0) continue;
      if (!buckets.has(key)) buckets.set(key, newUsageBucket());
      accumulateUsage(buckets.get(key), record);
    }
  }

  const totals = newUsageBucket();
  for (const bucket of buckets.values()) {
    totals.requests += bucket.requests;
    totals.promptTokens += bucket.promptTokens;
    totals.completionTokens += bucket.completionTokens;
    totals.totalTokens += bucket.totalTokens;
    for (const outcome of OUTCOMES) totals.outcomes[outcome] += bucket.outcomes[outcome];
    for (const quality of bucket.qualities) totals.qualities.add(quality);
    for (const name of ['strong', 'generic', 'unavailable']) {
      totals.attribution[name] += bucket.attribution[name];
    }
    for (const reason of bucket.attribution.reasonCodes) totals.attribution.reasonCodes.add(reason);
    totals.substitutedRequests += bucket.substitutedRequests;
    for (const [modelKey, model] of bucket.byModel) {
      if (!totals.byModel.has(modelKey)) totals.byModel.set(modelKey, newModelEntry(model.providerCode));
      mergeModelEntry(totals.byModel.get(modelKey), model);
    }
  }

  const readModel = {
    readModelVersion: 'usage.v1',
    generatedAt: selection.generatedAt,
    readModelId: `usage-${selection.view}-${selection.scope}-${selection.teamKey ?? 'none'}`,
    window: {
      windowStart: window.windowStart,
      windowEnd: window.windowEnd,
      asOf: window.asOf,
      completenessState,
      completenessReason: window.completeness.reason ?? null,
      reportedAt: freshness.reportedAt,
      lagSeconds: freshness.lagSeconds,
    },
    quality: {
      state: COMPLETENESS_QUALITY[completenessState],
      freshnessState: freshness.state,
      countsMeasured,
      reasonCode: countsMeasured ? null : window.completeness.reason ?? 'window-not-observed',
    },
    totals: countsMeasured ? sealUsageBucket(totals) : null,
    records: [...buckets.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([entityKey, bucket]) => ({ entityKind, entityKey, ...sealUsageBucket(bucket) })),
    selection: {
      view: selection.view,
      scope: selection.scope,
      teamKey: selection.scope === 'team' ? selection.teamKey : null,
    },
  };

  assertBodyFreeReadModel(readModel, SAFE_READ_MODEL_KEYS);
  return readModel;
}
