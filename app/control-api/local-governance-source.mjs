import { getDeterministicConfigurationRevisions, LOCAL_LIFECYCLE_ACTORS, LOCAL_SELF_APPROVERS } from '../local-adapters/deterministic-configuration-revisions.mjs';
import {
  getDeterministicGovernanceSnapshots,
} from '../local-adapters/deterministic-governance-snapshots.mjs';
import { getDeterministicModelPrices } from '../local-adapters/deterministic-model-prices.mjs';
import { getDeterministicProviderQuota } from '../local-adapters/deterministic-provider-quota.mjs';
import { getLocalNotifications } from '../local-adapters/notification-fixtures.mjs';
import { getOverviewFixture, OVERVIEW_FIXTURE_NAMES } from '../local-adapters/overview-fixtures.mjs';
import { getLocalRollups } from '../local-adapters/rollup-fixtures.mjs';
import {
  BUDGET_FIXTURE_NAMES,
  NOTIFICATION_FIXTURE_NAMES,
  RECORD_SCREEN_FIXTURE_NAMES,
} from '../local-adapters/screen-state-fixtures.mjs';
import { getUsageFixture, MODELS_FIXTURE_NAMES, USAGE_FIXTURE_NAMES } from '../local-adapters/usage-fixtures.mjs';
import {
  getUsersGroupsFixture,
  USERS_GROUPS_FIXTURE_NAMES,
} from '../local-adapters/users-groups-fixtures.mjs';
import { assertGovernanceReadSource } from './governance-read-source.mjs';

/**
 * The development implementation of the read source.
 *
 * It is not a leftover to be deleted once a store exists. A run whose data is fixed is
 * the only way to read a screen's degraded, partial, refused, and tampered states on
 * demand, so it stays and is held to the same interface as the stored one.
 */

// The fixture's global entitlement withholds the cheaper model, so the fallback plan it
// ships with has nowhere to go. Widening it is a development view of the same fixture,
// mirroring what the policy resolution tests already do.
function widenGlobalAllowlist(snapshots) {
  const bindings = snapshots.entitlementSnapshot.bindings.map((binding) =>
    binding.target.kind === 'global'
      ? { ...binding, modelAllowlist: ['coding-fast', 'coding-primary'] }
      : binding,
  );
  return {
    ...snapshots,
    entitlementSnapshot: { ...snapshots.entitlementSnapshot, bindings },
  };
}

export function createLocalGovernanceSource({ evaluationTime }) {
  if (typeof evaluationTime !== 'string' || Number.isNaN(Date.parse(evaluationTime))) {
    throw new TypeError('evaluationTime must be an ISO-8601 instant.');
  }

  const source = {
    capabilities: Object.freeze({
      overviewFixtures: OVERVIEW_FIXTURE_NAMES,
      usersGroupsFixtures: USERS_GROUPS_FIXTURE_NAMES,
      usageFixtures: USAGE_FIXTURE_NAMES,
      modelsFixtures: MODELS_FIXTURE_NAMES,
      budgetsFixtures: BUDGET_FIXTURE_NAMES,
      fallbackFixtures: RECORD_SCREEN_FIXTURE_NAMES,
      lifecycleFixtures: RECORD_SCREEN_FIXTURE_NAMES,
      notificationsFixtures: NOTIFICATION_FIXTURE_NAMES,
      auditFixtures: RECORD_SCREEN_FIXTURE_NAMES,
      overviewSources: Object.freeze(['fixture', 'rollup']),
      entitlementViews: Object.freeze(['fixture', 'both-models']),
      defaultLifecycleViewer: LOCAL_LIFECYCLE_ACTORS.approver,
      selfApprovalActors: LOCAL_SELF_APPROVERS,
      // Whether this source can show the published meters at all. A source that cannot
      // says so, and the routing refuses the read instead of answering an empty list,
      // which on a price screen would read as free rather than as unknown.
      modelPriceReference: true,
    }),

    describe() {
      return Object.freeze({ sourceKind: 'development', durability: 'ephemeral' });
    },

    readGovernanceSnapshots({ entitlementView = 'fixture' } = {}) {
      const snapshots = getDeterministicGovernanceSnapshots();
      return entitlementView === 'both-models' ? widenGlobalAllowlist(snapshots) : snapshots;
    },

    readOverview({ fixtureName, scope, teamKey }) {
      return getOverviewFixture(fixtureName, { scope, teamKey });
    },

    readUsersGroups({ fixtureName }) {
      return getUsersGroupsFixture(fixtureName);
    },

    readRollups() {
      return getLocalRollups({ asOf: evaluationTime });
    },

    readUsageRecords({ registry, fixtureName = 'complete' }) {
      return getUsageFixture(fixtureName, { asOf: evaluationTime, registry });
    },

    readProviderQuota() {
      return getDeterministicProviderQuota();
    },

    readModelPrices() {
      return getDeterministicModelPrices();
    },

    readConfigurationRevisions() {
      return getDeterministicConfigurationRevisions();
    },

    readNotificationSeed() {
      return getLocalNotifications();
    },
  };

  return Object.freeze(assertGovernanceReadSource(source));
}
