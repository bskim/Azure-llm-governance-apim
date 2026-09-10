import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createWebhookNotificationChannel,
  projectChannelBody,
  projectNotificationPayload,
} from '../../app/control-api/webhook-notification-channel.mjs';

const RECORD = Object.freeze({
  key: 'platform-engineering|budget-warning|budget-organization-monthly|1|2026-08-01T00:00:00.000Z|organization|platform-engineering|8000',
  kind: 'budget-warning',
  severity: 'warning',
  scope: 'organization',
  scopeKey: 'platform-engineering',
  periodStart: '2026-08-01T00:00:00.000Z',
  raisedAt: '2026-08-13T09:00:00.000Z',
  reasonCode: 'threshold-crossed',
  state: 'open',
  deliveryState: 'pending',
  attempts: [],
  nextAttemptAt: null,
  acknowledgedBy: null,
  acknowledgedAt: null,
});

const ENDPOINT = 'https://example.invalid/hooks/abc';

function channelWith(handler, options = {}) {
  const calls = [];
  const channel = createWebhookNotificationChannel({
    endpoint: ENDPOINT,
    transport: async (url, init) => {
      calls.push({ url, init });
      return handler(url, init);
    },
    ...options,
  });
  return { channel, calls };
}

test('what the recipient is given is codes, and never anything from a request', () => {
  const payload = projectNotificationPayload(RECORD);
  assert.deepEqual(Object.keys(payload).sort(), [
    'attemptNumber',
    'kind',
    'notificationCode',
    'periodStart',
    'raisedAt',
    'reasonCode',
    'scopeCode',
    'scopeKind',
    'severity',
  ]);

  const serialized = JSON.stringify(payload);
  for (const forbidden of ['prompt', 'completion', 'requestBody', 'responseBody', 'subjectId', 'applicationId']) {
    assert.ok(!serialized.includes(forbidden), `payload must not carry ${forbidden}`);
  }
});

test('a notification is posted once, as JSON, with no retry of its own', async () => {
  const { channel, calls } = channelWith(async () => ({ ok: true, status: 200 }));

  const result = await channel.send(RECORD);
  assert.equal(result.channelCode, 'operations-webhook');
  assert.equal(calls.length, 1, 'the ledger owns backoff, so the channel must attempt once');
  assert.equal(calls[0].url, ENDPOINT);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(JSON.parse(calls[0].init.body).notificationCode, RECORD.key);
});

test('an endpoint that refuses is told apart from one that was unavailable', async () => {
  const refused = channelWith(async () => ({ ok: false, status: 404 })).channel;
  await assert.rejects(refused.send(RECORD), (error) => error.reasonCode === 'channel-refused-request');

  const unavailable = channelWith(async () => ({ ok: false, status: 503 })).channel;
  await assert.rejects(unavailable.send(RECORD), (error) => error.reasonCode === 'channel-unavailable');

  const unreachable = channelWith(async () => { throw new Error('getaddrinfo ENOTFOUND example.invalid'); }).channel;
  await assert.rejects(unreachable.send(RECORD), (error) => error.reasonCode === 'channel-unreachable');
});

test('an endpoint that never answers is abandoned rather than held open', async () => {
  const { channel } = channelWith(
    (url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
    }),
    { timeoutMs: 20 },
  );

  await assert.rejects(channel.send(RECORD), (error) => error.reasonCode === 'channel-timed-out');
});

test('a failure names what happened rather than where it was sending', async () => {
  const { channel } = channelWith(async () => { throw new Error(`connect ECONNREFUSED ${ENDPOINT}`); });

  // A webhook URL carries its own authorisation, so it must not reach a reason code an
  // operator screen prints.
  await assert.rejects(channel.send(RECORD), (error) => {
    assert.ok(!error.reasonCode.includes('example.invalid'));
    assert.match(error.reasonCode, /^[a-z][a-z0-9-]{2,63}$/);
    return true;
  });

  assert.deepEqual(channel.describe(), { channelCode: 'operations-webhook', kind: 'webhook' });
  assert.ok(!JSON.stringify(channel.describe()).includes('example.invalid'));
});

test('an endpoint that cannot protect what it carries is refused at construction', () => {
  for (const endpoint of ['http://example.invalid/hooks/abc', 'not-a-url', '', null]) {
    assert.throws(() => createWebhookNotificationChannel({ endpoint, transport: async () => ({ ok: true })}), TypeError);
  }

  assert.throws(
    () => createWebhookNotificationChannel({ endpoint: ENDPOINT, channelCode: 'Operations Webhook', transport: async () => ({ ok: true }) }),
    TypeError,
  );
});

test('Slack and Teams are sent the one field both of them read', async () => {
  // Slack documents `{"text": ...}` for an incoming webhook, and the current Teams
  // path is a workflow trigger that documents the same field. A flat payload of codes
  // posts successfully to neither.
  for (const channelKind of ['slack', 'teams']) {
    const { channel, calls } = channelWith(async () => ({ ok: true, status: 200 }), { channelKind });
    await channel.send(RECORD);

    const body = JSON.parse(calls[0].init.body);
    assert.deepEqual(Object.keys(body), ['text'], channelKind);
    assert.match(body.text, /budget-warning/);
    assert.match(body.text, /threshold-crossed/);
  }
});

test('the readable line says no more than the codes it was built from', () => {
  // A message a person reads must not become the place a prompt or a name arrives.
  const payload = projectNotificationPayload(RECORD);
  const { text } = projectChannelBody(payload, 'slack');

  // Strike out every value the payload already carries and every fixed label; what
  // is left has to be punctuation, or the line is saying something of its own.
  let residue = text;
  for (const value of Object.values(payload)) residue = residue.split(String(value)).join('');
  for (const label of ['scope', 'period', 'raised', 'reason', 'attempt']) {
    residue = residue.split(label).join('');
  }

  assert.equal(residue.replace(/[\s[\]:]/g, ''), '', `the line added: ${residue}`);
});

test('an endpoint with no channel named keeps the payload a generic recipient expects', () => {
  const payload = projectNotificationPayload(RECORD);

  assert.deepEqual(projectChannelBody(payload, null), payload);
});

test('a value the notification does not have is left out rather than written as null', () => {
  // The organization scope carries no key and a raised finding often carries no reason.
  // The test above strikes every payload value out of the line, and String(null) is the
  // word null, so it accepted a message that read "scope: organization null".
  const payload = projectNotificationPayload({ ...RECORD, scopeKey: null, reasonCode: null });
  const { text } = projectChannelBody(payload, 'slack');

  assert.doesNotMatch(text, /\bnull\b/);
  assert.doesNotMatch(text, /\bundefined\b/);
  assert.match(text, /^scope: organization$/m);
  assert.doesNotMatch(text, /^reason:/m);
  assert.match(text, /^attempt: \d+$/m);
});
