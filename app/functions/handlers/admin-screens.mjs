import { errorResponse, jsonResponse } from './http-response.mjs';
import { readVerifiedCaller } from '../../control-api/client-principal.mjs';
import { projectModels } from '../../control-api/models-read-model-projector.mjs';
import { projectUsersGroupsReadModel } from '../../control-api/users-groups-read-model-projector.mjs';
import { projectUsage } from '../../control-api/usage-read-model-projector.mjs';
import { projectBudgets } from '../../control-api/budgets-read-model-projector.mjs';
import { projectFallback } from '../../control-api/fallback-read-model-projector.mjs';
import { projectLifecycle } from '../../control-api/lifecycle-read-model-projector.mjs';
import { projectChangeLog } from '../../control-api/change-log-read-model-projector.mjs';
import { deriveChangeEntries } from '../../governance-domain/change-log/derive-change-entries.mjs';
import { publishBudgets } from '../../governance-domain/policy/budget-publication.mjs';
import {
  budgetObservationSelector,
  observePeriodConsumption,
} from '../../governance-domain/usage/period-consumption.mjs';
import { startOfPeriod, scopeKeysInPeriod } from '../../governance-domain/usage/budget-period.mjs';
import {
  compileFallbackPlan,
  derivePermittedTargets,
  selectFallbackPlan,
} from '../../governance-domain/policy/fallback-plan-compiler.mjs';
import { API_FAMILIES } from '../../governance-domain/registry/model-registry-validator.mjs';
import {
  authorizeGovernanceAccess,
  ENTRA_ROLE_MAPPING,
} from '../../governance-domain/authorization/admin-role-authorization.mjs';
import { ReadSourceUnavailableError } from '../../control-api/governance-read-source.mjs';

/**
 * The screens that had a reading and no way to ask for it.
 *
 * The stored read source already answered every question these projections need. What
 * was missing was a route, so a reading was being produced in a deployment and read by
 * nobody.
 *
 * No handler here chooses a fixture, a persona, or an intent. A deployment has one
 * reading, and who is asking comes from the token; a stored source declares only
 * `['complete']` for every fixture capability for exactly this reason.
 */

const SCOPES = Object.freeze(['self', 'team', 'global']);
const USERS_GROUPS_VIEWS = Object.freeze(['users', 'groups', 'applications']);
const USAGE_VIEWS = Object.freeze(['users', 'groups']);
const SINCE_EVER = '1970-01-01T00:00:00.000Z';

function fail(message) {
  throw new TypeError(message);
}

function assertDependencies({ source, clock, expectedAudience }) {
  if (typeof source?.readGovernanceSnapshots !== 'function') fail('source is required.');
  if (typeof clock?.nowIso !== 'function') fail('clock is required.');
  if (typeof expectedAudience !== 'string' || expectedAudience.length === 0) {
    fail('expectedAudience is required.');
  }
}

function authorize({ request, expectedAudience, rolesClaim, roleMapping, knownTeamKeys, requestId }) {
  let caller;
  try {
    caller = readVerifiedCaller({ headers: request.headers, expectedAudience, rolesClaim });
  } catch (error) {
    return { failure: errorResponse(401, 'caller_not_authenticated', { requestId, reasonCode: error.reasonCode }) };
  }
  try {
    return { caller, authorization: authorizeGovernanceAccess({ roles: caller.roles, knownTeamKeys, roleMapping }) };
  } catch (error) {
    return {
      failure: errorResponse(403, 'governance_access_denied', { requestId, reasonCode: error.reasonCode }),
    };
  }
}

/**
 * Where the caller sits in the reading's own identifier space.
 *
 * The roster names people by a pseudonym of their directory object id. The caller's
 * token carries that same object id as `oid`, so deriving it the same way is what makes
 * "which of these is me" answerable at all. It is deliberately not the caller's subject
 * key, which is derived from the token's pairwise `sub` and could never match.
 *
 * Without a deriver there is no answer, and the reading says so rather than filtering by
 * something that cannot match and presenting the empty result as belonging to no group.
 */
function locateCaller(caller, deriveDirectoryCode) {
  if (deriveDirectoryCode === null) return null;
  if (typeof caller?.tenantId !== 'string' || typeof caller?.objectId !== 'string') return null;
  try {
    return deriveDirectoryCode({ tenantId: caller.tenantId, subjectId: caller.objectId });
  } catch {
    return null;
  }
}

function readSelection(request, { views = null } = {}) {
  const url = new URL(request.url);
  const scope = url.searchParams.get('scope') ?? 'global';
  const view = url.searchParams.get('view') ?? 'users';
  const teamKey = url.searchParams.get('team');
  if (!SCOPES.includes(scope)) return { refusal: 'scope_not_supported' };
  if (views !== null && !views.includes(view)) return { refusal: 'view_not_supported' };
  if (scope === 'team' && (teamKey === null || teamKey.length === 0)) {
    return { refusal: 'team_required' };
  }
  return { scope, view, teamKey: scope === 'team' ? teamKey : null };
}

/**
 * The administrator's own read of the published configuration, not a per-caller
 * entitlement: budgets and fallback deployed screens show what the organization has
 * authored for a scope, and every model those two carry has to compile against the
 * models the organization allows at all.
 */
function resolveGlobalAllowlist(entitlementSnapshot) {
  const binding = (entitlementSnapshot?.bindings ?? []).find(
    (candidate) => candidate.state === 'active' && candidate.target?.kind === 'global',
  );
  return binding === undefined ? null : binding.modelAllowlist;
}

// A refusal by the projection is the reader being told what they may see; a source with
// nothing stored is the deployment having no reading yet. They are different answers.
function respondToFailure(error, requestId, context, fallbackCode) {
  if (error instanceof ReadSourceUnavailableError) {
    return errorResponse(503, 'reading_unavailable', { requestId, reasonCode: error.code });
  }
  const denied = [
    'scope-denied',
    'team-scope-denied',
    'membership-not-authoritative',
    'view-not-permitted-for-scope',
    'self-scope-not-identifiable',
    'self-scope-membership-absent',
    // The gateway forwards this console's own token subject, which a usage record's
    // subjectKey can never match: a different fact from the roster's self-scope, so
    // it carries its own reason.
    'self-scope-not-attributable',
  ];
  if (denied.includes(error?.code)) {
    return errorResponse(403, 'scope_denied', { requestId, reasonCode: error.code });
  }
  if (['view-not-supported', 'scope-not-supported', 'viewer-subject-key-unavailable'].includes(error?.code)) {
    return errorResponse(400, 'selection_not_supported', { requestId, reasonCode: error.code });
  }
  context?.error?.('Read model projection failed.', { reason: error?.name });
  return errorResponse(500, fallbackCode, { requestId });
}

export function createUsersGroupsHandler({
  source,
  clock,
  expectedAudience,
  roleMapping = ENTRA_ROLE_MAPPING,
  rolesClaim,
  knownTeamKeys = [],
  deriveDirectoryCode,
} = {}) {
  assertDependencies({ source, clock, expectedAudience });
  // Required, may be null: a deployment with no pseudonym secret cannot place the
  // caller in the reading, and that is a different state from never having tried.
  if (deriveDirectoryCode === undefined) {
    fail('deriveDirectoryCode must be supplied, or supplied as null when unavailable.');
  }

  return async function usersGroups(request, context) {
    const requestId = context?.invocationId;
    const { failure, authorization, caller } = authorize({
      request,
      expectedAudience,
      rolesClaim,
      roleMapping,
      knownTeamKeys,
      requestId,
    });
    if (failure) return failure;

    const selection = readSelection(request, { views: USERS_GROUPS_VIEWS });
    if (selection.refusal) return errorResponse(400, selection.refusal, { requestId });

    const callerCode = locateCaller(caller, deriveDirectoryCode ?? null);

    try {
      const snapshots = await source.readGovernanceSnapshots();
      const reading = await source.readUsersGroups({});
      return jsonResponse(
        200,
        projectUsersGroupsReadModel({
          context: { subject: { subjectId: callerCode } },
          authorization,
          entitlementSnapshot: snapshots.entitlementSnapshot,
          assignmentSnapshot: snapshots.assignmentSnapshot,
          fixture: { ...reading, subjectsMatchCaller: callerCode !== null },
          selection,
        }),
        { requestId },
      );
    } catch (error) {
      return respondToFailure(error, requestId, context, 'users_groups_failed');
    }
  };
}

export function createModelsHandler({
  source,
  clock,
  expectedAudience,
  roleMapping = ENTRA_ROLE_MAPPING,
  rolesClaim,
  knownTeamKeys = [],
} = {}) {
  assertDependencies({ source, clock, expectedAudience });

  return async function models(request, context) {
    const requestId = context?.invocationId;
    const { failure, authorization } = authorize({
      request,
      expectedAudience,
      rolesClaim,
      roleMapping,
      knownTeamKeys,
      requestId,
    });
    if (failure) return failure;

    const selection = readSelection(request);
    if (selection.refusal) return errorResponse(400, selection.refusal, { requestId });

    try {
      const snapshots = await source.readGovernanceSnapshots();
      const usage = await source.readUsageRecords({ registry: snapshots.modelRegistrySnapshot });
      return jsonResponse(
        200,
        projectModels({
          authorization,
          registry: snapshots.modelRegistrySnapshot,
          entitlementSnapshot: snapshots.entitlementSnapshot,
          records: usage.records,
          window: usage.window,
          selection: {
            scope: selection.scope,
            teamKey: selection.teamKey,
            generatedAt: clock.nowIso(),
          },
          viewer: { subjectKey: null },
          providerQuota: await source.readProviderQuota(),
        }),
        { requestId },
      );
    } catch (error) {
      return respondToFailure(error, requestId, context, 'models_failed');
    }
  };
}

export function createUsageHandler({
  source,
  clock,
  expectedAudience,
  roleMapping = ENTRA_ROLE_MAPPING,
  rolesClaim,
  knownTeamKeys = [],
} = {}) {
  assertDependencies({ source, clock, expectedAudience });

  return async function usage(request, context) {
    const requestId = context?.invocationId;
    const { failure, authorization } = authorize({
      request,
      expectedAudience,
      rolesClaim,
      roleMapping,
      knownTeamKeys,
      requestId,
    });
    if (failure) return failure;

    const selection = readSelection(request, { views: USAGE_VIEWS });
    if (selection.refusal) return errorResponse(400, selection.refusal, { requestId });

    try {
      // A usage record's subject key is derived from the subject the gateway
      // forwarded for the caller it governed, while this console's own token is for
      // a different application. No derivation of this caller could ever match it,
      // so self scope is refused before any read rather than rendered as an empty
      // aggregate that reads as "you used nothing".
      if (selection.scope === 'self') {
        const error = new Error('self-scope-not-attributable');
        error.code = 'self-scope-not-attributable';
        throw error;
      }

      const snapshots = await source.readGovernanceSnapshots();
      const reading = await source.readUsageRecords({ registry: snapshots.modelRegistrySnapshot });
      return jsonResponse(
        200,
        projectUsage({
          authorization,
          records: reading.records,
          window: reading.window,
          selection: {
            view: selection.view,
            scope: selection.scope,
            teamKey: selection.teamKey,
            generatedAt: clock.nowIso(),
          },
          viewer: { subjectKey: null },
        }),
        { requestId },
      );
    } catch (error) {
      return respondToFailure(error, requestId, context, 'usage_failed');
    }
  };
}

export function createBudgetsHandler({
  source,
  clock,
  expectedAudience,
  roleMapping = ENTRA_ROLE_MAPPING,
  rolesClaim,
  knownTeamKeys = [],
  windowSeconds,
} = {}) {
  assertDependencies({ source, clock, expectedAudience });
  if (!Number.isSafeInteger(windowSeconds) || windowSeconds < 1) {
    fail('windowSeconds must be a positive integer.');
  }

  return async function budgets(request, context) {
    const requestId = context?.invocationId;
    const { failure, authorization } = authorize({
      request,
      expectedAudience,
      rolesClaim,
      roleMapping,
      knownTeamKeys,
      requestId,
    });
    if (failure) return failure;

    const selection = readSelection(request);
    if (selection.refusal) return errorResponse(400, selection.refusal, { requestId });

    try {
      const snapshots = await source.readGovernanceSnapshots();
      // The same fact the scheduled comparison already refuses on: a budget cannot be
      // priced or capped against models the organization has not entitled at all.
      const allowedModels = resolveGlobalAllowlist(snapshots.entitlementSnapshot);
      if (allowedModels === null) {
        return errorResponse(503, 'reading_unavailable', {
          requestId,
          reasonCode: 'organization-entitlement-absent',
        });
      }

      const evaluationTime = clock.nowIso();
      const publication = publishBudgets({
        budgetSnapshot: snapshots.budgetSnapshot,
        registry: snapshots.modelRegistrySnapshot,
        allowedModels,
        evaluationTime,
      });

      // The usage window is read for the same reason the models screen reads it: the
      // source already states how late it is, and that lag is also this period's own
      // "as of" boundary, so a second threshold is never invented for it here.
      const usage = await source.readUsageRecords({ registry: snapshots.modelRegistrySnapshot });
      const periodEnd = usage.window.windowEnd;

      const entries = publication.entries ?? [];
      let observations = [];
      if (entries.length > 0) {
        const rollups = await source.readRollups();
        const entriesByPeriod = new Map();
        for (const entry of entries) {
          const held = entriesByPeriod.get(entry.period) ?? [];
          held.push(entry);
          entriesByPeriod.set(entry.period, held);
        }
        for (const [period, periodEntries] of entriesByPeriod) {
          const periodStart = startOfPeriod(period, periodEnd);
          // Nothing of this period has happened yet; there is nothing to observe.
          if (periodStart >= periodEnd) continue;
          const scopes = periodEntries.flatMap((entry) => {
            if (entry.scope === 'organization') return [budgetObservationSelector(entry)];
            const keys = scopeKeysInPeriod(rollups, entry.scope, periodStart, periodEnd);
            return keys.map((scopeKey) => budgetObservationSelector({ ...entry, scopeKey }));
          });
          if (scopes.length === 0) continue;
          observations.push(
            ...observePeriodConsumption({ rollups, periodStart, periodEnd, windowSeconds, scopes }),
          );
        }
      }

      const plan = selectFallbackPlan({
        plans: snapshots.fallbackPolicySnapshot.plans,
        applicationId: null,
        subjectId: null,
        teamKey: selection.teamKey,
      });
      const modelSelection =
        plan === null
          ? null
          : {
              // Per contract, because a chain compiles against the contract the request
              // arrived on and a model states which ones it serves.
              contracts: API_FAMILIES.filter(
                (apiFamily) =>
                  compileFallbackPlan({
                    plan,
                    registry: snapshots.modelRegistrySnapshot,
                    allowedModels,
                    evaluationTime,
                    apiFamily,
                  }).enabled,
              ),
              substitutionNotice: plan.substitutionNotice ?? 'header',
              modelSelectionIntent: plan.modelSelectionIntent ?? 'pinned',
            };

      return jsonResponse(
        200,
        projectBudgets({
          authorization,
          publication,
          selection: {
            scope: selection.scope,
            teamKey: selection.teamKey,
            generatedAt: evaluationTime,
          },
          freshness: usage.window.freshness,
          modelSelection,
          observations,
        }),
        { requestId },
      );
    } catch (error) {
      return respondToFailure(error, requestId, context, 'budgets_failed');
    }
  };
}

export function createFallbackHandler({
  source,
  clock,
  expectedAudience,
  roleMapping = ENTRA_ROLE_MAPPING,
  rolesClaim,
  knownTeamKeys = [],
} = {}) {
  assertDependencies({ source, clock, expectedAudience });

  return async function fallback(request, context) {
    const requestId = context?.invocationId;
    const { failure, authorization } = authorize({
      request,
      expectedAudience,
      rolesClaim,
      roleMapping,
      knownTeamKeys,
      requestId,
    });
    if (failure) return failure;

    const selection = readSelection(request);
    if (selection.refusal) return errorResponse(400, selection.refusal, { requestId });

    try {
      const snapshots = await source.readGovernanceSnapshots();
      const evaluationTime = clock.nowIso();
      // An administrator's view of the published configuration for the selected
      // team, never one caller's own entitlement: there is no application or
      // subject behind a deployed console request.
      const plan = selectFallbackPlan({
        plans: snapshots.fallbackPolicySnapshot.plans,
        applicationId: null,
        subjectId: null,
        teamKey: selection.teamKey,
      });
      const allowedModels = resolveGlobalAllowlist(snapshots.entitlementSnapshot) ?? [];
      const compiled =
        plan === null
          ? null
          : API_FAMILIES.map((apiFamily) => ({
              apiFamily,
              compiled: compileFallbackPlan({
                plan,
                registry: snapshots.modelRegistrySnapshot,
                allowedModels,
                evaluationTime,
                apiFamily,
              }),
            }));
      // Offered whether or not a plan exists yet: the first hop an administrator
      // authors is the one they have least help with.
      const candidates = API_FAMILIES.map((apiFamily) => ({
        apiFamily,
        bySource: allowedModels.map((source) => ({
          source,
          ...derivePermittedTargets({
            registry: snapshots.modelRegistrySnapshot,
            allowedModels,
            source,
            apiFamily,
          }),
        })),
      }));

      return jsonResponse(
        200,
        projectFallback({
          authorization,
          plan,
          compiled,
          candidates,
          // A decision is about one live request; the console has none to show.
          decision: null,
          selection: {
            scope: selection.scope,
            teamKey: selection.teamKey,
            generatedAt: evaluationTime,
          },
        }),
        { requestId },
      );
    } catch (error) {
      return respondToFailure(error, requestId, context, 'fallback_failed');
    }
  };
}

export function createLifecycleHandler({
  source,
  clock,
  expectedAudience,
  roleMapping = ENTRA_ROLE_MAPPING,
  rolesClaim,
  knownTeamKeys = [],
  deriveLifecycleActor = null,
} = {}) {
  assertDependencies({ source, clock, expectedAudience });

  return async function lifecycle(request, context) {
    const requestId = context?.invocationId;
    const { failure, authorization, caller } = authorize({
      request,
      expectedAudience,
      rolesClaim,
      roleMapping,
      knownTeamKeys,
      requestId,
    });
    if (failure) return failure;

    const selection = readSelection(request);
    if (selection.refusal) return errorResponse(400, selection.refusal, { requestId });

    try {
      const revisions = await source.readConfigurationRevisions();
      const storedProposalAvailableByRevision =
        typeof source.hasConfigurationDraft === 'function'
          ? Object.fromEntries(await Promise.all(revisions.map(async (revision) => [
            revision.revisionId,
            await source.hasConfigurationDraft({ revisionId: revision.revisionId }),
          ])))
          : null;
      const commandsAvailable = authorization.capabilities.includes('publish-configuration');
      let viewerCode = source.capabilities.defaultLifecycleViewer;
      let selfApprovalGranted = source.capabilities.selfApprovalActors.includes(viewerCode);
      let callerIdentifiable = true;
      if (typeof deriveLifecycleActor === 'function') {
        viewerCode = null;
        selfApprovalGranted = false;
        callerIdentifiable = false;
        if (commandsAvailable) {
          try {
            viewerCode = deriveLifecycleActor(caller);
            selfApprovalGranted = authorization.capabilities.includes('approve-own-configuration');
            callerIdentifiable = true;
          } catch {
            // The screen remains readable, but a caller without an attributable identity
            // cannot be offered an action whose server-side attribution will be refused.
          }
        }
      }
      return jsonResponse(
        200,
        projectLifecycle({
          authorization,
          revisions,
          selection: {
            scope: selection.scope,
            teamKey: selection.teamKey,
            generatedAt: clock.nowIso(),
          },
          viewerCode,
          selfApprovalGranted,
          commandsAvailable,
          recoveryAbandonmentGranted: authorization.capabilities.includes('abandon-legacy-configuration'),
          storedProposalAvailableByRevision,
          callerIdentifiable,
        }),
        { requestId },
      );
    } catch (error) {
      return respondToFailure(error, requestId, context, 'lifecycle_failed');
    }
  };
}

export function createChangeLogHandler({
  source,
  ledger,
  clock,
  expectedAudience,
  roleMapping = ENTRA_ROLE_MAPPING,
  rolesClaim,
  knownTeamKeys = [],
} = {}) {
  assertDependencies({ source, clock, expectedAudience });
  if (typeof ledger?.list !== 'function') fail('ledger is required.');

  return async function changeLog(request, context) {
    const requestId = context?.invocationId;
    const { failure, authorization } = authorize({
      request,
      expectedAudience,
      rolesClaim,
      roleMapping,
      knownTeamKeys,
      requestId,
    });
    if (failure) return failure;

    const selection = readSelection(request);
    if (selection.refusal) return errorResponse(400, selection.refusal, { requestId });

    try {
      const revisions = await source.readConfigurationRevisions();
      // The stored read source declares no notification seed by design; a change log
      // built from it would render every deployed history as having no notification
      // events. The ledger is the durable source of those, so it is read directly.
      let notifications;
      try {
        notifications = await ledger.list({ sinceRaisedAt: SINCE_EVER });
      } catch (error) {
        context?.error?.('Notification ledger read failed.', { reason: error?.name });
        return errorResponse(503, 'reading_unavailable', {
          requestId,
          reasonCode: 'notification-source-unavailable',
        });
      }

      return jsonResponse(
        200,
        projectChangeLog({
          authorization,
          entries: deriveChangeEntries({ revisions, notifications }),
          selection: {
            scope: selection.scope,
            teamKey: selection.teamKey,
            generatedAt: clock.nowIso(),
          },
        }),
        { requestId },
      );
    } catch (error) {
      return respondToFailure(error, requestId, context, 'change_log_failed');
    }
  };
}
