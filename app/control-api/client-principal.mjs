/**
 * Reads the caller identity the platform established.
 *
 * Built-in authentication validates the token's signature, issuer, and audience
 * before a request reaches this code, then forwards the resulting claims in a
 * header. Nothing here re-implements that validation; it reads the outcome and
 * refuses anything it cannot read, so a missing platform means no caller rather
 * than an anonymous one.
 */

const PRINCIPAL_HEADER = 'x-ms-client-principal';

export class UnauthenticatedCallerError extends Error {
  constructor(reasonCode) {
    super('caller-not-authenticated');
    this.name = 'UnauthenticatedCallerError';
    this.code = 'caller-not-authenticated';
    this.reasonCode = reasonCode;
  }
}

function decode(header) {
  try {
    return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    throw new UnauthenticatedCallerError('principal-unreadable');
  }
}

function collect(claims, type) {
  return claims.filter((claim) => claim?.typ === type).map((claim) => claim.val);
}

// A platform may forward a claim under its short name or under the identity-model
// URI, and roles already anticipate that. Tenant and subject did not, so a caller
// arrived with roles the product could read and an identity it could not.
const TENANT_CLAIMS = Object.freeze(['tid', 'http://schemas.microsoft.com/identity/claims/tenantid']);
const OBJECT_CLAIMS = Object.freeze([
  'oid',
  'http://schemas.microsoft.com/identity/claims/objectidentifier',
  'sub',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier',
]);
const SUBJECT_CLAIMS = Object.freeze([
  'sub',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier',
]);
const APPLICATION_CLAIMS = Object.freeze(['azp', 'appid']);
const SCOPE_CLAIMS = Object.freeze(['scp', 'http://schemas.microsoft.com/identity/claims/scope']);

function unambiguous(claims, types) {
  const values = types.flatMap((type) => collect(claims, type));
  if (values.some((value) => typeof value !== 'string' || value.length === 0)) return null;
  const distinct = [...new Set(values)];
  return distinct.length === 1 ? distinct[0] : null;
}

function authenticationFlow(claims, roles) {
  const scopes = SCOPE_CLAIMS.flatMap((type) => collect(claims, type));
  const identityTypes = collect(claims, 'idtyp');
  if (identityTypes.some((value) => !['app', 'user'].includes(value))) return null;
  if (new Set(identityTypes).size > 1) return null;
  if (scopes.length > 0) {
    if (identityTypes.includes('app') || scopes.some((scope) => typeof scope !== 'string' || !scope.trim())) return null;
    return 'delegated';
  }
  if (identityTypes.includes('user')) return null;
  return roles.length > 0 ? 'application' : null;
}

function first(claims, types) {
  for (const type of types) {
    const [value] = collect(claims, type);
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/**
 * @param expectedAudience The resource this endpoint is. A token minted for any
 *   other resource is refused even when the platform accepted it, so one app
 *   hosting two resources cannot let a caller cross between them.
 * @param rolesClaim Where this provider puts roles. Identity providers disagree, so
 *   a deployment may name the claim rather than depend on one vendor's convention.
 */
export function readVerifiedCaller({ headers, expectedAudience, rolesClaim }) {
  if (typeof expectedAudience !== 'string' || expectedAudience.length === 0) {
    throw new TypeError('expectedAudience is required.');
  }

  const header = typeof headers?.get === 'function' ? headers.get(PRINCIPAL_HEADER) : headers?.[PRINCIPAL_HEADER];
  if (!header) throw new UnauthenticatedCallerError('principal-absent');

  const principal = decode(header);
  const claims = Array.isArray(principal?.claims) ? principal.claims : null;
  if (claims === null) throw new UnauthenticatedCallerError('principal-unreadable');

  if (!collect(claims, 'aud').includes(expectedAudience)) {
    throw new UnauthenticatedCallerError('audience-not-accepted');
  }

  const reportedRoleType = typeof principal.role_typ === 'string' && principal.role_typ.length > 0
    ? principal.role_typ
    : 'roles';
  // A configured claim wins, then whichever the platform reported, then the common
  // default. Each is read, because a provider may populate more than one.
  const roleTypes = new Set([rolesClaim, reportedRoleType, 'roles'].filter(Boolean));
  const groups = claims.some((claim) => claim?.typ === 'groups')
    ? Object.freeze([...new Set(collect(claims, 'groups'))].sort())
    : undefined;
  const roles = Object.freeze(
    [...new Set([...roleTypes].flatMap((type) => collect(claims, type)))].sort(),
  );

  return Object.freeze({
    tenantId: first(claims, TENANT_CLAIMS),
    objectId: first(claims, OBJECT_CLAIMS),
    subjectId: unambiguous(claims, SUBJECT_CLAIMS),
    applicationId: unambiguous(claims, APPLICATION_CLAIMS),
    authenticationFlow: authenticationFlow(claims, roles),
    groups,
    roles,
  });
}
