import { errorResponse, jsonResponse } from './http-response.mjs';
import { deriveAuthenticatedAdministratorActor } from './authenticated-admin-actor.mjs';
import { readVerifiedCaller } from '../../control-api/client-principal.mjs';
import { projectNotifications } from '../../control-api/notifications-read-model-projector.mjs';
import {
  createNotificationChannelRecord,
  describeNotificationChannel,
  SUPPORTED_CHANNEL_KINDS,
} from '../../governance-domain/notification/notification-channel.mjs';
import {
  assertGovernanceCapability,
  authorizeGovernanceAccess,
  ENTRA_ROLE_MAPPING,
} from '../../governance-domain/authorization/admin-role-authorization.mjs';

/**
 * What the governance ledger raised, and what has become of it since.
 *
 * Until this existed a finding could be raised, retried and exhausted without any
 * route by which an administrator could learn it had happened: the store is closed
 * to the public network and the overview reads usage windows, not the ledger.
 */

const SCOPES = Object.freeze(['self', 'team', 'global']);
const SINCE_EVER = '1970-01-01T00:00:00.000Z';

function fail(message) {
  throw new TypeError(message);
}

function authorize({ request, expectedAudience, rolesClaim, knownTeamKeys, roleMapping, requestId }) {
  let caller;
  try {
    caller = readVerifiedCaller({ headers: request.headers, expectedAudience, rolesClaim });
  } catch (error) {
    return { failure: errorResponse(401, 'caller_not_authenticated', { requestId, reasonCode: error.reasonCode }) };
  }

  try {
    return { caller, authorization: authorizeGovernanceAccess({ roles: caller.roles, knownTeamKeys, roleMapping }) };
  } catch (error) {
    return { failure: errorResponse(403, 'governance_access_denied', { requestId, reasonCode: error.reasonCode }) };
  }
}

export function createAdminNotificationsHandler({
  ledger,
  expectedAudience,
  clock,
  knownTeamKeys = [],
  roleMapping = ENTRA_ROLE_MAPPING,
  rolesClaim,
} = {}) {
  if (typeof ledger?.list !== 'function') fail('ledger is required.');
  if (typeof expectedAudience !== 'string' || expectedAudience.length === 0) {
    fail('expectedAudience is required.');
  }
  if (typeof clock?.nowIso !== 'function') fail('clock is required.');

  return async function adminNotifications(request, context) {
    const requestId = context?.invocationId;
    const { failure, authorization } = authorize({
      request,
      expectedAudience,
      rolesClaim,
      knownTeamKeys,
      roleMapping,
      requestId,
    });
    if (failure) return failure;

    const scope = request.query.get('scope') ?? 'global';
    const teamKey = request.query.get('team');
    if (!SCOPES.includes(scope)) return errorResponse(400, 'scope_not_supported', { requestId });

    // A ledger that cannot be read is reported as unreadable rather than as a ledger
    // with nothing in it, because those call for different actions.
    let records;
    try {
      records = await ledger.list({ sinceRaisedAt: SINCE_EVER });
    } catch (error) {
      context?.error?.('Notification ledger read failed.', { reason: error?.name });
      return errorResponse(503, 'notification_source_unavailable', { requestId });
    }

    try {
      return jsonResponse(
        200,
        projectNotifications({
          authorization,
          records,
          selection: { scope, teamKey: scope === 'team' ? teamKey : null, generatedAt: clock.nowIso() },
        }),
        { requestId },
      );
    } catch (error) {
      if (['scope-denied', 'team-scope-denied'].includes(error.code)) {
        return errorResponse(403, error.code.replaceAll('-', '_'), { requestId });
      }
      context?.error?.('Notification projection failed.', { reason: error?.name });
      return errorResponse(500, 'read_model_failed', { requestId });
    }
  };
}

/**
 * Where notifications go, read and chosen by an administrator.
 *
 * The endpoint is a bearer credential, so it is written and never read back: the
 * screen is told the channel and the host, which is enough to recognise what is
 * configured and not enough to post to it.
 */
export function createNotificationChannelHandler({
  store,
  deriver,
  scopeGroupId,
  expectedAudience,
  clock,
  knownTeamKeys = [],
  roleMapping = ENTRA_ROLE_MAPPING,
  rolesClaim,
} = {}) {
  if (typeof store?.readNotificationChannel !== 'function') fail('store is required.');
  if (typeof store?.putNotificationChannel !== 'function') fail('store is required.');
  if (typeof deriver?.deriveActorCode !== 'function') fail('deriver is required.');
  if (typeof scopeGroupId !== 'string' || scopeGroupId.length === 0) fail('scopeGroupId is required.');
  if (typeof expectedAudience !== 'string' || expectedAudience.length === 0) {
    fail('expectedAudience is required.');
  }
  if (typeof clock?.nowIso !== 'function') fail('clock is required.');

  return async function notificationChannel(request, context) {
    const requestId = context?.invocationId;
    const { failure, caller, authorization } = authorize({
      request,
      expectedAudience,
      rolesClaim,
      knownTeamKeys,
      roleMapping,
      requestId,
    });
    if (failure) return failure;

    if (request.method === 'GET') {
      try {
        const held = await store.readNotificationChannel({ scopeGroupId });
        return jsonResponse(
          200,
          { ...describeNotificationChannel(held?.document ?? null), supportedKinds: SUPPORTED_CHANNEL_KINDS },
          { requestId },
        );
      } catch (error) {
        context?.error?.('Notification channel read failed.', { reason: error?.name });
        return errorResponse(503, 'notification_source_unavailable', { requestId });
      }
    }

    try {
      assertGovernanceCapability(authorization, 'write-notification-channel');
    } catch (error) {
      return errorResponse(403, 'governance_capability_denied', { requestId, reasonCode: error.reasonCode });
    }
    const attributed = deriveAuthenticatedAdministratorActor({ caller, deriver, requestId });
    if (attributed.failure) return attributed.failure;

    let body;
    try {
      body = await request.json();
    } catch {
      return errorResponse(400, 'body_not_readable', { requestId });
    }

    let record;
    try {
      record = createNotificationChannelRecord({
        scopeGroupId,
        channelKind: body?.channelKind,
        endpoint: body?.endpoint,
        updatedByCode: attributed.actorCode,
        at: clock.nowIso(),
      });
    } catch (error) {
      // The refusal names the rule rather than the value, because the value is a
      // credential and this answer is read by a screen and written to a log.
      return errorResponse(400, 'channel_not_acceptable', {
        requestId,
        reasonCode: error?.reasonCode ?? 'endpoint-refused',
      });
    }

    try {
      const held = await store.readNotificationChannel({ scopeGroupId });
      await store.putNotificationChannel(record, { ifMatch: held?.etag ?? null });
    } catch (error) {
      if (error?.name === 'ConcurrencyConflictError') {
        return jsonResponse(409, { ok: false, reasonCode: 'changed-since-read' }, { requestId });
      }
      context?.error?.('Notification channel write failed.', { reason: error?.name });
      return errorResponse(503, 'notification_source_unavailable', { requestId });
    }

    return jsonResponse(200, { ok: true, ...describeNotificationChannel(record) }, { requestId });
  };
}

/**
 * Acknowledgement is the only part of a notification's life a person performs, so who
 * performed it is taken from the validated token and never from the request. A body
 * that could name its own actor would let any caller sign somebody else's name.
 */
export function createAcknowledgeNotificationHandler({
  ledger,
  deriver,
  expectedAudience,
  clock,
  knownTeamKeys = [],
  roleMapping = ENTRA_ROLE_MAPPING,
  rolesClaim,
} = {}) {
  if (typeof ledger?.acknowledge !== 'function') fail('ledger is required.');
  if (typeof deriver?.deriveActorCode !== 'function') fail('deriver is required.');
  if (typeof expectedAudience !== 'string' || expectedAudience.length === 0) {
    fail('expectedAudience is required.');
  }
  if (typeof clock?.nowIso !== 'function') fail('clock is required.');

  return async function acknowledgeNotification(request, context) {
    const requestId = context?.invocationId;
    const { failure, caller, authorization } = authorize({
      request,
      expectedAudience,
      rolesClaim,
      knownTeamKeys,
      roleMapping,
      requestId,
    });
    if (failure) return failure;

    try {
      assertGovernanceCapability(authorization, 'write-notification-channel');
    } catch (error) {
      return errorResponse(403, 'governance_capability_denied', { requestId, reasonCode: error.reasonCode });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return errorResponse(400, 'body_not_readable', { requestId });
    }
    if (typeof body?.key !== 'string' || body.key.length === 0) {
      return errorResponse(400, 'selection_not_supported', { requestId });
    }

    const attributed = deriveAuthenticatedAdministratorActor({ caller, deriver, requestId });
    if (attributed.failure) return attributed.failure;

    let result;
    try {
      result = await ledger.acknowledge({ key: body.key, actorCode: attributed.actorCode, at: clock.nowIso() });
    } catch (error) {
      context?.error?.('Acknowledgement failed.', { reason: error?.name });
      return errorResponse(400, 'acknowledge_refused', { requestId, reasonCode: error?.code });
    }

    // A refusal is an answer, not a failure: the record may have been acknowledged by
    // somebody else between the read and this write.
    if (result.ok !== true) {
      return jsonResponse(409, { ok: false, reasonCode: result.reasonCode }, { requestId });
    }
    return jsonResponse(200, { ok: true }, { requestId });
  };
}
