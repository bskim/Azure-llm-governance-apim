import assert from 'node:assert/strict';
import test from 'node:test';

import { startLocalAdminServer } from '../../app/control-api/local-admin-server.mjs';

/**
 * Exercises the route the gateway calls on a cache miss against a running
 * process, so the contract is proven by transport rather than by a direct
 * function call.
 */
async function withServer(run) {
  const server = await startLocalAdminServer({ port: 0 });
  const { port } = server.address();
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function post(baseUrl, body) {
  return fetch(`${baseUrl}/api/v1/internal/effective-policy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('the gateway route returns a resolved policy for an entitled persona', async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, { persona: 'governance-admin' });
    assert.equal(response.status, 200);

    const payload = await response.json();
    assert.equal(payload.reasonCode, 'resolved');
    assert.equal(payload.document.documentType, 'effective-policy');
    assert.equal(payload.document.resolution, 'resolved');
    assert.equal(payload.document.scopeGroupId, 'platform-engineering');
    assert.ok(payload.document.limits.some((limit) => limit.scope === 'organization'));
  });
});

test('the served document exposes no raw caller identifier', async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, { persona: 'governance-admin' });
    const body = await response.text();

    assert.ok(!body.includes('user-local-admin'));
    assert.ok(!body.includes('tenant-local-demo'));
    assert.ok(!body.includes('app-local-console'));
  });
});

test('the route refuses a read verb', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/internal/effective-policy`);
    assert.equal(response.status, 405);
  });
});

test('an unknown persona is refused rather than silently degraded', async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, { persona: 'not-a-persona' });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'persona_not_supported');
  });
});

test('a malformed body is refused', async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, '{ not json');
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'body_not_json');
  });
});

test('an oversized body is refused rather than buffered', async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, { persona: 'end-user', padding: 'x'.repeat(16_384) });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'body_too_large');
  });
});

test('the response is never cached by an intermediary', async () => {
  await withServer(async (baseUrl) => {
    const response = await post(baseUrl, { persona: 'governance-admin' });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  });
});
