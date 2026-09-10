import assert from 'node:assert/strict';
import test from 'node:test';

import { createTokenClaimsMembershipResolver } from '../../app/control-api/token-claims-membership-resolver.mjs';
import { assertMembershipEvidence } from '../../app/governance-domain/principal-context/principal-context-validator.mjs';
import { createFixedClock } from '../../app/local-adapters/deterministic-time.mjs';

const NOW = '2026-08-14T10:00:00.000Z';
const SUBJECT = Object.freeze({ tenantId: 'tenant-a', subjectId: 'subject-a', principalType: 'user' });
const CREDENTIAL_EXPIRES_AT = '2026-08-14T11:30:00.000Z';

function resolverAt(now = NOW) {
  return createTokenClaimsMembershipResolver({ clock: createFixedClock(now) });
}

function validate(memberships, credentialExpiresAt = CREDENTIAL_EXPIRES_AT) {
  assertMembershipEvidence(memberships, {
    subject: SUBJECT,
    evaluationTime: NOW,
    credentialExpiresAt,
  });
}

test('a group claim is an answer, so it resolves complete and validates', async () => {
  const memberships = await resolverAt().resolve({
    ...SUBJECT,
    directoryGroups: ['group-b', 'group-a', 'group-b'],
    credentialExpiresAt: CREDENTIAL_EXPIRES_AT,
  });

  assert.equal(memberships.status, 'complete');
  assert.equal(memberships.source, 'directory-claim');
  assert.deepEqual(memberships.groups.map((group) => group.groupId), ['group-a', 'group-b']);
  assert.ok(memberships.groups.every((group) => group.authorizationRelevant));
  validate(memberships);
});

test('evidence from a claim lives exactly as long as the credential, past the cached ceiling', async () => {
  // Ninety minutes is a lifetime the identity provider issues routinely and is beyond
  // the one-hour budget that governs cached evidence, so a shared ceiling would have
  // refused a token that had just been issued.
  const memberships = await resolverAt().resolve({
    ...SUBJECT,
    directoryGroups: [],
    credentialExpiresAt: CREDENTIAL_EXPIRES_AT,
  });

  assert.equal(memberships.expiresAt, CREDENTIAL_EXPIRES_AT);
  assert.equal(memberships.maxAgeSeconds, 5400);
  validate({ ...memberships, groups: [{ groupId: 'group-a', membership: 'direct', authorizationRelevant: true }], status: 'complete' });
});

test('a claim may not be trusted beyond the credential that asserted it', () => {
  const overreaching = {
    snapshotId: 'membership-claim-subject-a',
    status: 'empty-complete',
    source: 'directory-claim',
    tenantId: SUBJECT.tenantId,
    subjectId: SUBJECT.subjectId,
    resolvedAt: NOW,
    expiresAt: '2026-08-14T12:00:00.000Z',
    maxAgeSeconds: 7200,
    sourceRevision: 'entra-group-claim',
    groups: [],
  };

  assert.throws(() => validate(overreaching), RangeError);
  // And the credential is not optional for this source: omitting it is not permission.
  assert.throws(
    () => assertMembershipEvidence(
      { ...overreaching, expiresAt: CREDENTIAL_EXPIRES_AT, maxAgeSeconds: 5400 },
      { subject: SUBJECT, evaluationTime: NOW },
    ),
    TypeError,
  );
});

test('cached evidence keeps its one-hour ceiling', () => {
  const cached = {
    snapshotId: 'membership-cached',
    status: 'empty-complete',
    source: 'control-plane',
    tenantId: SUBJECT.tenantId,
    subjectId: SUBJECT.subjectId,
    resolvedAt: NOW,
    expiresAt: CREDENTIAL_EXPIRES_AT,
    maxAgeSeconds: 5400,
    sourceRevision: 'directory-001',
    groups: [],
  };

  assert.throws(() => validate(cached), TypeError);
});

test('a forwarded group list is required, and an empty one is not the same as none', async () => {
  // A caller assigned to the application directly rather than through a group has no
  // groups and is still admitted, so an empty list must be an answer. A gateway that
  // forwarded nothing has said nothing, and must not be read as that answer.
  const noGroups = await resolverAt().resolve({
    ...SUBJECT,
    directoryGroups: [],
    credentialExpiresAt: CREDENTIAL_EXPIRES_AT,
  });
  assert.equal(noGroups.status, 'empty-complete');
  assert.deepEqual(noGroups.groups, []);
  validate(noGroups);

  await assert.rejects(
    resolverAt().resolve({ ...SUBJECT, credentialExpiresAt: CREDENTIAL_EXPIRES_AT }),
    TypeError,
  );
  await assert.rejects(
    resolverAt().resolve({ ...SUBJECT, directoryGroups: [] }),
    TypeError,
  );
});

test('an unusable group identifier is refused rather than carried into governance', async () => {
  await assert.rejects(
    resolverAt().resolve({
      ...SUBJECT,
      directoryGroups: ['a group with spaces'],
      credentialExpiresAt: CREDENTIAL_EXPIRES_AT,
    }),
    (error) => error.reasonCode === 'membership-claim-unusable',
  );
});
