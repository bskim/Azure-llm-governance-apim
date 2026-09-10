import {
  acknowledgeNotification,
  raiseNotification,
  recordDeliveryAttempt,
} from '../governance-domain/notification/notification-delivery.mjs';

/**
 * The notifications a period has earned, and what has happened to them since.
 *
 * Deduplication is the store's create, not a set held in memory: a scheduler
 * re-reading a window and a second worker deciding the same thing are both normal,
 * and neither survives a process. Two writers producing the same identifier is the
 * intended outcome, so the conflict is the answer rather than an error.
 */

function fail(message) {
  throw new TypeError(message);
}

export function createNotificationLedger({ store, scopeGroupId }) {
  if (typeof store?.readNotification !== 'function' || typeof store?.putNotification !== 'function') {
    fail('store must be able to read and write notifications.');
  }
  if (typeof scopeGroupId !== 'string' || scopeGroupId.length === 0) fail('scopeGroupId is required.');

  async function raise(notifications) {
    const raised = [];
    const alreadyRaised = [];

    for (const planned of notifications) {
      const record = raiseNotification({
        scopeGroupId,
        key: planned.key,
        kind: planned.kind,
        severity: planned.severity,
        scope: planned.scope,
        scopeKey: planned.scopeKey ?? null,
        periodStart: planned.periodStart,
        raisedAt: planned.raisedAt,
      });
      try {
        await store.putNotification(record, { ifMatch: null });
        raised.push(planned.key);
      } catch (error) {
        if (error?.name !== 'ConcurrencyConflictError') throw error;
        alreadyRaised.push(planned.key);
      }
    }

    return Object.freeze({ raised: Object.freeze(raised), alreadyRaised: Object.freeze(alreadyRaised) });
  }

  async function list({ sinceRaisedAt }) {
    return store.queryNotifications({ scopeGroupId, sinceRaisedAt });
  }

  async function alreadyNotified({ sinceRaisedAt }) {
    const records = await list({ sinceRaisedAt });
    return new Set(records.map((record) => record.key));
  }

  async function dueForDelivery({ now, sinceRaisedAt = '1970-01-01T00:00:00.000Z' }) {
    const records = await list({ sinceRaisedAt });
    return records.filter(
      (record) =>
        record.deliveryState === 'pending' &&
        record.nextAttemptAt !== null &&
        Date.parse(record.nextAttemptAt) <= Date.parse(now),
    );
  }

  async function apply(key, change) {
    const held = await store.readNotification({ scopeGroupId, key });
    if (held === null) return Object.freeze({ ok: false, reasonCode: 'notification-absent' });

    const result = change(held.document);
    if (result.ok !== true) return result;

    try {
      await store.putNotification(result.notification, { ifMatch: held.etag });
    } catch (error) {
      if (error?.name !== 'ConcurrencyConflictError') throw error;
      // Somebody else recorded an outcome for this notification first. Overwriting it
      // would replace a real delivery record with a stale one.
      return Object.freeze({ ok: false, reasonCode: 'changed-since-read' });
    }
    return result;
  }

  function deliver({ key, outcome, channelCode, reasonCode = null, at }) {
    return apply(key, (notification) =>
      recordDeliveryAttempt({ notification, outcome, channelCode, reasonCode, at }),
    );
  }

  function acknowledge({ key, actorCode, at }) {
    return apply(key, (notification) => acknowledgeNotification({ notification, actorCode, at }));
  }

  return Object.freeze({ raise, list, alreadyNotified, dueForDelivery, deliver, acknowledge });
}
