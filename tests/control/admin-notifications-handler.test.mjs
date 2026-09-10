import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAcknowledgeNotificationHandler,
  createAdminNotificationsHandler,
  createNotificationChannelHandler,
} from '../../app/functions/handlers/admin-notifications.mjs';
import { createPrincipalKeyDeriver } from '../../app/governance-domain/identity/principal-key-derivation.mjs';
import { createFixedClock } from '../../app/local-adapters/deterministic-time.mjs';

const AS_OF = '2026-07-24T10:00:00.000Z';
const AUDIENCE = 'api-audience-0000';
const SECRET = 'a-derivation-secret-of-sufficient-length-0001';

function principal(claims) {
  return Buffer.from(JSON.stringify({ auth_typ: 'aad', role_typ: 'roles', claims }), 'utf8').toString('base64');
}

function callerHeader(roles, { objectId = 'object-0000', audience = AUDIENCE } = {}) {
  return principal([
    { typ: 'aud', val: audience },
    { typ: 'tid', val: 'tenant-0000' },
    { typ: 'oid', val: objectId },
    ...roles.map((role) => ({ typ: 'roles', val: role })),
  ]);
}

function request({ header, query = {}, body = null, method = 'GET' } = {}) {
  return {
    method,
    headers: { get: (name) => (name === 'x-ms-client-principal' ? header ?? null : null) },
    query: { get: (name) => query[name] ?? null },
    json: async () => {
      if (body === null) throw new Error('no body');
      return body;
    },
  };
}

function channelHandler(overrides = {}) {
  return createNotificationChannelHandler({
    store: { readNotificationChannel: async () => null, putNotificationChannel: async () => ({}) },
    deriver: createPrincipalKeyDeriver({ secret: SECRET, version: 1 }),
    scopeGroupId: 'platform-engineering',
    expectedAudience: AUDIENCE,
    clock: createFixedClock(AS_OF),
    knownTeamKeys: ['platform-engineering'],
    ...overrides,
  });
}

function record(overrides = {}) {
  return {
    key: 'budget-threshold-platform-engineering-2026-07',
    kind: 'budget-threshold-reached',
    severity: 'warning',
    scope: 'organization',
    scopeKey: 'organization',
    periodStart: '2026-07-01T00:00:00.000Z',
    raisedAt: '2026-07-24T09:00:00.000Z',
    state: 'open',
    deliveryState: 'pending',
    reasonCode: 'threshold-crossed',
    attempts: [],
    nextAttemptAt: '2026-07-24T09:00:00.000Z',
    acknowledgedBy: null,
    acknowledgedAt: null,
    ...overrides,
  };
}

function readHandler(overrides = {}) {
  return createAdminNotificationsHandler({
    ledger: { list: async () => [record()] },
    expectedAudience: AUDIENCE,
    clock: createFixedClock(AS_OF),
    knownTeamKeys: ['platform-engineering'],
    ...overrides,
  });
}

function acknowledgeHandler(overrides = {}) {
  return createAcknowledgeNotificationHandler({
    ledger: { acknowledge: async () => ({ ok: true }) },
    deriver: createPrincipalKeyDeriver({ secret: SECRET, version: 1 }),
    expectedAudience: AUDIENCE,
    clock: createFixedClock(AS_OF),
    knownTeamKeys: ['platform-engineering'],
    ...overrides,
  });
}

test('an administrator can read what the ledger raised', async () => {
  const response = await readHandler()(request({ header: callerHeader(['Governance.Administer']) }), {});

  assert.equal(response.status, 200);
  assert.equal(response.jsonBody.records.length, 1);
  assert.equal(response.jsonBody.records[0].kind, 'budget-threshold-reached');
});

test('a caller without a governance role is refused before the ledger is read', async () => {
  let read = false;
  const response = await readHandler({ ledger: { list: async () => { read = true; return []; } } })(
    request({ header: callerHeader([]) }),
    {},
  );

  assert.equal(response.status, 403);
  assert.equal(read, false, 'the ledger must not be read for a caller who may not see it');
});

test('an unreadable ledger is reported as unavailable rather than as an empty one', async () => {
  // "Nothing was raised" and "nothing could be read" call for different actions.
  const response = await readHandler({
    ledger: { list: async () => { throw new Error('unreachable'); } },
  })(request({ header: callerHeader(['Governance.Administer']) }), {});

  assert.equal(response.status, 503);
  assert.equal(response.jsonBody.error.code, 'notification_source_unavailable');
});

test('acknowledgement records the caller in the token, not a name the request chose', async () => {
  const seen = [];
  const handler = acknowledgeHandler({
    ledger: { acknowledge: async (call) => { seen.push(call); return { ok: true }; } },
  });

  const response = await handler(
    request({
      header: callerHeader(['Governance.Administer']),
      body: { key: 'budget-threshold-platform-engineering-2026-07', actorCode: 'somebody-else' },
    }),
    {},
  );

  assert.equal(response.status, 200);
  assert.equal(seen.length, 1);
  assert.notEqual(seen[0].actorCode, 'somebody-else');
  assert.match(seen[0].actorCode, /^actor1-[0-9a-f]{32}$/);
});

test('an auditor cannot acknowledge before its body is read, an actor is derived, or the ledger changes', async () => {
  let bodyRead = false;
  let derivations = 0;
  let acknowledged = false;
  const handler = acknowledgeHandler({
    deriver: {
      deriveActorCode: () => {
        derivations += 1;
        return 'actor1-0123456789abcdef0123456789abcdef';
      },
    },
    ledger: {
      acknowledge: async () => {
        acknowledged = true;
        return { ok: true };
      },
    },
  });
  const deniedRequest = request({ header: callerHeader(['Governance.Read']), body: { key: 'k-0001' } });
  deniedRequest.json = async () => {
    bodyRead = true;
    return { key: 'k-0001' };
  };

  const response = await handler(deniedRequest, {});

  assert.equal(response.status, 403);
  assert.equal(response.jsonBody.error.code, 'governance_capability_denied');
  assert.equal(response.jsonBody.error.reasonCode, 'write-notification-channel');
  assert.equal(bodyRead, false);
  assert.equal(derivations, 0);
  assert.equal(acknowledged, false);
});

test('a write-capable administrator can acknowledge a notification', async () => {
  let acknowledged = false;
  const response = await acknowledgeHandler({
    ledger: {
      acknowledge: async () => {
        acknowledged = true;
        return { ok: true };
      },
    },
  })(
    request({ header: callerHeader(['Governance.Administer']), body: { key: 'k-0001' } }),
    {},
  );

  assert.equal(response.status, 200);
  assert.equal(acknowledged, true);
});

test('two callers acknowledge under different names, and one caller keeps the same one', async () => {
  const seen = [];
  const handler = acknowledgeHandler({
    ledger: { acknowledge: async (call) => { seen.push(call.actorCode); return { ok: true }; } },
  });
  const ack = (objectId) =>
    handler(request({ header: callerHeader(['Governance.Administer'], { objectId }), body: { key: 'k-0001' } }), {});

  await ack('object-0000');
  await ack('object-0001');
  await ack('object-0000');

  assert.notEqual(seen[0], seen[1], 'two people must not acknowledge under one name');
  assert.equal(seen[0], seen[2], 'one person must be recognisable across acknowledgements');
});

test('the recorded actor is not the directory identifier it was derived from', async () => {
  const seen = [];
  const handler = acknowledgeHandler({
    ledger: { acknowledge: async (call) => { seen.push(call.actorCode); return { ok: true }; } },
  });

  await handler(
    request({
      header: callerHeader(['Governance.Administer'], { objectId: '11111111-2222-3333-4444-555555555555' }),
      body: { key: 'k-0001' },
    }),
    {},
  );

  assert.ok(!seen[0].includes('11111111'), 'the directory identifier must not travel into the record');
});

test('a record somebody else settled first is answered as a conflict, not as success', async () => {
  const handler = acknowledgeHandler({
    ledger: { acknowledge: async () => ({ ok: false, reasonCode: 'changed-since-read' }) },
  });

  const response = await handler(
    request({ header: callerHeader(['Governance.Administer']), body: { key: 'k-0001' } }),
    {},
  );

  assert.equal(response.status, 409);
  assert.equal(response.jsonBody.reasonCode, 'changed-since-read');
});

test('an acknowledgement without a notification to settle is refused', async () => {
  for (const body of [{}, { key: '' }, { key: 42 }]) {
    const response = await acknowledgeHandler()(
      request({ header: callerHeader(['Governance.Administer']), body }),
      {},
    );
    assert.equal(response.status, 400, JSON.stringify(body));
  }
});

test('an unauthenticated caller can neither read the ledger nor settle it', async () => {
  const read = await readHandler()(request({}), {});
  const settled = await acknowledgeHandler()(request({ body: { key: 'k-0001' } }), {});

  assert.equal(read.status, 401);
  assert.equal(settled.status, 401);
});

test('the channel is described by host and kind, and never by its endpoint', async () => {
  const handler = channelHandler({
    store: {
      readNotificationChannel: async () => ({
        document: {
          documentType: 'notification-channel',
          id: 'notification-channel|platform-engineering',
          scopeGroupId: 'platform-engineering',
          channelKind: 'slack',
          endpoint: 'https://hooks.slack.com/services/T0/B0/zzzzzzzzzzzz',
          endpointHost: 'hooks.slack.com',
          updatedByCode: 'actor1-0123456789abcdef0123456789abcdef',
          updatedAt: AS_OF,
        },
        etag: 'e1',
      }),
      putNotificationChannel: async () => ({}),
    },
  });

  const response = await handler(request({ header: callerHeader(['Governance.Administer']), method: 'GET' }), {});

  assert.equal(response.status, 200);
  assert.equal(response.jsonBody.endpointHost, 'hooks.slack.com');
  assert.ok(!JSON.stringify(response.jsonBody).includes('zzzzzzzzzzzz'));
});

test('a reader may see where notifications go but may not choose it', async () => {
  let written = false;
  const handler = channelHandler({
    store: {
      readNotificationChannel: async () => null,
      putNotificationChannel: async () => { written = true; return {}; },
    },
  });

  const seen = await handler(request({ header: callerHeader(['Governance.Read']), method: 'GET' }), {});
  const set = await handler(
    request({
      header: callerHeader(['Governance.Read']),
      method: 'PUT',
      body: { channelKind: 'slack', endpoint: 'https://hooks.slack.com/services/T0/B0/aaaa' },
    }),
    {},
  );

  assert.equal(seen.status, 200);
  assert.equal(set.status, 403);
  assert.equal(written, false, 'a read token must not be able to redirect notifications');
});

test('an endpoint the rules refuse is answered without repeating the endpoint', async () => {
  let written = false;
  const handler = channelHandler({
    store: {
      readNotificationChannel: async () => null,
      putNotificationChannel: async () => { written = true; return {}; },
    },
  });

  // Which endpoints are refused is settled in the channel's own suite; what matters
  // here is that the refusal does not carry the value back out.
  for (const endpoint of ['http://hooks.slack.com/x', 'https://localhost/x']) {
    const response = await handler(
      request({ header: callerHeader(['Governance.Administer']), method: 'PUT', body: { channelKind: 'slack', endpoint } }),
      {},
    );
    assert.equal(response.status, 400, endpoint);
    assert.ok(!JSON.stringify(response.jsonBody).includes(endpoint), 'the answer must not echo the endpoint');
  }
  assert.equal(written, false);
});

test('who chose the channel is taken from the token', async () => {
  const written = [];
  const handler = channelHandler({
    store: {
      readNotificationChannel: async () => null,
      putNotificationChannel: async (document) => { written.push(document); return {}; },
    },
  });

  const response = await handler(
    request({
      header: callerHeader(['Governance.Administer']),
      method: 'PUT',
      body: {
        channelKind: 'teams',
        endpoint: 'https://prod-11.westus.logic.azure.com/workflows/a/triggers/manual/paths/invoke?sig=x',
        updatedByCode: 'somebody-else',
      },
    }),
    {},
  );

  assert.equal(response.status, 200);
  assert.match(written[0].updatedByCode, /^actor1-[0-9a-f]{32}$/);
});

test('a notification-channel write without an actor identity is refused before persistence', async () => {
  let written = false;
  const handler = channelHandler({
    store: {
      readNotificationChannel: async () => null,
      putNotificationChannel: async () => { written = true; return {}; },
    },
  });
  const missingIdentity = principal([
    { typ: 'aud', val: AUDIENCE },
    { typ: 'tid', val: 'tenant-0000' },
    { typ: 'roles', val: 'Governance.Administer' },
  ]);

  const response = await handler(
    request({
      header: missingIdentity,
      method: 'PUT',
      body: { channelKind: 'teams', endpoint: 'https://prod-11.westus.logic.azure.com/workflows/a/triggers/manual/paths/invoke?sig=x' },
    }),
    {},
  );
  assert.equal(response.status, 403);
  assert.equal(response.jsonBody.error.code, 'caller_not_identifiable');
  assert.equal(written, false);
});
