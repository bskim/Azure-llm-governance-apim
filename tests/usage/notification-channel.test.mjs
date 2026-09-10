import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertChannelEndpoint,
  assertNotificationChannelRecord,
  createNotificationChannelRecord,
  describeNotificationChannel,
} from '../../app/governance-domain/notification/notification-channel.mjs';

const AT = '2026-08-14T02:00:00.000Z';

function channel(overrides = {}) {
  return createNotificationChannelRecord({
    scopeGroupId: 'platform-engineering',
    channelKind: 'slack',
    endpoint: 'https://hooks.slack.com/services/T00000000/B00000000/xxxxxxxxxxxx',
    updatedByCode: 'actor1-0123456789abcdef0123456789abcdef',
    at: AT,
    ...overrides,
  });
}

test('a channel records where to send, and who chose it', () => {
  const record = channel();

  assert.equal(record.documentType, 'notification-channel');
  assert.equal(record.channelKind, 'slack');
  assert.equal(record.endpointHost, 'hooks.slack.com');
  assert.equal(record.id, 'notification-channel|platform-engineering');
});

test('a reader is told the host and never the endpoint', () => {
  // Slack states the URL contains a secret, and a Teams workflow URL carries its
  // signature in the query. Either would be a working credential on a screen.
  const described = describeNotificationChannel(channel());

  assert.equal(described.endpointHost, 'hooks.slack.com');
  assert.ok(!Object.hasOwn(described, 'endpoint'));
  assert.ok(!JSON.stringify(described).includes('xxxxxxxxxxxx'));
});

test('an unset channel describes itself as unset rather than as an empty one', () => {
  assert.deepEqual(describeNotificationChannel(null), { configured: false });
});

test('an endpoint inside the deployment is refused', () => {
  // An administrator field that accepted these would let a request be made from
  // inside the network under the gateway's own identity.
  for (const endpoint of [
    'https://127.0.0.1/hook',
    'https://[::1]/hook',
    'https://169.254.169.254/metadata',
    'https://10.0.0.4/hook',
    'https://localhost/hook',
    'https://storage.internal',
    'https://printer.local/hook',
  ]) {
    assert.throws(() => assertChannelEndpoint(endpoint), TypeError, endpoint);
  }
});

test('an endpoint that is not an https URL is refused', () => {
  for (const endpoint of [
    'http://hooks.slack.com/services/x',
    'ftp://hooks.slack.com/x',
    'hooks.slack.com/x',
    '',
    'https://hooks/x',
  ]) {
    assert.throws(() => assertChannelEndpoint(endpoint), TypeError, endpoint);
  }
});

test('an endpoint carrying credentials is refused', () => {
  assert.throws(
    () => assertChannelEndpoint('https://user:pass@hooks.slack.com/services/x'),
    TypeError,
  );
});

test('a channel nobody supports is refused rather than attempted', () => {
  assert.throws(() => channel({ channelKind: 'pager' }), TypeError);
  assert.throws(() => channel({ channelKind: '' }), TypeError);
});

test('the actor who set the channel cannot be a directory identifier', () => {
  assert.throws(() => channel({ updatedByCode: '11111111-2222-3333-4444-555555555555' }), TypeError);
});

test('a stored channel whose host disagrees with its endpoint is refused', () => {
  // The host is stored beside the secret so a reader never parses the secret. A
  // disagreement means one of them was edited.
  const tampered = { ...channel(), endpointHost: 'hooks.example.com' };

  assert.throws(() => assertNotificationChannelRecord(tampered), TypeError);
});

test('a stored channel whose identifier does not match its scope is refused', () => {
  const misfiled = { ...channel(), scopeGroupId: 'another-group' };

  assert.throws(() => assertNotificationChannelRecord(misfiled), TypeError);
});

test('a Teams workflow endpoint is accepted, because its host is not a fixed one', () => {
  // The current Teams path is a Power Automate workflow URL whose host varies by
  // tenant and region, so it cannot be recognised by name.
  const record = channel({
    channelKind: 'teams',
    endpoint:
      'https://prod-11.westus.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?sig=xxxx',
  });

  assert.equal(record.channelKind, 'teams');
  assert.equal(record.endpointHost, 'prod-11.westus.logic.azure.com');
});
