import { app } from '@azure/functions';

import { createAdminOverviewHandler } from './handlers/admin-overview.mjs';
import { createEffectivePolicyHandler } from './handlers/effective-policy.mjs';
import { createRollupProjector } from './handlers/rollup-projector.mjs';
import {
  KNOWN_TEAM_KEYS,
  createDeployedAccessAuthoringHandlers,
  createDeployedNotificationSweeps,
  createDeployedNotificationDispatcher,
  createDeployedAdminNotificationsHandler,
  createDeployedAcknowledgeNotificationHandler,
  createDeployedBudgetNotifications,
  createDeployedNotificationChannelHandler,
  createDeployedDirectoryProjector,
  createDeployedConfigurationSummaryReader,
  createDeployedDriftSchedule,
  createDeployedScreenHandlers,
  createDeployedPolicyResolver,
  createDeployedPolicyImpactPreviewHandler,
  createDeployedPublishGovernanceHandler,
  createDeployedRollupSchedule,
  createModelRegistryReader,
  createRollupStore,
  createUsageQuery,
  NOTIFICATION_DISPATCH_INTERVAL_SECONDS,
  ROLLUP_CONFIG,
} from './composition-root.mjs';
import { readRoleMapping } from '../governance-domain/authorization/admin-role-authorization.mjs';

/**
 * Function registrations.
 *
 * This file holds no behaviour. Every handler is built elsewhere so it can be
 * exercised without the Functions host, and registration stays a declaration of
 * routes, methods, and authorization levels.
 */

const rollupStore = createRollupStore();
const systemClock = { nowIso: () => new Date().toISOString() };
// Null without a durable store, which is also the case where keeping per-request
// records would mean losing them at the next restart.
const modelRegistryReader = createModelRegistryReader(process.env, systemClock);
const publishGovernance = createDeployedPublishGovernanceHandler(process.env, { nowIso: () => new Date().toISOString() });
const accessAuthoring = createDeployedAccessAuthoringHandlers(process.env, systemClock);
const rollupSchedule = createDeployedRollupSchedule(process.env, systemClock);
const notificationSweeps = createDeployedNotificationSweeps(process.env, systemClock);
const budgetNotifications = createDeployedBudgetNotifications(process.env, systemClock);
const notificationDispatcher = createDeployedNotificationDispatcher(process.env, systemClock);
const driftSchedule = createDeployedDriftSchedule(process.env, systemClock);
const directoryProjector = createDeployedDirectoryProjector(process.env, systemClock);
const screens = createDeployedScreenHandlers(process.env, systemClock);
const adminNotifications = createDeployedAdminNotificationsHandler(process.env, systemClock);
const acknowledgeNotification = createDeployedAcknowledgeNotificationHandler(process.env, systemClock);
const notificationChannel = createDeployedNotificationChannelHandler(process.env, systemClock);
const policyImpactPreview = createDeployedPolicyImpactPreviewHandler(process.env, systemClock);

app.http('effectivePolicy', {
  route: 'v1/internal/effective-policy',
  methods: ['POST'],
  // The gateway presents a managed identity token that the platform validates
  // before the handler runs, so no function key is involved.
  authLevel: 'anonymous',
  handler: createEffectivePolicyHandler({
    resolver: createDeployedPolicyResolver(process.env, systemClock),
    expectedAudience: process.env.CONTROL_PLANE_AUDIENCE ?? '',
    requiredRole: 'Policy.Resolve',
    rolesClaim: process.env.GOVERNANCE_ROLES_CLAIM,
  }),
});

app.http('health', {
  route: 'healthz',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async () => ({
    status: 200,
    jsonBody: { status: 'ok' },
    headers: { 'Cache-Control': 'no-store' },
  }),
});

app.http('adminOverview', {
  route: 'v1/admin/overview',
  methods: ['GET'],
  // The platform validates the token before this runs; the handler then requires
  // its own audience and a governance role.
  authLevel: 'anonymous',
  handler: createAdminOverviewHandler({
    rollupStore,
    expectedAudience: process.env.CONTROL_PLANE_AUDIENCE ?? '',
    clock: systemClock,
    config: ROLLUP_CONFIG,
    knownTeamKeys: KNOWN_TEAM_KEYS,
    readConfigurationSummary: createDeployedConfigurationSummaryReader(process.env),
    roleMapping: readRoleMapping(),
    rolesClaim: process.env.GOVERNANCE_ROLES_CLAIM,
  }),
});

// A finding nobody can read is a finding nobody acts on, so the ledger gets a route
// of its own: the overview reads usage windows and never the notifications.
if (adminNotifications !== null) {
  app.http('adminNotifications', {
    route: 'v1/admin/notifications',
    methods: ['GET'],
    authLevel: 'anonymous',
    handler: adminNotifications,
  });
}

if (acknowledgeNotification !== null) {
  app.http('acknowledgeNotification', {
    route: 'v1/admin/notifications/acknowledge',
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: acknowledgeNotification,
  });
}

// Where notifications go is operational configuration rather than published
// governance, because the endpoint is a credential and the published set is
// projected into read models, audit records and exports.
if (notificationChannel !== null) {
  app.http('notificationChannel', {
    route: 'v1/admin/notifications/channel',
    methods: ['GET', 'PUT'],
    authLevel: 'anonymous',
    handler: notificationChannel,
  });
}

// The store is closed to the public network, so a governance set can only be written
// from in here. Without a store there is nothing to write to and no route to offer.
if (publishGovernance !== null) {
  app.http('publishGovernance', {
    route: 'v1/admin/governance/publish',
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: publishGovernance,
  });
}

// Publishing a set could already be done and composing one could not, so a deployment
// could be bootstrapped and then never changed. These two are the narrowest surface
// that lets an entitlement be changed in place; every other authoring path is still
// local only.
if (accessAuthoring !== null) {
  app.http('accessOptions', {
    route: 'v1/admin/access-options',
    methods: ['GET'],
    authLevel: 'anonymous',
    handler: accessAuthoring.accessOptions,
  });

  app.http('changeEntitlement', {
    route: 'v1/admin/entitlements',
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: accessAuthoring.changeEntitlement,
  });

  // Budgets and fallback already had a GET reading at this path; the write is the
  // same path under POST, the same shape REST already uses for a resource's edit.
  // Assignments had no reading of their own - they are named in `access-options` -
  // so its write gets a route of its own, the way `entitlements` did.
  app.http('changeBudget', {
    route: 'v1/admin/budgets',
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: accessAuthoring.changeBudget,
  });

  app.http('changeFallbackPlan', {
    route: 'v1/admin/fallback',
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: accessAuthoring.changeFallbackPlan,
  });

  app.http('changeAssignment', {
    route: 'v1/admin/assignments',
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: accessAuthoring.changeAssignment,
  });

  app.http('changeTeam', {
    route: 'v1/admin/teams',
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: accessAuthoring.changeTeam,
  });

  if (accessAuthoring.changeModel !== null) {
    app.http('changeModel', {
      route: 'v1/admin/models',
      methods: ['POST'],
      authLevel: 'anonymous',
      handler: accessAuthoring.changeModel,
    });
  }

  if (accessAuthoring.modelPrices !== null) {
    app.http('modelPrices', {
      route: 'v1/admin/model-prices',
      methods: ['GET'],
      authLevel: 'anonymous',
      handler: accessAuthoring.modelPrices,
    });
  }
}

// A reading nobody can ask for is a reading nobody sees. The roster and the model
// catalogue were both being produced in a deployment with no route to serve them.
if (screens !== null) {
  app.http('usersGroups', {
    route: 'v1/admin/users-groups',
    methods: ['GET'],
    authLevel: 'anonymous',
    handler: screens.usersGroups,
  });

  app.http('models', {
    route: 'v1/admin/models',
    methods: ['GET'],
    authLevel: 'anonymous',
    handler: screens.models,
  });

  app.http('budgets', {
    route: 'v1/admin/budgets',
    methods: ['GET'],
    authLevel: 'anonymous',
    handler: screens.budgets,
  });

  app.http('usage', {
    route: 'v1/admin/usage',
    methods: ['GET'],
    authLevel: 'anonymous',
    handler: screens.usage,
  });

  app.http('fallback', {
    route: 'v1/admin/fallback',
    methods: ['GET'],
    authLevel: 'anonymous',
    handler: screens.fallback,
  });

  app.http('lifecycle', {
    route: 'v1/admin/lifecycle',
    methods: ['GET'],
    authLevel: 'anonymous',
    handler: screens.lifecycle,
  });

  // The change log's readings need the durable notification ledger, which not every
  // deployment has. Without it the route is left unregistered rather than served
  // with a history that can never carry a notification event.
  if (screens.audit !== null) {
    app.http('audit', {
      route: 'v1/admin/audit',
      methods: ['GET'],
      authLevel: 'anonymous',
      handler: screens.audit,
    });
  }

  if (policyImpactPreview !== null) {
    app.http('policyImpactPreview', {
      route: 'v1/admin/policy-impact-preview',
      methods: ['POST'],
      authLevel: 'anonymous',
      handler: policyImpactPreview,
    });
  }
}

// Runs on its own scale group, so keeping the request path warm does not also
// hold an instance here.
app.timer('rollupProjector', {
  schedule: '0 5 * * * *',
  handler: async (_timer, context) => {
    // A durable store gets the recovering schedule: windows that fell due while
    // nothing was running are replayed, and a second instance learns it lost the
    // lease before doing the work rather than after writing the same aggregate.
    if (rollupSchedule !== null) {
      const result = await rollupSchedule.tick();
      context.log('Rollup schedule ticked.', { ...result, durability: rollupStore.durability });
      return;
    }
    const projector = createRollupProjector({
      usageQuery: createUsageQuery(),
      rollupStore,
      recordSink: modelRegistryReader === null ? null : rollupStore,
      readModelRegistry: modelRegistryReader,
      clock: systemClock,
      config: ROLLUP_CONFIG,
    });
    const result = await projector.run();
    context.log('Rollup window projected.', { ...result, durability: rollupStore.durability });
  },
});

// Comparing published budgets against what each period has consumed so far. It runs
// after the aggregation it reads and before the sweeps that re-derive, so a threshold
// crossed in the window just closed is raised in the same hour it happened.
if (budgetNotifications !== null) {
  app.timer('budgetNotifications', {
    schedule: '0 10 * * * *',
    handler: async (_timer, context) => {
      const result = await budgetNotifications.run();
      context.log('Budget comparison ran.', result);
    },
  });
}

// Sweeps that re-derive from the store, so a failure recorded while notifications
// were unavailable is still raised afterwards.
if (notificationSweeps !== null) {
  app.timer('notificationSweeps', {
    schedule: '0 15 * * * *',
    handler: async (_timer, context) => {
      const failures = await notificationSweeps.publishFailures.run();
      const retention = await notificationSweeps.retention.tick();
      context.log('Notification sweeps ran.', { failures, retention });
    },
  });
}

// Raising a notification and delivering it are separate, so a channel nobody has
// configured leaves the ledger intact rather than filling it with failed attempts.
// The schedule is derived from the interval the dispatcher was built with, so the
// promise and the cron expression cannot drift apart.
if (notificationDispatcher !== null) {
  app.timer('notificationDispatcher', {
    schedule: `0 */${NOTIFICATION_DISPATCH_INTERVAL_SECONDS / 60} * * * *`,
    handler: async (_timer, context) => {
      const result = await notificationDispatcher.dispatch({ now: systemClock.nowIso() });
      context.log('Notifications dispatched.', result);
    },
  });
}

// Comparing each closed window against the provider's own meter. It runs after the
// aggregation it reads, on the same recovering schedule, so a window that fell due
// while nothing was running is still compared rather than quietly never checked. A
// deployment that names no provider registers nothing: there is no second side to
// compare against, and disputing every window would bury the real disagreements.
if (driftSchedule !== null) {
  app.timer('driftDetector', {
    schedule: '0 35 * * * *',
    handler: async (_timer, context) => {
      const result = await driftSchedule.tick();
      context.log('Drift comparison ticked.', result);
    },
  });
}

// The roster the users-and-groups screen reads. Hourly at the half hour: a group
// membership change that lands mid-hour is visible within one, and the projection
// reports its own age, so a missed run leaves the previous reading ageing rather
// than nothing at all.
if (directoryProjector !== null) {
  app.timer('directoryProjector', {
    schedule: '0 30 * * * *',
    handler: async (_timer, context) => {
      const result = await directoryProjector();
      context.log('Directory reading projected.', result);
    },
  });
}
