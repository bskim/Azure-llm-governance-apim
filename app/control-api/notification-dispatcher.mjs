/**
 * Sending the notifications that are due, and recording what the channel said.
 *
 * The bound the product promises is a delay, so the interval is checked against it
 * here rather than left to whatever a deployment happens to schedule: a slower
 * schedule would satisfy every test and still miss the promise.
 *
 * A channel failure is an outcome, not an exception to escape through. The reason is
 * reduced to a bounded code because the thrown text carries hosts, URLs, and
 * sometimes credentials into a record an operator reads.
 */

export const MAXIMUM_NOTIFICATION_DELAY_SECONDS = 300;

const SAFE_CODE = /^[a-z][a-z0-9-]{2,63}$/;

function fail(message) {
  throw new TypeError(message);
}

function reasonFrom(error) {
  const stated = error?.reasonCode;
  return typeof stated === 'string' && SAFE_CODE.test(stated) ? stated : 'channel-unreachable';
}

export function createNotificationDispatcher({
  ledger,
  channel,
  resolveChannel,
  intervalSeconds = 60,
  sinceRaisedAt = '1970-01-01T00:00:00.000Z',
}) {
  if (typeof ledger?.dueForDelivery !== 'function') fail('ledger is required.');
  // A fixed channel or a way to find one, never neither: a dispatcher that resolved
  // nothing would record a failed attempt against a recipient that was never chosen.
  const resolve = resolveChannel ?? (channel ? async () => channel : null);
  if (typeof resolve !== 'function') fail('either a channel or a way to resolve one is required.');
  if (channel && (typeof channel.send !== 'function' || typeof channel.channelCode !== 'string')) {
    fail('channel must name itself and be able to send.');
  }
  if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < 1) {
    fail('intervalSeconds must be a positive integer.');
  }
  if (intervalSeconds > MAXIMUM_NOTIFICATION_DELAY_SECONDS) {
    fail(`intervalSeconds cannot exceed the ${MAXIMUM_NOTIFICATION_DELAY_SECONDS}s delay the product promises.`);
  }

  async function dispatch({ now }) {
    const due = await ledger.dueForDelivery({ now, sinceRaisedAt });
    if (due.length === 0) return Object.freeze({ considered: 0, delivered: 0, failed: 0 });

    // Resolved once per run rather than at startup, so choosing a recipient takes
    // effect on the next tick instead of the next deployment.
    const sending = await resolve();
    if (sending === null) {
      return Object.freeze({ considered: due.length, delivered: 0, failed: 0, reasonCode: 'channel-not-chosen' });
    }
    if (typeof sending.send !== 'function' || typeof sending.channelCode !== 'string') {
      fail('a resolved channel must name itself and be able to send.');
    }

    let delivered = 0;
    let failed = 0;

    for (const record of due) {
      let outcome = 'delivered';
      let reasonCode = null;
      try {
        await sending.send(record);
      } catch (error) {
        // One unreachable recipient must not strand the rest of the batch.
        outcome = 'failed';
        reasonCode = reasonFrom(error);
      }

      await ledger.deliver({
        key: record.key,
        outcome,
        channelCode: sending.channelCode,
        reasonCode,
        at: now,
      });
      if (outcome === 'delivered') delivered += 1;
      else failed += 1;
    }

    return Object.freeze({ considered: due.length, delivered, failed });
  }

  return Object.freeze({ dispatch, intervalSeconds });
}
