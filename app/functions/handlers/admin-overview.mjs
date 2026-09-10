import { errorResponse, jsonResponse } from './http-response.mjs';
import { readVerifiedCaller } from '../../control-api/client-principal.mjs';
import { projectAdminOverview } from '../../control-api/admin-read-model-projector.mjs';
import { buildOverviewFromRollups } from '../../control-api/overview-usage-source.mjs';
import { authorizeGovernanceAccess, ENTRA_ROLE_MAPPING } from '../../governance-domain/authorization/admin-role-authorization.mjs';

/**
 * The governance overview a console reads.
 *
 * Authorization comes from the roles Entra placed in the validated token and from
 * nothing in the request. Scope and range are the only things a caller chooses,
 * and both are checked against what their roles permit before any document is read.
 */

const RANGE_SECONDS = Object.freeze({ '24h': 86_400, '7d': 604_800, '30d': 2_592_000 });
const SCOPES = Object.freeze(['self', 'team', 'global']);

function fail(message) {
  throw new TypeError(message);
}

export function createAdminOverviewHandler({
  rollupStore,
  expectedAudience,
  clock,
  config,
  knownTeamKeys = [],
  readConfigurationSummary,
  roleMapping = ENTRA_ROLE_MAPPING,
  rolesClaim,
} = {}) {
  if (typeof rollupStore?.queryRollupWindows !== 'function') fail('rollupStore is required.');
  if (typeof expectedAudience !== 'string' || expectedAudience.length === 0) {
    fail('expectedAudience is required.');
  }
  if (typeof clock?.nowIso !== 'function') fail('clock is required.');
  if (typeof config?.scopeGroupId !== 'string' || config.scopeGroupId.length === 0) {
    fail('config.scopeGroupId is required.');
  }
  if (typeof readConfigurationSummary !== 'function') fail('readConfigurationSummary is required.');

  return async function adminOverview(request, context) {
    const requestId = context?.invocationId;

    let caller;
    try {
      caller = readVerifiedCaller({ headers: request.headers, expectedAudience, rolesClaim });
    } catch (error) {
      return errorResponse(401, 'caller_not_authenticated', { requestId, reasonCode: error.reasonCode });
    }

    let authorization;
    try {
      authorization = authorizeGovernanceAccess({ roles: caller.roles, knownTeamKeys, roleMapping });
    } catch (error) {
      return errorResponse(403, 'governance_access_denied', { requestId, reasonCode: error.reasonCode });
    }

    const scope = request.query.get('scope') ?? 'global';
    const range = request.query.get('range') ?? '24h';
    const teamKey = request.query.get('team');
    if (!SCOPES.includes(scope)) return errorResponse(400, 'scope_not_supported', { requestId });
    if (!Object.hasOwn(RANGE_SECONDS, range)) return errorResponse(400, 'range_not_supported', { requestId });

    const asOf = clock.nowIso();
    const sinceWindowStart = new Date(Date.parse(asOf) - RANGE_SECONDS[range] * 1000).toISOString();

    let documents;
    try {
      documents = await rollupStore.queryRollupWindows({
        scopeGroupId: config.scopeGroupId,
        sinceWindowStart,
      });
    } catch (error) {
      context?.error?.('Rollup read failed.', { reason: error?.name });
      return errorResponse(503, 'usage_source_unavailable', { requestId });
    }

    try {
      const readModel = projectAdminOverview({
        authorization,
        fixture: buildOverviewFromRollups({
          documents,
          scope,
          teamKey,
          range,
          asOf,
          configuration: await readConfigurationSummary(),
        }),
        selection: { scope, range, teamKey },
      });
      return jsonResponse(200, readModel, { requestId });
    } catch (error) {
      if (['scope-denied', 'team-scope-denied'].includes(error.code)) {
        return errorResponse(403, error.code.replaceAll('-', '_'), { requestId });
      }
      if (error.code === 'membership-not-authoritative') {
        return errorResponse(403, 'membership_not_authoritative', { requestId });
      }
      context?.error?.('Overview projection failed.', { reason: error?.name });
      return errorResponse(500, 'read_model_failed', { requestId });
    }
  };
}
