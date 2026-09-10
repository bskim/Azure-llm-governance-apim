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
import {
  addModel,
  captureModel,
  ModelCaptureRefusedError,
  recaptureModels,
  removeModel,
} from '../../governance-domain/registry/model-capture.mjs';
import { ENTRA_ROLE_MAPPING } from '../../governance-domain/authorization/admin-role-authorization.mjs';

/**
 * Bringing a deployment the provider already serves under governance, and taking one
 * back out.
 *
 * Adding a model used to mean editing a fixture and republishing the whole content
 * set, so a model deployed to Foundry could not be governed without a deployment of
 * this product. The administrator names a deployment; everything the registry keeps
 * is read from the provider's own answer about it, so there is nothing here for
 * anyone to type and nothing to guess.
 *
 * The capability is `write-entitlements`, matching the fallback and assignment routes:
 * which models exist here is the same kind of decision as which callers may reach
 * them, and this repository defines no narrower capability. Splitting one out is a
 * role-mapping change, not this slice.
 */

const DEPLOYMENT_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const MODEL_KEY = /^[A-Za-z0-9._-]{1,64}$/;

function refuseCapture(error, requestId) {
  if (error instanceof ModelCaptureRefusedError) {
    return jsonResponse(409, { outcome: 'refused', reasonCode: error.code, requestId }, { requestId });
  }
  return errorResponse(400, 'model_change_invalid', { requestId });
}

export function createModelChangeHandler({
  store,
  publisher,
  readPublishedSnapshots,
  readProviderDeployments,
  clock,
  scopeGroupId,
  expectedAudience,
  roleMapping = ENTRA_ROLE_MAPPING,
  rolesClaim,
  deriver,
} = {}) {
  assertDependencies({ readPublishedSnapshots, clock, expectedAudience });
  assertPublicationDependencies({ store, publisher, scopeGroupId, deriver });
  if (typeof readProviderDeployments !== 'function') {
    throw new TypeError('readProviderDeployments must be supplied: a model cannot be captured without the provider\u2019s own answer about the deployment.');
  }

  return async function changeModel(request, context) {
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
        context?.error?.('Resuming the model proposal failed.', { reason: error?.name });
        return errorResponse(500, 'model_change_failed', { requestId });
      }
    }
    if (!['add', 'remove', 'recapture'].includes(body?.command)) {
      return errorResponse(400, 'model_command_unsupported', { requestId });
    }
    if (body.command === 'add') {
      if (typeof body.deploymentName !== 'string' || !DEPLOYMENT_NAME.test(body.deploymentName)) {
        return errorResponse(400, 'deployment_required', { requestId });
      }
      if (body.modelKey !== undefined && (typeof body.modelKey !== 'string' || !MODEL_KEY.test(body.modelKey))) {
        return errorResponse(400, 'model_key_invalid', { requestId });
      }
    } else if (body.command === 'remove' && (typeof body.modelKey !== 'string' || !MODEL_KEY.test(body.modelKey))) {
      return errorResponse(400, 'model_required', { requestId });
    }

    let snapshots;
    try {
      snapshots = await readPublishedSnapshots();
    } catch (error) {
      const refused = unavailable(error, requestId);
      if (refused) return refused;
      context?.error?.('Reading the published set failed.', { reason: error?.name });
      return errorResponse(500, 'model_change_failed', { requestId });
    }

    let next;
    try {
      const at = clock.nowIso();
      if (body.command === 'remove') {
        next = {
          ...snapshots,
          modelRegistrySnapshot: removeModel({
            snapshot: snapshots.modelRegistrySnapshot,
            modelKey: body.modelKey,
            reasonCode: body.reasonCode,
            // Supplied explicitly, including as null, so "there was no entitlement set
            // to check" is never mistaken for "nothing is entitled to this model".
            entitlementSnapshot: snapshots.entitlementSnapshot ?? null,
            at,
          }),
        };
      } else {
        let reading;
        try {
          reading = await readProviderDeployments();
        } catch (error) {
          context?.error?.('Reading the provider deployments failed.', { reason: error?.name });
          return errorResponse(503, 'provider_unavailable', { requestId });
        }
        if (body.command === 'recapture') {
          next = {
            ...snapshots,
            modelRegistrySnapshot: recaptureModels({
              snapshot: snapshots.modelRegistrySnapshot,
              deployments: reading?.deployments ?? [],
              at,
            }),
          };
        } else {
          const deployment = (reading?.deployments ?? []).find(
            (entry) => entry.deploymentName === body.deploymentName,
          );
          if (deployment === undefined) {
            return jsonResponse(
              409,
              { outcome: 'refused', reasonCode: 'model-capture-deployment-unknown', requestId },
              { requestId },
            );
          }
          next = {
            ...snapshots,
            modelRegistrySnapshot: addModel({
              snapshot: snapshots.modelRegistrySnapshot,
              model: captureModel({ deployment, modelKey: body.modelKey }),
              at,
            }),
          };
        }
      }
    } catch (error) {
      return refuseCapture(error, requestId);
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
        // Group membership comes from the token's claim, so a registry change has
        // none to publish and must not declare a target it cannot satisfy.
        includeMembership: false,
        requestId,
      });
    } catch (error) {
      context?.error?.('Publishing the model change failed.', { reason: error?.name });
      return errorResponse(500, 'model_change_failed', { requestId });
    }
  };
}
