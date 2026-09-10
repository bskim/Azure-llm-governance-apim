import { assertPrincipalContextV1 } from './principal-context-validator.mjs';

const VERIFIED_IDENTITY_KEYS = new Set([
  'source',
  'validationId',
  'validatedAt',
  'credentialExpiresAt',
  'validationState',
  'subject',
  'application',
]);
// Optional because only a gateway reporting a credential that carries group claims can
// supply it. A resolver that needs it refuses when it is absent rather than assuming.
const OPTIONAL_VERIFIED_IDENTITY_KEYS = new Set(['directoryGroups']);

function clone(value) {
  return structuredClone(value);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

function assertVerifiedIdentityShape(identity) {
  if (identity === null || typeof identity !== 'object' || Array.isArray(identity)) {
    throw new TypeError('Verified identity must be an object.');
  }
  for (const key of VERIFIED_IDENTITY_KEYS) {
    if (!Object.hasOwn(identity, key)) {
      throw new TypeError(`Verified identity is missing ${key}.`);
    }
  }
  for (const key of Object.keys(identity)) {
    if (!VERIFIED_IDENTITY_KEYS.has(key) && !OPTIONAL_VERIFIED_IDENTITY_KEYS.has(key)) {
      throw new TypeError(`Verified identity field ${key} is not allowed.`);
    }
  }
}

export function createPrincipalContextFactory({ membershipResolver, clock, idGenerator }) {
  if (typeof membershipResolver?.resolve !== 'function') {
    throw new TypeError('membershipResolver.resolve is required.');
  }
  if (typeof clock?.nowIso !== 'function') {
    throw new TypeError('clock.nowIso is required.');
  }
  if (typeof idGenerator?.next !== 'function') {
    throw new TypeError('idGenerator.next is required.');
  }

  return Object.freeze({
    async create(verifiedIdentity) {
      assertVerifiedIdentityShape(verifiedIdentity);
      const identity = clone(verifiedIdentity);
      const membership = await membershipResolver.resolve({
        tenantId: identity.subject.tenantId,
        subjectId: identity.subject.subjectId,
        principalType: identity.subject.principalType,
        directoryGroups: identity.directoryGroups,
        credentialExpiresAt: identity.credentialExpiresAt,
      });
      const evaluationTime = clock.nowIso();
      const context = {
        contractVersion: 'v1',
        trust: {
          source: identity.source,
          validationId: identity.validationId,
          validatedAt: identity.validatedAt,
          credentialExpiresAt: identity.credentialExpiresAt,
          validationState: identity.validationState,
          callerSupplied: false,
        },
        subject: clone(identity.subject),
        application: clone(identity.application),
        memberships: clone(membership),
        correlation: {
          source: 'server-generated',
          requestId: idGenerator.next(),
          attempt: 1,
        },
      };

      assertPrincipalContextV1(context, { evaluationTime });
      return deepFreeze(context);
    },
  });
}