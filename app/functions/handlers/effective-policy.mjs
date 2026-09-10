import { errorResponse, jsonResponse, readJsonBody } from './http-response.mjs';
import { readVerifiedCaller } from '../../control-api/client-principal.mjs';

/**
 * The route the gateway calls on a cache miss.
 *
 * The gateway ignores errors from this call and falls through to its conservative
 * deployment default. Only the gateway machine role may resolve a caller policy;
 * human administration roles cannot use this endpoint to inspect another caller.
 */
export function createEffectivePolicyHandler({
  resolver,
  personaGuard,
  expectedAudience,
  requiredRole,
  rolesClaim,
} = {}) {
  if (resolver === null || typeof resolver !== 'object' || typeof resolver.resolve !== 'function') {
    throw new TypeError('resolver is required.');
  }
  if (typeof expectedAudience !== 'string' || expectedAudience.length === 0) {
    throw new TypeError('expectedAudience is required.');
  }
  if (typeof requiredRole !== 'string' || requiredRole.length === 0) {
    throw new TypeError('requiredRole is required.');
  }
  return async function effectivePolicy(request, context) {
    const requestId = context?.invocationId;

    let caller;
    try {
      caller = readVerifiedCaller({ headers: request.headers, expectedAudience, rolesClaim });
    } catch (error) {
      return errorResponse(401, 'caller_not_authenticated', { requestId, reasonCode: error.reasonCode });
    }
    if (!caller.roles.includes(requiredRole)) {
      return errorResponse(403, 'policy_resolution_access_denied', {
        requestId,
        reasonCode: 'required-role-absent',
      });
    }

    let body;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      return errorResponse(400, error.message.replaceAll('-', '_'), { requestId });
    }

    if (personaGuard && !personaGuard(body.persona)) {
      return errorResponse(400, 'persona_not_supported', { requestId });
    }

    try {
      const { status, reasonCode, document } = await resolver.resolve(body);
      return jsonResponse(status, { reasonCode, document }, { requestId });
    } catch (error) {
      // The detail is withheld because this response crosses into the gateway and
      // then into request telemetry.
      context?.error?.('Policy resolution failed.', { reason: error?.name });
      return errorResponse(500, 'policy_resolution_failed', { requestId });
    }
  };
}
