import { errorResponse, jsonResponse, readJsonBody } from './http-response.mjs';
import { deriveAuthenticatedAdministratorActor } from './authenticated-admin-actor.mjs';
import { parseStoredProposalResume, publishGovernanceContent } from './publish-governance.mjs';
import {
  assertDependencies,
  assertPublicationDependencies,
  authorize,
  EDIT_BODY_LIMIT_BYTES,
  unavailable,
} from './admin-access.mjs';
import { addBudget, BudgetEditRefusedError, editBudget, removeBudget } from '../../governance-domain/policy/budget-edit.mjs';
import { addFallbackPlan, editFallbackPlan, FallbackEditRefusedError } from '../../governance-domain/policy/fallback-plan-edit.mjs';
import {
  addTeam,
  removeTeam,
  TeamCatalogEditRefusedError,
} from '../../governance-domain/authorization/team-catalog-edit.mjs';
import {
  AssignmentEditRefusedError,
  grantAssignment,
  revokeAssignment,
} from '../../governance-domain/authorization/assignment-edit.mjs';
import { ENTRA_ROLE_MAPPING } from '../../governance-domain/authorization/admin-role-authorization.mjs';
import { DEPLOYED_THROTTLE_TIER_CODES } from '../../control-api/throttle-tier-codes.mjs';

/**
 * The rest of what the local development server can author, made deployable.
 *
 * `admin-access.mjs` closed the narrowest useful part of "nothing can change a
 * published set": naming an entitlement and changing it. These three routes are the
 * remaining proposal kinds the local server already has an edit function for - a
 * budget, the downgrade plan, and who holds which governance role - built the same
 * way: read the published set, apply the same domain edit function the local route
 * uses, and publish the result through the one write path. No new edit rule is
 * written here; each function only translates a domain refusal into a 409 and a
 * malformed request into a 400.
 *
 * Fallback and assignment edits share `write-entitlements` with the entitlement
 * route: this repository defines no narrower capability for them, and both are, like
 * an entitlement, a decision about which callers may reach which models. Splitting
 * them further is a role-mapping change this slice does not make.
 */

function translateRefusal(errorClass, invalidCode) {
  return (error, requestId) => {
    if (error instanceof errorClass) {
      return jsonResponse(409, { outcome: 'refused', reasonCode: error.code, requestId }, { requestId });
    }
    return errorResponse(400, invalidCode, { requestId });
  };
}

export function createBudgetChangeHandler({
  store,
  publisher,
  readPublishedSnapshots,
  clock,
  scopeGroupId,
  expectedAudience,
  roleMapping = ENTRA_ROLE_MAPPING,
  rolesClaim,
  deriver,
} = {}) {
  assertDependencies({ readPublishedSnapshots, clock, expectedAudience });
  assertPublicationDependencies({ store, publisher, scopeGroupId, deriver });
  const refuse = translateRefusal(BudgetEditRefusedError, 'budget_change_invalid');

  return async function changeBudget(request, context) {
    const requestId = context?.invocationId;
    const { failure, caller, authorization } = authorize({
      request,
      expectedAudience,
      rolesClaim,
      roleMapping,
      capability: 'write-budgets',
      requestId,
    });
    if (failure) return failure;
    const attributed = deriveAuthenticatedAdministratorActor({ caller, deriver, requestId });
    if (attributed.failure) return attributed.failure;
    const { actorCode } = attributed;

    let body;
    try {
      body = await readJsonBody(request, EDIT_BODY_LIMIT_BYTES);
    } catch (error) {
      return errorResponse(400, error.message.replaceAll('-', '_'), { requestId });
    }
    const resume = parseStoredProposalResume(body);
    if (resume.failureCode) return errorResponse(400, resume.failureCode.replaceAll('-', '_'), { requestId });
    if (resume.resume) {
      try {
        return await publishGovernanceContent({
          store, publisher, clock, scopeGroupId, actorCode, resumeRevisionId: resume.revisionId,
          selfApprovalGranted: authorization.capabilities.includes('approve-own-configuration'), requestId,
        });
      } catch (error) {
        context?.error?.('Resuming the budget proposal failed.', { reason: error?.name });
        return errorResponse(500, 'budget_change_failed', { requestId });
      }
    }
    if (!['add', 'remove', 'edit'].includes(body?.command)) {
      return errorResponse(400, 'budget_command_unsupported', { requestId });
    }
    if (body.command === 'add') {
      if (body.budget === null || typeof body.budget !== 'object' || Array.isArray(body.budget)) {
        return errorResponse(400, 'budget_required', { requestId });
      }
    } else if (typeof body.budgetId !== 'string' || body.budgetId.length === 0) {
      return errorResponse(400, 'budget_required', { requestId });
    }

    let snapshots;
    try {
      snapshots = await readPublishedSnapshots();
    } catch (error) {
      const refused = unavailable(error, requestId);
      if (refused) return refused;
      context?.error?.('Reading the published set failed.', { reason: error?.name });
      return errorResponse(500, 'budget_change_failed', { requestId });
    }

    let next;
    try {
      const at = clock.nowIso();
      next = {
        ...snapshots,
        budgetSnapshot:
          body.command === 'add'
            ? addBudget({
                snapshot: snapshots.budgetSnapshot,
                budget: body.budget,
                declaredTierCodes: DEPLOYED_THROTTLE_TIER_CODES,
                at,
              })
            : body.command === 'remove'
              ? removeBudget({
                  snapshot: snapshots.budgetSnapshot,
                  budgetId: body.budgetId,
                  reasonCode: body.reasonCode,
                  at,
                })
              : editBudget({
                  snapshot: snapshots.budgetSnapshot,
                  budgetId: body.budgetId,
                  changes: body.changes ?? {},
                  declaredTierCodes: DEPLOYED_THROTTLE_TIER_CODES,
                  at,
                }),
      };
    } catch (error) {
      // A refused edit is the administrator's answer, not a fault of the deployment.
      return refuse(error, requestId);
    }

    try {
      return await publishGovernanceContent({
        store,
        publisher,
        clock,
        scopeGroupId,
        actorCode,
        selfApprovalGranted: authorization.capabilities.includes('approve-own-configuration'),
        content: { snapshots: next },
        // Group membership comes from the token's claim, so a budget change has none
        // to publish and must not declare a target it cannot satisfy.
        includeMembership: false,
        requestId,
      });
    } catch (error) {
      context?.error?.('Publishing the budget change failed.', { reason: error?.name });
      return errorResponse(500, 'budget_change_failed', { requestId });
    }
  };
}

export function createFallbackChangeHandler({
  store,
  publisher,
  readPublishedSnapshots,
  clock,
  scopeGroupId,
  expectedAudience,
  roleMapping = ENTRA_ROLE_MAPPING,
  rolesClaim,
  deriver,
} = {}) {
  assertDependencies({ readPublishedSnapshots, clock, expectedAudience });
  assertPublicationDependencies({ store, publisher, scopeGroupId, deriver });
  const refuse = translateRefusal(FallbackEditRefusedError, 'fallback_change_invalid');

  return async function changeFallbackPlan(request, context) {
    const requestId = context?.invocationId;
    const { failure, caller, authorization } = authorize({
      request,
      expectedAudience,
      rolesClaim,
      roleMapping,
      capability: 'write-entitlements',
      requestId,
    });
    if (failure) return failure;
    const attributed = deriveAuthenticatedAdministratorActor({ caller, deriver, requestId });
    if (attributed.failure) return attributed.failure;
    const { actorCode } = attributed;

    let body;
    try {
      body = await readJsonBody(request, EDIT_BODY_LIMIT_BYTES);
    } catch (error) {
      return errorResponse(400, error.message.replaceAll('-', '_'), { requestId });
    }
    const resume = parseStoredProposalResume(body);
    if (resume.failureCode) return errorResponse(400, resume.failureCode.replaceAll('-', '_'), { requestId });
    if (resume.resume) {
      try {
        return await publishGovernanceContent({
          store, publisher, clock, scopeGroupId, actorCode, resumeRevisionId: resume.revisionId,
          selfApprovalGranted: authorization.capabilities.includes('approve-own-configuration'), requestId,
        });
      } catch (error) {
        context?.error?.('Resuming the fallback proposal failed.', { reason: error?.name });
        return errorResponse(500, 'fallback_change_failed', { requestId });
      }
    }
    if (body?.command !== undefined && !['add', 'edit'].includes(body.command)) {
      return errorResponse(400, 'fallback_command_unsupported', { requestId });
    }
    if (body?.command === 'add'
      ? body.plan === null || typeof body.plan !== 'object' || Array.isArray(body.plan)
      : typeof body?.planId !== 'string' || body.planId.length === 0) {
      return errorResponse(400, 'plan_required', { requestId });
    }

    let snapshots;
    try {
      snapshots = await readPublishedSnapshots();
    } catch (error) {
      const refused = unavailable(error, requestId);
      if (refused) return refused;
      context?.error?.('Reading the published set failed.', { reason: error?.name });
      return errorResponse(500, 'fallback_change_failed', { requestId });
    }

    let next;
    try {
      next = {
        ...snapshots,
        fallbackPolicySnapshot: body.command === 'add'
          ? addFallbackPlan({
              snapshot: snapshots.fallbackPolicySnapshot,
              plan: body.plan,
              registry: snapshots.modelRegistrySnapshot,
              teamCatalog: snapshots.entitlementSnapshot.teamCatalog,
              issuedBy: { kind: 'subject', key: actorCode },
              at: clock.nowIso(),
            })
          : editFallbackPlan({
              snapshot: snapshots.fallbackPolicySnapshot,
              planId: body.planId,
              changes: body.changes ?? {},
              at: clock.nowIso(),
            }),
      };
    } catch (error) {
      return refuse(error, requestId);
    }

    try {
      return await publishGovernanceContent({
        store,
        publisher,
        clock,
        scopeGroupId,
        actorCode,
        selfApprovalGranted: authorization.capabilities.includes('approve-own-configuration'),
        content: { snapshots: next },
        includeMembership: false,
        requestId,
      });
    } catch (error) {
      context?.error?.('Publishing the fallback plan change failed.', { reason: error?.name });
      return errorResponse(500, 'fallback_change_failed', { requestId });
    }
  };
}

export function createAssignmentChangeHandler({
  store,
  publisher,
  readPublishedSnapshots,
  clock,
  scopeGroupId,
  expectedAudience,
  roleMapping = ENTRA_ROLE_MAPPING,
  rolesClaim,
  deriver,
} = {}) {
  assertDependencies({ readPublishedSnapshots, clock, expectedAudience });
  assertPublicationDependencies({ store, publisher, scopeGroupId, deriver });
  const refuse = translateRefusal(AssignmentEditRefusedError, 'assignment_change_invalid');

  return async function changeAssignment(request, context) {
    const requestId = context?.invocationId;
    const { failure, caller, authorization } = authorize({
      request,
      expectedAudience,
      rolesClaim,
      roleMapping,
      capability: 'write-entitlements',
      requestId,
    });
    if (failure) return failure;
    const attributed = deriveAuthenticatedAdministratorActor({ caller, deriver, requestId });
    if (attributed.failure) return attributed.failure;
    const { actorCode } = attributed;

    let body;
    try {
      body = await readJsonBody(request, EDIT_BODY_LIMIT_BYTES);
    } catch (error) {
      return errorResponse(400, error.message.replaceAll('-', '_'), { requestId });
    }
    const resume = parseStoredProposalResume(body);
    if (resume.failureCode) return errorResponse(400, resume.failureCode.replaceAll('-', '_'), { requestId });
    if (resume.resume) {
      try {
        return await publishGovernanceContent({
          store, publisher, clock, scopeGroupId, actorCode, resumeRevisionId: resume.revisionId,
          selfApprovalGranted: authorization.capabilities.includes('approve-own-configuration'), requestId,
        });
      } catch (error) {
        context?.error?.('Resuming the assignment proposal failed.', { reason: error?.name });
        return errorResponse(500, 'assignment_change_failed', { requestId });
      }
    }
    if (!['grant', 'revoke'].includes(body?.command)) {
      return errorResponse(400, 'assignment_command_unsupported', { requestId });
    }
    if (typeof body.assignmentId !== 'string' || body.assignmentId.length === 0) {
      return errorResponse(400, 'assignment_required', { requestId });
    }

    let snapshots;
    try {
      snapshots = await readPublishedSnapshots();
    } catch (error) {
      const refused = unavailable(error, requestId);
      if (refused) return refused;
      context?.error?.('Reading the published set failed.', { reason: error?.name });
      return errorResponse(500, 'assignment_change_failed', { requestId });
    }

    let next;
    try {
      const at = clock.nowIso();
      next = {
        ...snapshots,
        assignmentSnapshot:
          body.command === 'revoke'
            ? revokeAssignment({
                snapshot: snapshots.assignmentSnapshot,
                assignmentId: body.assignmentId,
                reasonCode: body.reasonCode,
                at,
              })
            : grantAssignment({
                snapshot: snapshots.assignmentSnapshot,
                assignmentId: body.assignmentId,
                roleCode: body.roleCode,
                assignee: body.assignee,
                scope: body.scope,
                // The authority behind a grant is the signed-in administrator route,
                // not anything a caller could name in the request body.
                issuedBy: { kind: 'subject', key: actorCode },
                reasonCode: body.reasonCode,
                at,
              }),
      };
    } catch (error) {
      return refuse(error, requestId);
    }

    try {
      return await publishGovernanceContent({
        store,
        publisher,
        clock,
        scopeGroupId,
        actorCode,
        selfApprovalGranted: authorization.capabilities.includes('approve-own-configuration'),
        content: { snapshots: next },
        includeMembership: false,
        requestId,
      });
    } catch (error) {
      context?.error?.('Publishing the assignment change failed.', { reason: error?.name });
      return errorResponse(500, 'assignment_change_failed', { requestId });
    }
  };
}

/**
 * Which directory group is which governed team.
 *
 * Until this route existed a team could only be introduced by publishing an entire
 * governance set from a script, so onboarding one was a developer task. Membership
 * stays out: who is in a team is answered by the caller's own credential, and the
 * directory is where that is changed.
 */
export function createTeamChangeHandler({
  readPublishedSnapshots,
  store,
  publisher,
  clock,
  scopeGroupId,
  expectedAudience,
  roleMapping = ENTRA_ROLE_MAPPING,
  rolesClaim,
  deriver,
} = {}) {
  assertDependencies({ readPublishedSnapshots, clock, expectedAudience });
  assertPublicationDependencies({ store, publisher, scopeGroupId, deriver });
  const refuse = translateRefusal(TeamCatalogEditRefusedError, 'team_change_invalid');

  return async function changeTeam(request, context) {
    const requestId = context?.invocationId;
    const { failure, caller, authorization } = authorize({
      request,
      expectedAudience,
      rolesClaim,
      roleMapping,
      capability: 'write-entitlements',
      requestId,
    });
    if (failure) return failure;
    const attributed = deriveAuthenticatedAdministratorActor({ caller, deriver, requestId });
    if (attributed.failure) return attributed.failure;
    const { actorCode } = attributed;

    let body;
    try {
      body = await readJsonBody(request, EDIT_BODY_LIMIT_BYTES);
    } catch (error) {
      return errorResponse(400, error.message.replaceAll('-', '_'), { requestId });
    }
    const resume = parseStoredProposalResume(body);
    if (resume.failureCode) return errorResponse(400, resume.failureCode.replaceAll('-', '_'), { requestId });
    if (resume.resume) {
      try {
        return await publishGovernanceContent({
          store, publisher, clock, scopeGroupId, actorCode, resumeRevisionId: resume.revisionId,
          selfApprovalGranted: authorization.capabilities.includes('approve-own-configuration'), requestId,
        });
      } catch (error) {
        context?.error?.('Resuming the team proposal failed.', { reason: error?.name });
        return errorResponse(500, 'team_change_failed', { requestId });
      }
    }
    if (!['add', 'remove'].includes(body?.command)) {
      return errorResponse(400, 'team_command_unsupported', { requestId });
    }
    if (typeof body.teamKey !== 'string' || body.teamKey.length === 0) {
      return errorResponse(400, 'team_required', { requestId });
    }

    let snapshots;
    try {
      snapshots = await readPublishedSnapshots();
    } catch (error) {
      const refused = unavailable(error, requestId);
      if (refused) return refused;
      context?.error?.('Reading the published set failed.', { reason: error?.name });
      return errorResponse(500, 'team_change_failed', { requestId });
    }

    let next;
    try {
      const at = clock.nowIso();
      next = {
        ...snapshots,
        entitlementSnapshot:
          body.command === 'remove'
            ? removeTeam({
                snapshot: snapshots.entitlementSnapshot,
                teamKey: body.teamKey,
                reasonCode: body.reasonCode,
                at,
              })
            : addTeam({
                snapshot: snapshots.entitlementSnapshot,
                teamKey: body.teamKey,
                membershipGroupId: body.membershipGroupId,
                at,
              }),
      };
    } catch (error) {
      return refuse(error, requestId);
    }

    try {
      return await publishGovernanceContent({
        store,
        publisher,
        clock,
        scopeGroupId,
        actorCode,
        selfApprovalGranted: authorization.capabilities.includes('approve-own-configuration'),
        content: { snapshots: next },
        includeMembership: false,
        requestId,
      });
    } catch (error) {
      context?.error?.('Publishing the team change failed.', { reason: error?.name });
      return errorResponse(500, 'team_change_failed', { requestId });
    }
  };
}
