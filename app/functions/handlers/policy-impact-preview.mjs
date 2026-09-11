import { assertAuthorizedReadScope } from '../../control-api/admin-read-authorization.mjs';
import { PolicyImpactPreviewError } from '../../control-api/policy-impact-preview.mjs';
import { authorizeGovernanceAccess, ENTRA_ROLE_MAPPING } from '../../governance-domain/authorization/admin-role-authorization.mjs';
import { readVerifiedCaller } from '../../control-api/client-principal.mjs';
import { errorResponse, jsonResponse, readJsonBody } from './http-response.mjs';

function targetContext(caller) {
  if (
    typeof caller.tenantId !== 'string'
    || typeof caller.subjectId !== 'string'
    || typeof caller.applicationId !== 'string'
    || !['delegated', 'application'].includes(caller.authenticationFlow)
  ) {
    throw new PolicyImpactPreviewError('caller-policy-evidence-unavailable');
  }
  return Object.freeze({
    source: 'entra-validated',
    tenantId: caller.tenantId,
    subjectId: caller.subjectId,
    applicationId: caller.applicationId,
    authenticationFlow: caller.authenticationFlow,
    groups: caller.groups,
    evidence: 'verified-control-plane-token',
  });
}

export function createPolicyImpactPreviewHandler({
  preview,
  expectedAudience,
  roleMapping = ENTRA_ROLE_MAPPING,
  rolesClaim,
  knownTeamKeys = [],
} = {}) {
  if (typeof preview?.preview !== 'function') throw new TypeError('preview is required.');
  if (typeof expectedAudience !== 'string' || expectedAudience.length === 0) {
    throw new TypeError('expectedAudience is required.');
  }

  return async function policyImpactPreview(request, context) {
    const requestId = context?.invocationId;
    let caller;
    let authorization;
    try {
      caller = readVerifiedCaller({ headers: request.headers, expectedAudience, rolesClaim });
      authorization = authorizeGovernanceAccess({ roles: caller.roles, knownTeamKeys, roleMapping });
      assertAuthorizedReadScope({ authorization, scope: 'self' });
    } catch (error) {
      const status = error?.code === 'caller-not-authenticated' ? 401 : 403;
      return errorResponse(status, status === 401 ? 'caller_not_authenticated' : 'preview_denied', {
        requestId,
        reasonCode: error?.reasonCode ?? error?.code,
      });
    }

    let body;
    try {
      body = await readJsonBody(request, 2_048);
      const result = await preview.preview({ ...body, targetContext: targetContext(caller) });
      return jsonResponse(200, result, { requestId });
    } catch (error) {
      const code = error?.code ?? error?.message;
      if (code === 'preview-stale') return errorResponse(409, 'preview_stale', { requestId, reasonCode: code });
      if (code === 'revision-absent' || code === 'draft-content-absent') {
        return errorResponse(404, 'preview_unavailable', { requestId, reasonCode: code });
      }
      if ([
        'caller-policy-evidence-unavailable',
        'draft-content-incomplete',
      ].includes(code)) {
        return errorResponse(503, 'preview_unavailable', { requestId, reasonCode: code });
      }
      if (error instanceof PolicyImpactPreviewError || ['body-not-json', 'body-too-large'].includes(code)) {
        return errorResponse(400, 'preview_request_invalid', { requestId, reasonCode: code });
      }
      context?.error?.('Policy impact preview failed.', { reason: error?.name });
      return errorResponse(503, 'preview_unavailable', { requestId, reasonCode: 'preview-source-unavailable' });
    }
  };
}
