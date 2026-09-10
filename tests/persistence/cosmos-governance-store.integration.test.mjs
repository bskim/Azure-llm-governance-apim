// Integration coverage against the local emulator. Requires COSMOS_TEST_ENDPOINT
// and COSMOS_TEST_KEY, which the PowerShell entry point provides.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ConcurrencyConflictError,
  createCosmosClient,
  createGovernanceStore,
  effectivePolicyDocumentId,
} from '../../app/persistence/cosmos-governance-store.mjs';
import { projectUsageRollups } from '../../app/governance-domain/usage/usage-rollup-projector.mjs';
import { projectDirectorySnapshot } from '../../app/governance-domain/directory/directory-snapshot-projector.mjs';
import { containersForProfile } from '../../app/persistence/container-topology.mjs';
import { runGovernanceStoreContract } from './governance-store-contract.mjs';
import { governanceSnapshotDocument } from '../../app/governance-domain/policy/governance-snapshot-document.mjs';
import { getDeterministicGovernanceSnapshots } from '../../app/local-adapters/deterministic-governance-snapshots.mjs';

const endpoint = process.env.COSMOS_TEST_ENDPOINT;
const key = process.env.COSMOS_TEST_KEY;
const databaseId = process.env.COSMOS_TEST_DATABASE ?? 'governance-integration';
const LEGACY_BUDGET_EVALUATION_TIME = '2026-07-24T10:00:00.000Z';

if (!endpoint || !key) {
  throw new Error('COSMOS_TEST_ENDPOINT and COSMOS_TEST_KEY are required for integration tests.');
}

const client = createCosmosClient({ endpoint, key });

// The application never creates containers. The harness provisions them here to
// stand in for the infrastructure deployment, and reads the declared topology so
// it cannot drift from the contract the store asserts against.
const { database } = await client.databases.createIfNotExists({ id: databaseId });
for (const container of containersForProfile('always')) {
  await database.containers.createIfNotExists({
    id: container.id,
    partitionKey: { paths: [...container.partitionKeyPaths] },
    defaultTtl: container.defaultTimeToLiveSeconds ?? undefined,
  });
}

const store = createGovernanceStore({ client, databaseId });

// The emulator keeps data for the life of the container, so every run uses fresh
// keys and the suite stays re-runnable.
const runId = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
let counter = 0;
function policyDocument(overrides = {}) {
  counter += 1;
  const scopeGroupId = overrides.scopeGroupId ?? 'team-platform';
  const principalKey = overrides.principalKey ?? `pk1-it-${runId}-${String(counter).padStart(3, '0')}`;
  return {
    contractVersion: 'v1',
    documentType: 'effective-policy',
    id: effectivePolicyDocumentId({ scopeGroupId, principalKey }),
    scopeGroupId,
    principalKey,
    configVersion: 1,
    resolution: 'resolved',
    resolvedAt: '2026-08-04T00:00:00.000Z',
    expiresAt: '2026-08-04T00:01:00.000Z',
    attribution: {
      subjectKey: 'sk1-integration00000000000000000000',
      applicationKey: 'ak1-integration00000000000000000000',
      teamKey: scopeGroupId,
    },
    allowedModels: ['model-mini'],
    modelDeployments: [{ modelKey: 'model-mini', providerDeploymentName: 'deployment-mini' }],
    limits: [
      {
        scope: 'organization',
        modelScope: 'all-models',
        tokenQuota: 1000,
        quotaPeriod: 'Monthly',
      },
    ],
    fallback: { enabled: false, maxDepth: 1, chain: [] },
    ...overrides,
  };
}

// The behaviour shared with the in-memory store. Running it here is what makes that
// store a stand-in rather than a second set of assumptions.
runGovernanceStoreContract({
  label: 'cosmos',
  store,
  uniqueKey: () => {
    counter += 1;
    return `pk1-ct-${runId}-${String(counter).padStart(3, '0')}`;
  },
});

test('a policy carries its whole domain shape through the store', async () => {
  const document = policyDocument();
  await store.putEffectivePolicy(document, { ifMatch: null });

  const read = await store.readEffectivePolicy(document);
  assert.equal(read.document.attribution.teamKey, document.scopeGroupId);
  assert.equal(read.document.limits[0].tokenQuota, 1000);
});

test('a duplicate create is refused rather than silently overwriting', async () => {
  const document = policyDocument();
  await store.putEffectivePolicy(document, { ifMatch: null });
  await assert.rejects(
    () => store.putEffectivePolicy(document, { ifMatch: null }),
    ConcurrencyConflictError,
  );
});

test('a stale conditional replace is refused and does not apply', async () => {
  const document = policyDocument();
  await store.putEffectivePolicy(document, { ifMatch: null });
  const first = await store.readEffectivePolicy(document);
  const staleEtag = first.etag;

  await store.putEffectivePolicy({ ...document, configVersion: 2 }, { ifMatch: staleEtag });

  await assert.rejects(
    () => store.putEffectivePolicy({ ...document, configVersion: 99 }, { ifMatch: staleEtag }),
    ConcurrencyConflictError,
  );

  const after = await store.readEffectivePolicy(document);
  assert.equal(after.document.configVersion, 2);
});

test('concurrent conditional updates apply exactly once each', async () => {
  const document = policyDocument();
  await store.putEffectivePolicy(document, { ifMatch: null });

  const attempts = 20;
  let conflicts = 0;
  async function increment() {
    for (let attempt = 0; attempt < 100; attempt++) {
      const current = await store.readEffectivePolicy(document);
      try {
        await store.putEffectivePolicy(
          { ...current.document, configVersion: current.document.configVersion + 1 },
          { ifMatch: current.etag },
        );
        return;
      } catch (error) {
        if (!(error instanceof ConcurrencyConflictError)) throw error;
        conflicts += 1;
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 25));
      }
    }
    throw new Error('retry budget exhausted');
  }

  await Promise.all(Array.from({ length: attempts }, increment));
  const final = await store.readEffectivePolicy(document);
  assert.equal(final.document.configVersion, 1 + attempts, `conflicts observed: ${conflicts}`);
});

test('a document that violates the contract is refused before it reaches the store', async () => {
  const document = policyDocument();
  document.fallback = { enabled: true, maxDepth: 1, chain: [{ from: 'model-mini', to: 'model-unlisted' }] };
  document.warnThresholdPercent = 80;
  await assert.rejects(() => store.putEffectivePolicy(document, { ifMatch: null }), TypeError);
});

test('Cosmos hydration classifies all formerly valid legacy budget shapes without enabling them', async () => {
  const legacyCases = [
    ['supported-token-budget', () => {}, null],
    ['throttle-plus-quota', (budget, snapshot) => {
      snapshot.budgets.push({
        ...budget,
        budgetId: 'budget-organization-throttle',
        action: 'THROTTLE',
        thresholds: { tiers: [{ atBasisPoints: 8000, tierCode: 'tier-reduced' }] },
      });
    }, null],
    ['duplicate-quota-counter', (budget, snapshot) => {
      snapshot.budgets.push({
        ...budget,
        budgetId: 'budget-organization-daily',
        period: 'Daily',
      });
    }],
    ['zero-token-limit', (budget) => { budget.limit.amount = 0; }],
    ['subject-per-model', (budget) => {
      budget.scope = 'subject';
      budget.modelScope = 'per-model';
      budget.modelKey = 'coding-fast';
    }],
    ['application-per-model', (budget) => {
      budget.scope = 'application';
      budget.modelScope = 'per-model';
      budget.modelKey = 'coding-fast';
    }],
    ['all-models-with-model-key', (budget) => { budget.modelKey = 'coding-fast'; }],
    ['per-model-without-model-key', (budget) => { budget.modelScope = 'per-model'; }],
  ];

  for (const [name, mutate, expectedState = 'migration-required'] of legacyCases) {
    counter += 1;
    const scopeGroupId = `team-budget-${runId}-${counter}`;
    const legacy = governanceSnapshotDocument({
      scopeGroupId,
      kind: 'budget',
      snapshot: structuredClone(getDeterministicGovernanceSnapshots().budgetSnapshot),
    });
    delete legacy.snapshot.budgets[0].accountingBasis;
    mutate(legacy.snapshot.budgets[0], legacy.snapshot);

    await assert.rejects(
      () => store.putGovernanceSnapshot(legacy, {
        ifMatch: null,
        evaluationTime: LEGACY_BUDGET_EVALUATION_TIME,
      }),
      /accountingBasis/,
      `${name} remains forbidden for a current write`,
    );

    await database.container('governance').items.create(legacy);
    const read = () => store.readGovernanceSnapshot({
        scopeGroupId,
        kind: 'budget',
        evaluationTime: LEGACY_BUDGET_EVALUATION_TIME,
      });
    if (expectedState === null) {
      const hydrated = await read();
      assert.ok(hydrated.document.snapshot.budgets.every(
        (budget) => budget.accountingBasis === 'apim-estimated-total-tokens',
      ));
    } else {
      await assert.rejects(
        read,
        (error) => error.code === 'legacy-budget-migration-required' &&
          error.migrationRequirements[0].legacyShape === name,
        name,
      );
    }
  }
});

test('a mismatched identifier is refused', async () => {
  const document = policyDocument();
  document.id = 'effective-policy|team-other|pk1-integration00000000000000000000';
  await assert.rejects(() => store.putEffectivePolicy(document, { ifMatch: null }), TypeError);
});

// Rollups are produced by the projector rather than hand-written, so what the
// scheduled run actually emits is what the store is proven to accept.
function rollupWindow({ windowStart, rows, scopeGroupId }) {
  return projectUsageRollups({
    rows,
    scopeGroupId,
    grains: ['organization', 'team'],
    windowStart,
    windowEnd: new Date(Date.parse(windowStart) + 3_600_000).toISOString(),
    asOf: new Date(Date.parse(windowStart) + 7_200_000).toISOString(),
    source: {
      state: 'complete',
      rowCount: rows.length,
      rowLimit: 500_000,
      revision: 'integration',
      ingestionLagSeconds: 300,
    },
  });
}

function usageRow(overrides = {}) {
  return {
    teamKey: 'team-platform',
    subjectKey: 'sk1-integration00000000000000000000',
    applicationKey: 'ak1-integration00000000000000000000',
    requestedModel: 'model-mini',
    effectiveModel: 'model-mini',
    promptTokens: 10,
    completionTokens: 5,
    tokenQuality: 'reported',
    outcome: 'served',
    ...overrides,
  };
}

test('a projected rollup round-trips through the store', async () => {
  const scopeGroupId = `rollup-${runId}`;
  const [organization] = rollupWindow({
    windowStart: '2026-08-04T00:00:00.000Z',
    rows: [usageRow()],
    scopeGroupId,
  });

  const written = await store.putRollup(organization);
  assert.equal(written.document.id, organization.id);

  const read = await store.readRollup({ scopeGroupId, id: organization.id });
  assert.equal(read.document.totals.totalTokens, 15);
  assert.equal(read.document.completeness.state, 'complete');
  for (const property of ['_rid', '_self', '_etag', '_ts', '_attachments']) {
    assert.equal(Object.hasOwn(read.document, property), false, property);
  }
});

test('rewriting a window replaces it instead of duplicating it', async () => {
  const scopeGroupId = `rollup-rerun-${runId}`;
  const windowStart = '2026-08-04T01:00:00.000Z';
  const [first] = rollupWindow({ windowStart, rows: [usageRow()], scopeGroupId });
  await store.putRollup(first);

  // A backfill sees more of the same window; the recomputed totals must win.
  const [second] = rollupWindow({
    windowStart,
    rows: [usageRow(), usageRow({ promptTokens: 20, completionTokens: 5 })],
    scopeGroupId,
  });
  assert.equal(second.id, first.id);
  await store.putRollup(second);

  const read = await store.readRollup({ scopeGroupId, id: first.id });
  assert.equal(read.document.totals.requests, 2);
  assert.equal(read.document.totals.totalTokens, 40);
});

test('a rollup that violates the contract is refused before it reaches the store', async () => {
  const scopeGroupId = `rollup-invalid-${runId}`;
  const [organization] = rollupWindow({
    windowStart: '2026-08-04T02:00:00.000Z',
    rows: [usageRow()],
    scopeGroupId,
  });

  await assert.rejects(
    () => store.putRollup({ ...organization, completeness: { state: 'complete', reason: 'window-open' } }),
    TypeError,
  );
});

test('a window range is read back in order and bounded by its start', async () => {
  const scopeGroupId = `rollup-range-${runId}`;
  for (const windowStart of ['2026-08-04T03:00:00.000Z', '2026-08-04T04:00:00.000Z', '2026-08-04T05:00:00.000Z']) {
    for (const document of rollupWindow({ windowStart, rows: [usageRow()], scopeGroupId })) {
      await store.putRollup(document);
    }
  }

  const all = await store.queryRollupWindows({ scopeGroupId, sinceWindowStart: '2026-08-04T03:00:00.000Z' });
  const starts = [...new Set(all.map((document) => document.windowStart))];
  assert.deepEqual(starts, ['2026-08-04T03:00:00.000Z', '2026-08-04T04:00:00.000Z', '2026-08-04T05:00:00.000Z']);
  assert.deepEqual([...new Set(all.map((document) => document.grain))].sort(), ['organization', 'team']);
  for (const property of ['_rid', '_self', '_etag', '_ts', '_attachments']) {
    assert.equal(Object.hasOwn(all[0], property), false, property);
  }

  const narrowed = await store.queryRollupWindows({ scopeGroupId, sinceWindowStart: '2026-08-04T05:00:00.000Z' });
  assert.deepEqual([...new Set(narrowed.map((document) => document.windowStart))], ['2026-08-04T05:00:00.000Z']);
});

test('a window range never crosses into another scope group', async () => {
  const mine = `rollup-mine-${runId}`;
  const theirs = `rollup-theirs-${runId}`;
  for (const scopeGroupId of [mine, theirs]) {
    for (const document of rollupWindow({
      windowStart: '2026-08-04T06:00:00.000Z',
      rows: [usageRow()],
      scopeGroupId,
    })) {
      await store.putRollup(document);
    }
  }

  const read = await store.queryRollupWindows({ scopeGroupId: mine, sinceWindowStart: '2026-08-04T00:00:00.000Z' });
  assert.ok(read.length > 0);
  assert.equal(read.every((document) => document.scopeGroupId === mine), true);
});

test('a directory snapshot round-trips and one scope keeps one current snapshot', async () => {
  const scopeGroupId = `directory-${runId}`;
  const observed = (members) =>
    projectDirectorySnapshot({
      groups: [
        {
          groupId: 'group-platform',
          teamCode: 'team-platform',
          displayCode: 'team-platform',
          members,
        },
      ],
      scopeGroupId,
      configurationVersion: 'cfg-integration',
      observedAt: '2026-08-04T09:58:00.000Z',
      asOf: '2026-08-04T10:00:00.000Z',
      source: { state: 'complete', revision: 'integration' },
    });

  const first = observed([{ subjectId: 'user-a', displayCode: 'alpha', membership: 'direct' }]);
  await store.putDirectorySnapshot(first);

  const second = observed([
    { subjectId: 'user-a', displayCode: 'alpha', membership: 'direct' },
    { subjectId: 'user-b', displayCode: 'bravo', membership: 'direct' },
  ]);
  assert.equal(second.id, first.id);
  await store.putDirectorySnapshot(second);

  const read = await store.readDirectorySnapshot({ scopeGroupId });
  assert.equal(read.document.users.length, 2);
  assert.equal(read.document.completeness.state, 'complete');
  for (const property of ['_rid', '_self', '_etag', '_ts', '_attachments']) {
    assert.equal(Object.hasOwn(read.document, property), false, property);
  }
});

test('an absent directory snapshot reads as null rather than throwing', async () => {
  assert.equal(await store.readDirectorySnapshot({ scopeGroupId: `absent-${runId}` }), null);
});

test('a directory snapshot that violates the contract never reaches the store', async () => {
  await assert.rejects(
    () => store.putDirectorySnapshot({ contractVersion: 'v1', documentType: 'directory-snapshot' }),
    TypeError,
  );
});
