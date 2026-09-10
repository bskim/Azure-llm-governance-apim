import assert from 'node:assert/strict';
import test from 'node:test';

import { createEffectivePolicyHandler } from '../../app/functions/handlers/effective-policy.mjs';
import {
  createUnavailablePolicyResolver,
  createPersonaScopedResolver,
  isKnownPersona,
} from '../../app/functions/composition-root.mjs';
import { createSequenceIdGenerator } from '../../app/local-adapters/deterministic-time.mjs';

/**
 * Exercises the handler in the shape the Functions host invokes it, without the
 * host itself, so the contract is covered by the ordinary test run.
 */
const AUDIENCE = 'admin-api-audience-0000';

function principal(claims) {
  return Buffer.from(JSON.stringify({ auth_typ: 'aad', role_typ: 'roles', claims }), 'utf8').toString('base64');
}

function callerHeader(roles = ['Policy.Resolve'], audience = AUDIENCE) {
  return principal([
    { typ: 'aud', val: audience },
    { typ: 'tid', val: 'tenant-0000' },
    { typ: 'oid', val: 'gateway-principal-0000' },
    ...roles.map((role) => ({ typ: 'roles', val: role })),
  ]);
}

function request(body, { contentLength, header = callerHeader() } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const headers = new Map();
  headers.set('content-length', String(contentLength ?? Buffer.byteLength(text, 'utf8')));
  if (header) headers.set('x-ms-client-principal', header);
  return {
    method: 'POST',
    headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

const context = Object.freeze({
  invocationId: 'invocation-0001',
  log() {},
  error() {},
});

function handler() {
  return createEffectivePolicyHandler({
    resolver: createPersonaScopedResolver(createSequenceIdGenerator('handler-test')),
    personaGuard: isKnownPersona,
    expectedAudience: AUDIENCE,
    requiredRole: 'Policy.Resolve',
  });
}

test('the handler returns a resolved policy in the host response shape', async () => {
  const result = await handler()(request({ persona: 'governance-admin' }), context);

  assert.equal(result.status, 200);
  assert.equal(result.jsonBody.reasonCode, 'resolved');
  assert.equal(result.jsonBody.document.documentType, 'effective-policy');
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.equal(result.headers['X-Request-Id'], 'invocation-0001');
});

test('human administration roles cannot resolve caller policy', async () => {
  for (const role of ['Governance.Read', 'Governance.Administer']) {
    const result = await handler()(request({}, { header: callerHeader([role]) }), context);

    assert.equal(result.status, 403);
    assert.equal(result.jsonBody.error.code, 'policy_resolution_access_denied');
    assert.equal(result.jsonBody.error.reasonCode, 'required-role-absent');
  }
});

test('a token for another audience is refused before policy resolution', async () => {
  const result = await handler()(
    request({}, { header: callerHeader(['Policy.Resolve'], 'some-other-audience') }),
    context,
  );

  assert.equal(result.status, 401);
  assert.equal(result.jsonBody.error.code, 'caller_not_authenticated');
  assert.equal(result.jsonBody.error.reasonCode, 'audience-not-accepted');
});

test('a missing platform principal is refused before policy resolution', async () => {
  const result = await handler()(request({}, { header: null }), context);

  assert.equal(result.status, 401);
  assert.equal(result.jsonBody.error.code, 'caller_not_authenticated');
  assert.equal(result.jsonBody.error.reasonCode, 'principal-absent');
});

test('the handler refuses an unknown persona', async () => {
  const result = await handler()(request({ persona: 'not-a-persona' }), context);

  assert.equal(result.status, 400);
  assert.equal(result.jsonBody.error.code, 'persona_not_supported');
});

test('the handler refuses a malformed body', async () => {
  const result = await handler()(request('{ not json'), context);

  assert.equal(result.status, 400);
  assert.equal(result.jsonBody.error.code, 'body_not_json');
});

test('an oversized body is refused from its declared length alone', async () => {
  const result = await handler()(request({ persona: 'end-user' }, { contentLength: 99_999 }), context);

  assert.equal(result.status, 400);
  assert.equal(result.jsonBody.error.code, 'body_too_large');
});

test('a resolver failure is reported without leaking detail', async () => {
  const failing = createEffectivePolicyHandler({
    resolver: {
      resolve() {
        throw new Error('connection string sk-secret-value failed');
      },
    },
    expectedAudience: AUDIENCE,
    requiredRole: 'Policy.Resolve',
  });
  const result = await failing(request({}), context);

  assert.equal(result.status, 500);
  assert.equal(result.jsonBody.error.code, 'policy_resolution_failed');
  assert.ok(!JSON.stringify(result).includes('sk-secret-value'));
});

test('the handler requires a resolver rather than defaulting to one', () => {
  assert.throws(() => createEffectivePolicyHandler({}), /resolver is required/);
});

test('the handler requires an explicit machine audience and role', () => {
  const resolver = { resolve() {} };
  assert.throws(
    () => createEffectivePolicyHandler({ resolver, requiredRole: 'Policy.Resolve' }),
    /expectedAudience is required/,
  );
  assert.throws(
    () => createEffectivePolicyHandler({ resolver, expectedAudience: AUDIENCE }),
    /requiredRole is required/,
  );
});

test('the deployed unavailable resolver fails explicitly instead of serving fixture policy', async () => {
  const resolver = createUnavailablePolicyResolver();

  await assert.rejects(
    () => resolver.resolve({ tenantId: 'tenant-0000', subjectId: 'subject-0000', applicationId: 'app-0000' }),
    (error) => error.name === 'PolicySourceUnavailableError',
  );
});
