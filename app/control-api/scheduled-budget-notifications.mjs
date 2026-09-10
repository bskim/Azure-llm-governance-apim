import { publishBudgets } from '../governance-domain/policy/budget-publication.mjs';
import { observePeriodConsumption } from '../governance-domain/usage/period-consumption.mjs';
import { floorToWindow, startOfPeriod, scopeKeysInPeriod } from '../governance-domain/usage/budget-period.mjs';
import { createBudgetNotificationSweep } from './budget-notification-sweep.mjs';

/**
 * Running the budget comparison on a schedule, over whatever is published.
 *
 * The comparison itself already exists and is tested; what was missing was anything
 * that ran it. Hosting it needs three answers the sweep cannot give itself.
 *
 * A period is per budget, not per run: budgets may be hourly or yearly, and comparing
 * a yearly cap against an hour of traffic reports every year as comfortable.
 *
 * A period ends at the newest window the aggregation has actually closed, not at the
 * calendar end: every window between now and the end of the month is missing, and
 * missing windows are what tells a partial period from a quiet one.
 *
 * A budget names a scope but not which team, subject or application, because the
 * gateway gives each one its own counter and the cap applies to each. So the keys are
 * whichever appear in the period's aggregates. A key with no aggregate consumed
 * nothing and cannot cross a threshold -- but only while the organization's own
 * coverage is whole, because during a gap an absent key is indistinguishable from a
 * silent one. That is why an incomplete organization reading stops the run instead of
 * comparing the keys that happen to have survived.
 */

function fail(message) {
  throw new TypeError(message);
}

function globalAllowlist(entitlementSnapshot) {
  const binding = (entitlementSnapshot?.bindings ?? []).find(
    (candidate) => candidate.state === 'active' && candidate.target?.kind === 'global',
  );
  return binding === undefined ? null : binding.modelAllowlist;
}

export function createScheduledBudgetNotifications({
  store,
  ledger,
  readPublishedSnapshots,
  clock,
  scopeGroupId,
  windowSeconds = 3600,
  ingestionLagSeconds = 0,
}) {
  if (typeof store?.queryRollupWindows !== 'function') fail('store must be able to query rollups.');
  if (typeof ledger?.raise !== 'function') fail('ledger is required.');
  if (typeof readPublishedSnapshots !== 'function') fail('readPublishedSnapshots is required.');
  if (typeof clock?.nowIso !== 'function') fail('clock is required.');
  if (typeof scopeGroupId !== 'string' || scopeGroupId.length === 0) fail('scopeGroupId is required.');
  if (!Number.isSafeInteger(windowSeconds) || windowSeconds < 1) fail('windowSeconds must be a positive integer.');
  if (!Number.isSafeInteger(ingestionLagSeconds) || ingestionLagSeconds < 0) {
    fail('ingestionLagSeconds must be a whole number of seconds.');
  }

  async function run() {
    const now = clock.nowIso();
    const observedThrough = floorToWindow(Date.parse(now) - ingestionLagSeconds * 1000, windowSeconds);

    let snapshots;
    try {
      snapshots = await readPublishedSnapshots();
    } catch (error) {
      // Nothing published is not a period that earned no warnings; it is a period
      // nobody could judge, and the run has to say which.
      return Object.freeze({
        outcome: 'unavailable',
        reasonCode: error?.reasonCode ?? 'published-governance-unreadable',
        observedThrough,
        periods: [],
        raised: 0,
        alreadyRaised: 0,
      });
    }

    const allowedModels = globalAllowlist(snapshots.entitlementSnapshot);
    if (allowedModels === null) {
      return Object.freeze({
        outcome: 'unavailable',
        reasonCode: 'organization-entitlement-absent',
        observedThrough,
        periods: [],
        raised: 0,
        alreadyRaised: 0,
      });
    }

    const budgets = snapshots.budgetSnapshot?.budgets ?? [];
    const byPeriod = new Map();
    for (const budget of budgets) {
      const held = byPeriod.get(budget.period) ?? [];
      held.push(budget);
      byPeriod.set(budget.period, held);
    }
    if (byPeriod.size === 0) {
      return Object.freeze({
        outcome: 'idle',
        reasonCode: 'no-budget-published',
        observedThrough,
        periods: [],
        raised: 0,
        alreadyRaised: 0,
      });
    }

    const earliest = [...byPeriod.keys()]
      .map((period) => startOfPeriod(period, observedThrough))
      .sort()[0];
    const rollups = await store.queryRollupWindows({ scopeGroupId, sinceWindowStart: earliest });
    // The comparison reads the aggregates again through this, so a run is one read.
    const readOnce = {
      queryRollupWindows: async ({ sinceWindowStart }) =>
        rollups.filter((document) => document.windowStart >= sinceWindowStart),
    };

    const periods = [];
    let raised = 0;
    let alreadyRaised = 0;

    for (const [period, entries] of [...byPeriod.entries()].sort()) {
      const periodStart = startOfPeriod(period, observedThrough);
      if (periodStart >= observedThrough) {
        periods.push(Object.freeze({
          period,
          periodStart,
          periodEnd: observedThrough,
          state: 'skipped',
          reasonCode: 'period-not-yet-observable',
          budgets: entries.length,
          scopesObserved: 0,
          raised: 0,
          alreadyRaised: 0,
        }));
        continue;
      }

      // Read for the report only. Refusing to compare at all when the period has a
      // gap would leave the ledger silent, which is the one reading an operator must
      // never get from an unjudgeable period. The planner already refuses to conclude
      // a threshold from a partial observation and raises staleness instead, so the
      // gap is reported by the mechanism that exists for it.
      const [organization] = observePeriodConsumption({
        rollups,
        periodStart,
        periodEnd: observedThrough,
        windowSeconds,
        scopes: [{ scope: 'organization', scopeKey: null }],
      });

      const publication = publishBudgets({
        budgetSnapshot: { ...snapshots.budgetSnapshot, budgets: entries },
        registry: snapshots.modelRegistrySnapshot,
        allowedModels,
        evaluationTime: now,
      });

      // One published entry becomes one comparison per key the period saw, because
      // the cap applies to each of them separately at the gateway.
      const expanded = (publication.entries ?? []).flatMap((entry) => {
        if (entry.scope === 'organization') return [{ ...entry, scopeKey: null }];
        const keys = scopeKeysInPeriod(rollups, entry.scope, periodStart, observedThrough);
        return keys.map((scopeKey) => ({ ...entry, scopeKey }));
      });

      const outcome = await createBudgetNotificationSweep({
        store: readOnce,
        ledger,
        clock,
        scopeGroupId,
        publication: { ...publication, entries: expanded },
        periodStart,
        periodEnd: observedThrough,
        windowSeconds,
      }).run();

      raised += outcome.raised;
      alreadyRaised += outcome.alreadyRaised;
      periods.push(Object.freeze({
        period,
        periodStart,
        periodEnd: observedThrough,
        state: 'compared',
        reasonCode: publication.state === 'published' ? 'compared' : `publication-${publication.state}`,
        // How much of the period was actually aggregated. A total from a period with a
        // gap is lower than the truth, so the coverage has to travel with the run.
        coverage: organization.completeness,
        coverageReason: organization.completenessReason,
        budgets: entries.length,
        scopesObserved: expanded.length,
        raised: outcome.raised,
        alreadyRaised: outcome.alreadyRaised,
      }));
    }

    return Object.freeze({
      outcome: 'ran',
      reasonCode: 'run-recorded',
      observedThrough,
      periods: Object.freeze(periods),
      raised,
      alreadyRaised,
    });
  }

  return Object.freeze({ run });
}
