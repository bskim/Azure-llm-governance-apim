import { resolveApplicationAttribution, resolveModelDescriptor } from '../registry/model-registry-validator.mjs';
import { assertUsageRecordDocument, usageRecordDocumentId } from './usage-record-validator.mjs';

/**
 * Projects telemetry rows into one immutable record per request.
 *
 * Records are the only per-request evidence this product keeps, and they are what
 * drift detection compares against the provider. That makes re-projection the
 * interesting case rather than an edge case: the same window will be read more
 * than once, by a retry, a backfill, or an operator. Projecting the same request
 * twice must therefore produce the same document, and a second projection that
 * disagrees is a finding rather than an update.
 */

function fail(message) {
  throw new TypeError(message);
}

function resolveDescriptor(registry, modelKey) {
  if (registry === null) return { reasonCode: 'registry-unavailable' };
  if (registry.status !== 'complete') return { reasonCode: 'registry-unavailable' };
  const descriptor = resolveModelDescriptor(registry, modelKey);
  if (descriptor === null) return { reasonCode: 'model-unregistered' };
  return { descriptor, providerKey: descriptor.providerKey };
}

function providerFor(registry, modelKey) {
  const resolved = resolveDescriptor(registry, modelKey);
  return resolved.providerKey ?? null;
}

function attributionFor(registry, row) {
  if (registry === null || registry.status !== 'complete') {
    return {
      teamKey: row.teamKey,
      subjectKey: row.subjectKey,
      applicationKey: row.applicationKey,
      applicationQuality: null,
      applicationReasonCode: 'model-registry-unavailable',
    };
  }
  const resolved = resolveApplicationAttribution(registry, row.applicationId);
  return {
    teamKey: row.teamKey,
    subjectKey: row.subjectKey,
    applicationKey: row.applicationKey,
    applicationQuality: resolved.quality,
    applicationReasonCode: resolved.reasonCode,
  };
}

function usageFor(row) {
  const prompt = row.promptTokens ?? 0;
  const completion = row.completionTokens ?? 0;
  const quality = row.tokenQuality ?? 'unknown';
  // Streaming and abandoning both produce estimated counts. Only the second means the
  // caller never received what their budget paid for.
  const state = row.exchangeState ?? 'complete';
  // A count that arrives alongside an unknown quality is a count nothing vouches
  // for. Keeping it would let an unverifiable number into every aggregate above.
  if (quality === 'unknown') {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0, tokenQuality: 'unknown', exchangeState: state };
  }
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: prompt + completion,
    tokenQuality: quality,
    exchangeState: state,
  };
}

function freeze(document) {
  for (const value of Object.values(document)) {
    if (value !== null && typeof value === 'object') Object.freeze(value);
  }
  return Object.freeze(document);
}

/**
 * Two records describe the same request identically or they do not. Comparing the
 * serialised form rather than a chosen subset means a field added later is covered
 * without anyone remembering to add it here.
 */
function conflictBetween(existing, projected) {
  const { projectedAt: _existingAt, ...existingRest } = existing;
  const { projectedAt: _projectedAt, ...projectedRest } = projected;
  return JSON.stringify(existingRest) === JSON.stringify(projectedRest)
    ? null
    : { id: projected.id, correlationId: projected.correlationId };
}

export function projectUsageRecords({
  rows,
  scopeGroupId,
  registry = null,
  configVersion,
  sourceRevision,
  projectedAt,
  existingById = new Map(),
}) {
  if (!Array.isArray(rows)) fail('rows must be an array.');
  if (typeof scopeGroupId !== 'string' || scopeGroupId.length === 0) fail('scopeGroupId is required.');
  if (typeof projectedAt !== 'string') fail('projectedAt is required.');

  const records = [];
  const conflicts = [];
  const unchanged = [];
  const rejected = [];
  const seen = new Set();

  for (const row of rows) {
    if (typeof row?.correlationId !== 'string' || row.correlationId.length === 0) {
      // A row with no request identity cannot be deduplicated, so admitting it would
      // let one request be counted once per read.
      rejected.push({ reasonCode: 'correlation-id-absent' });
      continue;
    }
    // A repeat inside one read is the same request seen twice, not two requests.
    if (seen.has(row.correlationId)) {
      rejected.push({ correlationId: row.correlationId, reasonCode: 'duplicate-in-window' });
      continue;
    }
    seen.add(row.correlationId);

    const outcome = row.outcome ?? 'served';
    const usage = usageFor(row);
    const effectiveModel = row.effectiveModel ?? row.requestedModel;
    const document = {
      contractVersion: 'v1',
      documentType: 'usage-record',
      id: usageRecordDocumentId({ scopeGroupId, correlationId: row.correlationId }),
      scopeGroupId,
      correlationId: row.correlationId,
      observedAt: row.observedAt,
      projectedAt,
      outcome,
      attribution: attributionFor(registry, row),
      requested: {
        modelKey: row.requestedModel,
        providerKey: providerFor(registry, row.requestedModel),
      },
      effective: {
        modelKey: effectiveModel,
        providerKey: providerFor(registry, effectiveModel),
      },
      usage,
      configVersion,
      sourceRevision,
    };

    try {
      assertUsageRecordDocument(document);
    } catch (error) {
      rejected.push({ correlationId: row.correlationId, reasonCode: 'record-invalid', detail: error.message });
      continue;
    }

    const existing = existingById.get(document.id);
    if (existing === undefined) {
      records.push(freeze(document));
      continue;
    }
    const conflict = conflictBetween(existing, document);
    // The stored record wins. It was written from evidence available at the time,
    // and silently replacing it would erase the disagreement drift detection exists
    // to surface.
    if (conflict === null) unchanged.push(existing);
    else conflicts.push(conflict);
  }

  return Object.freeze({
    records: Object.freeze(records),
    unchanged: Object.freeze(unchanged),
    conflicts: Object.freeze(conflicts),
    rejected: Object.freeze(rejected),
  });
}
