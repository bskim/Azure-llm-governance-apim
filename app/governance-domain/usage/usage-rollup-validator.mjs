/**
 * Semantic validation for a usage rollup document.
 *
 * The schema constrains shape. These rules constrain meaning, and they exist
 * because a dashboard reads freshness and completeness from stored fields rather
 * than inferring them: a rollup that claims to be complete when it is not is
 * worse than one that reports nothing.
 */

const GRAINS = new Set(['organization', 'team', 'subject', 'application']);
const STATES = new Set(['complete', 'partial', 'degraded']);
const REASONS = new Set([
  'window-closed',
  'window-open',
  'source-truncated',
  'source-unavailable',
  'ingestion-lag',
]);
const QUALITIES = new Set(['reported', 'estimated', 'mixed', 'unknown']);
const SAFE_ID = /^[A-Za-z0-9._:-]+$/;
const MODEL_ALIAS = /^[A-Za-z0-9._-]+$/;

// A reason has to agree with the state it accompanies, otherwise the pair carries
// no information a reader can act on.
const REASONS_BY_STATE = Object.freeze({
  complete: new Set(['window-closed']),
  partial: new Set(['window-open', 'source-truncated', 'ingestion-lag']),
  degraded: new Set(['source-unavailable', 'source-truncated']),
});

function fail(message) {
  throw new TypeError(message);
}

function assertInstant(value, name) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    fail(`${name} must be an ISO-8601 instant.`);
  }
  return Date.parse(value);
}

function assertCount(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${name} must be a whole count.`);
  return value;
}

export function usageRollupDocumentId({ scopeGroupId, grain, grainKey, windowStart }) {
  if (typeof scopeGroupId !== 'string' || !SAFE_ID.test(scopeGroupId)) {
    fail('scopeGroupId is required.');
  }
  if (!GRAINS.has(grain)) fail('grain is unsupported.');
  return `usage-rollup|${scopeGroupId}|${grain}|${grainKey ?? ''}|${windowStart}`;
}

function assertMeasures(measures, path) {
  if (measures === null || typeof measures !== 'object' || Array.isArray(measures)) {
    fail(`${path} must be an object.`);
  }
  const prompt = assertCount(measures.promptTokens, `${path}.promptTokens`);
  const completion = assertCount(measures.completionTokens, `${path}.completionTokens`);
  const total = assertCount(measures.totalTokens, `${path}.totalTokens`);
  const requests = assertCount(measures.requests, `${path}.requests`);

  if (total !== prompt + completion) {
    fail(`${path}.totalTokens must equal promptTokens plus completionTokens.`);
  }
  if (!QUALITIES.has(measures.tokenQuality)) fail(`${path}.tokenQuality is unsupported.`);
  if (requests === 0 && total > 0) {
    fail(`${path} reports tokens without any request that produced them.`);
  }

  for (const optional of ['refusedRequests', 'fallbackRequests']) {
    if (!Object.hasOwn(measures, optional)) continue;
    const value = assertCount(measures[optional], `${path}.${optional}`);
    if (value > requests) fail(`${path}.${optional} cannot exceed requests.`);
  }
}

export function assertUsageRollupDocument(document) {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    fail('document must be an object.');
  }
  if (document.contractVersion !== 'v1') fail('contractVersion must be v1.');
  if (document.documentType !== 'usage-rollup') fail('documentType must be usage-rollup.');
  if (!GRAINS.has(document.grain)) fail('grain is unsupported.');

  // The organization grain aggregates every principal, so a key would name a
  // subset the totals do not describe.
  if (document.grain === 'organization') {
    if (Object.hasOwn(document, 'grainKey')) fail('The organization grain must not carry a key.');
  } else if (typeof document.grainKey !== 'string' || !SAFE_ID.test(document.grainKey)) {
    fail('grainKey is required for a keyed grain.');
  }

  const expectedId = usageRollupDocumentId(document);
  if (document.id !== expectedId) {
    fail('document.id must be derived from its scope, grain, key, and window.');
  }

  const start = assertInstant(document.windowStart, 'windowStart');
  const end = assertInstant(document.windowEnd, 'windowEnd');
  const asOf = assertInstant(document.asOf, 'asOf');
  if (end <= start) fail('windowEnd must be after windowStart.');
  if (asOf <= start) fail('asOf must be after windowStart.');

  const completeness = document.completeness;
  if (completeness === null || typeof completeness !== 'object') fail('completeness is required.');
  if (!STATES.has(completeness.state)) fail('completeness.state is unsupported.');
  if (!REASONS.has(completeness.reason)) fail('completeness.reason is unsupported.');
  if (!REASONS_BY_STATE[completeness.state].has(completeness.reason)) {
    fail(`completeness.reason '${completeness.reason}' cannot accompany state '${completeness.state}'.`);
  }
  // A still-open window is a legitimate partial view, but only a closed one can
  // claim to be whole.
  if (completeness.state === 'complete' && asOf < end) {
    fail('A window cannot be reported complete before it ends.');
  }
  if (completeness.reason === 'window-open' && asOf >= end) {
    fail('A window reported as open must be summarized before it ends.');
  }
  if (Object.hasOwn(completeness, 'observedRows') && Object.hasOwn(completeness, 'rowLimit')) {
    const observed = assertCount(completeness.observedRows, 'completeness.observedRows');
    const limit = assertCount(completeness.rowLimit, 'completeness.rowLimit');
    // Reaching the limit means rows were dropped, so the aggregate cannot claim
    // to be whole no matter what the projector believed.
    if (observed >= limit && completeness.state === 'complete') {
      fail('A rollup that reached the source row limit cannot claim to be complete.');
    }
  }

  if (typeof document.sourceRevision !== 'string' || !SAFE_ID.test(document.sourceRevision)) {
    fail('sourceRevision is required.');
  }

  assertMeasures(document.totals, 'totals');

  if (!Array.isArray(document.byModel)) fail('byModel must be an array.');
  const models = [];
  for (const [index, entry] of document.byModel.entries()) {
    const path = `byModel[${index}]`;
    if (typeof entry?.model !== 'string' || !MODEL_ALIAS.test(entry.model)) {
      fail(`${path}.model must be a model alias.`);
    }
    models.push(entry.model);
    assertMeasures(entry.measures, `${path}.measures`);
  }
  if (new Set(models).size !== models.length) fail('byModel must not repeat a model.');
  const sorted = [...models].sort();
  if (models.join('\u0000') !== sorted.join('\u0000')) fail('byModel must be sorted by model.');

  // A per-model breakdown that does not add up to the totals would let a reader
  // reach two different answers from one document.
  const modelRequests = document.byModel.reduce((sum, entry) => sum + entry.measures.requests, 0);
  const modelTokens = document.byModel.reduce((sum, entry) => sum + entry.measures.totalTokens, 0);
  if (document.byModel.length > 0) {
    if (modelRequests !== document.totals.requests) {
      fail('byModel requests must sum to the total requests.');
    }
    if (modelTokens !== document.totals.totalTokens) {
      fail('byModel tokens must sum to the total tokens.');
    }
  } else if (document.totals.requests > 0) {
    fail('A rollup with requests must break them down by model.');
  }

  return document;
}

export function isUsageRollupDocumentValid(document) {
  try {
    assertUsageRollupDocument(document);
    return true;
  } catch {
    return false;
  }
}
