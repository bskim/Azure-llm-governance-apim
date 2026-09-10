import { createHmac, timingSafeEqual } from 'node:crypto';

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const CANONICAL_TEAM_KEY = /^[a-z][a-z0-9-]{1,62}$/;
const MIN_SECRET_BYTES = 32;
const PLACEHOLDER_SECRETS = new Set([
  'changeme',
  'change-me',
  'placeholder',
  'secret',
  'password',
  'development',
  'test',
]);
const UNRESOLVED_REFERENCE = /^@(Microsoft\.KeyVault|AppConfigRef)\(/i;

export const DERIVATION_VERSION = 1;

const PREFIXES = Object.freeze({
  subject: 'sk1',
  application: 'ak1',
  principal: 'pk1',
  actor: 'actor',
});

function fail(message) {
  throw new TypeError(message);
}

function assertSafeId(value, path) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    fail(`${path} must be a bounded safe identifier.`);
  }
}

/**
 * Length prefixing keeps concatenated inputs unambiguous, so no two distinct
 * identifier tuples can produce the same message.
 */
function encodeSegments(segments) {
  return segments.map((segment) => `${segment.length}:${segment}`).join('|');
}

function assertUsableSecret(secret) {
  if (typeof secret !== 'string' || secret.length === 0) {
    fail('A derivation secret is required.');
  }
  if (Buffer.byteLength(secret, 'utf8') < MIN_SECRET_BYTES) {
    fail(`The derivation secret must be at least ${MIN_SECRET_BYTES} bytes.`);
  }
  if (PLACEHOLDER_SECRETS.has(secret.trim().toLowerCase())) {
    fail('The derivation secret must not be a placeholder value.');
  }
  // A configuration reference that failed to resolve arrives as its own text, which is
  // long enough and unusual enough to pass every check above while being public.
  if (UNRESOLVED_REFERENCE.test(secret)) {
    fail('The derivation secret is an unresolved configuration reference, not a secret.');
  }
}

export function createPrincipalKeyDeriver({ secret, version = DERIVATION_VERSION } = {}) {
  assertUsableSecret(secret);
  if (!Number.isSafeInteger(version) || version < 1) {
    fail('The derivation version must be a positive integer.');
  }

  const key = Buffer.from(secret, 'utf8');

  function pseudonym(prefix, segments) {
    const message = encodeSegments([`v${version}`, prefix, ...segments]);
    const digest = createHmac('sha256', key).update(message, 'utf8').digest('base64url');
    return `${prefix}-${digest}`;
  }

  return Object.freeze({
    version,

    deriveSubjectKey({ tenantId, subjectId }) {
      assertSafeId(tenantId, 'tenantId');
      assertSafeId(subjectId, 'subjectId');
      return pseudonym(PREFIXES.subject, [tenantId, subjectId]);
    },

    deriveApplicationKey({ tenantId, applicationId }) {
      assertSafeId(tenantId, 'tenantId');
      assertSafeId(applicationId, 'applicationId');
      return pseudonym(PREFIXES.application, [tenantId, applicationId]);
    },

    /** Identifies the caller pair that one effective policy document applies to. */
    derivePrincipalKey({ tenantId, subjectId, applicationId }) {
      assertSafeId(tenantId, 'tenantId');
      assertSafeId(subjectId, 'subjectId');
      assertSafeId(applicationId, 'applicationId');
      return pseudonym(PREFIXES.principal, [tenantId, subjectId, applicationId]);
    },

    /**
     * Names who acted, for records whose alphabet is narrower than a pseudonym's.
     * Hex rather than base64url because those records accept lower case only.
     */
    deriveActorCode({ tenantId, subjectId }) {
      assertSafeId(tenantId, 'tenantId');
      assertSafeId(subjectId, 'subjectId');
      const message = encodeSegments([`v${version}`, PREFIXES.actor, tenantId, subjectId]);
      const digest = createHmac('sha256', key).update(message, 'utf8').digest('hex');
      return `${PREFIXES.actor}${version}-${digest.slice(0, 32)}`;
    },

    /** Confirms a pseudonym belongs to a known identity without exposing the secret. */
    matchesSubject(candidate, identity) {
      if (typeof candidate !== 'string') return false;
      const expected = this.deriveSubjectKey(identity);
      if (candidate.length !== expected.length) return false;
      return timingSafeEqual(Buffer.from(candidate, 'utf8'), Buffer.from(expected, 'utf8'));
    },
  });
}

/**
 * Team is an organizational grouping rather than a personal identifier. It stays
 * canonical so it can be read in dashboards and used as a partition key, while
 * subject and application are always pseudonymous.
 */
export function assertCanonicalTeamKey(teamKey) {
  if (typeof teamKey !== 'string' || !CANONICAL_TEAM_KEY.test(teamKey)) {
    fail('teamKey must be a canonical lowercase team key.');
  }
  return teamKey;
}

export function derivePrincipalIdentifiers(
  deriver,
  { principalContext, canonicalTeamKey = null, scopeGroupId = canonicalTeamKey } = {},
) {
  if (deriver === null || typeof deriver !== 'object') {
    fail('deriver is required.');
  }
  if (principalContext === null || typeof principalContext !== 'object') {
    fail('principalContext is required.');
  }

  const { subject, application } = principalContext;
  if (subject === null || typeof subject !== 'object') fail('principalContext.subject is required.');
  if (application === null || typeof application !== 'object') {
    fail('principalContext.application is required.');
  }

  const { tenantId, subjectId } = subject;
  const { applicationId } = application;
  if (canonicalTeamKey !== null) assertCanonicalTeamKey(canonicalTeamKey);
  assertCanonicalTeamKey(scopeGroupId);

  const identifiers = Object.freeze({
    derivationVersion: deriver.version,
    subjectKey: deriver.deriveSubjectKey({ tenantId, subjectId }),
    applicationKey: deriver.deriveApplicationKey({ tenantId, applicationId }),
    principalKey: deriver.derivePrincipalKey({ tenantId, subjectId, applicationId }),
    teamKey: canonicalTeamKey,
    scopeGroupId,
  });

  for (const [name, value] of Object.entries(identifiers)) {
    if (typeof value !== 'string') continue;
    if (value.includes(tenantId) || value.includes(subjectId) || value.includes(applicationId)) {
      if (name !== 'teamKey' && name !== 'scopeGroupId') {
        fail(`${name} must not contain a raw organizational identifier.`);
      }
    }
  }

  return identifiers;
}
