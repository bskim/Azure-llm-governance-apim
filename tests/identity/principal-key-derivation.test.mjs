import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DERIVATION_VERSION,
  assertCanonicalTeamKey,
  createPrincipalKeyDeriver,
  derivePrincipalIdentifiers,
} from '../../app/governance-domain/identity/principal-key-derivation.mjs';
import { assertEffectivePolicyDocument } from '../../app/governance-domain/policy/effective-policy-validator.mjs';

const SECRET = 'a'.repeat(32) + '-derivation-secret-for-tests';
const OTHER_SECRET = 'b'.repeat(32) + '-different-secret-for-tests';

const identity = Object.freeze({
  tenantId: 'tenant-0001',
  subjectId: 'subject-0001',
  applicationId: 'application-0001',
});

const principalContext = Object.freeze({
  subject: { tenantId: identity.tenantId, subjectId: identity.subjectId },
  application: { applicationId: identity.applicationId },
});

function deriver(secret = SECRET) {
  return createPrincipalKeyDeriver({ secret });
}

test('derivation is deterministic for the same identity and secret', () => {
  const first = deriver().derivePrincipalKey(identity);
  const second = deriver().derivePrincipalKey(identity);
  assert.equal(first, second);
});

test('a different secret produces a different pseudonym', () => {
  assert.notEqual(
    deriver().derivePrincipalKey(identity),
    deriver(OTHER_SECRET).derivePrincipalKey(identity),
  );
});

test('subject, application, and principal pseudonyms are distinct', () => {
  const d = deriver();
  const keys = new Set([
    d.deriveSubjectKey(identity),
    d.deriveApplicationKey(identity),
    d.derivePrincipalKey(identity),
  ]);
  assert.equal(keys.size, 3);
});

test('pseudonyms carry a version prefix so a rotation is visible', () => {
  const d = deriver();
  assert.match(d.deriveSubjectKey(identity), /^sk1-/);
  assert.match(d.deriveApplicationKey(identity), /^ak1-/);
  assert.match(d.derivePrincipalKey(identity), /^pk1-/);

  const rotated = createPrincipalKeyDeriver({ secret: SECRET, version: 2 });
  assert.notEqual(rotated.derivePrincipalKey(identity), d.derivePrincipalKey(identity));
});

test('administrator actors are domain-separated, versioned, stable, and non-identifying', () => {
  const d = deriver();
  const actor = d.deriveActorCode(identity);
  const anotherActor = d.deriveActorCode({ ...identity, subjectId: 'subject-0002' });

  assert.match(actor, /^actor1-[0-9a-f]{32}$/);
  assert.equal(actor, d.deriveActorCode(identity));
  assert.notEqual(actor, anotherActor);
  assert.notEqual(actor, d.deriveSubjectKey(identity));
  for (const raw of [identity.tenantId, identity.subjectId, SECRET]) {
    assert.equal(actor.includes(raw), false);
  }
});

test('distinct identities cannot collide through concatenation', () => {
  const d = deriver();
  // Without length prefixing these two tuples would encode to the same message.
  const left = d.derivePrincipalKey({
    tenantId: 'tenant-a',
    subjectId: 'bb',
    applicationId: 'app',
  });
  const right = d.derivePrincipalKey({
    tenantId: 'tenant-ab',
    subjectId: 'b',
    applicationId: 'app',
  });
  assert.notEqual(left, right);
});

test('pseudonyms match the contract pattern accepted by the policy document', () => {
  const d = deriver();
  for (const value of [
    d.deriveSubjectKey(identity),
    d.deriveApplicationKey(identity),
    d.derivePrincipalKey(identity),
  ]) {
    assert.match(value, /^[A-Za-z0-9._-]{16,128}$/);
  }
});

test('a pseudonym reveals no raw identifier', () => {
  const d = deriver();
  const value = d.derivePrincipalKey(identity);
  for (const raw of Object.values(identity)) {
    assert.equal(value.includes(raw), false);
  }
  assert.equal(value.includes(SECRET), false);
});

test('weak or placeholder secrets are refused', () => {
  for (const secret of [undefined, '', 'short', 'changeme', '   Placeholder   ', 'x'.repeat(31)]) {
    assert.throws(() => createPrincipalKeyDeriver({ secret }), TypeError, String(secret));
  }
});

test('malformed identity components are refused', () => {
  const d = deriver();
  for (const bad of [undefined, '', 'has space', 'has|pipe', 'x'.repeat(129)]) {
    assert.throws(() => d.derivePrincipalKey({ ...identity, subjectId: bad }), TypeError);
  }
});

test('a known identity can be confirmed against a pseudonym', () => {
  const d = deriver();
  const subjectKey = d.deriveSubjectKey(identity);
  assert.equal(d.matchesSubject(subjectKey, identity), true);
  assert.equal(d.matchesSubject(subjectKey, { ...identity, subjectId: 'subject-0002' }), false);
  assert.equal(d.matchesSubject('sk1-short', identity), false);
  assert.equal(d.matchesSubject(undefined, identity), false);
});

test('team keys stay canonical rather than pseudonymous', () => {
  assert.equal(assertCanonicalTeamKey('team-platform'), 'team-platform');
  for (const bad of ['Team-Platform', 'team platform', 't', 'team_platform', 42]) {
    assert.throws(() => assertCanonicalTeamKey(bad), TypeError, String(bad));
  }
});

test('the identifier set binds the scope group to the canonical team', () => {
  const identifiers = derivePrincipalIdentifiers(deriver(), {
    principalContext,
    canonicalTeamKey: 'team-platform',
  });

  assert.equal(identifiers.derivationVersion, DERIVATION_VERSION);
  assert.equal(identifiers.teamKey, 'team-platform');
  assert.equal(identifiers.scopeGroupId, 'team-platform');
  assert.match(identifiers.principalKey, /^pk1-/);
  assert.equal(Object.isFrozen(identifiers), true);
});

test('the identifier set requires a complete principal context and a team', () => {
  const d = deriver();
  assert.throws(() => derivePrincipalIdentifiers(d, { principalContext }), TypeError, 'no team');
  assert.throws(
    () => derivePrincipalIdentifiers(d, { canonicalTeamKey: 'team-platform' }),
    TypeError,
    'no context',
  );
  assert.throws(
    () =>
      derivePrincipalIdentifiers(d, {
        principalContext: { subject: principalContext.subject },
        canonicalTeamKey: 'team-platform',
      }),
    TypeError,
    'no application',
  );
});

test('derived identifiers satisfy the effective policy document contract', () => {
  const identifiers = derivePrincipalIdentifiers(deriver(), {
    principalContext,
    canonicalTeamKey: 'team-platform',
  });

  const document = {
    contractVersion: 'v1',
    documentType: 'effective-policy',
    id: `effective-policy|${identifiers.scopeGroupId}|${identifiers.principalKey}`,
    scopeGroupId: identifiers.scopeGroupId,
    principalKey: identifiers.principalKey,
    configVersion: 1,
    resolution: 'resolved',
    resolvedAt: '2026-08-04T00:00:00.000Z',
    expiresAt: '2026-08-04T00:01:00.000Z',
    attribution: {
      subjectKey: identifiers.subjectKey,
      applicationKey: identifiers.applicationKey,
      teamKey: identifiers.teamKey,
    },
    allowedModels: ['model-mini'],
    modelDeployments: [{ modelKey: 'model-mini', providerDeploymentName: 'deployment-mini' }],
    limits: [
      {
        scope: 'organization',
        modelScope: 'all-models',
        tokenQuota: 1000,
        quotaPeriod: 'Monthly',
      },
    ],
    fallback: { enabled: false, maxDepth: 1, chain: [] },
  };

  assert.equal(assertEffectivePolicyDocument(document), true);
});
