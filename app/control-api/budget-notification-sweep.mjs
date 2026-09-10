import { budgetObservationSelector, observePeriodConsumption } from '../governance-domain/usage/period-consumption.mjs';
import { planBudgetNotifications } from '../governance-domain/usage/budget-notification-planner.mjs';

/**
 * Comparing a period's consumption against its budgets, and raising what it earned.
 *
 * The observation is built for every scope the publication names, including scopes
 * with no aggregate at all: leaving one out makes the planner suppress it as
 * "nothing to compare", which is the same as saying the period was fine.
 */

function fail(message) {
  throw new TypeError(message);
}

export function createBudgetNotificationSweep({
  store,
  ledger,
  clock,
  scopeGroupId,
  publication,
  periodStart,
  periodEnd,
  windowSeconds = 3600,
}) {
  if (typeof store?.queryRollupWindows !== 'function') fail('store must be able to query rollups.');
  if (typeof ledger?.raise !== 'function') fail('ledger is required.');
  if (typeof clock?.nowIso !== 'function') fail('clock is required.');
  if (publication === null || typeof publication !== 'object') fail('publication is required.');

  async function run() {
    const rollups = await store.queryRollupWindows({ scopeGroupId, sinceWindowStart: periodStart });
    const scopes = (publication.entries ?? []).map(budgetObservationSelector);

    const observations =
      scopes.length === 0
        ? []
        : observePeriodConsumption({ rollups, periodStart, periodEnd, windowSeconds, scopes });

    const { planned } = planBudgetNotifications({
      scopeGroupId,
      publication,
      observations,
      periodStart,
      evaluationTime: clock.nowIso(),
      alreadyNotified: await ledger.alreadyNotified({ sinceRaisedAt: '1970-01-01T00:00:00.000Z' }),
    });
    if (planned.length === 0) return Object.freeze({ raised: 0, alreadyRaised: 0 });

    const result = await ledger.raise(
      planned.map((notification) => ({
        ...notification,
        scope: notification.scope ?? 'organization',
        scopeKey: notification.scopeKey ?? null,
      })),
    );
    return Object.freeze({ raised: result.raised.length, alreadyRaised: result.alreadyRaised.length });
  }

  return Object.freeze({ run });
}
