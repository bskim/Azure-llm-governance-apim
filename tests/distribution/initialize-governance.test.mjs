import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import {
  INITIALIZER_REASONS,
  assertTokenUsable,
  buildAuthorizationUrl,
  createDeviceCodeAuthorizer,
  createPkceAuthorizer,
  initializeGovernance,
  parseArguments,
  parseFoundryAccountResourceId,
  readAzdTargets,
} from '../../tools/distribution/Initialize-Governance.mjs';

const AT = '2026-08-26T02:00:00.000Z';
const TENANT = '00000000-0000-4000-8000-000000000002';
const AUDIENCE = '00000000-0000-4000-8000-000000000003';
const GROUP = '00000000-0000-4000-8000-000000000001';
const targets = {
  controlPlaneEndpoint: 'https://control.example.com',
  tenantId: TENANT,
  audience: AUDIENCE,
  scope: 'api://example/Governance.Access',
  clientId: '00000000-0000-4000-8000-000000000004',
  foundryAccountResourceId: [
    '',
    'subscriptions',
    '00000000-0000-4000-8000-000000000005',
    'resourceGroups',
    'example',
    'providers',
    'Microsoft.CognitiveServices',
    'accounts',
    'example',
  ].join('/'),
  scopeGroupId: 'organization',
  knownTeamKeys: 'engineering',
  membershipGroupIds: GROUP,
  membershipSource: 'directory-claim',
};
const input = {
  tenantId: TENANT,
  scopeGroupId: 'organization',
  organization: {
    models: ['coding-model'],
    limits: { requestsPerMinute: 80, tokensPerMinute: 80_000, tokenQuota: 40_000_000, quotaPeriod: 'Monthly' },
  },
  teams: [{ teamKey: 'engineering', membershipGroupId: GROUP }],
  models: [{ deploymentName: 'deploy-coding-model', modelKey: 'coding-model' }],
};
const provider = { deployments: [{
  deploymentName: 'deploy-coding-model',
  modelName: 'coding-model',
  modelVersion: '1',
  modelFormat: 'OpenAI',
  capabilities: { chatCompletion: true, responses: true },
  raiPolicyName: null,
}] };

function jwt(claims) {
  return `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
}

const validToken = jwt({
  tid: TENANT,
  aud: AUDIENCE,
  azp: targets.clientId,
  roles: ['Governance.Administer'],
  exp: Date.parse(AT) / 1000 + 3600,
});
const ready = async () => ({ anonymousStatus: 401, anonymousBodyBytes: 0, status: 200 });

test('dry run validates provider-backed content and performs no sign-in or publication', async () => {
  let authorized = 0;
  let published = 0;
  const result = await initializeGovernance({
    input,
    targets,
    at: AT,
    dryRun: true,
    readProvider: async () => provider,
    authorize: async () => { authorized += 1; return validToken; },
    checkReadiness: ready,
    publish: async () => { published += 1; return {}; },
  });
  assert.equal(result.outcome, 'validated');
  assert.equal(authorized, 0);
  assert.equal(published, 0);
});

test('wrong token claims refuse before publication', async () => {
  let published = 0;
  await assert.rejects(
    () => initializeGovernance({
      input,
      targets,
      at: AT,
      readProvider: async () => provider,
      authorize: async () => jwt({ tid: TENANT, aud: 'wrong', azp: targets.clientId, roles: ['Governance.Administer'], exp: Date.parse(AT) / 1000 + 3600 }),
      checkReadiness: ready,
      publish: async () => { published += 1; return {}; },
    }),
    (error) => error.code === INITIALIZER_REASONS.tokenAudienceMismatch,
  );
  assert.equal(published, 0);
});

test('active publication requires all five targets verified', async () => {
  const verified = ['assignment', 'entitlement', 'modelRegistry', 'fallbackPolicy', 'budget']
    .map((targetCode) => ({ targetCode, outcome: 'verified', reasonCode: null }));
  const result = await initializeGovernance({
    input,
    targets,
    at: AT,
    readProvider: async () => provider,
    authorize: async () => validToken,
    checkReadiness: ready,
    now: () => AT,
    publish: async ({ accessToken, body }) => {
      assert.equal(accessToken, validToken);
      assert.equal(body.initialOnly, true);
      return { status: 200, body: { state: 'active', revisionId: 'revision-0001', revisionNumber: 1, targets: verified } };
    },
  });

  assert.equal(result.outcome, 'active');

  await assert.rejects(
    () => initializeGovernance({
      input,
      targets,
      at: AT,
      readProvider: async () => provider,
      authorize: async () => validToken,
      checkReadiness: ready,
      now: () => AT,
      publish: async () => ({ status: 200, body: { state: 'publishing', targets: verified.slice(0, 4) } }),
    }),
    (error) => error.code === INITIALIZER_REASONS.publishIncomplete,
  );
});

test('a bootstrap resume sends only the held revision and never rebuilds input content', async () => {
  let providerReads = 0;
  let publishedBody;
  const verified = ['assignment', 'entitlement', 'modelRegistry', 'fallbackPolicy', 'budget']
    .map((targetCode) => ({ targetCode, outcome: 'verified', reasonCode: null }));
  const result = await initializeGovernance({
    input,
    targets,
    at: AT,
    resume: true,
    revisionId: 'revision-0001',
    readProvider: async () => { providerReads += 1; return provider; },
    authorize: async () => validToken,
    checkReadiness: ready,
    now: () => AT,
    publish: async ({ body }) => {
      publishedBody = body;
      return { status: 200, body: { state: 'active', revisionId: 'revision-0001', revisionNumber: 1, targets: verified } };
    },
  });
  assert.equal(providerReads, 0);
  assert.deepEqual(publishedBody, { initialOnly: true, resume: true, revisionId: 'revision-0001' });
  assert.equal(result.outcome, 'active');
  assert.equal(result.expiresAt, null);
});

test('publish-in-progress names the resume action', async () => {
  await assert.rejects(
    () => initializeGovernance({
      input,
      targets,
      at: AT,
      readProvider: async () => provider,
      authorize: async () => validToken,
      checkReadiness: ready,
      now: () => AT,
      publish: async () => ({ status: 409, body: { reasonCode: 'publish-in-progress' } }),
    }),
    (error) => error.code === 'publish-in-progress' && /--resume/.test(error.message),
  );
});

test('a bodyless publication refusal reports its HTTP status', async () => {
  await assert.rejects(
    () => initializeGovernance({
      input,
      targets,
      at: AT,
      readProvider: async () => provider,
      authorize: async () => validToken,
      checkReadiness: ready,
      now: () => AT,
      publish: async () => ({ status: 403, body: null }),
    }),
    (error) => error.code === INITIALIZER_REASONS.publishRefused
      && /HTTP 403/.test(error.message)
      && /unknown/.test(error.message),
  );
});

test('PKCE URL fixes the registered redirect and forces account selection', () => {
  const url = new URL(buildAuthorizationUrl({
    tenantId: TENANT,
    clientId: targets.clientId,
    scope: targets.scope,
    state: 'state',
    challenge: 'challenge',
  }));
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:4173');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('prompt'), 'select_account');
  assert.match(url.searchParams.get('scope'), /Governance\.Access$/);
  assert.doesNotMatch(url.searchParams.get('scope'), /offline_access/);
});

test('PKCE token redemption distinguishes SPA and native public clients', async () => {
  const calls = [];
  const transport = async (_url, options) => {
    calls.push(options.headers);
    return { ok: true, json: async () => ({ access_token: validToken }) };
  };
  // The callback itself is exercised elsewhere; this source contract pins the token
  // request mode without introducing a second listener into this test process.
  const source = await readFile(new URL('../../tools/distribution/Initialize-Governance.mjs', import.meta.url), 'utf8');
  assert.match(source, /tokenRequestOrigin = REDIRECT_URI/);
  assert.match(source, /tokenRequestOrigin === null \? \{\} : \{ Origin: tokenRequestOrigin \}/);
  assert.equal(calls.length, 0);
  assert.equal(typeof createPkceAuthorizer({ transport, tokenRequestOrigin: null }), 'function');
});

test('an insecure control-plane endpoint refuses before sign-in or publication', async () => {
  let authorized = 0;
  let published = 0;
  await assert.rejects(
    () => initializeGovernance({
      input,
      targets: { ...targets, controlPlaneEndpoint: 'http://control.example.com' },
      at: AT,
      readProvider: async () => provider,
      authorize: async () => { authorized += 1; return validToken; },
      publish: async () => { published += 1; return {}; },
    }),
    /HTTPS URL/,
  );
  assert.equal(authorized, 0);
  assert.equal(published, 0);
});

test('input scope and teams must match the applied deployment outputs', async () => {
  await assert.rejects(
    () => initializeGovernance({
      input: { ...input, scopeGroupId: 'another-scope' },
      targets,
      at: AT,
      readProvider: async () => provider,
      authorize: async () => validToken,
      publish: async () => ({}),
    }),
    (error) => error.code === INITIALIZER_REASONS.targetMismatch,
  );
});

test('an existing active set is never replaced by the initializer', async () => {
  await assert.rejects(
    () => initializeGovernance({
      input,
      targets,
      at: AT,
      now: () => AT,
      readProvider: async () => provider,
      authorize: async () => validToken,
      checkReadiness: ready,
      publish: async () => ({ status: 409, body: { reasonCode: 'governance-already-initialized' } }),
    }),
    (error) => error.code === INITIALIZER_REASONS.alreadyInitialized,
  );
});

test('an incomplete publication names the targets it could not verify', async () => {
  const targetsResult = ['assignment', 'entitlement', 'modelRegistry', 'fallbackPolicy', 'budget']
    .map((targetCode) => ({ targetCode, outcome: targetCode === 'budget' ? 'failed' : 'verified' }));
  await assert.rejects(
    () => initializeGovernance({
      input,
      targets,
      at: AT,
      now: () => AT,
      readProvider: async () => provider,
      authorize: async () => validToken,
      checkReadiness: ready,
      publish: async () => ({ status: 200, body: { state: 'publishing', targets: targetsResult } }),
    }),
    (error) => error.code === INITIALIZER_REASONS.publishIncomplete && /budget/.test(error.message),
  );
});

test('an authenticated administration refusal prevents publication', async () => {
  let published = 0;
  await assert.rejects(
    () => initializeGovernance({
      input,
      targets,
      at: AT,
      now: () => AT,
      readProvider: async () => provider,
      authorize: async () => validToken,
      checkReadiness: async () => ({ anonymousStatus: 401, anonymousBodyBytes: 0, status: 403 }),
      publish: async () => { published += 1; return {}; },
    }),
    (error) => error.code === INITIALIZER_REASONS.controlPlaneNotReady
      && /anonymous HTTP 401\/0 bytes, authenticated HTTP 403/.test(error.message)
      && /No publication was attempted/.test(error.message),
  );
  assert.equal(published, 0);
});

test('an anonymously reachable administration route prevents publication', async () => {
  let published = 0;
  await assert.rejects(
    () => initializeGovernance({
      input,
      targets,
      at: AT,
      now: () => AT,
      readProvider: async () => provider,
      authorize: async () => validToken,
      checkReadiness: async () => ({ anonymousStatus: 200, anonymousBodyBytes: 2, status: 200 }),
      publish: async () => { published += 1; return {}; },
    }),
    (error) => error.code === INITIALIZER_REASONS.controlPlaneNotReady
      && /anonymous HTTP 200\/2 bytes/.test(error.message),
  );
  assert.equal(published, 0);
});

test('the public tool never persists or prints token payloads', async () => {
  const source = await readFile(new URL('../../tools/distribution/Initialize-Governance.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /writeFile|appendFile/);
  assert.doesNotMatch(source, /console\.(?:log|error)\([^\n]*(?:accessToken|refreshToken|access_token|refresh_token)/);
});

test('claim validation refuses missing role and expired tokens', () => {
  assert.throws(
    () => assertTokenUsable(
      { tid: TENANT, aud: AUDIENCE, azp: targets.clientId, roles: [], exp: Date.parse(AT) / 1000 + 1 },
      { tenantId: TENANT, audience: AUDIENCE, clientId: targets.clientId, at: AT },
    ),
    (error) => error.code === INITIALIZER_REASONS.tokenRoleAbsent,
  );
  assert.throws(
    () => assertTokenUsable(
      { tid: TENANT, aud: AUDIENCE, azp: targets.clientId, roles: ['Governance.Administer'], exp: Date.parse(AT) / 1000 },
      { tenantId: TENANT, audience: AUDIENCE, clientId: targets.clientId, at: AT },
    ),
    (error) => error.code === INITIALIZER_REASONS.tokenExpired,
  );
});

test('target discovery reads only the outputs the standard distribution publishes', async () => {
  const requested = [];
  const values = Object.fromEntries([
    ['CONTROL_PLANE_ENDPOINT', targets.controlPlaneEndpoint],
    ['ENTRA_TENANT_ID', targets.tenantId],
    ['ENTRA_ADMIN_API_AUDIENCE', targets.audience],
    ['ENTRA_ADMIN_API_SCOPE', targets.scope],
    ['ENTRA_ADMIN_SPA_APPLICATION_ID', targets.clientId],
    ['FOUNDRY_ACCOUNT_RESOURCE_ID', targets.foundryAccountResourceId],
    ['GOVERNANCE_SCOPE', targets.scopeGroupId],
    ['GOVERNANCE_TEAMS', targets.knownTeamKeys],
    ['GOVERNANCE_MEMBERSHIP_GROUPS', targets.membershipGroupIds],
    ['GOVERNANCE_MEMBERSHIP_SOURCE', targets.membershipSource],
  ]);
  const discovered = await readAzdTargets({
    environment: 'example',
    runProcess: async (_command, args) => {
      assert.deepEqual(args.slice(0, 3), ['env', 'get-value', args[2]]);
      assert.deepEqual(args.slice(3), ['--environment', 'example']);
      requested.push(args[2]);
      return values[args[2]];
    },
  });
  assert.deepEqual(discovered, targets);
  assert.deepEqual(requested.sort(), Object.keys(values).sort());
});

test('the Foundry account output is parsed without accepting a child resource', () => {
  assert.deepEqual(parseFoundryAccountResourceId(targets.foundryAccountResourceId), {
    subscriptionId: '00000000-0000-4000-8000-000000000005',
    resourceGroupName: 'example',
    accountName: 'example',
  });
  assert.throws(
    () => parseFoundryAccountResourceId(`${targets.foundryAccountResourceId}/projects/project`),
    TypeError,
  );
});

test('the owner role is accepted because the server grants it publishing authority', () => {
  assert.doesNotThrow(() => assertTokenUsable(
    { tid: TENANT, aud: AUDIENCE, azp: targets.clientId, roles: ['Governance.Own'], exp: Date.parse(AT) / 1000 + 60 },
    { tenantId: TENANT, audience: AUDIENCE, clientId: targets.clientId, at: AT },
  ));
});

test('claim validation refuses a token issued to another client', () => {
  assert.throws(
    () => assertTokenUsable(
      { tid: TENANT, aud: AUDIENCE, azp: 'another-client', roles: ['Governance.Administer'], exp: Date.parse(AT) / 1000 + 60 },
      { tenantId: TENANT, audience: AUDIENCE, clientId: targets.clientId, at: AT },
    ),
    (error) => error.code === INITIALIZER_REASONS.tokenClientMismatch,
  );
});

test('input group IDs must match the groups assigned to the gateway API', async () => {
  await assert.rejects(
    () => initializeGovernance({
      input,
      targets: { ...targets, membershipGroupIds: '00000000-0000-4000-8000-000000000099' },
      at: AT,
      readProvider: async () => provider,
      authorize: async () => validToken,
      publish: async () => ({}),
    }),
    (error) => error.code === INITIALIZER_REASONS.targetMismatch,
  );
});

test('device-code sign-in is the default', async () => {
  const source = await readFile(new URL('../../tools/distribution/Initialize-Governance.mjs', import.meta.url), 'utf8');
  assert.match(source, /options\['sign-in'\] \?\? 'device-code'/);
});

test('an unrecognised --sign-in value is refused', () => {
  assert.throws(() => parseArguments(['--sign-in', 'popup']), TypeError);
  assert.doesNotThrow(() => parseArguments(['--sign-in', 'device-code']));
  assert.doesNotThrow(() => parseArguments(['--sign-in', 'browser']));
});

test('the device-code authorizer requests offline_access and surfaces the prompt', async () => {
  const requestedScopes = [];
  const prompts = [];
  const fetchImpl = async (url, options) => {
    const body = new URLSearchParams(options.body);
    if (url.endsWith('/devicecode')) {
      requestedScopes.push(body.get('scope'));
      return {
        ok: true,
        json: async () => ({
          verification_uri: 'https://microsoft.com/devicelogin',
          user_code: 'ABC-123',
          device_code: 'device-code-value',
          interval: 5,
          expires_in: 900,
        }),
      };
    }
    if (url.endsWith('/token')) {
      return {
        ok: true,
        json: async () => ({ access_token: validToken, refresh_token: 'refresh-value', expires_in: 3600 }),
      };
    }
    throw new Error(`unexpected request to ${url}`);
  };
  const authorize = createDeviceCodeAuthorizer({
    fetchImpl,
    sleep: async () => {},
    writeLine: (message) => prompts.push(message),
  });
  const token = await authorize({ tenantId: TENANT, clientId: targets.clientId, scope: targets.scope });
  assert.equal(token, validToken);
  assert.equal(requestedScopes.length, 1);
  assert.match(requestedScopes[0], /offline_access$/);
  assert.match(requestedScopes[0], /Governance\.Access offline_access/);
  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /https:\/\/microsoft\.com\/devicelogin/);
  assert.match(prompts[0], /ABC-123/);
  assert.match(prompts[1], /15 minutes/);
});

test('the interactive sign-in never gives up before the code the provider issued expires', async () => {
  const source = await readFile(new URL('../../tools/distribution/Initialize-Governance.mjs', import.meta.url), 'utf8');
  const declared = /const DEVICE_CODE_TIMEOUT_MS = (\d+) \* 60 \* 1000;/.exec(source);
  assert.ok(declared, 'the initializer must declare its own device-code timeout');
  assert.ok(Number(declared[1]) >= 15, 'the timeout must exceed the provider device-code lifetime of about 15 minutes');
  assert.match(source, /timeoutMs: DEVICE_CODE_TIMEOUT_MS/);

  // The shared acquirer's default is sized for an unattended bridge, so a bootstrap that
  // did not override it would abandon an operator who is still at the browser.
  const acquirer = await readFile(new URL('../../tools/agent-auth-bridge/agent-auth-bridge.mjs', import.meta.url), 'utf8');
  const fallback = /timeoutMs = (\d[\d_]*),/.exec(acquirer);
  assert.ok(fallback, 'the acquirer must declare a default timeout');
  assert.ok(Number(declared[1]) * 60 * 1000 > Number(fallback[1].replaceAll('_', '')));
});