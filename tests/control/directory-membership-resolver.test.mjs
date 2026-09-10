import assert from 'node:assert/strict';
import test from 'node:test';

import { createDirectoryMembershipResolver } from '../../app/control-api/directory-membership-resolver.mjs';
import { createTokenClaimsMembershipResolver } from '../../app/control-api/token-claims-membership-resolver.mjs';
import { createEntraGroupMembershipQuery } from '../../app/providers/entra-group-membership-query.mjs';
import { createPrincipalContextFactory } from '../../app/governance-domain/principal-context/principal-context-factory.mjs';
import { isStrictMembershipEligible } from '../../app/governance-domain/principal-context/principal-context-validator.mjs';
import { createFixedClock, createSequenceIdGenerator } from '../../app/local-adapters/deterministic-time.mjs';

const NOW = '2026-08-18T10:00:00.000Z';
const TENANT_ID = 'tenant-local-demo';
const GROUP_ID = 'be817d3e-869d-4866-a454-a629035e0eb0';

function createResolver(readGroupIds) {
  const clock = createFixedClock(NOW);
  return createDirectoryMembershipResolver({
    claimResolver: createTokenClaimsMembershipResolver({ clock }),
    directory: { readGroupIds },
    clock,
  });
}

function workloadRequest(overrides = {}) {
  return {
    tenantId: TENANT_ID,
    subjectId: 'workload-agent-001',
    principalType: 'workload',
    directoryGroups: [],
    credentialExpiresAt: '2026-08-18T11:00:00.000Z',
    ...overrides,
  };
}

test('a user is answered by their own claim, and the directory is never asked', async () => {
  let asked = false;
  const resolved = await createResolver(async () => {
    asked = true;
    return [];
  }).resolve(workloadRequest({
    subjectId: 'user-local-admin',
    principalType: 'user',
    directoryGroups: ['group-governance-admin'],
  }));

  assert.equal(asked, false, 'a claim is stronger evidence than a reading, so it wins');
  assert.equal(resolved.source, 'directory-claim');
  assert.deepEqual(resolved.groups.map((group) => group.groupId), ['group-governance-admin']);
});

test('a workload is placed by the directory, which holds what its token cannot carry', async () => {
  const resolved = await createResolver(async ({ principalType, subjectId }) => {
    assert.equal(principalType, 'workload');
    assert.equal(subjectId, 'workload-agent-001');
    return [GROUP_ID];
  }).resolve(workloadRequest());

  assert.equal(resolved.status, 'complete');
  assert.equal(resolved.source, 'entra-adapter');
  assert.deepEqual(resolved.groups.map((group) => group.groupId), [GROUP_ID]);
  assert.equal(isStrictMembershipEligible({ memberships: resolved }, NOW), true);
});

test('a workload the directory places in nothing is an answer, not a gap', async () => {
  const resolved = await createResolver(async () => []).resolve(workloadRequest());

  assert.equal(resolved.status, 'empty-complete');
  assert.deepEqual(resolved.groups, []);
});

test('a directory that would not answer establishes nothing, and cannot admit anyone', async () => {
  const resolved = await createResolver(async () => {
    throw Object.assign(new Error('directory-read-failed'), { code: 'directory-read-failed' });
  }).resolve(workloadRequest());

  assert.equal(resolved.status, 'source-unavailable');
  assert.deepEqual(resolved.groups, []);
  // The empty group list must never read as "belongs to nothing", which would grant
  // whatever such a caller is entitled to on evidence nobody gathered.
  assert.equal(isStrictMembershipEligible({ memberships: resolved }, NOW), false);
});

test('a principal the directory does not hold is unmapped, not unavailable', async () => {
  const resolved = await createResolver(async () => {
    throw Object.assign(new Error('absent'), { code: 'directory-principal-absent' });
  }).resolve(workloadRequest());

  assert.equal(resolved.status, 'unmapped');
  assert.equal(isStrictMembershipEligible({ memberships: resolved }, NOW), false);
});

test('a reading carries a staleness budget that a claim does not need', async () => {
  const claimed = await createResolver(async () => [GROUP_ID]).resolve(workloadRequest({
    principalType: 'user',
    directoryGroups: [GROUP_ID],
  }));
  const read = await createResolver(async () => [GROUP_ID]).resolve(workloadRequest());

  // The claim is exactly as current as the authentication and is bounded by it; the
  // reading is an observation and expires on its own budget well before the credential.
  assert.equal(claimed.expiresAt, '2026-08-18T11:00:00.000Z');
  assert.ok(Date.parse(read.expiresAt) < Date.parse(claimed.expiresAt));
  assert.ok(read.maxAgeSeconds <= 3600);
});

test('a group identifier the directory returned unusable is refused, not carried', async () => {
  await assert.rejects(
    () => createResolver(async () => ['not a group id']).resolve(workloadRequest()),
    (error) => error.reasonCode === 'membership-claim-unusable',
  );
});

test('the evidence a workload produces builds a principal context the contract accepts', async () => {
  // Built through the real factory, because a hand-written context only encodes what I
  // already believe the shape to be.
  const factory = createPrincipalContextFactory({
    membershipResolver: createResolver(async () => [GROUP_ID]),
    clock: createFixedClock(NOW),
    idGenerator: createSequenceIdGenerator('directory-test'),
  });

  const context = await factory.create({
    source: 'entra-validated',
    validationId: 'validation-workload-001',
    validatedAt: '2026-08-18T09:55:00.000Z',
    credentialExpiresAt: '2026-08-18T11:00:00.000Z',
    validationState: 'validated',
    subject: { tenantId: TENANT_ID, subjectId: 'workload-agent-001', principalType: 'workload' },
    application: { applicationId: 'app-local-agent', authenticationFlow: 'application' },
    directoryGroups: [],
  });

  assert.equal(context.memberships.source, 'entra-adapter');
  assert.equal(isStrictMembershipEligible(context, NOW), true);
});

test('the query reads the collection the principal actually lives in', async () => {
  const seen = [];
  const query = createEntraGroupMembershipQuery({
    credential: { getToken: async () => ({ token: 'a-token' }) },
    transport: async (url) => {
      seen.push(url);
      return { value: [{ id: GROUP_ID }] };
    },
  });

  await query.readGroupIds({ principalType: 'workload', subjectId: 'sp-001' });
  await query.readGroupIds({ principalType: 'user', subjectId: 'user-001' });

  assert.match(seen[0], /\/servicePrincipals\/sp-001\/transitiveMemberOf\//);
  assert.match(seen[1], /\/users\/user-001\/transitiveMemberOf\//);
});

test('a membership too large to answer in one page is refused rather than truncated', async () => {
  const query = createEntraGroupMembershipQuery({
    credential: { getToken: async () => ({ token: 'a-token' }) },
    transport: async () => ({
      value: [{ id: GROUP_ID }],
      '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next',
    }),
  });

  await assert.rejects(
    () => query.readGroupIds({ principalType: 'workload', subjectId: 'sp-001' }),
    (error) => error.code === 'directory-membership-oversized',
  );
});

test('a credential that returns no token is a fault, not an empty membership', async () => {
  const query = createEntraGroupMembershipQuery({
    credential: { getToken: async () => ({}) },
    // The real transport asks for the token, so a fake that never did would prove
    // nothing about the guard.
    transport: async (url, { getToken }) => {
      await getToken();
      return { value: [] };
    },
  });

  await assert.rejects(
    () => query.readGroupIds({ principalType: 'workload', subjectId: 'sp-001' }),
    /returned no directory token/,
  );
});
