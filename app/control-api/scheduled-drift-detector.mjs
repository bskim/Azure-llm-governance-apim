import { createScheduleRunner } from './schedule-runner.mjs';
import { detectUsageDrift } from '../governance-domain/usage/drift-detector.mjs';
import { planDriftNotifications } from '../governance-domain/usage/governance-event-notifications.mjs';
import { usageRollupDocumentId } from '../governance-domain/usage/usage-rollup-validator.mjs';

/**
 * Comparing each closed window against the provider, on a schedule that survives a
 * restart.
 *
 * Both sides declare whether they are complete, and neither absence is treated as a
 * zero. A missing rollup compared as zero would report the provider inventing
 * traffic; an unreachable provider compared as zero would report the gateway
 * inventing it. Both are louder than the real disputes and would bury them.
 */

function fail(message) {
  throw new TypeError(message);
}

function internalSide(rollup) {
  if (rollup === null) {
    return { requests: 0, totalTokens: 0, completeness: 'partial' };
  }
  return {
    requests: rollup.totals.requests,
    totalTokens: rollup.totals.totalTokens,
    completeness: rollup.completeness.state === 'complete' ? 'complete' : 'partial',
  };
}

export function createScheduledDriftDetector({
  store,
  ledger,
  providerUsage,
  clock,
  scopeGroupId,
  windowSeconds = 3600,
  ingestionLagSeconds = 300,
  startedFrom,
  ownerCode,
  leaseSeconds,
  maxBackfillWindows,
  scheduleId = 'usage-drift',
}) {
  if (typeof providerUsage?.readWindow !== 'function') fail('providerUsage is required.');
  if (typeof ledger?.raise !== 'function') fail('ledger is required.');
  if (typeof clock?.nowIso !== 'function') fail('clock is required.');

  // A provider that cannot be reached produces the same run as one that agreed, so
  // without this a comparison that never happened is indistinguishable from a clean
  // one. Counted per tick and reported, so the failure has somewhere to show.
  let tally = null;

  async function compare({ windowStart, windowEnd }) {
    const held = await store.readRollup({
      scopeGroupId,
      id: usageRollupDocumentId({ scopeGroupId, grain: 'organization', windowStart }),
    });

    let provider;
    try {
      const reported = await providerUsage.readWindow({ windowStart, windowEnd });
      provider = { ...reported, completeness: 'complete' };
      tally.providerRead += 1;
    } catch (error) {
      provider = { requests: 0, totalTokens: 0, completeness: 'unavailable' };
      tally.providerUnavailable += 1;
      tally.providerReasonCodes.add(error?.name ?? 'request-failed');
    }

    const drift = detectUsageDrift({
      windowStart,
      windowEnd,
      internal: internalSide(held?.document ?? null),
      provider,
      evaluationTime: clock.nowIso(),
    });
    tally.states[drift.state] = (tally.states[drift.state] ?? 0) + 1;

    const { planned } = planDriftNotifications({
      scopeGroupId,
      drift,
      evaluationTime: clock.nowIso(),
      alreadyNotified: await ledger.alreadyNotified({ sinceRaisedAt: '1970-01-01T00:00:00.000Z' }),
    });
    if (planned.length > 0) await ledger.raise(planned);
    tally.raised += planned.length;
  }

  const runner = createScheduleRunner({
    store,
    scopeGroupId,
    scheduleId,
    intervalSeconds: windowSeconds,
    startedFrom,
    leaseSeconds,
    ownerCode,
    maxBackfillWindows,
    run: compare,
  });

  async function tick() {
    // The same lag the aggregation waits for: comparing a window the rollup has not
    // finished covering would dispute an aggregate that is still being written.
    const delivered = new Date(Date.parse(clock.nowIso()) - ingestionLagSeconds * 1000).toISOString();
    tally = { providerRead: 0, providerUnavailable: 0, providerReasonCodes: new Set(), states: {}, raised: 0 };
    const result = await runner.tick(delivered);
    return Object.freeze({
      ...result,
      comparison: Object.freeze({
        providerRead: tally.providerRead,
        providerUnavailable: tally.providerUnavailable,
        providerReasonCodes: Object.freeze([...tally.providerReasonCodes].sort()),
        states: Object.freeze({ ...tally.states }),
        raised: tally.raised,
      }),
    });
  }

  return Object.freeze({ tick });
}
