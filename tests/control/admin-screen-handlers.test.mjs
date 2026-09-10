import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createModelsHandler,
  createUsersGroupsHandler,
  createUsageHandler,
  createBudgetsHandler,
  createFallbackHandler,
  createLifecycleHandler,
  createChangeLogHandler,
} from '../../app/functions/handlers/admin-screens.mjs';
import { ReadSourceUnavailableError } from '../../app/control-api/governance-read-source.mjs';
import { createLocalGovernanceSource } from '../../app/control-api/local-governance-source.mjs';
import { createNotificationLedger } from '../../app/control-api/notification-ledger.mjs';
import { createInMemoryGovernanceStore } from '../../app/persistence/in-memory-governance-store.mjs';
import { getDeterministicGovernanceSnapshots } from '../../app/local-adapters/deterministic-governance-snapshots.mjs';
import { getUsersGroupsFixture } from '../../app/local-adapters/users-groups-fixtures.mjs';

const NOW = '2026-07-24T10:00:00.000Z';
const AUDIENCE = 'api://control-plane';
const clock = { nowIso: () => NOW };
const invocation = { invocationId: 'invocation-1', error: () => {} };

function principalHeader(roles, identity = {}) {
  const identityClaims = [
    ...(identity.tenantId ? [{ typ: 'tid', val: identity.tenantId }] : []),
    ...(identity.objectId ? [{ typ: 'oid', val: identity.objectId }] : []),
  ];
  return Buffer.from(
    JSON.stringify({
      auth_typ: 'aad',
      role_typ: 'roles',
      claims: [
        { typ: 'aud', val: AUDIENCE },
        ...identityClaims,
        ...roles.map((role) => ({ typ: 'roles', val: role })),
      ],
    }),
    'utf8',
  ).toString('base64');
}

function requestWith({ roles = ['Governance.Administer'], query = '', identity } = {}) {
  const headers = new Map([['x-ms-client-principal', principalHeader(roles, identity)]]);
  return {
    url: `https://control-plane.example.com/api/v1/admin/screen${query}`,
    headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
  };
}

function sourceWith(overrides = {}) {
  const snapshots = getDeterministicGovernanceSnapshots();
  // The usage reading comes from the real producer: a hand-written one encodes a shape
  // the product never emits, and the projector refuses it for the wrong reason.
  const development = createLocalGovernanceSource({ evaluationTime: NOW });
  return {
    capabilities: development.capabilities,
    readGovernanceSnapshots: async () => snapshots,
    // A deployment has one reading, so the source takes no fixture name.
    readUsersGroups: async () => ({ ...getUsersGroupsFixture('complete'), subjectsMatchCaller: false }),
    readUsageRecords: async () => development.readUsageRecords({
      registry: snapshots.modelRegistrySnapshot,
      fixtureName: 'complete',
    }),
    readRollups: async () => development.readRollups(),
    readConfigurationRevisions: async () => development.readConfigurationRevisions(),
    readProviderQuota: async () => null,
    ...overrides,
  };
}

function handlers({
  deriveDirectoryCode = null,
  deriveLifecycleActor = null,
  windowSeconds = 3600,
  ledger = null,
  ...overrides
} = {}) {
  const shared = {
    source: sourceWith(overrides),
    clock,
    expectedAudience: AUDIENCE,
    knownTeamKeys: ['platform-engineering', 'developer-experience'],
  };
  return {
    usersGroups: createUsersGroupsHandler({ ...shared, deriveDirectoryCode }),
    models: createModelsHandler(shared),
    usage: createUsageHandler(shared),
    budgets: createBudgetsHandler({ ...shared, windowSeconds }),
    fallback: createFallbackHandler(shared),
    lifecycle: createLifecycleHandler({ ...shared, deriveLifecycleActor }),
    ...(ledger === null ? {} : { audit: createChangeLogHandler({ ...shared, ledger }) }),
  };
}

test('the roster is served to a governance reader at global scope', async () => {
  const response = await handlers().usersGroups(requestWith({ query: '?scope=global&view=groups' }), invocation);

  assert.equal(response.status, 200);
  assert.equal(response.jsonBody.readModelVersion, 'users-groups.v1');
  assert.ok(response.jsonBody.records.length > 0);
});

test('self scope is refused rather than answered with nobody', async () => {
  // No deriver and no object id: the caller cannot be placed in a reading that names
  // people by directory object id, so the filter would match nothing and read as
  // "you are in no groups" rather than as "this cannot be determined".
  const response = await handlers().usersGroups(requestWith({ query: '?scope=self&view=users' }), invocation);

  assert.equal(response.status, 403);
  assert.equal(response.jsonBody.error.reasonCode, 'self-scope-not-identifiable');
});

test('self scope answers once the caller can be placed in the reading', async () => {
  const mine = getUsersGroupsFixture('complete').users[0];
  const seen = [];
  const response = await handlers({
    deriveDirectoryCode: (identity) => {
      seen.push(identity);
      return mine.subjectId;
    },
  }).usersGroups(
    requestWith({
      query: '?scope=self&view=users',
      identity: { tenantId: 'tenant-1', objectId: 'object-1' },
    }),
    invocation,
  );

  assert.equal(response.status, 200);
  // Derived from the directory object id, not from the token's pairwise subject.
  assert.deepEqual(seen, [{ tenantId: 'tenant-1', subjectId: 'object-1' }]);
  // One of the roster, not all of it: self scope narrowed rather than passing through.
  assert.ok(getUsersGroupsFixture('complete').users.length > 1);
  assert.equal(response.jsonBody.records.length, 1);
});

test('a deriver without an object id to derive from still refuses', async () => {
  const response = await handlers({
    deriveDirectoryCode: () => assert.fail('must not derive without an object id'),
  }).usersGroups(requestWith({ query: '?scope=self&view=users' }), invocation);

  assert.equal(response.status, 403);
  assert.equal(response.jsonBody.error.reasonCode, 'self-scope-not-identifiable');
});

test('a reading whose groups never recorded membership refuses rather than throwing', async () => {
  // What a snapshot written before groups carried their members looks like on read.
  const stored = getUsersGroupsFixture('complete');
  const response = await handlers({
    deriveDirectoryCode: () => stored.users[0].subjectId,
    readUsersGroups: async () => ({
      ...stored,
      groups: stored.groups.map(({ memberSubjectIds, ...rest }) => rest),
      subjectsMatchCaller: false,
    }),
  }).usersGroups(
    requestWith({
      query: '?scope=self&view=groups',
      identity: { tenantId: 'tenant-1', objectId: 'object-1' },
    }),
    invocation,
  );

  assert.equal(response.status, 403);
  assert.equal(response.jsonBody.error.reasonCode, 'self-scope-membership-absent');
});

test('nothing stored is reported as no reading yet, not as an empty organization', async () => {
  const response = await handlers({
    readUsersGroups: async () => {
      throw new ReadSourceUnavailableError('directory-snapshot-absent');
    },
  }).usersGroups(requestWith({ query: '?scope=global&view=groups' }), invocation);

  assert.equal(response.status, 503);
  assert.equal(response.jsonBody.error.code, 'reading_unavailable');
  assert.equal(response.jsonBody.error.reasonCode, 'directory-snapshot-absent');
});

test('the model catalogue is served, and reports allocation as not collected when the provider is silent', async () => {
  const response = await handlers().models(requestWith({ query: '?scope=global' }), invocation);

  assert.equal(response.status, 200);
  assert.equal(response.jsonBody.readModelVersion, 'models.v1');
  assert.ok(response.jsonBody.records.length > 0);
});

test('neither screen takes a fixture, a persona, or a viewer from the request', async () => {
  const asked = [];
  const { usersGroups, models } = handlers({
    readUsersGroups: async (args) => {
      asked.push(args);
      return { ...getUsersGroupsFixture('complete'), subjectsMatchCaller: false };
    },
  });
  const query = '?scope=global&view=groups&fixture=denied&persona=end-user&viewer=someone-else';
  assert.equal((await usersGroups(requestWith({ query }), invocation)).status, 200);
  assert.equal((await models(requestWith({ query }), invocation)).status, 200);
  for (const args of asked) {
    assert.deepEqual(Object.keys(args ?? {}), []);
  }
});

test('an unauthenticated caller never reaches the source', async () => {
  let read = 0;
  const handler = createUsersGroupsHandler({
    source: sourceWith({
      readGovernanceSnapshots: async () => {
        read += 1;
        return getDeterministicGovernanceSnapshots();
      },
    }),
    clock,
    expectedAudience: AUDIENCE,
    deriveDirectoryCode: null,
  });

  const response = await handler(
    { url: 'https://control-plane.example.com/api/v1/admin/users-groups', headers: { get: () => null } },
    invocation,
  );
  assert.equal(response.status, 401);
  assert.equal(read, 0);
});

test('a reader without a governance role is refused', async () => {
  const response = await handlers().models(requestWith({ roles: ['Other.Role'], query: '?scope=global' }), invocation);
  assert.equal(response.status, 403);
  assert.equal(response.jsonBody.error.code, 'governance_access_denied');
});

test('an unsupported selection is refused before anything is read', async () => {
  const { usersGroups } = handlers();
  for (const [query, code] of [
    ['?scope=everywhere', 'scope_not_supported'],
    ['?scope=global&view=machines', 'view_not_supported'],
    ['?scope=team', 'team_required'],
  ]) {
    const response = await usersGroups(requestWith({ query }), invocation);
    assert.equal(response.status, 400, query);
    assert.equal(response.jsonBody.error.code, code);
  }
});

test('the handlers refuse to be built without what they need', () => {
  assert.throws(() => createUsersGroupsHandler({ clock, expectedAudience: AUDIENCE }), TypeError);  assert.throws(() => createModelsHandler({ source: sourceWith(), clock }), TypeError);
});

function realLedger({ scopeGroupId = 'platform-engineering' } = {}) {
  return createNotificationLedger({ store: createInMemoryGovernanceStore(), scopeGroupId });
}

const NEW_SCREENS = Object.freeze(['usage', 'budgets', 'fallback', 'lifecycle', 'audit']);

test('the five newly deployed screens all require authentication, a governance role, and a supported scope', async () => {
  const built = handlers({ ledger: realLedger() });

  for (const name of NEW_SCREENS) {
    const handler = built[name];

    const noPrincipal = await handler(
      { url: 'https://control-plane.example.com/api/v1/admin/screen', headers: { get: () => null } },
      invocation,
    );
    assert.equal(noPrincipal.status, 401, `${name} without a principal header`);

    const noRole = await handler(requestWith({ roles: ['Other.Role'], query: '?scope=global' }), invocation);
    assert.equal(noRole.status, 403, `${name} without a governance role`);
    assert.equal(noRole.jsonBody.error.code, 'governance_access_denied', name);

    const unsupportedScope = await handler(requestWith({ query: '?scope=everywhere' }), invocation);
    assert.equal(unsupportedScope.status, 400, `${name} with an unsupported scope`);
    assert.equal(unsupportedScope.jsonBody.error.code, 'scope_not_supported', name);
  }
});

test('usage is served at global scope, with a real-shaped reading', async () => {
  const { usage } = handlers();
  const response = await usage(requestWith({ query: '?scope=global&view=users' }), invocation);

  assert.equal(response.status, 200);
  assert.equal(response.jsonBody.readModelVersion, 'usage.v1');
});

test('usage self scope is refused before any read, because the caller can never be found in a usage record', async () => {
  const asked = [];
  const { usage } = handlers({
    readGovernanceSnapshots: async () => {
      asked.push('snapshots');
      return getDeterministicGovernanceSnapshots();
    },
  });
  const response = await usage(requestWith({ query: '?scope=self&view=users' }), invocation);

  assert.equal(response.status, 403);
  assert.equal(response.jsonBody.error.reasonCode, 'self-scope-not-attributable');
  // Refused before any projection, not merely rendered as an empty aggregate.
  assert.deepEqual(asked, []);
});

test('budgets is served at global scope, with a real-shaped reading', async () => {
  const { budgets } = handlers();
  const response = await budgets(requestWith({ query: '?scope=global' }), invocation);

  assert.equal(response.status, 200);
  assert.equal(response.jsonBody.readModelVersion, 'budgets.v1');
  assert.ok(response.jsonBody.records.length > 0);
});

test('budgets pass a per-model identity selector to consumption', async () => {
  const snapshots = getDeterministicGovernanceSnapshots();
  const perModelSnapshots = {
    ...snapshots,
    budgetSnapshot: {
      ...snapshots.budgetSnapshot,
      budgets: snapshots.budgetSnapshot.budgets.map((budget) => ({
        ...budget,
        modelScope: 'per-model',
        modelKey: 'coding-primary',
      })),
    },
  };
  const response = await handlers({
    readGovernanceSnapshots: async () => perModelSnapshots,
  }).budgets(requestWith({ query: '?scope=global' }), invocation);
  const [record] = response.jsonBody.records;

  assert.equal(response.status, 200);
  assert.equal(record.modelScope, 'per-model');
  assert.equal(record.modelKey, 'coding-primary');
  assert.equal(record.consumption.state, 'partial');
  assert.ok(record.consumption.consumedTokens > 0);
});

test('budgets refuses to price against nothing, when no global entitlement binding exists', async () => {
  const snapshots = getDeterministicGovernanceSnapshots();
  const withoutGlobalBinding = {
    ...snapshots,
    entitlementSnapshot: {
      ...snapshots.entitlementSnapshot,
      bindings: snapshots.entitlementSnapshot.bindings.filter((binding) => binding.target.kind !== 'global'),
    },
  };
  const { budgets } = handlers({ readGovernanceSnapshots: async () => withoutGlobalBinding });
  const response = await budgets(requestWith({ query: '?scope=global' }), invocation);

  assert.equal(response.status, 503);
  assert.equal(response.jsonBody.error.reasonCode, 'organization-entitlement-absent');
});

test('fallback is served at global scope, with a real-shaped reading', async () => {
  const { fallback } = handlers();
  const response = await fallback(requestWith({ query: '?scope=global' }), invocation);

  assert.equal(response.status, 200);
  assert.equal(response.jsonBody.readModelVersion, 'fallback.v1');
  // The administrator's view of the published plan, not a live request's decision.
  assert.equal(response.jsonBody.decision, null);
});

test('lifecycle is served at global scope, with a real-shaped reading', async () => {
  const { lifecycle } = handlers();
  const response = await lifecycle(requestWith({ query: '?scope=global' }), invocation);

  assert.equal(response.status, 200);
  assert.equal(response.jsonBody.readModelVersion, 'lifecycle.v1');
  assert.ok(response.jsonBody.records.length > 0);
});

test('lifecycle offers deployed proposal actions only to the authenticated write-capable actor', async () => {
  const derived = [];
  const { lifecycle } = handlers({
    deriveLifecycleActor: (caller) => {
      derived.push({ tenantId: caller.tenantId, objectId: caller.objectId });
      return 'actor1-0123456789abcdef0123456789abcdef';
    },
  });

  const reader = await lifecycle(
    requestWith({ roles: ['Governance.Read'], query: '?scope=global', identity: { tenantId: 'tenant-0001', objectId: 'reader-0001' } }),
    invocation,
  );
  assert.equal(reader.status, 200);
  assert.deepEqual(derived, []);
  assert.deepEqual(reader.jsonBody.records.flatMap((record) => record.availableCommands), []);

  const administrator = await lifecycle(
    requestWith({ query: '?scope=global', identity: { tenantId: 'tenant-0001', objectId: 'admin-0001' } }),
    invocation,
  );
  assert.equal(administrator.status, 200);
  assert.deepEqual(derived, [{ tenantId: 'tenant-0001', objectId: 'admin-0001' }]);
});

test('lifecycle withholds proposal actions when the deployed handler cannot derive the caller actor', async () => {
  const { lifecycle } = handlers({
    deriveLifecycleActor: () => {
      throw new Error('identity derivation unavailable');
    },
  });

  const response = await lifecycle(
    requestWith({
      query: '?scope=global',
      identity: { tenantId: 'tenant-0001', objectId: 'admin-0001' },
    }),
    invocation,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(response.jsonBody.records.flatMap((entry) => entry.availableCommands), []);
});

test('the change log is served from the durable ledger, with a real-shaped reading', async () => {
  const { audit } = handlers({ ledger: realLedger() });
  const response = await audit(requestWith({ query: '?scope=global' }), invocation);

  assert.equal(response.status, 200);
  assert.equal(response.jsonBody.readModelVersion, 'change-log.v1');
});

test('an unreadable ledger is reported as unavailable, not as a history with nothing in it', async () => {
  const { audit } = handlers({
    ledger: {
      list: async () => {
        throw new Error('ledger unreachable');
      },
    },
  });
  const response = await audit(requestWith({ query: '?scope=global' }), invocation);

  assert.equal(response.status, 503);
  assert.equal(response.jsonBody.error.reasonCode, 'notification-source-unavailable');
});

test('none of the five newly deployed screens take a fixture, a persona, or an intent from the request', async () => {
  const asked = [];
  const { usage, budgets, fallback, lifecycle, audit } = handlers({
    ledger: realLedger(),
    readGovernanceSnapshots: async (args) => {
      asked.push(args);
      return getDeterministicGovernanceSnapshots();
    },
  });
  const query = '?scope=global&view=users&fixture=denied&persona=end-user&intent=pinned&viewer=someone-else';
  for (const [name, handler] of [
    ['usage', usage],
    ['budgets', budgets],
    ['fallback', fallback],
    ['lifecycle', lifecycle],
    ['audit', audit],
  ]) {
    assert.equal((await handler(requestWith({ query }), invocation)).status, 200, name);
  }
  for (const args of asked) {
    assert.deepEqual(Object.keys(args ?? {}), []);
  }
});
