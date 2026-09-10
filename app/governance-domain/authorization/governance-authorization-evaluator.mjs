import {
  assertPrincipalContextV1,
  isStrictMembershipEligible,
} from '../principal-context/principal-context-validator.mjs';
import {
  GOVERNANCE_ROLE_READ_SCOPES,
  assertEntitlementPolicySnapshotV1,
  assertGovernanceAssignmentSnapshotV1,
  getSnapshotAuthorityReason,
} from './governance-authorization-validator.mjs';

function isActiveAt(record, evaluationTime) {
  if (record.state !== 'active') return false;
  const now = Date.parse(evaluationTime);
  const validFrom = Date.parse(record.validFrom);
  const validUntil = record.validUntil === null ? Number.POSITIVE_INFINITY : Date.parse(record.validUntil);
  return Number.isFinite(validFrom) && validFrom <= now && validUntil > now;
}

function assignmentMatches(assignment, principalContext) {
  if (assignment.assignee.kind === 'subject') {
    return assignment.assignee.key === principalContext.subject.subjectId;
  }
  if (assignment.assignee.kind === 'application') {
    return assignment.assignee.key === principalContext.application.applicationId;
  }
  if (assignment.assignee.kind === 'group') {
    return principalContext.memberships.groups.some(
      (group) => group.authorizationRelevant && group.groupId === assignment.assignee.key,
    );
  }
  return false;
}

function getMatchingRoleAssignments(principalContext, snapshot, evaluationTime) {
  return snapshot.assignments
    .filter((assignment) => isActiveAt(assignment, evaluationTime))
    .filter((assignment) => assignmentMatches(assignment, principalContext));
}

function validateTeamRoleAssignments(assignments, teamByGroup) {
  const knownTeams = new Set(teamByGroup.values());
  for (const assignment of assignments) {
    if (assignment.scope.kind === 'team' && !knownTeams.has(assignment.scope.key)) {
      throw new TypeError('Role assignment references an unknown team.');
    }
    if (assignment.assignee.kind === 'group' && assignment.scope.kind === 'team') {
      if (teamByGroup.get(assignment.assignee.key) !== assignment.scope.key) {
        throw new TypeError('Group role assignment does not match its team mapping.');
      }
    }
  }
  return assignments;
}

function bindingMatches(binding, principalContext, teamKeys) {
  if (binding.target.kind === 'global') return true;
  if (binding.target.kind === 'team') return teamKeys.has(binding.target.key);
  if (binding.target.kind === 'subject') {
    return binding.target.key === principalContext.subject.subjectId;
  }
  if (binding.target.kind === 'application') {
    return binding.target.key === principalContext.application.applicationId;
  }
  return false;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function resolveReadScopes(assignments) {
  if (assignments.length === 0) return [];
  const scopes = new Set(['self']);
  for (const assignment of assignments) {
    const maximumScopes = GOVERNANCE_ROLE_READ_SCOPES[assignment.roleCode] ?? [];
    if (assignment.scope.kind === 'global') {
      for (const scope of maximumScopes) scopes.add(scope);
    } else if (maximumScopes.includes('team')) {
      scopes.add('team');
    }
  }
  return ['self', 'team', 'global'].filter((scope) => scopes.has(scope));
}

function resolveTeamKeys(assignments, knownTeamKeys = []) {
  if (assignments.some((assignment) => assignment.scope.kind === 'global')) {
    return [...new Set(knownTeamKeys)].sort();
  }
  return [...new Set(
    assignments
      .filter((assignment) => assignment.scope.kind === 'team')
      .map((assignment) => assignment.scope.key),
  )].sort();
}

function projectAssignments(assignments) {
  return assignments.map((assignment) => ({
    assignmentId: assignment.assignmentId,
    assignmentVersion: assignment.assignmentVersion,
    roleCode: assignment.roleCode,
    scopeKind: assignment.scope.kind,
    scopeKey: assignment.scope.key,
  }));
}

function projectBindings(bindings) {
  return bindings.map((binding) => ({
    bindingId: binding.bindingId,
    bindingVersion: binding.bindingVersion,
    targetKind: binding.target.kind,
    targetKey: binding.target.key,
  }));
}

function resolveModelAllowlist(bindings) {
  const organization = bindings.filter((binding) => binding.target.kind === 'global');
  if (organization.length === 0) return [];
  const ceiling = new Set(
    organization[0].modelAllowlist.filter((model) =>
      organization.every((binding) => binding.modelAllowlist.includes(model))),
  );
  const grants = bindings.filter((binding) => binding.target.kind !== 'global');
  if (grants.length === 0) return [...ceiling].sort();
  return [...new Set(grants.flatMap((binding) => binding.modelAllowlist))]
    .filter((model) => ceiling.has(model))
    .sort();
}

function minimumLimit(bindings, name) {
  const values = bindings
    .map((binding) => binding.limits[name])
    .filter((value) => value !== undefined);
  return values.length === 0 ? null : Math.min(...values);
}

export function evaluateEffectiveEntitlementBindings(bindings) {
  if (!Array.isArray(bindings) || bindings.length === 0) {
    return deepFreeze({
      decision: 'unavailable',
      reasonCode: 'required-policy-unavailable',
      modelAllowlist: [],
      limits: { requestsPerMinute: null, tokensPerMinute: null },
    });
  }
  const modelAllowlist = resolveModelAllowlist(bindings);
  const decision = modelAllowlist.length === 0 ? 'deny' : 'allow';
  return deepFreeze({
    decision,
    reasonCode: decision === 'allow' ? 'most-restrictive-policy' : 'model-intersection-empty',
    modelAllowlist,
    limits: decision === 'allow'
      ? {
          requestsPerMinute: minimumLimit(bindings, 'requestsPerMinute'),
          tokensPerMinute: minimumLimit(bindings, 'tokensPerMinute'),
        }
      : { requestsPerMinute: null, tokensPerMinute: null },
  });
}

function snapshotEvidence(principalContext, assignmentSnapshot, entitlementSnapshot, evaluationTime) {
  return {
    assignmentSnapshotId: assignmentSnapshot.snapshotId,
    assignmentSnapshotVersion: assignmentSnapshot.version,
    entitlementSnapshotId: entitlementSnapshot.snapshotId,
    entitlementSnapshotVersion: entitlementSnapshot.version,
    membershipSnapshotId: principalContext.memberships.snapshotId,
    evaluationTime,
  };
}

function unavailableDecision({
  principalContext,
  assignmentSnapshot,
  entitlementSnapshot,
  evaluationTime,
  reasonCode,
  roleAssignments = [],
  defaultEndUser = false,
  knownTeamKeys = [],
}) {
  const effectiveRoles = roleAssignments.length === 0
    ? defaultEndUser ? ['end-user'] : []
    : [...new Set(roleAssignments.map((assignment) => assignment.roleCode))].sort();
  return deepFreeze({
    contractVersion: 'v1',
    decision: 'unavailable',
    // Whether the caller is known is a different question from whether their model
    // entitlement resolved, and a reader must not be refused for the latter.
    readAuthority: defaultEndUser || roleAssignments.length > 0 ? 'authoritative' : 'unavailable',
    reasonCode,
    effectiveRoles,
    permittedReadScopes: resolveReadScopes(roleAssignments),
    permittedTeamKeys: resolveTeamKeys(roleAssignments, knownTeamKeys),
    modelAllowlist: [],
    limits: { requestsPerMinute: null, tokensPerMinute: null },
    appliedAssignments: projectAssignments(roleAssignments),
    appliedBindings: [],
    ...snapshotEvidence(
      principalContext,
      assignmentSnapshot,
      entitlementSnapshot,
      evaluationTime,
    ),
  });
}

const MEMBERSHIP_REASON_PREFIX = 'membership-evidence-';

/**
 * Refusing a caller and being unable to answer for one are different outcomes, and
 * only the first may block a request: a roster nobody could read must not empty the
 * gateway. A refusal means the roster was read and did not list this principal, or
 * that the bindings that do apply to them left no model at all.
 */
export const ADMISSION_REFUSED_REASONS = Object.freeze(new Set([
  `${MEMBERSHIP_REASON_PREFIX}unmapped`,
  'model-intersection-empty',
  'principal-not-entitled',
]));

export function isAdmissionRefusedReason(reasonCode) {
  if (reasonCode === undefined) throw new TypeError('reasonCode is required.');
  return ADMISSION_REFUSED_REASONS.has(reasonCode);
}

/** Returns the refusal reason when the roster answered and omitted this principal, else null. */
export function rosterRefusalReason(memberships) {
  if (memberships === null || typeof memberships !== 'object') {
    throw new TypeError('memberships is required.');
  }
  return memberships.status === 'unmapped' ? `${MEMBERSHIP_REASON_PREFIX}unmapped` : null;
}

export function evaluateGovernanceAuthorization({
  principalContext,
  assignmentSnapshot,
  entitlementSnapshot,
  evaluationTime,
}) {
  assertPrincipalContextV1(principalContext, { evaluationTime });
  assertGovernanceAssignmentSnapshotV1(
    assignmentSnapshot,
    { evaluationTime, principalTenantId: principalContext.subject.tenantId },
  );
  assertEntitlementPolicySnapshotV1(
    entitlementSnapshot,
    { evaluationTime, principalTenantId: principalContext.subject.tenantId },
  );

  if (!isStrictMembershipEligible(principalContext, evaluationTime)) {
    return unavailableDecision({
      principalContext,
      assignmentSnapshot,
      entitlementSnapshot,
      evaluationTime,
      reasonCode: `${MEMBERSHIP_REASON_PREFIX}${principalContext.memberships.status}`,
    });
  }

  const assignmentReason = getSnapshotAuthorityReason(
    assignmentSnapshot,
    evaluationTime,
    'assignment',
  );
  if (assignmentReason) {
    return unavailableDecision({
      principalContext,
      assignmentSnapshot,
      entitlementSnapshot,
      evaluationTime,
      reasonCode: assignmentReason,
    });
  }

  const matchingRoleAssignments = getMatchingRoleAssignments(
    principalContext,
    assignmentSnapshot,
    evaluationTime,
  );

  const entitlementReason = getSnapshotAuthorityReason(
    entitlementSnapshot,
    evaluationTime,
    'entitlement',
  );
  if (entitlementReason) {
    const globalRoleAssignments = matchingRoleAssignments.filter(
      (assignment) => assignment.scope.kind === 'global',
    );
    const hasUnresolvedTeamAssignment = matchingRoleAssignments.some(
      (assignment) => assignment.scope.kind === 'team',
    );
    return unavailableDecision({
      principalContext,
      assignmentSnapshot,
      entitlementSnapshot,
      evaluationTime,
      reasonCode: entitlementReason,
      roleAssignments: globalRoleAssignments,
      defaultEndUser: globalRoleAssignments.length > 0 || !hasUnresolvedTeamAssignment,
    });
  }

  const teamByGroup = new Map(
    entitlementSnapshot.teamCatalog.map((mapping) => [mapping.membershipGroupId, mapping.teamKey]),
  );
  const teamKeys = new Set(
    principalContext.memberships.groups
      .filter((group) => group.authorizationRelevant)
      .map((group) => teamByGroup.get(group.groupId))
      .filter(Boolean),
  );
  const roleAssignments = validateTeamRoleAssignments(
    matchingRoleAssignments,
    teamByGroup,
  );
  const effectiveRoles = roleAssignments.length === 0
    ? ['end-user']
    : [...new Set(roleAssignments.map((assignment) => assignment.roleCode))].sort();
  const permittedReadScopes = resolveReadScopes(roleAssignments);
  const permittedTeamKeys = resolveTeamKeys(roleAssignments, teamByGroup.values());

  const bindings = entitlementSnapshot.bindings
    .filter((binding) => isActiveAt(binding, evaluationTime))
    .filter((binding) => bindingMatches(binding, principalContext, teamKeys));
  const hasSpecificGrant = bindings.some((binding) => binding.target.kind !== 'global');
  if (!hasSpecificGrant) {
    return deepFreeze({
      contractVersion: 'v1',
      decision: 'deny',
      readAuthority: 'authoritative',
      reasonCode: 'principal-not-entitled',
      effectiveRoles,
      permittedReadScopes,
      permittedTeamKeys,
      modelAllowlist: [],
      limits: { requestsPerMinute: null, tokensPerMinute: null },
      appliedAssignments: projectAssignments(roleAssignments),
      appliedBindings: [],
      ...snapshotEvidence(
        principalContext,
        assignmentSnapshot,
        entitlementSnapshot,
        evaluationTime,
      ),
    });
  }

  const effectivePolicy = evaluateEffectiveEntitlementBindings(bindings);
  return deepFreeze({
    contractVersion: 'v1',
    decision: effectivePolicy.decision,
    readAuthority: 'authoritative',
    reasonCode: effectivePolicy.reasonCode,
    effectiveRoles,
    permittedReadScopes,
    permittedTeamKeys,
    modelAllowlist: effectivePolicy.modelAllowlist,
    limits: effectivePolicy.limits,
    appliedAssignments: projectAssignments(roleAssignments),
    appliedBindings: projectBindings(bindings),
    ...snapshotEvidence(
      principalContext,
      assignmentSnapshot,
      entitlementSnapshot,
      evaluationTime,
    ),
  });
}