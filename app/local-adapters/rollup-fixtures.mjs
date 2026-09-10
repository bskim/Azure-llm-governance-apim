import { projectUsageRecords } from '../governance-domain/usage/usage-record-projector.mjs';
import { projectUsageRollups } from '../governance-domain/usage/usage-rollup-projector.mjs';

/**
 * Deterministic rollup windows for local development.
 *
 * They are produced by the same projector the scheduled run uses, so the local
 * Admin UI is driven by documents a deployment could actually have written
 * rather than by a hand-shaped imitation of them.
 */

const SCOPE_GROUP_ID = 'platform-engineering';

const ROWS = Object.freeze([
  { teamKey: 'platform-engineering', model: 'coding-primary', requests: 9, prompt: 620, completion: 180 },
  { teamKey: 'platform-engineering', model: 'coding-fast', requests: 3, prompt: 140, completion: 60 },
  { teamKey: 'developer-experience', model: 'coding-fast', requests: 4, prompt: 210, completion: 70 },
]);

// How well a calling application is known differs by how it authenticated, and all three
// answers occur in practice: a client with its own registered identity, a shared
// developer tool that authenticates as itself, and something the catalogue does not
// carry at all. A fixture with only one of them cannot show a screen refusing to name a
// specific agent for the other two.
const APPLICATIONS = Object.freeze([
  { applicationId: 'app-local-console', applicationKey: 'ak1-local-console-0000' },
  { applicationId: 'app-local-agent', applicationKey: 'ak1-local-agent-0000' },
  { applicationId: 'app-local-unlisted', applicationKey: 'ak1-local-unlisted-000' },
]);

function expand({ teamKey, model, requests, prompt, completion }, windowIndex) {
  return Array.from({ length: requests }, (_unused, requestIndex) => {
    const application = APPLICATIONS[requestIndex % APPLICATIONS.length];
    // One request per window is served by the cheaper model it was downgraded to, so the
    // aggregate has a substitution to report rather than only matching pairs.
    const substituted = model === 'coding-primary' && requestIndex === 1;
    return {
      teamKey,
      subjectKey: `sk1-local-${teamKey}-${(requestIndex % 3) + 1}`,
      applicationId: application.applicationId,
      applicationKey: application.applicationKey,
      requestedModel: model,
      effectiveModel: substituted ? 'coding-fast' : model,
      promptTokens: prompt + windowIndex,
      completionTokens: completion,
      // One window carries an estimated row, so the local UI shows a mixed window
      // rather than only the flattering case.
      tokenQuality: windowIndex === 1 && model === 'coding-fast' ? 'estimated' : 'reported',
      outcome: requestIndex === 0 && model === 'coding-fast' ? 'refused' : 'served',
      correlationId: `local-${windowIndex}-${teamKey}-${model}-${requestIndex}`,
    };
  });
}

/** Windows end on the hour and lag the source, exactly as the scheduled run aligns them. */
function alignWindows({ asOf, windows, ingestionLagSeconds }) {
  const hourMs = 3_600_000;
  const lastEnd = Math.floor((Date.parse(asOf) - ingestionLagSeconds * 1000) / hourMs) * hourMs;
  return Array.from({ length: windows }, (_unused, index) => {
    const windowEnd = lastEnd - (windows - 1 - index) * hourMs;
    return {
      index,
      windowStart: new Date(windowEnd - hourMs).toISOString(),
      windowEnd: new Date(windowEnd).toISOString(),
      rows: ROWS.flatMap((row) => expand(row, index)),
    };
  });
}

export function getLocalRollups({ asOf, windows = 3, ingestionLagSeconds = 300 }) {
  const documents = [];
  for (const { index, windowStart, windowEnd, rows } of alignWindows({ asOf, windows, ingestionLagSeconds })) {
    documents.push(
      ...projectUsageRollups({
        rows,
        scopeGroupId: SCOPE_GROUP_ID,
        windowStart,
        windowEnd,
        asOf,
        source: {
          state: 'complete',
          rowCount: rows.length,
          rowLimit: 500_000,
          revision: `local-rollup-${index}`,
          ingestionLagSeconds,
        },
      }),
    );
  }
  return documents;
}

/**
 * The same rows as records, so the usage screen and the overview cannot disagree.
 *
 * A refused request never reached a model, so it carries no tokens here. That is
 * what makes the local screen show a partially priced aggregate: the refusal is
 * counted, and its cost is absent with a reason rather than as a zero.
 */
export function getLocalUsageRecords({ asOf, registry, windows = 3, ingestionLagSeconds = 300, configVersion = 1 }) {
  const records = [];
  const aligned = alignWindows({ asOf, windows, ingestionLagSeconds });
  for (const { index, windowEnd, rows } of aligned) {
    const observedAt = new Date(Date.parse(windowEnd) - 1000).toISOString();
    records.push(
      ...projectUsageRecords({
        rows: rows.map((row) => ({
          ...row,
          observedAt,
          promptTokens: row.outcome === 'refused' ? 0 : row.promptTokens,
          completionTokens: row.outcome === 'refused' ? 0 : row.completionTokens,
        })),
        scopeGroupId: SCOPE_GROUP_ID,
        registry,
        configVersion,
        sourceRevision: `local-rollup-${index}`,
        projectedAt: asOf,
      }).records,
    );
  }
  return {
    records,
    window: {
      windowStart: aligned[0].windowStart,
      windowEnd: aligned.at(-1).windowEnd,
      asOf,
      completeness: { state: 'complete', reason: 'window-closed' },
    },
  };
}
