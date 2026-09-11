import { DefaultAzureCredential } from '@azure/identity';

import { createPolicyResolver } from '../control-api/policy-resolution-endpoint.mjs';
import { createPolicyImpactPreview, PolicyImpactPreviewError } from '../control-api/policy-impact-preview.mjs';
import { createGatewayIdentityResolver } from '../control-api/gateway-identity.mjs';
import {
  createGovernancePublisher,
  governancePublicationTargets,
} from '../control-api/governance-publisher.mjs';
import { createDraftAuthor } from '../control-api/draft-authoring.mjs';
import { createGovernanceRemovalService } from '../control-api/governance-removal-service.mjs';
import { createPublishedPolicySource } from '../control-api/published-policy-source.mjs';
import { createStoredMembershipResolver } from '../control-api/stored-membership-resolver.mjs';
import { createTokenClaimsMembershipResolver } from '../control-api/token-claims-membership-resolver.mjs';
import { createDirectoryMembershipResolver } from '../control-api/directory-membership-resolver.mjs';
import { createEntraGroupMembershipQuery } from '../providers/entra-group-membership-query.mjs';
import { createEntraDirectoryQuery } from '../providers/entra-directory-query.mjs';
import { readAccountRegion, readProviderQuota } from '../providers/foundry-quota-query.mjs';
import { readFoundryModelPrices } from '../providers/foundry-price-query.mjs';
import { createStoredGovernanceSource } from '../control-api/stored-governance-source.mjs';
import { createPublishGovernanceHandler } from './handlers/publish-governance.mjs';
import {
  createAccessOptionsHandler,
  createEntitlementChangeHandler,
} from './handlers/admin-access.mjs';
import {
  createAssignmentChangeHandler,
  createTeamChangeHandler,
  createBudgetChangeHandler,
  createFallbackChangeHandler,
} from './handlers/admin-governance-edit.mjs';
import { createModelChangeHandler } from './handlers/admin-model-edit.mjs';
import { createModelPricesHandler } from './handlers/admin-model-prices.mjs';
import {
  createRemovalPlanHandler,
  createRemovalProposalHandler,
} from './handlers/admin-removal.mjs';
import {
  createModelsHandler,
  createUsersGroupsHandler,
  createUsageHandler,
  createBudgetsHandler,
  createFallbackHandler,
  createLifecycleHandler,
  createChangeLogHandler,
} from './handlers/admin-screens.mjs';
import { createRollupProjector } from './handlers/rollup-projector.mjs';
import { createPolicyImpactPreviewHandler } from './handlers/policy-impact-preview.mjs';
import { createScheduledRollupProjector } from '../control-api/scheduled-rollup-projector.mjs';
import { createScheduledDriftDetector } from '../control-api/scheduled-drift-detector.mjs';
import { createScheduledDirectoryProjector } from '../control-api/scheduled-directory-projector.mjs';
import { createAzureMonitorProviderUsage } from '../telemetry/azure-monitor-provider-usage.mjs';
import {
  createAdminNotificationsHandler,
  createAcknowledgeNotificationHandler,
  createNotificationChannelHandler,
} from './handlers/admin-notifications.mjs';
import { createNotificationLedger } from '../control-api/notification-ledger.mjs';
import { createScheduledBudgetNotifications } from '../control-api/scheduled-budget-notifications.mjs';
import { createNotificationDispatcher } from '../control-api/notification-dispatcher.mjs';
import { createWebhookNotificationChannel } from '../control-api/webhook-notification-channel.mjs';
import { createNotificationRetentionSweep } from '../control-api/notification-retention-sweep.mjs';
import { createPublishFailureSweep } from '../control-api/publish-failure-sweep.mjs';
import { resolveOwnerCode, resolveStartedFrom } from './schedule-configuration.mjs';
import { readRoleMapping } from '../governance-domain/authorization/admin-role-authorization.mjs';
import { assertChannelEndpoint } from '../governance-domain/notification/notification-channel.mjs';
import { createPrincipalContextFactory } from '../governance-domain/principal-context/principal-context-factory.mjs';
import { createPrincipalKeyDeriver } from '../governance-domain/identity/principal-key-derivation.mjs';
import { createLogAnalyticsUsageQuery } from '../telemetry/log-analytics-usage-query.mjs';
import { createCosmosClient, createGovernanceStore } from '../persistence/cosmos-governance-store.mjs';
import { createDeterministicIdentityAdapter } from '../local-adapters/deterministic-identity-adapter.mjs';
import { createDeterministicMembershipResolver } from '../local-adapters/deterministic-membership-resolver.mjs';
import { createFixedClock, createSequenceIdGenerator } from '../local-adapters/deterministic-time.mjs';
import { getDeterministicGovernanceSnapshots } from '../local-adapters/deterministic-governance-snapshots.mjs';

/**
 * Builds the dependency graph the functions run against.
 *
 * Both hosts that serve this application - the Functions host and the local
 * development server - construct their handlers from here, so there is one
 * behaviour with two transports rather than two implementations that can drift.
 */

export const EVALUATION_TIME = '2026-07-24T10:00:00.000Z';

export const PERSONAS = Object.freeze({
  'governance-admin': {
    subjectId: 'user-local-admin',
    applicationId: 'app-local-console',
    groupId: 'group-governance-admin',
  },
  auditor: {
    subjectId: 'user-local-auditor',
    applicationId: 'app-local-console',
    groupId: 'group-auditor',
  },
  'end-user': {
    subjectId: 'user-local-end-user',
    applicationId: 'app-local-console',
    groupId: 'group-end-user',
  },
});

/** Mirrors the values the deployed gateway supplies through configuration. */
export const RESOLVER_CONFIG = Object.freeze({
  cacheTtlSeconds: 60,
  warnThresholdPercent: 80,
});

/** Local only, so pseudonyms stay stable within a session. Never a deployed key. */
const LOCAL_DERIVATION_SECRET = 'local-demo-principal-key-secret-not-a-production-value';

export function createLocalIdentifierDeriver() {
  return createPrincipalKeyDeriver({ secret: LOCAL_DERIVATION_SECRET, version: 1 });
}

export function isKnownPersona(personaName) {
  return personaName === undefined || Object.hasOwn(PERSONAS, personaName);
}

export function createPersonaRuntime(personaName, idGenerator, { membershipStatus = 'complete' } = {}) {
  const persona = PERSONAS[personaName];
  if (!persona) throw new TypeError('persona-not-supported');
  const tenantId = 'tenant-local-demo';
  const identity = {
    source: 'local-deterministic',
    validationId: `validation-${personaName}`,
    validatedAt: '2026-07-24T09:55:00.000Z',
    credentialExpiresAt: '2026-07-24T11:00:00.000Z',
    validationState: 'local-trusted',
    subject: { tenantId, subjectId: persona.subjectId, principalType: 'user' },
    application: { applicationId: persona.applicationId, authenticationFlow: 'delegated' },
  };
  const memberships = {
    snapshotId: `snapshot-${personaName}`,
    status: membershipStatus,
    source: 'local-fixture',
    tenantId,
    subjectId: persona.subjectId,
    resolvedAt: '2026-07-24T09:55:00.000Z',
    expiresAt: '2026-07-24T10:30:00.000Z',
    maxAgeSeconds: 2_100,
    sourceRevision: `revision-${personaName}-001`,
    groups:
      membershipStatus === 'complete'
        ? [{ groupId: persona.groupId, membership: 'direct', authorizationRelevant: true }]
        : [],
  };
  if (membershipStatus !== 'complete') {
    memberships.reason = `local-${membershipStatus}-membership`;
  }
  return {
    identityAdapter: createDeterministicIdentityAdapter(identity),
    factory: createPrincipalContextFactory({
      membershipResolver: createDeterministicMembershipResolver([
        { tenantId, subjectId: persona.subjectId, memberships },
      ]),
      clock: createFixedClock(EVALUATION_TIME),
      idGenerator,
    }),
  };
}

export function createLocalPolicyResolver(personaName, idGenerator, snapshotProvider = () => getDeterministicGovernanceSnapshots()) {
  const runtime = createPersonaRuntime(personaName, idGenerator);
  return createPolicyResolver({
    deriver: createLocalIdentifierDeriver(),
    scopeGroupId: 'organization',
    snapshotProvider,
    principalContextFactory: runtime.factory,
    identityResolver: () => runtime.identityAdapter.getVerifiedIdentity(),
    clock: createFixedClock(EVALUATION_TIME),
    config: RESOLVER_CONFIG,
  });
}

/**
 * Resolution is per caller, so the resolver is built per request from the
 * persona in the body. A deployed build resolves the caller from the validated
 * token instead and builds the resolver once.
 */
export function createPersonaScopedResolver(idGenerator) {
  return {
    resolve(body) {
      // The snapshot source is never taken from the body: it decides which governance
      // evidence resolution trusts, and that is not a caller's to choose.
      const resolver = createLocalPolicyResolver(body?.persona ?? 'end-user', idGenerator);
      return resolver.resolve(body);
    },
  };
}

/**
 * A deployed gateway must never receive deterministic fixture policy as if it
 * were caller-specific governance. Until the durable published-policy source is
 * wired, report the dependency as unavailable and let APIM apply its explicit,
 * conservative deployment default.
 */
export function createUnavailablePolicyResolver(reasonCode = 'published-policy-source-unavailable') {
  return Object.freeze({
    async resolve() {
      const error = new Error(reasonCode);
      error.name = 'PolicySourceUnavailableError';
      throw error;
    },
  });
}

/**
 * Resolution from published governance, for a deployment.
 *
 * Three inputs have to be real before a caller-specific answer is possible: the
 * published snapshots, membership evidence for the caller, and a derivation secret.
 * The first two report themselves absent and degrade; the third cannot, because a
 * pseudonym derived from a stand-in secret is indistinguishable from a real one and
 * would silently attribute usage to identifiers nothing else agrees with. So a missing
 * secret refuses here, and the caller keeps the resolver that reports unavailable.
 */
export function createPublishedPolicyResolver({ store, scopeGroupId, clock, secret, config = RESOLVER_CONFIG, membershipSource = 'store' }) {
  const deriver = createPrincipalKeyDeriver({ secret, version: 1 });
  return createPolicyResolver({
    deriver,
    scopeGroupId,
    snapshotProvider: createPublishedPolicySource({ store, scopeGroupId, clock }),
    principalContextFactory: createPrincipalContextFactory({
      membershipResolver: createMembershipResolver({ membershipSource, store, scopeGroupId, clock }),
      clock,
      idGenerator: createSequenceIdGenerator('policy'),
    }),
    identityResolver: createGatewayIdentityResolver({ clock }),
    clock,
    config,
  });
}

/**
 * The screens whose readings a deployment already produced and could not serve.
 *
 * Every one of them reads through the same source, so adding another is a route each
 * rather than another way of reading. Budget, fallback, and assignment authoring
 * have dedicated handlers; lifecycle exposes only stored-proposal approval and retry.
 */
export function createDeployedScreenHandlers(
  environment = process.env,
  clock = { nowIso: () => new Date().toISOString() },
) {
  const source = createGovernanceReadSource(environment, clock);
  if (source === null) return null;

  // The same derivation the roster was written with, so the caller can be found in it.
  // Without the secret the roster is still served; only "which of these is me" is
  // unanswerable, and the screen says so rather than guessing.
  const secret = environment.PRINCIPAL_KEY_SECRET;
  const deriver =
    typeof secret === 'string' && secret.length > 0
      ? createPrincipalKeyDeriver({ secret, version: 1 })
      : null;
  const shared = {
    source,
    clock,
    expectedAudience: environment.CONTROL_PLANE_AUDIENCE ?? '',
    roleMapping: readRoleMapping(environment),
    rolesClaim: environment.GOVERNANCE_ROLES_CLAIM,
    knownTeamKeys: KNOWN_TEAM_KEYS,
    deriveLifecycleActor: deriver === null
      ? null
      : (caller) => deriver.deriveActorCode({ tenantId: caller.tenantId, subjectId: caller.objectId }),
  };
  const deriveDirectoryCode = deriver === null ? null : (identity) => deriver.deriveActorCode(identity);

  // The change log's notifications come from the durable ledger, never from the read
  // source: a stored source declares an empty seed by design, which would render every
  // deployed change log as having no notification events. Without a store there is no
  // ledger to read, so that one route is left unregistered rather than served empty.
  const store = createGovernanceStoreFromEnvironment(environment);
  const ledger = store === null ? null : createNotificationLedger({ store, scopeGroupId: ROLLUP_CONFIG.scopeGroupId });

  return {
    usersGroups: createUsersGroupsHandler({ ...shared, deriveDirectoryCode }),
    models: createModelsHandler(shared),
    usage: createUsageHandler(shared),
    budgets: createBudgetsHandler({ ...shared, windowSeconds: ROLLUP_CONFIG.windowSeconds }),
    fallback: createFallbackHandler(shared),
    lifecycle: createLifecycleHandler(shared),
    audit: ledger === null ? null : createChangeLogHandler({ ...shared, ledger }),
  };
}

export function createPolicyImpactCallerIdentity(target, evaluatedAt) {
  if (!['delegated', 'application'].includes(target.authenticationFlow)) {
    throw new TypeError('The preview requires an established authentication flow.');
  }
  return createGatewayIdentityResolver({ clock: { nowIso: () => evaluatedAt } })({
    tenantId: target.tenantId,
    subjectId: target.subjectId,
    applicationId: target.applicationId,
    authenticationFlow: target.authenticationFlow,
    ...(target.groups === undefined ? {} : { groups: target.groups }),
  });
}

export function createPolicyImpactPreviewFromStore({
  store,
  scopeGroupId,
  deriver,
  membershipSource,
  clock,
}) {
  const readActiveSnapshots = createPublishedPolicySource({ store, scopeGroupId, clock });
  return createPolicyImpactPreview({
    clock,
    readActiveSnapshots,
    async readDraft({ revisionId }) {
      const held = await store.readConfigurationDraft({ scopeGroupId, revisionId });
      return held?.document ?? null;
    },
    async readRevision({ revisionId }) {
      const held = await store.readConfigurationRevision({ scopeGroupId, revisionId });
      return held?.document ?? null;
    },
    async readActiveRevision() {
      return selectActiveRevision(await store.queryConfigurationRevisions({ scopeGroupId }));
    },
    async resolvePolicy({ snapshots, request, targetContext, evaluatedAt }) {
      if (
        membershipSource === 'directory-claim'
        && targetContext?.authenticationFlow === 'delegated'
        && !Array.isArray(targetContext.groups)
      ) {
        throw new PolicyImpactPreviewError('caller-policy-evidence-unavailable');
      }
      const evaluationClock = { nowIso: () => evaluatedAt };
      const resolver = createPolicyResolver({
        deriver,
        scopeGroupId,
        snapshotProvider: async () => snapshots,
        principalContextFactory: createPrincipalContextFactory({
          membershipResolver: createMembershipResolver({
            membershipSource,
            store,
            scopeGroupId,
            clock: evaluationClock,
          }),
          clock: evaluationClock,
          idGenerator: createSequenceIdGenerator('preview'),
        }),
        identityResolver: async () => createPolicyImpactCallerIdentity(targetContext, evaluatedAt),
        clock: evaluationClock,
        config: RESOLVER_CONFIG,
      });
      return resolver.resolve(request);
    },
  });
}

export function createDeployedPolicyImpactPreviewHandler(
  environment = process.env,
  clock = { nowIso: () => new Date().toISOString() },
) {
  const store = createGovernanceStoreFromEnvironment(environment);
  const deriver = createDeployedActorDeriver(environment);
  if (store === null || deriver === null) return null;
  return createPolicyImpactPreviewHandler({
    preview: createPolicyImpactPreviewFromStore({
      store,
      scopeGroupId: ROLLUP_CONFIG.scopeGroupId,
      deriver,
      membershipSource: readMembershipSource(environment),
      clock,
    }),
    expectedAudience: environment.CONTROL_PLANE_AUDIENCE ?? '',
    roleMapping: readRoleMapping(environment),
    rolesClaim: environment.GOVERNANCE_ROLES_CLAIM,
    knownTeamKeys: KNOWN_TEAM_KEYS,
  });
}

/**
 * The roster behind the users-and-groups screen, or nothing.
 *
 * Needs a store to write to, the pseudonym secret so no directory object identifier is
 * stored raw, and the tenant the governed groups live in. Any of them missing means the
 * screen keeps saying it has no reading, which is true.
 */
export function createDeployedDirectoryProjector(
  environment = process.env,
  clock = { nowIso: () => new Date().toISOString() },
) {
  const store = createGovernanceStoreFromEnvironment(environment);
  const secret = environment.PRINCIPAL_KEY_SECRET;
  if (store === null || !secret) return null;

  const deriver = createPrincipalKeyDeriver({ secret, version: 1 });
  return createScheduledDirectoryProjector({
    store,
    readPublishedSnapshots: createPublishedPolicySource({
      store,
      scopeGroupId: ROLLUP_CONFIG.scopeGroupId,
      clock,
    }),
    readGovernedDirectory: createEntraDirectoryQuery({
      createCredential: () => new DefaultAzureCredential(),
      // The actor code, not the subject key: its alphabet is what a directory record
      // accepts, and it is not the caller pseudonym, which is derived from a different
      // identifier and must not look joinable to this one.
      deriveDirectoryCode: (identity) => deriver.deriveActorCode(identity),
    }),
    clock,
    scopeGroupId: ROLLUP_CONFIG.scopeGroupId,
  });
}

/**
 * The deployed resolver when everything it needs is configured, and the one that
 * reports unavailable when it is not. The gateway answer is the same either way; what
 * differs is whether a caller-specific policy is possible at all.
 */
export function createDeployedPolicyResolver(environment = process.env, clock = { nowIso: () => new Date().toISOString() }) {
  const store = createGovernanceStoreFromEnvironment(environment);
  const secret = environment.PRINCIPAL_KEY_SECRET;
  if (store === null || typeof secret !== 'string' || secret.length === 0) {
    return createUnavailablePolicyResolver();
  }
  try {
    // Inside the try on purpose. A setting that has stopped mattering must be loud, but a
    // host that will not start cannot be read, and every caller is now refused when this
    // resolver is absent -- so the loudness has to arrive as a named refusal, not a crash.
    assertNoWithdrawnDegradedSetting(environment);
    return createPublishedPolicyResolver({
      store,
      scopeGroupId: ROLLUP_CONFIG.scopeGroupId,
      clock,
      secret,
      membershipSource: readMembershipSource(environment),
    });
  } catch (fault) {
    // A refused secret is a configuration fault, not a request fault. Reporting the
    // source unavailable keeps the gateway on its default instead of failing to start.
    return createUnavailablePolicyResolver(fault?.reasonCode ?? 'published-policy-source-unavailable');
  }
}

/**
 * The recovering schedule, or nothing.
 *
 * The recovery logic is only worth anything against a store that survives the
 * process: a checkpoint in memory records what an instance owes to itself, which is
 * not a claim about restarts. Without a durable store the ordinary timer runs and the
 * deployment says so, rather than appearing to recover and recovering nothing.
 */
export function createDeployedRollupSchedule(environment = process.env, clock = { nowIso: () => new Date().toISOString() }) {
  const store = createGovernanceStoreFromEnvironment(environment);
  if (store === null) return null;

  const projector = createRollupProjector({
    usageQuery: createUsageQuery(environment),
    rollupStore: store,
    recordSink: store,
    readModelRegistry: createModelRegistryReader(environment, clock),
    clock,
    config: ROLLUP_CONFIG,
  });

  return createScheduledRollupProjector({
    projector,
    store,
    clock,
    scopeGroupId: ROLLUP_CONFIG.scopeGroupId,
    windowSeconds: ROLLUP_CONFIG.windowSeconds,
    ingestionLagSeconds: ROLLUP_CONFIG.ingestionLagSeconds,
    startedFrom: resolveStartedFrom(environment, clock, ROLLUP_CONFIG.windowSeconds),
    ownerCode: resolveOwnerCode(environment),
    leaseSeconds: SCHEDULE_LEASE_SECONDS,
    maxBackfillWindows: MAXIMUM_BACKFILL_WINDOWS,
  });
}

/**
 * Comparing each closed window against the provider's own meter, or not at all.
 *
 * Two things have to be present: a store to read the aggregates from, and a provider
 * resource to compare against. A deployment that names no provider has nothing to
 * compare with, and a detector that treated the missing side as zero would dispute
 * every window it ever read.
 */
export function createDeployedDriftSchedule(environment = process.env, clock = { nowIso: () => new Date().toISOString() }) {
  const store = createGovernanceStoreFromEnvironment(environment);
  if (store === null) return null;

  const resourceId = environment.PROVIDER_ACCOUNT_RESOURCE_ID;
  if (!resourceId) return null;

  return createScheduledDriftDetector({
    store,
    ledger: createNotificationLedger({ store, scopeGroupId: ROLLUP_CONFIG.scopeGroupId }),
    providerUsage: createAzureMonitorProviderUsage({
      resourceId,
      credential: new DefaultAzureCredential(),
    }),
    clock,
    scopeGroupId: ROLLUP_CONFIG.scopeGroupId,
    windowSeconds: ROLLUP_CONFIG.windowSeconds,
    // The comparison follows the aggregation rather than racing it: a window the
    // rollup has not been written for yet would be disputed as missing.
    ingestionLagSeconds: ROLLUP_CONFIG.ingestionLagSeconds + ROLLUP_CONFIG.windowSeconds,
    startedFrom: resolveStartedFrom(environment, clock, ROLLUP_CONFIG.windowSeconds),
    ownerCode: resolveOwnerCode(environment),
    leaseSeconds: SCHEDULE_LEASE_SECONDS,
    maxBackfillWindows: MAXIMUM_BACKFILL_WINDOWS,
  });
}

/**
 * The notifications screen, and the acknowledgement it offers.
 *
 * Both need the durable ledger; acknowledgement additionally needs the derivation
 * secret, because it records who acted and a stand-in secret would name an actor
 * nothing else agrees with. Without either, the route is not offered at all rather
 * than offered and failing, which would read as an outage.
 */
export function createDeployedAdminNotificationsHandler(
  environment = process.env,
  clock = { nowIso: () => new Date().toISOString() },
) {
  const store = createGovernanceStoreFromEnvironment(environment);
  if (store === null) return null;

  return createAdminNotificationsHandler({
    ledger: createNotificationLedger({ store, scopeGroupId: ROLLUP_CONFIG.scopeGroupId }),
    expectedAudience: environment.CONTROL_PLANE_AUDIENCE ?? '',
    clock,
    knownTeamKeys: KNOWN_TEAM_KEYS,
    roleMapping: readRoleMapping(),
    rolesClaim: environment.GOVERNANCE_ROLES_CLAIM,
  });
}

export function createDeployedAcknowledgeNotificationHandler(
  environment = process.env,
  clock = { nowIso: () => new Date().toISOString() },
) {
  const store = createGovernanceStoreFromEnvironment(environment);
  const secret = environment.PRINCIPAL_KEY_SECRET;
  if (store === null || typeof secret !== 'string' || secret.length === 0) return null;

  return createAcknowledgeNotificationHandler({
    ledger: createNotificationLedger({ store, scopeGroupId: ROLLUP_CONFIG.scopeGroupId }),
    deriver: createPrincipalKeyDeriver({ secret, version: 1 }),
    expectedAudience: environment.CONTROL_PLANE_AUDIENCE ?? '',
    clock,
    knownTeamKeys: KNOWN_TEAM_KEYS,
    roleMapping: readRoleMapping(),
    rolesClaim: environment.GOVERNANCE_ROLES_CLAIM,
  });
}

export function createDeployedNotificationChannelHandler(
  environment = process.env,
  clock = { nowIso: () => new Date().toISOString() },
) {
  const store = createGovernanceStoreFromEnvironment(environment);
  const secret = environment.PRINCIPAL_KEY_SECRET;
  if (store === null || typeof secret !== 'string' || secret.length === 0) return null;

  return createNotificationChannelHandler({
    store,
    deriver: createPrincipalKeyDeriver({ secret, version: 1 }),
    scopeGroupId: ROLLUP_CONFIG.scopeGroupId,
    expectedAudience: environment.CONTROL_PLANE_AUDIENCE ?? '',
    clock,
    knownTeamKeys: KNOWN_TEAM_KEYS,
    roleMapping: readRoleMapping(),
    rolesClaim: environment.GOVERNANCE_ROLES_CLAIM,
  });
}

/**
 * Delivering what has been raised, or nothing.
 *
 * The recipient is whichever an administrator chose, read on every run so that
 * choosing one takes effect on the next tick rather than the next deployment. A
 * deployment may also name a fixed endpoint, which is how a generic recipient is
 * reached: that value is set by whoever deploys rather than by an administrator, and
 * the two are not the same trust. Where neither exists the run is quiet rather than a
 * ledger filling with attempts against a channel nobody chose.
 */
export function createDeployedNotificationDispatcher(
  environment = process.env,
  clock = { nowIso: () => new Date().toISOString() },
  {
    store: suppliedStore,
    createWebhookChannel = createWebhookNotificationChannel,
  } = {},
) {
  const store = suppliedStore ?? createGovernanceStoreFromEnvironment(environment);
  if (store === null) return null;

  const deployedEndpoint = environment.NOTIFICATION_WEBHOOK_ENDPOINT ?? '';
  // The configured endpoint is a deployment error, not a delivery error. Validate it
  // while the host starts so a bad secret reference cannot remain dormant until a
  // notification is due.
  if (deployedEndpoint.length > 0) assertChannelEndpoint(deployedEndpoint);
  const deployedChannel = deployedEndpoint.length === 0
    ? null
    : createWebhookChannel({ endpoint: deployedEndpoint });

  return createNotificationDispatcher({
    ledger: createNotificationLedger({ store, scopeGroupId: ROLLUP_CONFIG.scopeGroupId }),
    async resolveChannel() {
      const held = await store.readNotificationChannel({ scopeGroupId: ROLLUP_CONFIG.scopeGroupId });
      if (held !== null) {
        return createWebhookChannel({
          endpoint: held.document.endpoint,
          channelKind: held.document.channelKind,
          channelCode: `operations-${held.document.channelKind}`,
        });
      }
      return deployedChannel;
    },
    // The dispatcher refuses an interval longer than the delay the product promises,
    // so the schedule below cannot drift past it without failing at startup.
    intervalSeconds: NOTIFICATION_DISPATCH_INTERVAL_SECONDS,
    clock,
  });
}

/**
 * Comparing published budgets against what the period consumed, or nothing.
 *
 * Needs the published set as well as the store: a budget is only a number until the
 * catalogue prices it and the organization entitlement says which models it may be
 * spent on. Where nothing is published the run reports that, rather than a period
 * that earned no warnings.
 */
export function createDeployedBudgetNotifications(environment = process.env, clock = { nowIso: () => new Date().toISOString() }) {
  const store = createGovernanceStoreFromEnvironment(environment);
  if (store === null) return null;

  return createScheduledBudgetNotifications({
    store,
    ledger: createNotificationLedger({ store, scopeGroupId: ROLLUP_CONFIG.scopeGroupId }),
    readPublishedSnapshots: createPublishedPolicySource({
      store,
      scopeGroupId: ROLLUP_CONFIG.scopeGroupId,
      clock,
    }),
    clock,
    scopeGroupId: ROLLUP_CONFIG.scopeGroupId,
    windowSeconds: ROLLUP_CONFIG.windowSeconds,
    // The comparison follows the aggregation rather than racing it: a window the
    // rollup has not been written for yet reads as a gap in the period.
    ingestionLagSeconds: ROLLUP_CONFIG.ingestionLagSeconds + ROLLUP_CONFIG.windowSeconds,
  });
}

/**
 * Sweeps that need no source beyond the store. A failure recorded while notifications
 * were unavailable is re-derived from the stored revisions, and acknowledged
 * notifications are removed once they are older than the retention period.
 */
export function createDeployedNotificationSweeps(environment = process.env, clock = { nowIso: () => new Date().toISOString() }) {
  const store = createGovernanceStoreFromEnvironment(environment);
  if (store === null) return null;

  const ledger = createNotificationLedger({ store, scopeGroupId: ROLLUP_CONFIG.scopeGroupId });
  return Object.freeze({
    publishFailures: createPublishFailureSweep({
      store,
      ledger,
      clock,
      scopeGroupId: ROLLUP_CONFIG.scopeGroupId,
    }),
    retention: createNotificationRetentionSweep({
      store,
      ledger,
      clock,
      scopeGroupId: ROLLUP_CONFIG.scopeGroupId,
      startedFrom: resolveStartedFrom(environment, clock, ROLLUP_CONFIG.windowSeconds),
      ownerCode: resolveOwnerCode(environment),
      leaseSeconds: SCHEDULE_LEASE_SECONDS,
      retentionDays: NOTIFICATION_RETENTION_DAYS,
    }),
  });
}

/**
 * The publication route, or nothing. The store is closed to the public network, so a
 * governance set can only be written from inside it; without a store there is nothing
 * to write to and the route is not offered rather than offered and broken.
 */
export function createDeployedPublishGovernanceHandler(
  environment = process.env,
  clock = { nowIso: () => new Date().toISOString() },
) {
  const store = createGovernanceStoreFromEnvironment(environment);
  const deriver = createDeployedActorDeriver(environment);
  if (store === null || deriver === null) return null;

  return createPublishGovernanceHandler({
    store,
    publisher: createGovernancePublisher({ store, scopeGroupId: ROLLUP_CONFIG.scopeGroupId, clock }),
    clock,
    scopeGroupId: ROLLUP_CONFIG.scopeGroupId,
    expectedAudience: environment.CONTROL_PLANE_AUDIENCE ?? '',
    roleMapping: readRoleMapping(environment),
    rolesClaim: environment.GOVERNANCE_ROLES_CLAIM,
    deriver,
  });
}

/**
 * Every authoring route the deployed control plane offers, or nothing. Same reason as
 * the publication route: without a store there is nothing published to read, nothing
 * to change, and nowhere to write the result, so the routes are not offered rather
 * than offered and broken.
 *
 * One shared reading, one shared publisher, and one shared actor deriver keep the
 * routes aligned; they differ only in which domain edit function they apply and which
 * capability they ask for.
 */
export function createDeployedAccessAuthoringHandlers(
  environment = process.env,
  clock = { nowIso: () => new Date().toISOString() },
) {
  const store = createGovernanceStoreFromEnvironment(environment);
  const deriver = createDeployedActorDeriver(environment);
  if (store === null || deriver === null) return null;

  const shared = {
    readPublishedSnapshots: createPublishedPolicySource({
      store,
      scopeGroupId: ROLLUP_CONFIG.scopeGroupId,
      clock,
    }),
    clock,
    expectedAudience: environment.CONTROL_PLANE_AUDIENCE ?? '',
    roleMapping: readRoleMapping(environment),
    rolesClaim: environment.GOVERNANCE_ROLES_CLAIM,
    store,
    publisher: createGovernancePublisher({ store, scopeGroupId: ROLLUP_CONFIG.scopeGroupId, clock }),
    scopeGroupId: ROLLUP_CONFIG.scopeGroupId,
    deriver,
  };

  const readProviderDeployments = createProviderQuotaReader(environment, clock);
  const removalService = createGovernanceRemovalService({
    readPublishedSnapshots: shared.readPublishedSnapshots,
    drafts: createDraftAuthor({
      store,
      scopeGroupId: ROLLUP_CONFIG.scopeGroupId,
      clock,
      targets: governancePublicationTargets({ includeMembership: false }),
    }),
    clock,
  });

  return {
    accessOptions: createAccessOptionsHandler(shared),
    changeEntitlement: createEntitlementChangeHandler(shared),
    changeBudget: createBudgetChangeHandler(shared),
    changeFallbackPlan: createFallbackChangeHandler(shared),
    changeAssignment: createAssignmentChangeHandler(shared),
    changeTeam: createTeamChangeHandler(shared),
    removalPlan: createRemovalPlanHandler({ ...shared, service: removalService }),
    removalProposal: createRemovalProposalHandler({ ...shared, service: removalService }),
    // Capturing a model requires the provider's own answer about the deployment, so
    // where no account is configured this route is absent rather than present and
    // failing. The other four do not depend on it and stay.
    changeModel:
      readProviderDeployments === null
        ? null
        : createModelChangeHandler({ ...shared, readProviderDeployments }),
    // Reference only, and read-only. Absent for the same reason as capture: without
    // the deployments there is nothing to match the published meters against.
    modelPrices:
      readProviderDeployments === null
        ? null
        : createModelPricesHandler({
            readProviderDeployments,
            readModelPrices: createModelPriceReader(environment),
            region: environment.PROVIDER_ACCOUNT_REGION ?? null,
            expectedAudience: shared.expectedAudience,
            roleMapping: shared.roleMapping,
            rolesClaim: shared.rolesClaim,
            clock,
          }),
  };
}

/**
 * The published price list for the account's own region.
 *
 * The list is public and unauthenticated, so this needs no grant; what it does need is
 * the region, which is read from the account rather than configured so there is no
 * second setting that can disagree with the account it describes.
 */
export function createModelPriceReader(environment = process.env) {
  const resourceId = environment.PROVIDER_ACCOUNT_RESOURCE_ID;
  if (!resourceId) return null;

  const parsed = /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.CognitiveServices\/accounts\/([^/]+)$/i
    .exec(resourceId);
  if (parsed === null) return null;

  const [, subscriptionId, resourceGroupName, accountName] = parsed;
  const account = { subscriptionId, resourceGroupName, accountName, credential: new DefaultAzureCredential() };
  return async () => readFoundryModelPrices({ region: await readAccountRegion(account) });
}

/**
 * Administrative writes require the same deployment-owned key as principal
 * pseudonymization. An absent or rejected key leaves authoring unregistered
 * rather than allowing a shared or fixture actor to be persisted.
 */
function createDeployedActorDeriver(environment) {
  const secret = environment.PRINCIPAL_KEY_SECRET;
  if (typeof secret !== 'string' || secret.length === 0) return null;
  try {
    return createPrincipalKeyDeriver({ secret, version: 1 });
  } catch {
    return null;
  }
}

const SAFE_GOVERNANCE_KEY = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const DEFAULT_SCOPE_GROUP_ID = 'platform-engineering';
const DEFAULT_KNOWN_TEAM_KEYS = Object.freeze(['developer-experience', 'platform-engineering']);

export function readGovernanceScopeGroupId(environment = process.env) {
  const configured = environment.GOVERNANCE_SCOPE_GROUP_ID;
  if (configured === undefined) return DEFAULT_SCOPE_GROUP_ID;
  if (!SAFE_GOVERNANCE_KEY.test(configured)) {
    throw new TypeError('GOVERNANCE_SCOPE_GROUP_ID must be a lowercase alphanumeric key with interior hyphens.');
  }
  return configured;
}

export function readGovernanceKnownTeamKeys(environment = process.env) {
  const configured = environment.GOVERNANCE_KNOWN_TEAM_KEYS;
  if (configured === undefined) return DEFAULT_KNOWN_TEAM_KEYS;
  const keys = configured.split(',');
  if (keys.length === 0 || keys.some((key) => !SAFE_GOVERNANCE_KEY.test(key))) {
    throw new TypeError('GOVERNANCE_KNOWN_TEAM_KEYS must be a comma-separated list of lowercase alphanumeric keys with interior hyphens.');
  }
  if (new Set(keys).size !== keys.length) {
    throw new TypeError('GOVERNANCE_KNOWN_TEAM_KEYS must not repeat a team key.');
  }
  if (keys.join(',') !== [...keys].sort().join(',')) {
    throw new TypeError('GOVERNANCE_KNOWN_TEAM_KEYS must be sorted.');
  }
  return Object.freeze(keys);
}

export const ROLLUP_CONFIG = Object.freeze({
  scopeGroupId: readGovernanceScopeGroupId(),
  windowSeconds: 3600,
  ingestionLagSeconds: 300,
  rowLimit: 500_000,
});

// Long enough that a slow window does not lose its lease mid-run, short enough that a
// runner which died holding one does not stop the schedule for an hour.
export const SCHEDULE_LEASE_SECONDS = 600;
// One outage must not produce an unbounded run; what it declines is recorded.
export const MAXIMUM_BACKFILL_WINDOWS = 48;
export const NOTIFICATION_RETENTION_DAYS = 90;
// Inside the five minutes the product promises, with room for a run to overrun its
// slot without the next one starting late.
export const NOTIFICATION_DISPATCH_INTERVAL_SECONDS = 120;

/** Teams a global reader may select. Server-owned, never taken from a request. */
export const KNOWN_TEAM_KEYS = readGovernanceKnownTeamKeys();

/**
 * Configuration state is published by the control plane rather than measured by the
 * usage source, so a report is supplied it rather than deriving it from rollups.
 *
 * This is the local fixture value only. A deployment reads its own answer through
 * `createDeployedConfigurationSummaryReader`, below.
 */
export const PUBLISHED_CONFIGURATION = Object.freeze({
  activeVersion: 'cfg-local-003',
  state: 'active',
  publishedAt: '2026-07-24T09:30:00.000Z',
});

/** Every value `readConfigurationSummary()` may report for `state`. */
export const CONFIGURATION_SUMMARY_STATES = Object.freeze(['active', 'no-active-revision', 'unavailable']);

function selectActiveRevision(revisions) {
  return revisions
    .filter((revision) => revision.state === 'active')
    // Mirrors the Publishing screen's own tie-break, so the two screens cannot name
    // different revisions as active if more than one were ever left in that state.
    .reduce((newest, revision) => (
      newest === null || revision.revisionNumber > newest.revisionNumber ? revision : newest
    ), null);
}

const UNAVAILABLE_CONFIGURATION_SUMMARY = Object.freeze({
  activeVersion: null,
  state: 'unavailable',
  publishedAt: null,
});

/**
 * The configuration genuinely serving a deployment, read from the same revisions the
 * Publishing screen renders, so the two screens cannot disagree about what is active.
 *
 * Nothing published and a source that cannot be read are reported as themselves,
 * never as an active configuration - a fabricated `publishedAt` would be worse than
 * neither.
 */
export function createConfigurationSummaryReader({ store, scopeGroupId }) {
  if (typeof store?.queryConfigurationRevisions !== 'function') {
    throw new TypeError('store is required.');
  }
  if (typeof scopeGroupId !== 'string' || scopeGroupId.length === 0) {
    throw new TypeError('scopeGroupId is required.');
  }

  return async function readConfigurationSummary() {
    let revisions;
    try {
      revisions = await store.queryConfigurationRevisions({ scopeGroupId });
    } catch {
      return UNAVAILABLE_CONFIGURATION_SUMMARY;
    }
    const active = selectActiveRevision(revisions);
    if (active === null) {
      return { activeVersion: null, state: 'no-active-revision', publishedAt: null };
    }
    return { activeVersion: active.revisionId, state: 'active', publishedAt: active.publishCompletedAt };
  };
}

/** A deployment with no durable store has nothing to read; anything else delegates. */
export function createDeployedConfigurationSummaryReader(environment = process.env) {
  const store = createGovernanceStoreFromEnvironment(environment);
  if (store === null) {
    return async function readConfigurationSummary() {
      return UNAVAILABLE_CONFIGURATION_SUMMARY;
    };
  }
  return createConfigurationSummaryReader({ store, scopeGroupId: ROLLUP_CONFIG.scopeGroupId });
}

/**
 * Stands in for the diagnostic log query until a deployed build supplies one.
 * It reports an unavailable source rather than an empty window, so a local run
 * exercises the degraded path instead of fabricating a quiet hour.
 */
export function createLocalUsageQuery() {
  return {
    async readWindow() {
      return { rows: [], state: 'unavailable', rowCount: 0, revision: 'local-no-log-source' };
    },
  };
}

/**
 * A deployment that names a workspace reads real usage; anything else keeps the
 * local placeholder. The projector cannot tell the difference, because an
 * unconfigured source and a broken one both report unavailable.
 */
export function createUsageQuery(environment = process.env) {
  const workspaceId = environment.USAGE_WORKSPACE_ID;
  if (!workspaceId) return createLocalUsageQuery();

  return createLogAnalyticsUsageQuery({
    workspaceId,
    apiId: environment.GOVERNED_API_ID ?? 'inference',
    credential: new DefaultAzureCredential(),
    rowLimit: ROLLUP_CONFIG.rowLimit,
  });
}

export function createLocalRollupSink() {
  const written = [];
  const records = [];
  return {
    durability: 'ephemeral',
    written,
    records,
    async putRollup(document) {
      written.push(document);
      return { document };
    },
    async queryRollupWindows() {
      return written;
    },
    async putUsageRecord(document) {
      const held = records.find((candidate) => candidate.id === document.id);
      if (held !== undefined) return { document: held, created: false };
      records.push(document);
      return { document, created: true };
    },
    async queryUsageRecords() {
      return records;
    },
  };
}

/**
 * A deployment that names a store persists rollups; anything else keeps them in
 * memory. The two are not interchangeable, so the sink reports which it is and
 * the projector run says so in its log: a run that claims to have written a
 * document when nothing was persisted is worse than one that fails outright.
 */
export function createRollupStore(environment = process.env) {
  const store = createGovernanceStoreFromEnvironment(environment);
  if (store === null) return createLocalRollupSink();

  return Object.freeze({
    durability: 'durable',
    putRollup: store.putRollup,
    readRollup: store.readRollup,
    queryRollupWindows: store.queryRollupWindows,
    putUsageRecord: store.putUsageRecord,
    queryUsageRecords: store.queryUsageRecords,
  });
}

/**
 * The published catalogue, for the fields a record carries that an aggregate cannot:
 * which provider served it, what it cost, and under which configuration version those
 * were decided. Nothing published means no record rather than a record priced at zero.
 */
export function createModelRegistryReader(environment = process.env, clock = { nowIso: () => new Date().toISOString() }) {
  const store = createGovernanceStoreFromEnvironment(environment);
  if (store === null) return null;

  const readPublished = createPublishedPolicySource({
    store,
    scopeGroupId: ROLLUP_CONFIG.scopeGroupId,
    clock,
  });
  return async () => {
    try {
      const snapshots = await readPublished();
      return snapshots.modelRegistrySnapshot ?? null;
    } catch {
      return null;
    }
  };
}

/**
 * Screens read from the durable store when a deployment names one, and from the
 * development fixtures when it does not.
 *
 * The two implementations answer the same eleven reads, so a screen does not know
 * which it is talking to — but it is told: the source names its kind and durability,
 * and declares a narrower set of selectable states, so a deployment refuses a
 * development affordance rather than answering it with real data.
 */
export function createGovernanceReadSource(environment = process.env, clock = { nowIso: () => new Date().toISOString() }) {
  const store = createGovernanceStoreFromEnvironment(environment);
  if (store === null) return null;

  return createStoredGovernanceSource({
    store,
    scopeGroupId: ROLLUP_CONFIG.scopeGroupId,
    clock,
    lifecycleViewer: environment.GOVERNANCE_DEFAULT_VIEWER ?? 'governance-administrator',
    selfApprovalActors: (environment.GOVERNANCE_SELF_APPROVERS ?? '')
      .split(',')
      .map((actor) => actor.trim())
      .filter((actor) => actor.length > 0),
    readProviderQuota: createProviderQuotaReader(environment, clock),
  });
}

/**
 * Reading the provider's own view of what it will serve, or deciding not to.
 *
 * A working reader existed and only a human command-line tool called it, so a
 * deployment could only ever report the allocation as not collected. It needs the same
 * account the drift detector compares against, and the identity's Monitoring Reader
 * grant on that account already covers the per-deployment read.
 *
 * The subscription-wide allocation pool sits at a different scope and is not granted,
 * so that half degrades to `pool-unavailable` on its own. That is the reader's designed
 * behaviour rather than a failure: what the provider will serve for a deployment and
 * how much subscription quota is already allocated are separate answers.
 */
export function createProviderQuotaReader(environment = process.env, clock = { nowIso: () => new Date().toISOString() }) {
  const resourceId = environment.PROVIDER_ACCOUNT_RESOURCE_ID;
  if (!resourceId) return null;

  const parsed = /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.CognitiveServices\/accounts\/([^/]+)$/i
    .exec(resourceId);
  if (parsed === null) return null;

  const [, subscriptionId, resourceGroupName, accountName] = parsed;
  const credential = new DefaultAzureCredential();
  const account = { subscriptionId, resourceGroupName, accountName, credential };
  return async () => readProviderQuota({
    ...account,
    // Asked of the account rather than configured, so there is no second setting to
    // forget and none that can disagree with the account it describes.
    region: await readAccountRegion(account),
    now: clock.nowIso,
  });
}

/**
 * Refuses a deployment still configured for a behaviour that was withdrawn.
 *
 * This named the models to grant when a caller's entitlement could not be established.
 * Nothing grants there any more, so a deployment that still sets it is describing a
 * policy the code no longer has. Ignoring it would leave an operator believing a cap
 * applies that nothing reads, which is how the grant it configured survived unnoticed
 * in the first place. It refuses rather than starts, but as an unavailable resolver
 * rather than a host that will not boot, because the setting has to be readable to be
 * removed.
 */
function assertNoWithdrawnDegradedSetting(environment) {
  if (environment.GOVERNANCE_DEGRADED_MODELS !== undefined) {
    const fault = new TypeError(
      'GOVERNANCE_DEGRADED_MODELS has been withdrawn: an unresolvable entitlement is refused, not granted a conservative model. Remove the setting.',
    );
    fault.reasonCode = 'withdrawn-degraded-setting-present';
    throw fault;
  }
}

const MEMBERSHIP_SOURCES = Object.freeze(['store', 'directory-claim']);

/**
 * Where a deployment learns which groups a caller belongs to.
 *
 * `store` reads what an administrator last published, which keeps admitting someone
 * the directory has since removed. `directory-claim` reads the caller's own token, so
 * the answer is only ever as old as their authentication. It is stated rather than
 * inferred because an absent group claim and a caller in no groups look identical, and
 * guessing between them would either govern the wrong caller or refuse a valid one.
 *
 * Under `directory-claim`, a workload is asked about rather than read off, because
 * Entra emits group claims for user principals only. Both answers still come from the
 * directory; only the way of obtaining one differs.
 */
function readMembershipSource(environment) {
  const source = environment.GOVERNANCE_MEMBERSHIP_SOURCE ?? 'store';
  if (!MEMBERSHIP_SOURCES.includes(source)) {
    throw new TypeError(`GOVERNANCE_MEMBERSHIP_SOURCE ${source} is unsupported.`);
  }
  return source;
}

function createMembershipResolver({ membershipSource, store, scopeGroupId, clock }) {
  if (membershipSource !== 'directory-claim') {
    return createStoredMembershipResolver({ store, scopeGroupId, clock });
  }
  return createDirectoryMembershipResolver({
    claimResolver: createTokenClaimsMembershipResolver({ clock }),
    directory: createEntraGroupMembershipQuery({ credential: new DefaultAzureCredential() }),
    clock,
  });
}

/** The full store when a deployment names one, and null when it does not. */
export function createGovernanceStoreFromEnvironment(environment = process.env) {
  const endpoint = environment.GOVERNANCE_STORE_ENDPOINT;
  const databaseId = environment.GOVERNANCE_DATABASE_NAME;
  if (!endpoint || !databaseId) return null;

  return createGovernanceStore({
    client: createCosmosClient({ endpoint, credential: new DefaultAzureCredential() }),
    databaseId,
  });
}
