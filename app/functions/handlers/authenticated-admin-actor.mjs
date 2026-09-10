import { errorResponse } from './http-response.mjs';

/**
 * Derives the actor only after the route has authenticated and authorized the caller.
 * The HMAC deriver validates both platform-supplied identifier components.
 */
export function deriveAuthenticatedAdministratorActor({ caller, deriver, requestId }) {
  try {
    return {
      actorCode: deriver.deriveActorCode({
        tenantId: caller.tenantId,
        subjectId: caller.objectId,
      }),
    };
  } catch {
    return {
      failure: errorResponse(403, 'caller_not_identifiable', { requestId }),
    };
  }
}
