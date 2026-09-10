import { assembleGovernanceSnapshots } from '../governance-domain/policy/governance-snapshot-document.mjs';
import { assertGovernanceReadSource, ReadSourceUnavailableError } from './governance-read-source.mjs';

/**
 * The same eleven reads, answered from the durable store.
 *
 * It is deliberately narrower than the development source, and says so rather than
 * inventing what it cannot produce. A deployment has no selectable states: a screen is
 * whatever the stored evidence makes it, so every state list declares only that one
 * selection and the routing refuses the rest instead of quietly answering with
 * something else.
 *
 * Where the store holds nothing the answer is a refusal, never an empty reading. An
 * absent directory snapshot and a directory with nobody in it are different facts, and
 * a screen that renders them alike tells an operator the organization is empty.
 */

const STATE_SELECTIONS = Object.freeze(['complete']);

// A directory reading is only as good as the observation behind it. A truncated one is
// partial, one nobody refreshed is stale, and both make the effective policy refuse.
const DIRECTORY_QUALITY = Object.freeze({
  complete: 'fresh',
  'source-truncated': 'partial',
  'observation-stale': 'stale',
});

function unavailable(reasonCode) {
  return new ReadSourceUnavailableError(reasonCode);
}

function projectDirectoryFixture(document, asOf) {
  // Nobody could be asked, so how much of the directory is missing is unknown. A
  // screen built on it would understate memberships without saying so.
  if (document.completeness.state === 'degraded') {
    throw unavailable('directory-evidence-degraded');
  }
  const state = document.completeness.state === 'complete'
    ? DIRECTORY_QUALITY.complete
    : DIRECTORY_QUALITY[document.completeness.reason] ?? 'partial';

  return {
    name: document.completeness.state,
    generatedAt: document.asOf,
    configurationVersion: document.configurationVersion,
    quality: {
      reportedAt: document.observedAt,
      lagSeconds: Math.max(0, Math.round((Date.parse(asOf) - Date.parse(document.observedAt)) / 1000)),
      state,
      aggregation: document.completeness.state === 'complete' ? 'complete' : 'partial',
    },
    users: structuredClone(document.users),
    groups: structuredClone(document.groups),
    // Graph knows a person by their directory object identifier; the gateway forwards
    // the token's subject, which is pairwise per application. Self scope has no answer
    // here, and saying so beats returning nobody.
    subjectsMatchCaller: false,
  };
}

/**
 * Rollups describe the window; records carry the cost. Both come from the same run,
 * so the window is read from the rollups rather than guessed from the records: with
 * no rollup at all there is nothing that observed the period, and no number of
 * missing records could tell that apart from a period in which nothing happened.
 */
function projectUsageWindow(rollups, asOf) {
  if (rollups.length === 0) {
    return {
      windowStart: asOf,
      windowEnd: asOf,
      asOf,
      completeness: { state: 'degraded', reason: 'source-unavailable' },
      freshness: { state: 'stale', reportedAt: asOf, lagSeconds: 0 },
    };
  }
  const ordered = [...rollups].sort((left, right) => left.windowStart.localeCompare(right.windowStart));
  const windowEnd = ordered.at(-1).windowEnd;
  const states = new Set(ordered.map((document) => document.source?.state ?? 'complete'));
  const state = states.has('degraded') ? 'degraded' : states.has('partial') ? 'partial' : 'complete';
  const lagSeconds = Math.max(0, Math.round((Date.parse(asOf) - Date.parse(windowEnd)) / 1000));
  const maxLag = Math.max(
    ...ordered.map((document) => document.source?.ingestionLagSeconds ?? 0),
  );

  return {
    windowStart: ordered[0].windowStart,
    windowEnd,
    asOf,
    completeness: {
      state,
      reason: state === 'complete'
        ? 'window-closed'
        : state === 'partial'
          ? 'ingestion-lag'
          : 'source-unavailable',
    },
    // Later than the run's own ingestion lag means nothing has arrived since, which
    // is the reading being late rather than the window being incomplete.
    freshness: {
      state: lagSeconds > maxLag * 2 ? 'stale' : 'fresh',
      reportedAt: windowEnd,
      lagSeconds,
    },
  };
}

export function createStoredGovernanceSource({
  store,
  scopeGroupId,
  clock,
  lifecycleViewer,
  selfApprovalActors = [],
  readProviderQuota,
}) {
  if (store === null || typeof store !== 'object') throw new TypeError('store is required.');
  if (typeof scopeGroupId !== 'string' || scopeGroupId.length === 0) {
    throw new TypeError('scopeGroupId is required.');
  }
  if (typeof clock?.nowIso !== 'function') throw new TypeError('clock is required.');
  if (typeof lifecycleViewer !== 'string' || lifecycleViewer.length === 0) {
    throw new TypeError('lifecycleViewer must name the actor a screen defaults to.');
  }
  // Three-valued on purpose: null is a deployment that decided not to read the
  // provider, and omitting it is a deployment that never considered the question.
  // Those produce the same empty column, and only one of them is an answer.
  if (readProviderQuota === undefined) {
    throw new TypeError('readProviderQuota must be supplied, or supplied as null when not configured.');
  }
  if (readProviderQuota !== null && typeof readProviderQuota !== 'function') {
    throw new TypeError('readProviderQuota must be a function or null.');
  }

  async function readStored(reasonCode, read) {
    try {
      return await read();
    } catch (error) {
      if (error instanceof ReadSourceUnavailableError) throw error;
      throw unavailable(reasonCode);
    }
  }

  const source = {
    capabilities: Object.freeze({
      overviewFixtures: STATE_SELECTIONS,
      usersGroupsFixtures: STATE_SELECTIONS,
      usageFixtures: STATE_SELECTIONS,
      modelsFixtures: STATE_SELECTIONS,
      budgetsFixtures: STATE_SELECTIONS,
      fallbackFixtures: STATE_SELECTIONS,
      lifecycleFixtures: STATE_SELECTIONS,
      notificationsFixtures: STATE_SELECTIONS,
      auditFixtures: STATE_SELECTIONS,
      // Measured traffic is the only overview a deployment has; there is no fixture
      // behind it to offer as an alternative.
      overviewSources: Object.freeze(['rollup']),
      entitlementViews: Object.freeze(['fixture']),
      defaultLifecycleViewer: lifecycleViewer,
      selfApprovalActors: Object.freeze([...selfApprovalActors]),
      // A deployment answers the published meters from its own route, which reads the
      // live price list; this source has nothing to read them from and says so rather
      // than offering a reading it would have to invent.
      modelPriceReference: false,
    }),

    describe() {
      return Object.freeze({ sourceKind: 'stored', durability: 'durable' });
    },

    async readGovernanceSnapshots() {
      const evaluationTime = clock.nowIso();
      const documents = await readStored('governance-snapshots-unreadable', () =>
        store.queryGovernanceSnapshots({ scopeGroupId, evaluationTime }));
      try {
        return assembleGovernanceSnapshots(documents);
      } catch (error) {
        throw unavailable(error?.code ?? 'governance-snapshots-invalid');
      }
    },

    // Only the measured overview exists here, and the routing already builds it from
    // the rollups. Reaching this would mean a selection the capabilities refuse.
    readOverview() {
      throw unavailable('overview-fixture-not-available');
    },

    async readUsersGroups() {
      const held = await readStored('directory-snapshot-unreadable', () =>
        store.readDirectorySnapshot({ scopeGroupId }));
      if (held === null) throw unavailable('directory-snapshot-absent');
      return projectDirectoryFixture(held.document, clock.nowIso());
    },

    async readRollups() {
      return readStored('rollups-unreadable', () =>
        store.queryRollupWindows({ scopeGroupId, sinceWindowStart: '1970-01-01T00:00:00.000Z' }));
    },

    async readUsageRecords() {
      const asOf = clock.nowIso();
      const [records, rollups] = await Promise.all([
        readStored('usage-records-unreadable', () =>
          store.queryUsageRecords({ scopeGroupId, sinceObservedAt: '1970-01-01T00:00:00.000Z' })),
        readStored('rollups-unreadable', () =>
          store.queryRollupWindows({ scopeGroupId, sinceWindowStart: '1970-01-01T00:00:00.000Z' })),
      ]);
      return { records, window: projectUsageWindow(rollups, asOf) };
    },

    // Provider allocation is read from the provider, not from this store. A failed
    // read answers null, which the catalogue already reports as not collected: a
    // refusal here would take the whole models screen down over one column.
    async readProviderQuota() {
      if (readProviderQuota === null) return null;
      try {
        return await readProviderQuota();
      } catch {
        return null;
      }
    },

    async readConfigurationRevisions() {
      return readStored('configuration-revisions-unreadable', () =>
        store.queryConfigurationRevisions({ scopeGroupId }));
    },

    async hasConfigurationDraft({ revisionId }) {
      const draft = await readStored('configuration-draft-unreadable', () =>
        store.readConfigurationDraft({ scopeGroupId, revisionId }));
      return draft !== null;
    },

    // The ledger is the notification source in a deployment, so there is nothing to
    // seed. An empty seed is the answer, not a missing one.
    readNotificationSeed() {
      return [];
    },
  };

  return Object.freeze(assertGovernanceReadSource(source));
}
