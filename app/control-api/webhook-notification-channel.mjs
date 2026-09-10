/**
 * Sending a notification to somewhere a person actually looks.
 *
 * A webhook rather than mail: it is the one transport that reaches Teams, Slack, an
 * on-call service, or a plain HTTP endpoint without this product acquiring a mailbox,
 * a sender identity, or a deliverability problem. The operator decides what is on the
 * other end.
 *
 * What is sent is what the notification already is: codes, a scope, a severity, and
 * when it was raised. No message body has ever been part of a notification and none is
 * assembled here, so this cannot become the place bodies leak.
 *
 * Retry is deliberately not implemented here. The ledger owns backoff and attempt
 * counting, so a channel that retried on its own would spend the attempts the ledger
 * is counting and the screen would report one failure where there were five.
 */

const SAFE_CODE = /^[a-z][a-z0-9-]{2,63}$/;

// Everything the recipient is given. Derived from the notification, never from the
// request that caused it.
const PAYLOAD_KEYS = Object.freeze([
  'notificationCode',
  'kind',
  'severity',
  'scopeKind',
  'scopeCode',
  'periodStart',
  'raisedAt',
  'reasonCode',
]);

function fail(message) {
  throw new TypeError(message);
}

function refuse(reasonCode) {
  const error = new Error(reasonCode);
  error.reasonCode = reasonCode;
  return error;
}

/**
 * A webhook URL is a credential: a Teams or Slack endpoint carries its authorisation in
 * the path. It is never logged, never returned by `describe`, and never put in a reason
 * code, so a failure says what happened rather than where.
 */
function assertEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length === 0) fail('endpoint is required.');
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    fail('endpoint must be an absolute URL.');
  }
  if (parsed.protocol !== 'https:') {
    // A notification names who is over budget and by how much. That is not something to
    // put on the wire in the clear, and an operator pasting an http:// endpoint has
    // almost certainly pasted the wrong thing.
    fail('endpoint must be https.');
  }
  return parsed;
}

export function projectNotificationPayload(record) {
  const lastAttempt = record.attempts?.at(-1) ?? null;
  return {
    notificationCode: record.key,
    kind: record.kind,
    severity: record.severity,
    scopeKind: record.scope,
    scopeCode: record.scopeKey,
    periodStart: record.periodStart,
    raisedAt: record.raisedAt,
    reasonCode: record.reasonCode,
    attemptNumber: (lastAttempt ? record.attempts.length : 0) + 1,
  };
}

/**
 * Slack and the current Teams workflow trigger both take `{ text }`, so one line
 * serves both. It is assembled from the codes the payload already carries, so the
 * readable form cannot say more than the machine-readable one.
 */
function projectChannelText(payload) {
  const absent = (value) => value === null || value === undefined;
  const lines = [
    `[${payload.severity}] ${payload.kind}`,
    // A scope with no key is the organization itself, not a scope whose key is missing.
    absent(payload.scopeCode) ? `scope: ${payload.scopeKind}` : `scope: ${payload.scopeKind} ${payload.scopeCode}`,
    `period: ${payload.periodStart}`,
    `raised: ${payload.raisedAt}`,
  ];
  if (!absent(payload.reasonCode)) lines.push(`reason: ${payload.reasonCode}`);
  lines.push(`attempt: ${payload.attemptNumber}`);
  return lines.join('\n');
}

export function projectChannelBody(payload, channelKind) {
  return channelKind === 'teams' || channelKind === 'slack'
    ? { text: projectChannelText(payload) }
    : payload;
}

export function createWebhookNotificationChannel({
  endpoint,
  channelKind = null,
  channelCode = 'operations-webhook',
  timeoutMs = 10_000,
  transport = globalThis.fetch,
}) {
  assertEndpoint(endpoint);
  if (!SAFE_CODE.test(channelCode)) fail('channelCode must be a bounded code.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) fail('timeoutMs must be a positive integer.');
  if (typeof transport !== 'function') fail('transport must be callable.');

  async function send(record) {
    const payload = projectNotificationPayload(record);
    for (const key of Object.keys(payload)) {
      if (key !== 'attemptNumber' && !PAYLOAD_KEYS.includes(key)) {
        throw refuse('notification-payload-unexpected');
      }
    }

    // Without a deadline an unanswering endpoint holds the dispatch open past the
    // interval, and the next run overlaps the one that never finished.
    const deadline = AbortSignal.timeout(timeoutMs);
    let response;
    try {
      response = await transport(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(projectChannelBody(payload, channelKind)),
        signal: deadline,
      });
    } catch (error) {
      throw refuse(error?.name === 'TimeoutError' ? 'channel-timed-out' : 'channel-unreachable');
    }

    // A recipient that refuses will refuse the retry too, so it is worth telling apart
    // from one that was merely unavailable: the operator has to fix the endpoint rather
    // than wait.
    if (response.status >= 400 && response.status < 500) throw refuse('channel-refused-request');
    if (!response.ok) throw refuse('channel-unavailable');
    return { channelCode };
  }

  return Object.freeze({
    channelCode,
    send,
    // Names the channel without naming where it sends, because this is read by
    // diagnostics that are allowed to be printed.
    describe: () => Object.freeze({ channelCode, kind: channelKind ?? 'webhook' }),
  });
}
