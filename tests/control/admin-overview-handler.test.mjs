import assert from 'node:assert/strict';
import test from 'node:test';

import { createAdminOverviewHandler } from '../../app/functions/handlers/admin-overview.mjs';
import { getLocalRollups } from '../../app/local-adapters/rollup-fixtures.mjs';
import { createFixedClock } from '../../app/local-adapters/deterministic-time.mjs';

const AS_OF = '2026-07-24T10:00:00.000Z';
const AUDIENCE = 'api-audience-0000';
const CONFIGURATION = Object.freeze({
  activeVersion: 'cfg-003',
  state: 'active',
  publishedAt: '2026-07-24T09:30:00.000Z',
});

function principal(claims) {
  return Buffer.from(JSON.stringify({ auth_typ: 'aad', role_typ: 'roles', claims }), 'utf8').toString('base64');
}

function callerHeader(roles, audience = AUDIENCE) {
  return principal([
    { typ: 'aud', val: audience },
    { typ: 'tid', val: 'tenant-0000' },
    { typ: 'oid', val: 'object-0000' },
    ...roles.map((role) => ({ typ: 'roles', val: role })),
  ]);
}

function request({ header, query = {} } = {}) {
  return {
    headers: { get: (name) => (name === 'x-ms-client-principal' ? header ?? null : null) },
    query: { get: (name) => query[name] ?? null },
  };
}

function createHandler(overrides = {}) {
  return createAdminOverviewHandler({
    rollupStore: { queryRollupWindows: async () => getLocalRollups({ asOf: AS_OF }) },
    expectedAudience: AUDIENCE,
    clock: createFixedClock(AS_OF),
    config: { scopeGroupId: 'platform-engineering' },
    knownTeamKeys: ['developer-experience', 'platform-engineering'],
    readConfigurationSummary: async () => CONFIGURATION,
    ...overrides,
  });
}

test('an administrator receives the overview read model', async () => {
  const response = await createHandler()(request({ header: callerHeader(['Governance.Administer']) }), {});

  assert.equal(response.status, 200);
  assert.equal(response.jsonBody.readModelVersion, 'overview.v2');
  assert.ok(response.jsonBody.metrics.find((metric) => metric.id === 'requests').value > 0);
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.deepEqual(response.jsonBody.configuration, CONFIGURATION);
});

test('the configuration summary is read per request rather than fixed at construction', async () => {
  const summaries = [
    { activeVersion: 'revision-0007', state: 'active', publishedAt: '2026-07-24T09:16:00.000Z' },
    { activeVersion: null, state: 'no-active-revision', publishedAt: null },
  ];
  let calls = 0;
  const handler = createHandler({ readConfigurationSummary: async () => summaries[calls++] });

  const first = await handler(request({ header: callerHeader(['Governance.Read']) }), {});
  const second = await handler(request({ header: callerHeader(['Governance.Read']) }), {});

  assert.equal(first.jsonBody.configuration.activeVersion, 'revision-0007');
  assert.equal(second.jsonBody.configuration.state, 'no-active-revision');
  assert.equal(calls, 2);
});

test('an auditor receives the same read model as an administrator', async () => {
  const administer = await createHandler()(request({ header: callerHeader(['Governance.Administer']) }), {});
  const read = await createHandler()(request({ header: callerHeader(['Governance.Read']) }), {});

  assert.equal(read.status, 200);
  assert.deepEqual(read.jsonBody.metrics, administer.jsonBody.metrics);
});

test('a caller with no governance role is refused', async () => {
  const response = await createHandler()(request({ header: callerHeader([]) }), {});

  assert.equal(response.status, 403);
  assert.equal(response.jsonBody.error.code, 'governance_access_denied');
  assert.equal(response.jsonBody.error.reasonCode, 'no-governance-role');
});

test('the gateway machine role cannot read administration data', async () => {
  const response = await createHandler()(request({ header: callerHeader(['Policy.Resolve']) }), {});

  assert.equal(response.status, 403);
  assert.equal(response.jsonBody.error.reasonCode, 'governance-role-not-recognized');
});

test('a token minted for another resource is refused even with the right role', async () => {
  const response = await createHandler()(
    request({ header: callerHeader(['Governance.Administer'], 'some-other-audience') }),
    {},
  );

  assert.equal(response.status, 401);
  assert.equal(response.jsonBody.error.reasonCode, 'audience-not-accepted');
});

test('an unauthenticated request is refused rather than treated as anonymous', async () => {
  for (const header of [undefined, 'not-base64-json']) {
    const response = await createHandler()(request({ header }), {});
    assert.equal(response.status, 401);
    assert.equal(response.jsonBody.error.code, 'caller_not_authenticated');
  }
});

test('scope and range are validated before anything is read', async () => {
  let read = false;
  const handler = createHandler({
    rollupStore: {
      queryRollupWindows: async () => {
        read = true;
        return [];
      },
    },
  });

  for (const query of [{ scope: 'everything' }, { range: 'forever' }]) {
    const response = await handler(request({ header: callerHeader(['Governance.Read']), query }), {});
    assert.equal(response.status, 400);
  }
  assert.equal(read, false);
});

test('a team selection outside the known teams is refused', async () => {
  const response = await createHandler()(
    request({ header: callerHeader(['Governance.Read']), query: { scope: 'team', team: 'no-such-team' } }),
    {},
  );

  assert.equal(response.status, 403);
  assert.equal(response.jsonBody.error.code, 'team_scope_denied');
});

test('a permitted team selection narrows the report', async () => {
  const global = await createHandler()(request({ header: callerHeader(['Governance.Read']) }), {});
  const team = await createHandler()(
    request({
      header: callerHeader(['Governance.Read']),
      query: { scope: 'team', team: 'developer-experience' },
    }),
    {},
  );

  assert.equal(team.status, 200);
  assert.ok(
    team.jsonBody.metrics.find((metric) => metric.id === 'requests').value <
      global.jsonBody.metrics.find((metric) => metric.id === 'requests').value,
  );
});

test('a store failure is reported as unavailable rather than as an empty report', async () => {
  const handler = createHandler({
    rollupStore: {
      queryRollupWindows: async () => {
        throw new Error('offline');
      },
    },
  });

  const response = await handler(request({ header: callerHeader(['Governance.Read']) }), {});

  assert.equal(response.status, 503);
  assert.equal(response.jsonBody.error.code, 'usage_source_unavailable');
});

test('the served body carries no caller identity', async () => {
  const response = await createHandler()(request({ header: callerHeader(['Governance.Administer']) }), {});

  const serialized = JSON.stringify(response.jsonBody);
  for (const forbidden of ['tenant-0000', 'object-0000', 'Governance.Administer', 'roles', 'permissions']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test('the window read is bounded by the requested range', async () => {
  const seen = [];
  const handler = createHandler({
    rollupStore: {
      queryRollupWindows: async (parameters) => {
        seen.push(parameters);
        return [];
      },
    },
  });

  await handler(request({ header: callerHeader(['Governance.Read']), query: { range: '24h' } }), {});
  await handler(request({ header: callerHeader(['Governance.Read']), query: { range: '30d' } }), {});

  assert.equal(seen[0].scopeGroupId, 'platform-engineering');
  assert.ok(Date.parse(seen[0].sinceWindowStart) > Date.parse(seen[1].sinceWindowStart));
});

test('a misconfigured handler is refused at construction', () => {
  for (const missing of ['rollupStore', 'expectedAudience', 'clock', 'config', 'readConfigurationSummary']) {
    assert.throws(() => createHandler({ [missing]: undefined }), TypeError, missing);
  }
});

test('a deployment on another identity provider is configured, not forked', async () => {
  const keycloak = createHandler({ roleMapping: { administer: ['llm-gov-admin'], read: ['llm-gov-auditor'] } });

  const granted = await keycloak(request({ header: callerHeader(['llm-gov-admin']) }), {});
  assert.equal(granted.status, 200);

  const entraName = await keycloak(request({ header: callerHeader(['Governance.Administer']) }), {});
  assert.equal(entraName.status, 403);
});

test('a provider that puts roles in another claim is read from that claim', async () => {
  const handler = createHandler({
    roleMapping: { administer: ['gov-admin'], read: ['gov-read'] },
    rolesClaim: 'realm_roles',
  });
  const header = Buffer.from(
    JSON.stringify({
      auth_typ: 'oidc',
      role_typ: 'realm_roles',
      claims: [
        { typ: 'aud', val: AUDIENCE },
        { typ: 'sub', val: 'subject-0000' },
        { typ: 'realm_roles', val: 'gov-admin' },
      ],
    }),
    'utf8',
  ).toString('base64');

  const response = await handler(request({ header }), {});
  assert.equal(response.status, 200);
});
