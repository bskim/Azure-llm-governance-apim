import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createGatewayTokenHelper,
  isStaleCredential,
  resolveExpiry,
} from '../../app/governance-domain/identity/gateway-token-helper.mjs';

const audience = 'api://llm-governance-gateway';
const scope = `${audience}/Gateway.Access`;

function helperWith(acquisitions, { start = 1_000_000, skewSeconds = 300 } = {}) {
  let current = start;
  let calls = 0;
  const helper = createGatewayTokenHelper({
    audience,
    scope,
    profile: 'azure-cli',
    skewSeconds,
    now: () => current,
    acquireToken: async () => {
      const acquired = acquisitions[Math.min(calls, acquisitions.length - 1)];
      calls += 1;
      return typeof acquired === 'function' ? acquired() : acquired;
    },
  });
  return {
    helper,
    advance: (ms) => {
      current += ms;
    },
    get calls() {
      return calls;
    },
  };
}

function token(value, expiresInSeconds, { start = 1_000_000 } = {}) {
  return { token: value, expiresOnEpochSeconds: Math.floor(start / 1000) + expiresInSeconds };
}

// For helpers left on the real clock, the expiry has to be relative to it.
function liveToken(value, expiresInSeconds) {
  return token(value, expiresInSeconds, { start: Date.now() });
}

test('the epoch expiry wins over the local one, because the local one has no zone', () => {
  // `az` reports both. Parsing the local form interprets the token as expiring in
  // whatever zone the reader is in, which is right only in UTC.
  const both = resolveExpiry({
    token: 'value',
    expiresOnEpochSeconds: 1_800_000_000,
    expiresOnIso: '2026-08-07 10:00:00.000000',
  });
  assert.equal(both, 1_800_000_000_000);

  const isoOnly = resolveExpiry({ token: 'value', expiresOnIso: '2026-08-07T10:00:00.000Z' });
  assert.equal(isoOnly, Date.parse('2026-08-07T10:00:00.000Z'));

  assert.throws(
    () => resolveExpiry({ token: 'value', expiresOnIso: 'tomorrow morning' }),
    /unambiguous expiry/,
  );
});

test('a cached token is reused until it is inside the refresh skew', async () => {
  const state = helperWith([token('first', 3_600), token('second', 3_600)]);

  assert.equal(await state.helper.getToken(), 'first');
  state.advance(1_000 * 1_000);
  assert.equal(await state.helper.getToken(), 'first');
  assert.equal(state.calls, 1);

  // Inside the skew, so the token is replaced before a request could carry an
  // expired one.
  state.advance(2_400 * 1_000);
  assert.equal(await state.helper.getToken(), 'second');
});

test('parallel acquisitions are coalesced into one sign-in', async () => {
  let resolveAcquisition;
  const pending = new Promise((resolve) => {
    resolveAcquisition = resolve;
  });
  let calls = 0;
  const helper = createGatewayTokenHelper({
    audience,
    scope,
    profile: 'azure-cli',
    acquireToken: async () => {
      calls += 1;
      await pending;
      return liveToken('only', 3_600);
    },
  });

  const all = Promise.all([helper.getToken(), helper.getToken(), helper.getToken()]);
  resolveAcquisition();
  const tokens = await all;

  // An agent turn that runs ten tools would otherwise start ten sign-ins the moment
  // the cached token ages out.
  assert.equal(calls, 1);
  assert.deepEqual(tokens, ['only', 'only', 'only']);
});

test('a stale credential is refreshed and the request is retried exactly once', async () => {
  const { helper } = helperWith([token('expired', 3_600), token('fresh', 3_600)]);
  const sent = [];

  const response = await helper.authorize(async ({ authorization }) => {
    sent.push(authorization);
    return { status: sent.length === 1 ? 401 : 200 };
  });

  assert.equal(response.status, 200);
  assert.deepEqual(sent, ['Bearer expired', 'Bearer fresh']);
});

test('a second refusal is returned rather than retried again', async () => {
  const { helper } = helperWith([token('a', 3_600), token('b', 3_600), token('c', 3_600)]);
  let attempts = 0;

  const response = await helper.authorize(async () => {
    attempts += 1;
    return { status: 401 };
  });

  assert.equal(response.status, 401);
  // A loop would turn an authorization problem into a load problem, and every
  // attempt is a request the gateway counts.
  assert.equal(attempts, 2);
});

test('a refusal a fresh token cannot fix is surfaced instead of retried', async () => {
  const { helper } = helperWith([token('valid', 3_600)]);
  let attempts = 0;

  const response = await helper.authorize(async () => {
    attempts += 1;
    return { status: 403, body: { error: { code: 'model_not_allowed' } } };
  });

  // 403 says the caller is not entitled. Retrying doubles the load and produces the
  // same refusal.
  assert.equal(attempts, 1);
  assert.equal(response.status, 403);
  assert.equal(isStaleCredential(response), false);
  assert.equal(isStaleCredential({ status: 401 }), true);
});

test('a bare resource is refused, because it yields a token with no scope to validate', () => {
  assert.throws(
    () => createGatewayTokenHelper({ acquireToken: async () => {}, audience, scope: audience, profile: 'azure-cli' }),
    /delegated scope/,
  );
  assert.throws(
    () =>
      createGatewayTokenHelper({
        acquireToken: async () => {},
        audience,
        scope: 'api://someone-else/Gateway.Access',
        profile: 'azure-cli',
      }),
    /delegated scope/,
  );
});

test('an already expired token is refused rather than cached and sent', async () => {
  const { helper } = helperWith([token('stale', -60)]);

  await assert.rejects(() => helper.getToken(), /already expired/);
});

test('a failed acquisition does not leave the helper unable to try again', async () => {
  let calls = 0;
  const helper = createGatewayTokenHelper({
    audience,
    scope,
    profile: 'azure-cli',
    acquireToken: async () => {
      calls += 1;
      if (calls === 1) throw new Error('sign-in required');
      return liveToken('recovered', 3_600);
    },
  });

  await assert.rejects(() => helper.getToken(), /sign-in required/);
  assert.equal(await helper.getToken(), 'recovered');
});

test('what the helper will say about itself never includes the token', async () => {
  const { helper } = helperWith([token('secret-value', 3_600)]);
  await helper.getToken();

  const described = helper.describe();
  assert.equal(described.profile, 'azure-cli');
  assert.equal(described.hasToken, true);
  assert.equal(JSON.stringify(described).includes('secret-value'), false);
  assert.ok(Object.isFrozen(described));
});
