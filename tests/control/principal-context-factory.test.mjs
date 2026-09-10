import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createPrincipalContextFactory } from '../../app/governance-domain/principal-context/principal-context-factory.mjs';
import {
  isStrictMembershipEligible,
  MEMBERSHIP_SOURCE_NAMES,
} from '../../app/governance-domain/principal-context/principal-context-validator.mjs';
import { createDeterministicIdentityAdapter } from '../../app/local-adapters/deterministic-identity-adapter.mjs';
import { createDeterministicMembershipResolver } from '../../app/local-adapters/deterministic-membership-resolver.mjs';
import { createFixedClock, createSequenceIdGenerator } from '../../app/local-adapters/deterministic-time.mjs';

const evaluationTime = '2026-07-24T00:00:00.000Z';

function verifiedIdentity(overrides = {}) {
  return {
    source: 'local-deterministic',
    validationId: 'validation-local-001',
    validatedAt: '2026-07-23T23:59:00.000Z',
    credentialExpiresAt: '2026-07-24T01:00:00.000Z',
    validationState: 'local-trusted',
    subject: {
      tenantId: 'tenant-synthetic',
      subjectId: 'user-synthetic-001',
      principalType: 'user',
    },
    application: {
      applicationId: 'app-synthetic-admin',
      authenticationFlow: 'delegated',
    },
    ...overrides,
  };
}

function completeMembership(overrides = {}) {
  return {
    snapshotId: 'snapshot-local-001',
    status: 'complete',
    source: 'local-fixture',
    tenantId: 'tenant-synthetic',
    subjectId: 'user-synthetic-001',
    resolvedAt: '2026-07-23T23:59:00.000Z',
    expiresAt: '2026-07-24T00:30:00.000Z',
    maxAgeSeconds: 1860,
    sourceRevision: 'revision-local-001',
    groups: [
      {
        groupId: 'group-governance-admin',
        membership: 'direct',
        authorizationRelevant: true,
      },
    ],
    ...overrides,
  };
}

function createFactory(identity = verifiedIdentity(), membership = completeMembership()) {
  const identityAdapter = createDeterministicIdentityAdapter(identity);
  const membershipResolver = createDeterministicMembershipResolver([
    {
      tenantId: identity.subject.tenantId,
      subjectId: identity.subject.subjectId,
      memberships: membership,
    },
  ]);
  const factory = createPrincipalContextFactory({
    membershipResolver,
    clock: createFixedClock(evaluationTime),
    idGenerator: createSequenceIdGenerator('request-factory'),
  });
  return { identityAdapter, factory };
}

test('factory constructs an immutable, body-free principal context', async () => {
  const { identityAdapter, factory } = createFactory();
  const context = await factory.create(await identityAdapter.getVerifiedIdentity());

  assert.equal(context.contractVersion, 'v1');
  assert.equal(context.trust.callerSupplied, false);
  assert.equal(context.correlation.source, 'server-generated');
  assert.equal(context.correlation.requestId, 'request-factory-0001');
  assert.equal(isStrictMembershipEligible(context, evaluationTime), true);
  assert.equal(Object.isFrozen(context), true);
  assert.equal(Object.isFrozen(context.memberships.groups[0]), true);

  const serialized = JSON.stringify(context);
  for (const forbidden of [
    'accessToken',
    'authorization',
    'prompt',
    'completion',
    'backendUrl',
    'deployment',
    'roles',
  ]) {
    assert.equal(serialized.includes(`"${forbidden}"`), false);
  }
});

test('deterministic identity adapter ignores caller-shaped input', async () => {
  const fixed = verifiedIdentity();
  const adapter = createDeterministicIdentityAdapter(fixed);
  const result = await adapter.getVerifiedIdentity({
    subjectId: 'attacker',
    applicationId: 'attacker-app',
  });

  assert.equal(result.subject.subjectId, fixed.subject.subjectId);
  assert.equal(result.application.applicationId, fixed.application.applicationId);
});

test('factory rejects raw authentication material and unexpected identity fields', async () => {
  const { factory } = createFactory();
  const untrustedIdentity = verifiedIdentity();
  untrustedIdentity[['access', 'Token'].join('')] = 'forbidden';
  await assert.rejects(
    factory.create(untrustedIdentity),
    /accessToken is not allowed/,
  );
});

test('factory rejects subject and membership binding mismatches', async () => {
  const { identityAdapter, factory } = createFactory(
    verifiedIdentity(),
    completeMembership({ tenantId: 'another-tenant' }),
  );
  await assert.rejects(
    factory.create(await identityAdapter.getVerifiedIdentity()),
    /Membership tenant does not match/,
  );
});

test('factory rejects expired verified identity evidence', async () => {
  const identity = verifiedIdentity({ credentialExpiresAt: evaluationTime });
  const { identityAdapter, factory } = createFactory(identity);
  await assert.rejects(
    factory.create(await identityAdapter.getVerifiedIdentity()),
    /identity evidence is expired/i,
  );
});

test('factory preserves degraded membership but strict authorization fails closed', async () => {
  const membership = completeMembership({
    status: 'stale',
    reason: 'snapshot-expired',
    expiresAt: '2026-07-23T23:59:30.000Z',
    maxAgeSeconds: 30,
    groups: [],
  });
  const { identityAdapter, factory } = createFactory(verifiedIdentity(), membership);
  const context = await factory.create(await identityAdapter.getVerifiedIdentity());

  assert.equal(context.memberships.status, 'stale');
  assert.equal(isStrictMembershipEligible(context, evaluationTime), false);
});

test('factory rejects unsafe generated correlation identifiers', async () => {
  const identity = verifiedIdentity();
  const membershipResolver = createDeterministicMembershipResolver([
    {
      tenantId: identity.subject.tenantId,
      subjectId: identity.subject.subjectId,
      memberships: completeMembership(),
    },
  ]);
  const factory = createPrincipalContextFactory({
    membershipResolver,
    clock: createFixedClock(evaluationTime),
    idGenerator: { next: () => 'unsafe request id' },
  });

  await assert.rejects(factory.create(identity), /bounded safe identifier/);
});
test('the published contract and the PowerShell gate name the same membership sources', async () => {
  // Each list was maintained by hand and they had already drifted: the schema carried a
  // source nothing produces and omitted directory-claim, which is how a deployment
  // actually resolves membership, so a real context would have failed the contract gate.
  const root = new URL('../../', import.meta.url);
  const schema = JSON.parse(
    await readFile(new URL('app/governance-domain/contracts/v1/principal-context.schema.json', root), 'utf8'),
  );
  const schemaSources = schema.$defs.memberships.properties.source.enum;
  assert.deepEqual(schemaSources.slice().sort(), MEMBERSHIP_SOURCE_NAMES.slice().sort());

  const gate = await readFile(new URL('tests/control/Test-PrincipalContextContract.ps1', root), 'utf8');
  const listed = gate.match(/memberships\.source -in @\(([^)]*)\)/);
  assert.ok(listed, 'the contract gate must state which membership sources it accepts');
  const gateSources = [...listed[1].matchAll(/'([\w-]+)'/g)].map(([, name]) => name);
  assert.deepEqual(gateSources.slice().sort(), MEMBERSHIP_SOURCE_NAMES.slice().sort());
});
