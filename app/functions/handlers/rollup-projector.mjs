import { projectUsageRollups } from '../../governance-domain/usage/usage-rollup-projector.mjs';
import { projectUsageRecords } from '../../governance-domain/usage/usage-record-projector.mjs';

/**
 * The scheduled rollup projector.
 *
 * It reads a closed window from the diagnostic log source, aggregates it, and
 * writes rollup documents. Rewriting the same window must be safe, because a
 * retry, a schedule overlap, or a manual backfill will all do exactly that.
 */

function fail(message) {
  throw new TypeError(message);
}

/**
 * Windows are aligned to the schedule grain so two runs covering the same period
 * produce the same window boundaries, and therefore the same document
 * identifiers, rather than two overlapping partial views.
 */
export function resolveWindow(now, windowSeconds, lagSeconds = 0) {
  if (!Number.isSafeInteger(windowSeconds) || windowSeconds < 60) {
    fail('windowSeconds must be at least 60.');
  }
  const nowMs = Date.parse(now);
  if (Number.isNaN(nowMs)) fail('now must be an ISO-8601 instant.');

  const windowMs = windowSeconds * 1000;
  // The lag is subtracted before alignment so the projector summarizes a window
  // the source has had time to deliver, rather than the one that just ended.
  const alignedEnd = Math.floor((nowMs - lagSeconds * 1000) / windowMs) * windowMs;
  return {
    windowStart: new Date(alignedEnd - windowMs).toISOString(),
    windowEnd: new Date(alignedEnd).toISOString(),
  };
}

export function createRollupProjector({ usageQuery, rollupStore, recordSink, readModelRegistry, clock, config } = {}) {
  if (typeof usageQuery?.readWindow !== 'function') fail('usageQuery is required.');
  if (typeof rollupStore?.putRollup !== 'function') fail('rollupStore is required.');
  if (typeof clock?.nowIso !== 'function') fail('clock is required.');
  if (config === null || typeof config !== 'object') fail('config is required.');
  if (typeof config.scopeGroupId !== 'string' || config.scopeGroupId.length === 0) {
    fail('config.scopeGroupId is required.');
  }
  // Required rather than optional, and three-valued. An aggregate cannot say what one
  // request cost, so a deployment that keeps no records has decided that; a caller who
  // simply forgot would otherwise get the same silence.
  if (recordSink === undefined) fail('recordSink is required; pass null to keep no per-request records.');
  if (recordSink !== null && typeof recordSink.putUsageRecord !== 'function') {
    fail('recordSink must be able to write a usage record.');
  }
  if (recordSink !== null && typeof recordSink.queryUsageRecords !== 'function') {
    fail('recordSink must be able to read back what it wrote, or a replay cannot be compared.');
  }
  if (recordSink !== null && typeof readModelRegistry !== 'function') {
    fail('readModelRegistry is required when records are kept: a record carries the provider that served it.');
  }

  const windowSeconds = config.windowSeconds ?? 3600;
  const ingestionLagSeconds = config.ingestionLagSeconds ?? 300;

  async function runWindow({ windowStart, windowEnd }) {
    const now = clock.nowIso();

    let result;
    try {
      result = await usageQuery.readWindow({ windowStart, windowEnd });
    } catch {
      // A source outage must produce a document that says so, not a gap a reader
      // would mistake for a quiet hour.
      result = { rows: [], state: 'unavailable', rowCount: 0, revision: `unavailable-${now}` };
    }

    const documents = projectUsageRollups({
      rows: result.rows ?? [],
      scopeGroupId: config.scopeGroupId,
      windowStart,
      windowEnd,
      asOf: now,
      source: {
        state: result.state ?? 'complete',
        rowCount: result.rowCount ?? (result.rows ?? []).length,
        rowLimit: result.rowLimit ?? config.rowLimit ?? 500_000,
        revision: result.revision,
        ingestionLagSeconds,
      },
    });

    let written = 0;
    for (const document of documents) {
      await rollupStore.putRollup(document);
      written += 1;
    }

    const records = await recordWindow({
      rows: result.rows ?? [],
      windowStart,
      sourceRevision: result.revision ?? `unavailable-${now}`,
      projectedAt: now,
    });

    return Object.freeze({
      windowStart,
      windowEnd,
      asOf: now,
      documentsWritten: written,
      completeness: documents[0]?.completeness.state ?? 'degraded',
      records,
    });
  }

  /**
   * The same rows again, one document per request, because only a record carries a
   * cost and an aggregate cannot be asked what one request was.
   *
   * The store creates and never replaces, so a replayed window meets what it wrote
   * last time. Agreement is the ordinary case; disagreement is a finding, and the
   * stored record wins, because overwriting it would erase the finding.
   */
  async function recordWindow({ rows, windowStart, sourceRevision, projectedAt }) {
    if (recordSink === null) {
      return Object.freeze({ state: 'not-kept', reasonCode: 'records-not-configured', written: 0, conflicts: 0 });
    }

    let registry;
    try {
      registry = await readModelRegistry();
    } catch {
      registry = null;
    }
    // The version a reader needs to re-derive the provider and price a record carries,
    // so it comes from the catalogue that decided them.
    const configVersion = registry?.version ?? null;
    if (registry === null || !Number.isSafeInteger(configVersion)) {
      return Object.freeze({
        state: 'skipped',
        reasonCode: 'model-catalogue-unavailable',
        written: 0,
        conflicts: 0,
      });
    }

    const existingById = new Map(
      (await recordSink.queryUsageRecords({ scopeGroupId: config.scopeGroupId, sinceObservedAt: windowStart }))
        .map((document) => [document.id, document]),
    );

    const { records, conflicts } = projectUsageRecords({
      rows,
      scopeGroupId: config.scopeGroupId,
      registry,
      configVersion,
      sourceRevision,
      projectedAt,
      existingById,
    });

    let written = 0;
    for (const record of records) {
      const outcome = await recordSink.putUsageRecord(record);
      if (outcome?.created !== false) written += 1;
    }
    return Object.freeze({
      state: 'kept',
      reasonCode: conflicts.length === 0 ? 'records-written' : 'records-written-with-conflicts',
      written,
      conflicts: conflicts.length,
    });
  }

  async function run() {
    return runWindow(resolveWindow(clock.nowIso(), windowSeconds, ingestionLagSeconds));
  }

  return Object.freeze({ run, runWindow });
}
