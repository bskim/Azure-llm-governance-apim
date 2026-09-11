import { deriveAuthenticatedAdministratorActor } from './authenticated-admin-actor.mjs';
import {
  assertDependencies,
  authorize,
  EDIT_BODY_LIMIT_BYTES,
  unavailable,
} from './admin-access.mjs';
import { errorResponse, jsonResponse, readJsonBody } from './http-response.mjs';
import {
  assertGovernanceCapability,
  ENTRA_ROLE_MAPPING,
} from '../../governance-domain/authorization/admin-role-authorization.mjs';
import {
  GovernanceRemovalRefusedError,
} from '../../governance-domain/removal/governance-removal.mjs';

function budgetPermissionFailure(authorization, plan, requestId) {
  if (!plan.references.some((entry) => entry.kind === 'model-budget')) return null;
  try {
    assertGovernanceCapability(authorization, 'write-budgets');
    return null;
  } catch (error) {
    return errorResponse(403, 'governance_access_denied', {
      requestId,
      reasonCode: error.reasonCode,
    });
  }
}

function refuse(error, requestId) {
  if (!(error instanceof GovernanceRemovalRefusedError)) return null;
  const badRequest = [
    'removal-target-invalid',
    'removal-selection-required',
    'removal-selection-duplicate',
  ].includes(error.code);
  return jsonResponse(
    badRequest ? 400 : 409,
    { outcome: 'refused', reasonCode: error.code },
    { requestId },
  );
}

function assertRemovalDependencies({ service, clock, expectedAudience }) {
  assertDependencies({
    readPublishedSnapshots: service?.plan?.bind(service),
    clock,
    expectedAudience,
  });
  if (typeof service?.propose !== 'function') {
    throw new TypeError('service.propose is required.');
  }
}

export function createRemovalPlanHandler({
  service,
  clock,
  expectedAudience,
  roleMapping = ENTRA_ROLE_MAPPING,
  rolesClaim,
} = {}) {
  assertRemovalDependencies({ service, clock, expectedAudience });
  return async function removalPlan(request, context) {
    const requestId = context?.invocationId;
    const { failure, authorization } = authorize({
      request,
      expectedAudience,
      rolesClaim,
      roleMapping,
      capability: 'write-entitlements',
      requestId,
    });
    if (failure) return failure;

    let body;
    try {
      body = await readJsonBody(request, EDIT_BODY_LIMIT_BYTES);
      const plan = await service.plan({
        target: body.target,
        reasonCode: body.reasonCode,
      });
      const budgetFailure = budgetPermissionFailure(authorization, plan, requestId);
      return budgetFailure ?? jsonResponse(200, plan, { requestId });
    } catch (error) {
      const rejected = refuse(error, requestId);
      if (rejected) return rejected;
      const sourceFailure = unavailable(error, requestId);
      if (sourceFailure) return sourceFailure;
      if (error instanceof TypeError && error.message.startsWith('body-')) {
        return errorResponse(400, error.message.replaceAll('-', '_'), { requestId });
      }
      context?.error?.('Planning governance removal failed.', { reason: error?.name });
      return errorResponse(500, 'removal_plan_failed', { requestId });
    }
  };
}

export function createRemovalProposalHandler({
  service,
  clock,
  expectedAudience,
  roleMapping = ENTRA_ROLE_MAPPING,
  rolesClaim,
  deriver,
} = {}) {
  assertRemovalDependencies({ service, clock, expectedAudience });
  if (typeof deriver?.deriveActorCode !== 'function') {
    throw new TypeError('deriver.deriveActorCode is required.');
  }
  return async function removalProposal(request, context) {
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

    let body;
    try {
      body = await readJsonBody(request, EDIT_BODY_LIMIT_BYTES);
      const currentPlan = await service.plan({
        target: body.target,
        reasonCode: body.reasonCode,
      });
      const budgetFailure = budgetPermissionFailure(authorization, currentPlan, requestId);
      if (budgetFailure) return budgetFailure;
      const proposed = await service.propose({
        target: body.target,
        reasonCode: body.reasonCode,
        planDigest: body.planDigest,
        selectedReferenceIds: body.selectedReferenceIds,
        authoredBy: attributed.actorCode,
      });
      return jsonResponse(201, proposed, { requestId });
    } catch (error) {
      const rejected = refuse(error, requestId);
      if (rejected) return rejected;
      const sourceFailure = unavailable(error, requestId);
      if (sourceFailure) return sourceFailure;
      if (error instanceof TypeError && error.message.startsWith('body-')) {
        return errorResponse(400, error.message.replaceAll('-', '_'), { requestId });
      }
      context?.error?.('Creating governance removal proposal failed.', { reason: error?.name });
      return errorResponse(500, 'removal_proposal_failed', { requestId });
    }
  };
}
