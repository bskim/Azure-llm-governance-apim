import { errorResponse, jsonResponse, readJsonBody } from './http-response.mjs';
import { deriveAuthenticatedAdministratorActor } from './authenticated-admin-actor.mjs';
import { parseStoredProposalResume, publishGovernanceContent } from './publish-governance.mjs';
import { readVerifiedCaller } from '../../control-api/client-principal.mjs';
import { PolicySourceUnavailableError } from '../../control-api/published-policy-source.mjs';
import {
  addEntitlementBinding,
  editEntitlementBinding,
  ENTITLEMENT_GRANT_REASONS,
  EntitlementEditRefusedError,
} from '../../governance-domain/authorization/entitlement-edit.mjs';
import { TEAM_REMOVAL_REASONS } from '../../governance-domain/authorization/team-catalog-edit.mjs';
import {
  assertGovernanceCapability,
  authorizeGovernanceAccess,
  ENTRA_ROLE_MAPPING,
} from '../../governance-domain/authorization/admin-role-authorization.mjs';
import { DEPLOYED_THROTTLE_TIER_CODES } from '../../control-api/throttle-tier-codes.mjs';
import {
  ASSIGNMENT_GRANT_RULES,
} from '../../governance-domain/authorization/assignment-edit.mjs';
import { buildIdentifierEvidence } from '../../control-api/identifier-assistance.mjs';

/**
 * Changing who may use which model, from inside the network.
 *
 * The publish route could already write a governance set and nothing could produce
 * one: the only surface that composes an edit into the next version of the set lived
 * on the local development server. So a deployment could be bootstrapped and then
 * never changed except by re-importing a set from somewhere else.
 *
 * The options route names the identifiers an edit may choose from, and the entitlement
 * route applies one change to the published set and publishes the result. The sibling
 * module {@link ../handlers/admin-governance-edit.mjs} does the same for budgets,
 * the downgrade plan, and role assignments, sharing the authorization and publication
 * helpers exported here rather than restating them. The console's authoring panels
 * are still local only.
 *
 * Applying a change creates a reviewable revision. A second administrator resumes it
 * to approve and publish; only an explicitly configured own-approval authority may
 * take both actions, and the lifecycle records that exception.
 */

// One bounded edit, not a whole governance set. The fallback compiler permits 32
// connections whose aliases may each be 128 characters, so the shared ceiling must
// admit that complete valid edge set without becoming an unbounded publication route.
export const EDIT_BODY_LIMIT_BYTES = 16_384;

// Mirrors the local development route's catalogue exactly, so an administrator sees
// the same choices whether the console is talking to a deployment or to a laptop.
const REVOCATION_REASON_CODES = Object.freeze([
  'left-the-organization',
  'changed-role',
  'access-review-removed',
  'granted-in-error',
  'temporary-access-expired',
]);

function fail(message) {
  throw new TypeError(message);
}

export function assertDependencies({ readPublishedSnapshots, clock, expectedAudience }) {
  if (typeof readPublishedSnapshots !== 'function') fail('readPublishedSnapshots is required.');
  if (typeof clock?.nowIso !== 'function') fail('clock is required.');
  if (typeof expectedAudience !== 'string' || expectedAudience.length === 0) {
    fail('expectedAudience is required.');
  }
}

/** What every route that publishes a changed snapshot needs, beyond what {@link assertDependencies} covers. */
export function assertPublicationDependencies({ store, publisher, scopeGroupId, deriver }) {
  if (typeof store?.queryConfigurationRevisions !== 'function') fail('store is required.');
  if (typeof publisher?.publish !== 'function') fail('publisher is required.');
  if (typeof scopeGroupId !== 'string' || scopeGroupId.length === 0) fail('scopeGroupId is required.');
  if (typeof deriver?.deriveActorCode !== 'function') {
    fail('deriver.deriveActorCode is required.');
  }
}

export function authorize({ request, expectedAudience, rolesClaim, roleMapping, capability, requestId }) {
  let caller;
  try {
    caller = readVerifiedCaller({ headers: request.headers, expectedAudience, rolesClaim });
  } catch (error) {
    return { failure: errorResponse(401, 'caller_not_authenticated', { requestId, reasonCode: error.reasonCode }) };
  }
  try {
    const authorization = authorizeGovernanceAccess({ roles: caller.roles, roleMapping });
    assertGovernanceCapability(authorization, capability);
    return { caller, authorization };
  } catch (error) {
    return {
      failure: errorResponse(403, 'governance_access_denied', { requestId, reasonCode: error.reasonCode }),
    };
  }
}

// Nothing published is a different answer from a store that cannot be reached, and an
// administrator deciding whether to retry needs to be able to tell them apart.
export function unavailable(error, requestId) {
  if (error instanceof PolicySourceUnavailableError) {
    return errorResponse(503, 'governance_unavailable', { requestId, reasonCode: error.reasonCode });
  }
  return null;
}

export function createAccessOptionsHandler({
  readPublishedSnapshots,
  clock,
  expectedAudience,
  roleMapping = ENTRA_ROLE_MAPPING,
  rolesClaim,
  deriver = null,
} = {}) {
  assertDependencies({ readPublishedSnapshots, clock, expectedAudience });

  return async function accessOptions(request, context) {
    const requestId = context?.invocationId;
    // The options name real identifiers rather than the pseudonymous codes the
    // directory table is built from, so reading them is gated as an authoring act.
    const { failure, caller } = authorize({
      request,
      expectedAudience,
      rolesClaim,
      roleMapping,
      capability: 'write-entitlements',
      requestId,
    });
    if (failure) return failure;

    let snapshots;
    try {
      snapshots = await readPublishedSnapshots();
    } catch (error) {
      const refused = unavailable(error, requestId);
      if (refused) return refused;
      context?.error?.('Reading the published set failed.', { reason: error?.name });
      return errorResponse(500, 'access_options_failed', { requestId });
    }

    return jsonResponse(
      200,
      {
        readModelVersion: 'access-options.v1',
        generatedAt: clock.nowIso(),
        identifierEvidence: buildIdentifierEvidence({
          identity: caller,
          deriver,
          snapshots,
        }),
        models: snapshots.modelRegistrySnapshot.models.map((model) => model.modelKey),
        budgetOptions: { throttleTierCodes: [...DEPLOYED_THROTTLE_TIER_CODES] },
        // Which directory group is which governed team. A team is offered with the
        // bindings that target it, because removing one is refused while any remain
        // and an administrator should see that before trying.
        teams: snapshots.entitlementSnapshot.teamCatalog.map((mapping) => ({
          teamCode: mapping.teamKey,
          membershipGroupCode: mapping.membershipGroupId,
          bindingCodes: snapshots.entitlementSnapshot.bindings
            .filter((binding) => binding.target.kind === 'team' && binding.target.key === mapping.teamKey)
            .map((binding) => binding.bindingId),
        })),
        bindings: snapshots.entitlementSnapshot.bindings
          .map((binding) => ({
            bindingCode: binding.bindingId,
            targetKind: binding.target.kind,
            targetCode: binding.target.key,
            state: binding.state,
            canRestore:
              binding.state === 'revoked'
              && (binding.validUntil === null || Date.parse(binding.validUntil) > Date.parse(clock.nowIso())),
            modelCodes: [...binding.modelAllowlist],
            limits: structuredClone(binding.limits),
          })),
        assignments: snapshots.assignmentSnapshot.assignments
          .filter((assignment) => assignment.state === 'active')
          .map((assignment) => ({
            assignmentCode: assignment.assignmentId,
            roleCode: assignment.roleCode,
            assigneeKind: assignment.assignee.kind,
            assigneeCode: assignment.assignee.key,
            scopeKind: assignment.scope.kind,
            scopeCode: assignment.scope.key,
          })),
        revocationReasonCodes: REVOCATION_REASON_CODES,
        grantReasonCodes: ENTITLEMENT_GRANT_REASONS,
        assignmentGrantRules: ASSIGNMENT_GRANT_RULES.map((rule) => ({
          roleCode: rule.roleCode,
          assigneeKinds: [...rule.assigneeKinds],
          scopeKinds: [...rule.scopeKinds],
        })),
        teamRemovalReasonCodes: TEAM_REMOVAL_REASONS,
        requestId,
      },
      { requestId },
    );
  };
}

export function createEntitlementChangeHandler({
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

  return async function changeEntitlement(request, context) {
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
    if (resume.failureCode) {
      return errorResponse(400, resume.failureCode.replaceAll('-', '_'), { requestId });
    }
    if (resume.resume) {
      try {
        return await publishGovernanceContent({
          store,
          publisher,
          clock,
          scopeGroupId,
          actorCode,
          resumeRevisionId: resume.revisionId,
          selfApprovalGranted: authorization.capabilities.includes('approve-own-configuration'),
          requestId,
        });
      } catch (error) {
        context?.error?.('Resuming the entitlement proposal failed.', { reason: error?.name });
        return errorResponse(500, 'entitlement_change_failed', { requestId });
      }
    }
    if (typeof body?.bindingId !== 'string' || body.bindingId.length === 0) {
      return errorResponse(400, 'binding_required', { requestId });
    }
    // A request that names no command is the edit this route has always served, so an
    // existing caller keeps working and creating is asked for explicitly.
    const command = body.command ?? 'edit';
    if (!['add', 'edit'].includes(command)) {
      return errorResponse(400, 'entitlement_command_unsupported', { requestId });
    }

    let snapshots;
    try {
      snapshots = await readPublishedSnapshots();
    } catch (error) {
      const refused = unavailable(error, requestId);
      if (refused) return refused;
      context?.error?.('Reading the published set failed.', { reason: error?.name });
      return errorResponse(500, 'entitlement_change_failed', { requestId });
    }

    let next;
    try {
      const at = clock.nowIso();
      next = {
        ...snapshots,
        entitlementSnapshot: command === 'add'
          ? addEntitlementBinding({
              snapshot: snapshots.entitlementSnapshot,
              bindingId: body.bindingId,
              target: body.target,
              modelAllowlist: body.modelAllowlist,
              limits: body.limits ?? {},
              // The authority behind a grant is the signed-in administrator route,
              // not anything a caller could name in the request body.
              issuedBy: { kind: 'subject', key: actorCode },
              reasonCode: body.reasonCode,
              registry: snapshots.modelRegistrySnapshot,
              at,
            })
          : editEntitlementBinding({
              snapshot: snapshots.entitlementSnapshot,
              bindingId: body.bindingId,
              changes: body.changes ?? {},
              registry: snapshots.modelRegistrySnapshot,
              at,
            }),
      };
    } catch (error) {
      // A refused edit is the administrator's answer, not a fault of the deployment.
      if (error instanceof EntitlementEditRefusedError) {
        return jsonResponse(409, { outcome: 'refused', reasonCode: error.code, requestId }, { requestId });
      }
      return errorResponse(400, 'entitlement_change_invalid', { requestId });
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
        // Group membership comes from the token's claim, so an entitlement change has
        // none to publish and must not declare a target it cannot satisfy.
        includeMembership: false,
        requestId,
      });
    } catch (error) {
      context?.error?.('Publishing the entitlement change failed.', { reason: error?.name });
      return errorResponse(500, 'entitlement_change_failed', { requestId });
    }
  };
}
