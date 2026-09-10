import assert from 'node:assert/strict';
import test from 'node:test';

import { createGatewayIdentityResolver } from '../../app/control-api/gateway-identity.mjs';
import { createStoredMembershipResolver } from '../../app/control-api/stored-membership-resolver.mjs';
import {
  assertPrincipalMembershipDocument,
  principalMembershipDocument,
  principalMembershipDocumentId,
} from '../../app/governance-domain/directory/principal-membership-document.mjs';
import { createPrincipalContextFactory } from '../../app/governance-domain/principal-context/principal-context-factory.mjs';
import { assertPrincipalContextV1 } from '../../app/governance-domain/principal-context/principal-context-validator.mjs';
import { createInMemoryGovernanceStore } from '../../app/persistence/in-memory-governance-store.mjs';
import { createSequenceIdGenerator } from '../../app/local-adapters/deterministic-time.mjs';

const NOW = '2026-07-24T10:00:00.000Z';
const SCOPE_GROUP_ID = 'platform-engineering';
const TENANT_ID = 'tenant-contract';
const SUBJECT_ID = 'subject-contract';
const clock = { nowIso: () => NOW };

function membershipEvidence(overrides = {}) {
  return {
    snapshotId: 'membership-0001',
    status: 'complete',
    source: 'control-plane',
    tenantId: TENANT_ID,
    subjectId: SUBJECT_ID,
    resolvedAt: '2026-07-24T09:58:00.000Z',
    expiresAt: '2026-07-24T10:03:00.000Z',
    maxAgeSeconds: 300,
    sourceRevision: 'directory-0001',
    groups: [{ groupId: 'group-governance-admin', membership: 'direct', authorizationRelevant: true }],
    ...overrides,
  };
}

async function storeWithMembership(evidence = membershipEvidence()) {
  const store = createInMemoryGovernanceStore();
  await store.putPrincipalMembership(
    principalMembershipDocument({ scopeGroupId: SCOPE_GROUP_ID, memberships: evidence }),
    { ifMatch: null, evaluationTime: NOW },
  );
  return store;
}

const resolverFor = (store) => createStoredMembershipResolver({ store, scopeGroupId: SCOPE_GROUP_ID, clock });

test('published membership is returned as the evidence it is', async () => {
  const resolved = await resolverFor(await storeWithMembership()).resolve({
    tenantId: TENANT_ID,
    subjectId: SUBJECT_ID,
  });
  assert.equal(resolved.status, 'complete');
  assert.deepEqual(resolved.groups, membershipEvidence().groups);
});

test('no published membership is unmapped, never an empty answer', async () => {
  // An empty group list and "nobody established what this principal belongs to" look
  // identical downstream, and only the first is an answer.
  const resolved = await resolverFor(createInMemoryGovernanceStore()).resolve({
    tenantId: TENANT_ID,
    subjectId: SUBJECT_ID,
  });
  assert.equal(resolved.status, 'unmapped');
  assert.notEqual(resolved.status, 'empty-complete');
  assert.equal(resolved.reason, 'membership-not-published');
  assert.deepEqual(resolved.groups, []);
});

test('an unreachable store is told apart from an unpublished principal', async () => {
  const unreachable = {
    async readPrincipalMembership() {
      throw new Error('ECONNREFUSED');
    },
  };
  const resolved = await resolverFor(unreachable).resolve({ tenantId: TENANT_ID, subjectId: SUBJECT_ID });
  assert.equal(resolved.status, 'source-unavailable');
  assert.equal(resolved.reason, 'membership-store-unreadable');
});

test('a malformed principal is refused rather than reported as a store failure', async () => {
  const resolver = resolverFor(createInMemoryGovernanceStore());
  for (const selection of [{}, { tenantId: TENANT_ID }, { tenantId: TENANT_ID, subjectId: 'has spaces' }]) {
    await assert.rejects(() => resolver.resolve(selection), TypeError);
  }
});

test('degraded membership still satisfies the principal context contract', async () => {
  // A degraded status is only useful if a context can actually carry it; a shape the
  // validator refuses would turn an honest degradation into a request failure.
  for (const store of [createInMemoryGovernanceStore(), await storeWithMembership()]) {
    const factory = createPrincipalContextFactory({
      membershipResolver: resolverFor(store),
      clock,
      idGenerator: createSequenceIdGenerator('membership'),
    });
    const identity = createGatewayIdentityResolver({ clock })({
      tenantId: TENANT_ID,
      subjectId: SUBJECT_ID,
      applicationId: 'app-contract',
    });
    const context = await factory.create(identity);
    assert.equal(assertPrincipalContextV1(context, { evaluationTime: NOW }), context);
  }
});

test('the gateway principal becomes a validated identity, not a caller-supplied one', () => {
  const identity = createGatewayIdentityResolver({ clock })({
    tenantId: TENANT_ID,
    subjectId: SUBJECT_ID,
    applicationId: 'app-contract',
  });
  assert.equal(identity.source, 'entra-validated');
  assert.equal(identity.validationState, 'validated');
  assert.equal(identity.subject.subjectId, SUBJECT_ID);
  assert.equal(identity.application.applicationId, 'app-contract');
  assert.ok(Date.parse(identity.credentialExpiresAt) > Date.parse(identity.validatedAt));
});

test('an incomplete gateway principal is refused with a reason', () => {
  const resolve = createGatewayIdentityResolver({ clock });
  for (const body of [undefined, {}, { tenantId: TENANT_ID }, { tenantId: TENANT_ID, subjectId: SUBJECT_ID }]) {
    assert.throws(
      () => resolve(body),
      (error) => error instanceof TypeError && error.reasonCode === 'gateway-principal-incomplete',
    );
  }
});

test('an unattended workload is told apart from a person, and only by what the gateway said', async () => {
  const resolve = createGatewayIdentityResolver({ clock });
  const principal = { tenantId: TENANT_ID, subjectId: SUBJECT_ID, applicationId: 'app-contract' };

  // A gateway that says nothing only ever validated delegated tokens. Reading that as a
  // person is the conservative half: a person still has to belong to a governed group,
  // while a workload is admitted by an application role.
  const unstated = resolve(principal);
  assert.equal(unstated.subject.principalType, 'user');
  assert.equal(unstated.application.authenticationFlow, 'delegated');

  const person = resolve({ ...principal, authenticationFlow: 'delegated' });
  assert.equal(person.subject.principalType, 'user');
  assert.equal(person.application.authenticationFlow, 'delegated');

  const workload = resolve({ ...principal, authenticationFlow: 'application' });
  assert.equal(workload.subject.principalType, 'workload');
  assert.equal(workload.application.authenticationFlow, 'application');

  for (const authenticationFlow of ['client_credentials', 'application ', '', null, 42]) {
    assert.throws(
      () => resolve({ ...principal, authenticationFlow }),
      (error) => error instanceof TypeError && error.reasonCode === 'gateway-authentication-flow-unusable',
    );
  }

  // The pairing is a contract rule elsewhere, so a workload identity has to survive the
  // same validation a person's does rather than only satisfying this resolver.
  const factory = createPrincipalContextFactory({
    membershipResolver: resolverFor(await storeWithMembership()),
    clock,
    idGenerator: createSequenceIdGenerator('workload'),
  });
  const context = await factory.create(resolve({ ...principal, authenticationFlow: 'application' }));
  assert.equal(context.subject.principalType, 'workload');
  assert.equal(assertPrincipalContextV1(context, { evaluationTime: NOW }), context);
});

test('forwarded groups are carried only when the gateway sent them', () => {
  const resolve = createGatewayIdentityResolver({ clock });
  const principal = { tenantId: TENANT_ID, subjectId: SUBJECT_ID, applicationId: 'app-contract' };

  // Absent stays absent: a gateway that forwarded nothing has not reported that the
  // caller belongs to no groups, and the resolver must be able to tell those apart.
  assert.equal(Object.hasOwn(resolve(principal), 'directoryGroups'), true);
  assert.equal(resolve(principal).directoryGroups, undefined);
  assert.deepEqual(resolve({ ...principal, groups: [] }).directoryGroups, []);
  assert.deepEqual(resolve({ ...principal, groups: ['group-a'] }).directoryGroups, ['group-a']);

  for (const groups of ['group-a', { groupId: 'group-a' }, ['a group with spaces'], [42]]) {
    assert.throws(
      () => resolve({ ...principal, groups }),
      (error) => error.reasonCode === 'gateway-groups-unusable',
    );
  }
  assert.throws(
    () => resolve({ ...principal, groups: Array.from({ length: 201 }, (_, index) => `group-${index}`) }),
    (error) => error.reasonCode === 'gateway-groups-overflow',
  );
});

test('the membership document identifier is derived from all three of its parts', () => {
  const document = principalMembershipDocument({
    scopeGroupId: SCOPE_GROUP_ID,
    memberships: membershipEvidence(),
  });
  assert.equal(
    document.id,
    principalMembershipDocumentId({ scopeGroupId: SCOPE_GROUP_ID, tenantId: TENANT_ID, subjectId: SUBJECT_ID }),
  );
  assert.throws(
    () => assertPrincipalMembershipDocument({ ...document, subjectId: 'someone-else' }, { evaluationTime: NOW }),
    TypeError,
  );
});

test('a document whose evidence names another principal is refused', () => {
  const document = principalMembershipDocument({
    scopeGroupId: SCOPE_GROUP_ID,
    memberships: membershipEvidence(),
  });
  assert.throws(
    () =>
      assertPrincipalMembershipDocument(
        { ...document, memberships: { ...document.memberships, subjectId: 'other' } },
        { evaluationTime: NOW },
      ),
    TypeError,
  );
});

test('expired complete evidence is refused on the way out', () => {
  const document = principalMembershipDocument({
    scopeGroupId: SCOPE_GROUP_ID,
    memberships: membershipEvidence(),
  });
  assert.throws(
    () => assertPrincipalMembershipDocument(document, { evaluationTime: '2026-07-24T10:05:00.000Z' }),
    RangeError,
  );
});
