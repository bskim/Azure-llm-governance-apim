import assert from 'node:assert/strict';
import test from 'node:test';

import { createGatewayMock } from '../mock/gateway-mock.mjs';
import { createGatewayTokenHelper } from '../../app/governance-domain/identity/gateway-token-helper.mjs';

const audience = 'api://llm-governance-gateway';
const scope = `${audience}/Gateway.Access`;

async function withMock(action, options = {}) {
  const mock = createGatewayMock(options);
  const origin = await mock.listen();
  try {
    await action({ mock, origin });
  } finally {
    await mock.close();
  }
}

function bearer(token) {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

test('a request without a bearer token is refused with a discovery hint', async () => {
  await withMock(async ({ origin, mock }) => {
    const response = await fetch(`${origin}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'coding-primary', messages: [{ role: 'user', content: 'hi' }] }),
    });

    assert.equal(response.status, 401);
    // The challenge is what lets a native client discover where to get a token
    // instead of guessing, so it is part of the contract rather than a courtesy.
    assert.match(
      response.headers.get('www-authenticate'),
      /resource_metadata="https:\/\/gateway\.example\.net\/\.well-known\/oauth-protected-resource\/v1"/,
    );
    assert.equal(mock.requests[0].outcome, 'no-bearer');
  });
});

test('the recorded capture holds a digest rather than a usable credential', async () => {
  await withMock(async ({ origin, mock }) => {
    await fetch(`${origin}/v1/chat/completions`, {
      method: 'POST',
      headers: bearer('header.payload.signature'),
      body: JSON.stringify({ model: 'coding-primary', messages: [{ role: 'user', content: 'hi' }] }),
    });

    const [captured] = mock.requests;
    assert.equal(captured.outcome, 'served');
    assert.equal(captured.credentialLooksLikeJwt, true);
    assert.match(captured.credentialSha256, /^[0-9a-f]{64}$/);
    // A capture file is read by a person and kept on disk, so it must not be a place
    // a working token can be recovered from.
    assert.equal(JSON.stringify(mock.requests).includes('header.payload.signature'), false);
  });
});

test('a client that duplicates its credential into a second header is recorded', async () => {
  await withMock(async ({ origin, mock }) => {
    await fetch(`${origin}/v1/messages`, {
      method: 'POST',
      headers: { ...bearer('a.b.c'), 'x-api-key': 'a.b.c' },
      body: JSON.stringify({ model: 'coding-primary', messages: [{ role: 'user', content: 'hi' }] }),
    });

    // Claude Code copies its helper value into both headers, so the gateway has to
    // decide which one it trusts and remove the other before dispatch.
    assert.deepEqual(mock.requests[0].duplicatedCredentialHeaders, ['x-api-key']);
  });
});

test('the three wire formats each answer in their own shape', async () => {
  await withMock(async ({ origin }) => {
    const body = JSON.stringify({ model: 'coding-primary', messages: [{ role: 'user', content: 'hi' }], input: 'hi' });

    const anthropic = await (await fetch(`${origin}/v1/messages`, { method: 'POST', headers: bearer('a.b.c'), body })).json();
    assert.equal(anthropic.type, 'message');
    assert.equal(anthropic.content[0].type, 'text');

    const responses = await (await fetch(`${origin}/v1/responses`, { method: 'POST', headers: bearer('a.b.c'), body })).json();
    assert.equal(responses.object, 'response');
    assert.equal(responses.output[0].content[0].type, 'output_text');

    const chat = await (await fetch(`${origin}/v1/chat/completions`, { method: 'POST', headers: bearer('a.b.c'), body })).json();
    assert.equal(chat.object, 'chat.completion');
    assert.equal(typeof chat.choices[0].message.content, 'string');
  });
});

test('a model outside the allowlist is refused with the models the caller may use', async () => {
  await withMock(async ({ origin }) => {
    const response = await fetch(`${origin}/v1/chat/completions`, {
      method: 'POST',
      headers: bearer('a.b.c'),
      body: JSON.stringify({ model: 'not-entitled', messages: [{ role: 'user', content: 'hi' }] }),
    });

    assert.equal(response.status, 403);
    const payload = await response.json();
    assert.equal(payload.error.code, 'model_not_allowed');
    assert.deepEqual(payload.error.allowed_models, ['coding-primary', 'coding-fast']);
  });
});

test('an allowed model can return a stable rate-limit response for client tests', async () => {
  await withMock(
    async ({ origin, mock }) => {
      const response = await fetch(`${origin}/v1/responses`, {
        method: 'POST',
        headers: bearer('a.b.c'),
        body: JSON.stringify({ model: 'coding-throttled', input: 'hi' }),
      });

      assert.equal(response.status, 429);
      assert.equal(response.headers.get('retry-after'), '7');
      assert.equal((await response.json()).error.code, 'rate_limit_exceeded');
      assert.deepEqual(mock.requests.map((entry) => entry.outcome), ['rate-limited']);
    },
    {
      allowedModels: ['coding-primary', 'coding-throttled'],
      rateLimitedModels: ['coding-throttled'],
      retryAfter: '7',
    },
  );
});

test('a caller-chosen backend is refused rather than honoured', async () => {
  await withMock(async ({ origin, mock }) => {
    const response = await fetch(`${origin}/v1/chat/completions`, {
      method: 'POST',
      headers: bearer('a.b.c'),
      body: JSON.stringify({ model: 'coding-primary', messages: [], api_version: '2024-10-21' }),
    });

    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'routing_input_not_allowed');
    assert.deepEqual(mock.requests[0].routingInputsSent, ['api_version']);
  });
});

test('the mock refuses model discovery because the governed API does not expose it', async () => {
  await withMock(async ({ origin, mock }) => {
    const response = await fetch(`${origin}/v1/models`, { headers: bearer('a.b.c') });

    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, 'operation_not_found');
    assert.deepEqual(mock.requests.map((entry) => entry.outcome), ['operation-not-found']);
  });
});

test('the token helper recovers from a stale credential against the mock, end to end', async () => {
  await withMock(
    async ({ origin, mock }) => {
      let issued = 0;
      const helper = createGatewayTokenHelper({
        audience,
        scope,
        profile: 'azure-cli',
        acquireToken: async () => {
          issued += 1;
          return { token: `tok.${issued}.sig`, expiresOnEpochSeconds: Math.floor(Date.now() / 1000) + 3_600 };
        },
      });
      mock.markStale('tok.1.sig');

      const response = await helper.authorize(async ({ authorization }) =>
        fetch(`${origin}/v1/chat/completions`, {
          method: 'POST',
          headers: { authorization, 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'coding-primary', messages: [{ role: 'user', content: 'hi' }] }),
        }),
      );

      assert.equal(response.status, 200);
      assert.equal(issued, 2);
      assert.deepEqual(
        mock.requests.map((entry) => entry.outcome),
        ['stale-token', 'served'],
      );
      // The retry carried a different credential, which is what distinguishes a real
      // refresh from a client that simply resent the same token.
      assert.notEqual(mock.requests[0].credentialSha256, mock.requests[1].credentialSha256);
    },
    { staleCredentials: [] },
  );
});

test('discovery metadata is served and carries no secret', async () => {
  await withMock(async ({ origin }) => {
    const response = await fetch(`${origin}/.well-known/oauth-protected-resource`);
    assert.equal(response.status, 200);

    const metadata = await response.json();
    assert.deepEqual(metadata.bearer_methods_supported, ['header']);
    assert.equal(metadata.resource, 'https://gateway.example.net/v1');
    assert.deepEqual(metadata.scopes_supported, ['api://llm-governance-gateway/Gateway.Access']);
    for (const forbidden of ['secret', 'password', 'client_secret', 'key']) {
      assert.equal(JSON.stringify(metadata).includes(forbidden), false, forbidden);
    }
  });
});

test('a streamed request answers as a stream in each format', async () => {
  await withMock(async ({ origin, mock }) => {
    for (const path of ['/v1/messages', '/v1/responses', '/v1/chat/completions']) {
      const response = await fetch(`${origin}${path}`, {
        method: 'POST',
        headers: bearer('a.b.c'),
        body: JSON.stringify({ model: 'coding-primary', stream: true, messages: [], input: 'hi' }),
      });
      assert.match(response.headers.get('content-type'), /text\/event-stream/);
      assert.match(await response.text(), /data: \[DONE\]/);
    }
    assert.ok(mock.requests.every((entry) => entry.streamRequested === true));
  });
});
