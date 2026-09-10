import assert from 'node:assert/strict';
import test from 'node:test';

import { createAuthBridge, deviceCodeAcquirer } from '../../tools/agent-auth-bridge/agent-auth-bridge.mjs';
import { createGatewayMock } from '../mock/gateway-mock.mjs';
import { createGatewayTokenHelper } from '../../app/governance-domain/identity/gateway-token-helper.mjs';

const audience = 'api://llm-governance-gateway';
const scope = `${audience}/Gateway.Access`;

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

async function withBridge(action, { mockOptions = {}, acquire } = {}) {
  const mock = createGatewayMock(mockOptions);
  const upstream = await mock.listen();
  let issued = 0;
  const helper = createGatewayTokenHelper({
    audience,
    scope,
    profile: 'azure-cli',
    acquireToken:
      acquire ??
      (async () => {
        issued += 1;
        return { token: `tok.${issued}.sig`, expiresOnEpochSeconds: Math.floor(Date.now() / 1000) + 3_600 };
      }),
  });
  const events = [];
  const bridge = createAuthBridge({
    upstream,
    helper,
    onEvent: (event) => events.push(event),
  });
  const origin = await listen(bridge);
  try {
    await action({ origin, mock, events, issuedCount: () => issued });
  } finally {
    await new Promise((resolve) => bridge.close(resolve));
    await mock.close();
  }
}

test('an upstream carrying a path is refused rather than doubling the client path', () => {
  assert.throws(
    () => createAuthBridge({ upstream: 'https://gateway.example.net/v1', helper: {} }),
    /origin without a path/,
  );
});

test('a request with no credential of its own arrives at the gateway authenticated', async () => {
  await withBridge(async ({ origin, mock }) => {
    const response = await fetch(`${origin}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'coding-primary', messages: [{ role: 'user', content: 'hi' }] }),
    });

    assert.equal(response.status, 200);
    assert.equal(mock.requests[0].outcome, 'served');
    assert.equal(mock.requests[0].authorizationScheme, 'Bearer');
  });
});

test('a placeholder credential from the agent is removed rather than forwarded', async () => {
  await withBridge(async ({ origin, mock }) => {
    await fetch(`${origin}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer placeholder-from-the-agent',
        'x-api-key': 'placeholder-from-the-agent',
      },
      body: JSON.stringify({ model: 'coding-primary', messages: [{ role: 'user', content: 'hi' }] }),
    });

    const [captured] = mock.requests;
    // The gateway authenticates the person. A second credential in the request is
    // only ambiguity, and a placeholder must never reach it.
    assert.deepEqual(captured.duplicatedCredentialHeaders, []);
    assert.equal(captured.outcome, 'served');
  });
});

test('a refusal the agent could not act on is recovered by the bridge', async () => {
  await withBridge(
    async ({ origin, mock, events, issuedCount }) => {
      mock.markStale('tok.1.sig');

      const response = await fetch(`${origin}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'coding-primary', messages: [{ role: 'user', content: 'hi' }] }),
      });

      assert.equal(response.status, 200);
      assert.equal(issuedCount(), 2);
      assert.deepEqual(
        mock.requests.map((entry) => entry.outcome),
        ['stale-token', 'served'],
      );
      // The retry carried a different credential, which is the whole point: the agent
      // would have resent the same one.
      assert.notEqual(mock.requests[0].credentialSha256, mock.requests[1].credentialSha256);
      assert.ok(events.some((event) => event.kind === 'refreshing'));
    },
    { mockOptions: {} },
  );
});

test('the bridge preserves request semantics apart from replacing the credential', async () => {
  await withBridge(async ({ origin, mock }) => {
    const body = { model: 'coding-primary', messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function' }] };
    await fetch(`${origin}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    const [captured] = mock.requests;
    // No translation, model choice, body rewriting, or path change. Credential
    // replacement is covered separately because it is the bridge's purpose.
    assert.equal(captured.model, 'coding-primary');
    assert.deepEqual(captured.toolTypes, ['function']);
    assert.equal(captured.path, '/v1/chat/completions');
  });
});

test('a streamed answer is piped rather than buffered', async () => {
  await withBridge(async ({ origin }) => {
    const response = await fetch(`${origin}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'coding-primary', stream: true, messages: [] }),
    });

    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    assert.match(await response.text(), /data: \[DONE\]/);
  });
});

test('a sign-in failure is reported to the agent instead of being retried forever', async () => {
  await withBridge(
    async ({ origin, mock, events }) => {
      const response = await fetch(`${origin}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'coding-primary', messages: [] }),
      });

      assert.equal(response.status, 401);
      assert.equal((await response.json()).error.code, 'sign_in_required');
      assert.equal(mock.requests.length, 0, 'nothing reaches the gateway without a credential');
      assert.ok(events.some((event) => event.kind === 'sign-in-failed'));
    },
    {
      acquire: async () => {
        throw new Error('sign-in required: run az login');
      },
    },
  );
});

test('nothing the bridge reports carries a credential', async () => {
  await withBridge(async ({ origin, events }) => {
    await fetch(`${origin}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'coding-primary', messages: [] }),
    });

    // A developer pastes these lines into an issue, so they carry a status and a
    // path and nothing that could be replayed.
    const serialized = JSON.stringify(events);
    assert.equal(serialized.includes('tok.'), false);
    assert.equal(serialized.toLowerCase().includes('bearer'), false);
  });
});

// --- device code acquisition -------------------------------------------------
// The Azure CLI cannot serve a gateway that pins an approved client: it is not
// preauthorized for the audience, and a token it did mint would carry its own `azp`,
// which the gateway refuses. These cover the sign-in that can.

const tenantId = '11111111-2222-3333-4444-555555555555';
const clientId = '66666666-7777-8888-9999-aaaaaaaaaaaa';

function scriptedFetch(steps) {
  const calls = [];
  const remaining = [...steps];
  const fetchImpl = async (url, init) => {
    const body = Object.fromEntries(new URLSearchParams(init.body));
    calls.push({ url, body });
    const next = remaining.shift();
    if (!next) throw new Error(`unexpected request to ${url}`);
    return { ok: next.ok, json: async () => next.payload };
  };
  return { fetchImpl, calls };
}

test('device code sign-in uses the approved client and reports an epoch expiry', async () => {
  const { fetchImpl, calls } = scriptedFetch([
    { ok: true, payload: { device_code: 'dc', user_code: 'ABC-123', verification_uri: 'https://example.test/device', interval: '5', expires_in: '900' } },
    { ok: true, payload: { access_token: 'access.value', refresh_token: 'refresh.value', expires_in: '3600' } },
  ]);
  const prompts = [];
  const acquire = deviceCodeAcquirer({
    tenantId,
    clientId,
    scope,
    onPrompt: (prompt) => prompts.push(prompt),
    fetchImpl,
    sleep: async () => {},
    now: () => 1_000_000,
  });

  const result = await acquire();

  assert.equal(result.token, 'access.value');
  assert.equal(result.expiresOnEpochSeconds, 1000 + 3600);
  assert.equal(calls[0].body.client_id, clientId);
  assert.ok(calls[0].url.includes(tenantId), 'the directory must be the configured one');
  assert.deepEqual(prompts, [{ verificationUri: 'https://example.test/device', userCode: 'ABC-123', expiresInSeconds: 900 }]);
});

test('the prompt carries no credential', async () => {
  const { fetchImpl } = scriptedFetch([
    { ok: true, payload: { device_code: 'dc', user_code: 'ABC-123', verification_uri: 'https://example.test/device', interval: '5', expires_in: '900' } },
    { ok: true, payload: { access_token: 'access.value', refresh_token: 'refresh.value', expires_in: '3600' } },
  ]);
  const prompts = [];
  await deviceCodeAcquirer({ tenantId, clientId, scope, onPrompt: (p) => prompts.push(p), fetchImpl, sleep: async () => {} })();

  const serialized = JSON.stringify(prompts);
  assert.ok(!serialized.includes('access.value'), 'the access token must not reach the prompt');
  assert.ok(!serialized.includes('refresh.value'), 'the refresh token must not reach the prompt');
  assert.ok(!serialized.includes('dc'), 'the device code must not reach the prompt');
});

test('a pending authorization is waited out and a slow_down backs off', async () => {
  const { fetchImpl } = scriptedFetch([
    { ok: true, payload: { device_code: 'dc', user_code: 'ABC-123', verification_uri: 'https://example.test/device', interval: '5', expires_in: '900' } },
    { ok: false, payload: { error: 'authorization_pending' } },
    { ok: false, payload: { error: 'slow_down' } },
    { ok: true, payload: { access_token: 'access.value', expires_in: '3600' } },
  ]);
  const waits = [];
  const result = await deviceCodeAcquirer({
    tenantId,
    clientId,
    scope,
    onPrompt: () => {},
    fetchImpl,
    sleep: async (ms) => waits.push(ms),
  })();

  assert.equal(result.token, 'access.value');
  assert.deepEqual(waits, [5000, 5000, 10000], 'a slow_down must lengthen the interval');
});

test('a declined sign-in fails instead of waiting for the deadline', async () => {
  const { fetchImpl } = scriptedFetch([
    { ok: true, payload: { device_code: 'dc', user_code: 'ABC-123', verification_uri: 'https://example.test/device', interval: '5', expires_in: '900' } },
    { ok: false, payload: { error: 'authorization_declined' } },
  ]);
  await assert.rejects(
    deviceCodeAcquirer({ tenantId, clientId, scope, onPrompt: () => {}, fetchImpl, sleep: async () => {} })(),
    /authorization_declined/,
  );
});

test('a second acquisition refreshes silently rather than prompting again', async () => {
  const { fetchImpl, calls } = scriptedFetch([
    { ok: true, payload: { device_code: 'dc', user_code: 'ABC-123', verification_uri: 'https://example.test/device', interval: '5', expires_in: '900' } },
    { ok: true, payload: { access_token: 'first.value', refresh_token: 'refresh.value', expires_in: '3600' } },
    { ok: true, payload: { access_token: 'second.value', refresh_token: 'refresh.next', expires_in: '3600' } },
  ]);
  let prompted = 0;
  const acquire = deviceCodeAcquirer({ tenantId, clientId, scope, onPrompt: () => { prompted += 1; }, fetchImpl, sleep: async () => {} });

  assert.equal((await acquire()).token, 'first.value');
  assert.equal((await acquire()).token, 'second.value');
  assert.equal(prompted, 1, 'the user must not be asked again while the session holds');
  assert.equal(calls[2].body.grant_type, 'refresh_token');
});

test('a refused refresh falls back to an interactive sign-in', async () => {
  const { fetchImpl } = scriptedFetch([
    { ok: true, payload: { device_code: 'dc', user_code: 'ABC-123', verification_uri: 'https://example.test/device', interval: '5', expires_in: '900' } },
    { ok: true, payload: { access_token: 'first.value', refresh_token: 'refresh.value', expires_in: '3600' } },
    { ok: false, payload: { error: 'invalid_grant' } },
    { ok: true, payload: { device_code: 'dc2', user_code: 'DEF-456', verification_uri: 'https://example.test/device', interval: '5', expires_in: '900' } },
    { ok: true, payload: { access_token: 'third.value', expires_in: '3600' } },
  ]);
  let prompted = 0;
  const acquire = deviceCodeAcquirer({ tenantId, clientId, scope, onPrompt: () => { prompted += 1; }, fetchImpl, sleep: async () => {} });

  await acquire();
  assert.equal((await acquire()).token, 'third.value');
  assert.equal(prompted, 2, 'a lost session has to be re-established, not reported as a failure');
});

test('the directory and application identifiers cannot carry anything but an identifier', () => {
  for (const hostile of ['../../evil', 'common', 'https://attacker.test/', '']) {
    assert.throws(() => deviceCodeAcquirer({ tenantId: hostile, clientId, scope, onPrompt: () => {} }), TypeError);
    assert.throws(() => deviceCodeAcquirer({ tenantId, clientId: hostile, scope, onPrompt: () => {} }), TypeError);
  }
});
