/**
 * Semantic validation for a single request's usage record.
 *
 * A rollup can be recomputed from its window; a record cannot be recomputed from
 * anything, because the request it describes is gone. So the rules here are about
 * what the record is permitted to claim rather than what it is permitted to omit:
 * a figure it cannot support is absent with a reason, never zero, and never a
 * rounded guess that reads like a measurement.
 */

export const OUTCOMES = new Set(['served', 'refused', 'failed']);
const QUALITIES = new Set(['reported', 'estimated', 'unknown']);
// Named for the exchange, not the response: `completion` is body vocabulary and a
// body-free guard is right to refuse it.
export const EXCHANGE_STATES = new Set(['complete', 'abandoned', 'failed']);
const ATTRIBUTION_QUALITIES = new Set(['strong', 'generic']);
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MODEL_ALIAS = /^[A-Za-z0-9._-]{1,64}$/;
const PSEUDONYMOUS_KEY = /^[A-Za-z0-9._-]{16,128}$/;
const CANONICAL_TEAM_KEY = /^[a-z][a-z0-9-]{1,62}$/;
// The same shapes the effective policy document refuses, for the same reason: a
// record crosses into a store and a dashboard, and neither is a place for a secret.
const FORBIDDEN_VALUE = /(https?:\/\/|bearer\s|api-key|sk-[A-Za-z0-9]{8})/i;

function fail(message) {
  throw new TypeError(message);
}

function assertCount(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${name} must be a whole count.`);
  return value;
}

function assertInstant(value, name) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    fail(`${name} must be an ISO-8601 instant.`);
  }
  return Date.parse(value);
}

export function usageRecordDocumentId({ scopeGroupId, correlationId }) {
  if (typeof scopeGroupId !== 'string' || !SAFE_ID.test(scopeGroupId)) {
    fail('scopeGroupId is required.');
  }
  if (typeof correlationId !== 'string' || !CORRELATION_ID.test(correlationId)) {
    fail('correlationId is required.');
  }
  return `usage-record|${scopeGroupId}|${correlationId}`;
}

function assertNoForbiddenValues(value, path) {
  if (typeof value === 'string') {
    if (FORBIDDEN_VALUE.test(value)) fail(`${path} carries a value that must not be stored.`);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) assertNoForbiddenValues(child, `${path}.${key}`);
}

function assertAttribution(attribution) {
  if (attribution === null || typeof attribution !== 'object') fail('attribution is required.');
  if (attribution.teamKey !== null &&
      (typeof attribution.teamKey !== 'string' || !CANONICAL_TEAM_KEY.test(attribution.teamKey))) {
    fail('attribution.teamKey must be null or a canonical team key.');
  }
  for (const name of ['subjectKey', 'applicationKey']) {
    const key = attribution[name];
    if (typeof key !== 'string' || !PSEUDONYMOUS_KEY.test(key)) {
      fail(`attribution.${name} must be a bounded pseudonymous key.`);
    }
  }
  // An unregistered caller is unavailable, not generic. Presenting a shared tool as a
  // specific agent, or an unknown one as a shared tool, both misattribute usage.
  const quality = attribution.applicationQuality;
  if (quality !== null && !ATTRIBUTION_QUALITIES.has(quality)) {
    fail('attribution.applicationQuality must be strong, generic, or null.');
  }
  if (quality === null && typeof attribution.applicationReasonCode !== 'string') {
    fail('attribution.applicationReasonCode is required when the quality is unavailable.');
  }
}

function assertModel(model, path) {
  if (model === null || typeof model !== 'object') fail(`${path} is required.`);
  if (typeof model.modelKey !== 'string' || !MODEL_ALIAS.test(model.modelKey)) {
    fail(`${path}.modelKey must be a bounded model alias.`);
  }
  if (model.providerKey !== null && (typeof model.providerKey !== 'string' || !SAFE_ID.test(model.providerKey))) {
    fail(`${path}.providerKey must be a bounded identifier or null.`);
  }
}

function assertUsage(usage, outcome) {
  if (usage === null || typeof usage !== 'object') fail('usage is required.');
  const prompt = assertCount(usage.promptTokens, 'usage.promptTokens');
  const completion = assertCount(usage.completionTokens, 'usage.completionTokens');
  const total = assertCount(usage.totalTokens, 'usage.totalTokens');
  if (total !== prompt + completion) {
    fail('usage.totalTokens must equal promptTokens plus completionTokens.');
  }
  if (!QUALITIES.has(usage.tokenQuality)) fail('usage.tokenQuality is unsupported.');
  if (!EXCHANGE_STATES.has(usage.exchangeState)) fail('usage.exchangeState is unsupported.');
  // An abandoned exchange was still charged, so its count can never be exact.
  if (usage.exchangeState === 'abandoned' && usage.tokenQuality === 'reported') {
    fail('An abandoned request cannot carry a reported token count.');
  }
  // A refused request never reached a model, so counted tokens would have to have
  // come from somewhere else.
  if (outcome === 'refused' && total > 0) {
    fail('A refused request cannot report token usage.');
  }
  if (usage.tokenQuality === 'unknown' && total > 0) {
    fail('Usage reported as unknown cannot also carry a token count.');
  }
}

export function assertUsageRecordDocument(document) {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    fail('document must be an object.');
  }
  if (document.contractVersion !== 'v1') fail('document.contractVersion must be v1.');
  if (document.documentType !== 'usage-record') fail('document.documentType must be usage-record.');

  const expectedId = usageRecordDocumentId(document);
  if (document.id !== expectedId) {
    fail('document.id must be derived from scopeGroupId and correlationId.');
  }

  const observedAt = assertInstant(document.observedAt, 'document.observedAt');
  const projectedAt = assertInstant(document.projectedAt, 'document.projectedAt');
  if (projectedAt < observedAt) fail('document.projectedAt cannot precede document.observedAt.');

  if (!OUTCOMES.has(document.outcome)) fail('document.outcome is unsupported.');
  assertAttribution(document.attribution);
  assertModel(document.requested, 'document.requested');
  assertModel(document.effective, 'document.effective');
  assertUsage(document.usage, document.outcome);

  if (!Number.isSafeInteger(document.configVersion) || document.configVersion < 1) {
    fail('document.configVersion must be a positive integer.');
  }
  if (typeof document.sourceRevision !== 'string' || document.sourceRevision.length === 0) {
    fail('document.sourceRevision is required.');
  }
  assertNoForbiddenValues(document, 'document');
  return true;
}
