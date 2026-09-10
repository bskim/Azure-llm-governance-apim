import { planPublishNotifications } from '../governance-domain/usage/governance-event-notifications.mjs';

/**
 * Turning recorded publish failures into notifications.
 *
 * It re-derives from the stored revisions rather than firing at the moment a failure
 * is written, so a failure recorded while the notification path was down is still
 * raised later. Repeating is safe: the key names the publish attempt, and the store
 * refuses the second write.
 */

function fail(message) {
  throw new TypeError(message);
}

export function createPublishFailureSweep({ store, ledger, clock, scopeGroupId }) {
  if (typeof store?.queryConfigurationRevisions !== 'function') {
    fail('store must be able to list configuration revisions.');
  }
  if (typeof ledger?.raise !== 'function') fail('ledger is required.');
  if (typeof clock?.nowIso !== 'function') fail('clock is required.');

  async function run() {
    const revisions = await store.queryConfigurationRevisions({ scopeGroupId });
    const { planned } = planPublishNotifications({
      scopeGroupId,
      revisions,
      evaluationTime: clock.nowIso(),
      alreadyNotified: await ledger.alreadyNotified({ sinceRaisedAt: '1970-01-01T00:00:00.000Z' }),
    });
    if (planned.length === 0) return Object.freeze({ raised: 0, alreadyRaised: 0 });

    const result = await ledger.raise(planned);
    return Object.freeze({ raised: result.raised.length, alreadyRaised: result.alreadyRaised.length });
  }

  return Object.freeze({ run });
}
