/**
 * Maps identity provider roles onto governance permissions.
 *
 * Governance has exactly two capabilities to separate: changing budgets, entitlements,
 * and configuration, and reading what they did. Which claim values mean which of the
 * two is deployment configuration, because not every organization signs in with
 * Microsoft Entra and a product that hard-codes one provider's role names cannot be
 * deployed anywhere else.
 *
 * Authorization is decided from the roles the platform placed in the validated token
 * and from nothing the caller can influence. A caller who matches neither is refused
 * outright: an ordinary gateway user calls models, and administration is not a lesser
 * version of that, it is a different resource.
 */

export const GOVERNANCE_ROLES = Object.freeze({
  // Separation of duties is the rule, and an organization with one administrator still
  // has to be able to publish. The exception is a capability rather than a special case
  // in the reducer, so who holds it is deployment configuration and every use of it is
  // recorded as its own reason rather than as an ordinary approval.
  own: Object.freeze({
    readScopes: Object.freeze(['self', 'team', 'global']),
    capabilities: Object.freeze([
      'read-governance',
      'write-budgets',
      'write-entitlements',
      'publish-configuration',
      'write-notification-channel',
      'approve-own-configuration',
    ]),
  }),
  administer: Object.freeze({
    readScopes: Object.freeze(['self', 'team', 'global']),
    capabilities: Object.freeze([
      'read-governance',
      'write-budgets',
      'write-entitlements',
      'publish-configuration',
      'write-notification-channel',
    ]),
  }),
  read: Object.freeze({
    readScopes: Object.freeze(['self', 'team', 'global']),
    capabilities: Object.freeze(['read-governance']),
  }),
});

/** Claim values for the governance roles. Microsoft Entra is given only the administer and
 * read roles, so `Governance.Own` reaches nobody unless an operator adds that role. */
export const ENTRA_ROLE_MAPPING = Object.freeze({
  own: Object.freeze(['Governance.Own']),
  administer: Object.freeze(['Governance.Administer']),
  read: Object.freeze(['Governance.Read']),
});

const SCOPE_ORDER = Object.freeze(['self', 'team', 'global']);

/** Roles a deployment may leave unmapped, granting them to nobody. */
const OPTIONAL_ROLES = Object.freeze(['own']);

export class GovernanceAccessDeniedError extends Error {
  constructor(reasonCode) {
    super('governance-access-denied');
    this.name = 'GovernanceAccessDeniedError';
    this.code = 'governance-access-denied';
    this.reasonCode = reasonCode;
  }
}

function fail(message) {
  throw new TypeError(message);
}

/**
 * A mapping is validated rather than trusted, because a deployment that silently
 * granted nothing would look like a working system until the first administrator
 * tried to sign in.
 */
export function assertRoleMapping(mapping) {
  if (mapping === null || typeof mapping !== 'object' || Array.isArray(mapping)) {
    fail('roleMapping must be an object.');
  }
  const seen = new Map();
  for (const governanceRole of Object.keys(GOVERNANCE_ROLES)) {
    const values = mapping[governanceRole];
    // The owner role is the one exception a deployment opts into. Leaving it unmapped
    // means nobody can approve their own change, which is the stricter posture, so its
    // absence is a choice rather than a misconfiguration.
    if (values === undefined && OPTIONAL_ROLES.includes(governanceRole)) continue;
    if (!Array.isArray(values) || values.length === 0) {
      fail(`roleMapping.${governanceRole} must name at least one claim value.`);
    }
    for (const value of values) {
      if (typeof value !== 'string' || value.length === 0) {
        fail(`roleMapping.${governanceRole} values must be non-empty strings.`);
      }
      // One claim value meaning two different governance roles is a configuration
      // mistake, not a union a deployment intended.
      if (seen.has(value) && seen.get(value) !== governanceRole) {
        fail(`roleMapping value '${value}' is claimed by more than one governance role.`);
      }
      seen.set(value, governanceRole);
    }
  }
  return mapping;
}

/**
 * @param roles The roles claim of a validated access token. Values the mapping does
 *   not name are ignored rather than rejected, so adding a role at the provider
 *   cannot lock out callers that already hold a mapped one.
 */
export function authorizeGovernanceAccess({
  roles,
  knownTeamKeys = [],
  roleMapping = ENTRA_ROLE_MAPPING,
} = {}) {
  if (roles !== undefined && !Array.isArray(roles)) fail('roles must be an array when present.');
  if (!Array.isArray(knownTeamKeys)) fail('knownTeamKeys must be an array.');
  assertRoleMapping(roleMapping);

  const byValue = new Map();
  for (const [governanceRole, values] of Object.entries(roleMapping)) {
    for (const value of values) byValue.set(value, governanceRole);
  }

  const granted = (roles ?? []).filter((role) => byValue.has(role));
  if (granted.length === 0) {
    throw new GovernanceAccessDeniedError(
      (roles ?? []).length === 0 ? 'no-governance-role' : 'governance-role-not-recognized',
    );
  }

  const scopes = new Set();
  const capabilities = new Set();
  const governanceRoles = new Set();
  for (const role of granted) {
    const governanceRole = byValue.get(role);
    governanceRoles.add(governanceRole);
    for (const scope of GOVERNANCE_ROLES[governanceRole].readScopes) scopes.add(scope);
    for (const capability of GOVERNANCE_ROLES[governanceRole].capabilities) capabilities.add(capability);
  }

  return Object.freeze({
    contractVersion: 'v1',
    // A role the provider placed in a validated token is authoritative evidence.
    readAuthority: 'authoritative',
    permittedReadScopes: Object.freeze(SCOPE_ORDER.filter((scope) => scopes.has(scope))),
    permittedTeamKeys: Object.freeze([...new Set(knownTeamKeys)].sort()),
    capabilities: Object.freeze([...capabilities].sort()),
    governanceRoles: Object.freeze([...governanceRoles].sort()),
    grantedRoles: Object.freeze([...granted].sort()),
  });
}

/** Write paths ask for the capability by name so a read token cannot reach them. */
export function assertGovernanceCapability(authorization, capability) {
  if (!Array.isArray(authorization?.capabilities) || !authorization.capabilities.includes(capability)) {
    const error = new Error('governance-capability-denied');
    error.code = 'governance-capability-denied';
    error.reasonCode = capability;
    throw error;
  }
}

/**
 * Reads a mapping from deployment configuration. Absent means the Entra role names
 * this repository provisions, which keeps the common case free of configuration.
 */
export function readRoleMapping(environment = process.env) {
  const configured = environment.GOVERNANCE_ROLE_MAPPING;
  if (!configured) return ENTRA_ROLE_MAPPING;

  let parsed;
  try {
    parsed = JSON.parse(configured);
  } catch {
    fail('GOVERNANCE_ROLE_MAPPING must be JSON.');
  }
  const mapping = Object.freeze({
    administer: Object.freeze([...(parsed?.administer ?? [])]),
    read: Object.freeze([...(parsed?.read ?? [])]),
  });
  return assertRoleMapping(mapping);
}
