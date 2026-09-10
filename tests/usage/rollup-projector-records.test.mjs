import assert from 'node:assert/strict';
import test from 'node:test';

import { createRollupProjector } from '../../app/functions/handlers/rollup-projector.mjs';
import { createInMemoryGovernanceStore } from '../../app/persistence/in-memory-governance-store.mjs';
import { assertModelRegistrySnapshotV1 } from '../../app/governance-domain/registry/model-registry-validator.mjs';

const SCOPE = 'platform-engineering';
const TENANT = 'tenant-local-demo';
const NOW = '2026-08-10T04:05:00.000Z';
const WINDOW = { windowStart: '2026-08-10T03:00:00.000Z', windowEnd: '2026-08-10T04:00:00.000Z' };

function registry(version = 7) {
  return assertModelRegistrySnapshotV1(
    {
      contractVersion: 'v1',
      snapshotId: 'model-registry-001',
      tenantId: TENANT,
      version,
      status: 'complete',
      capturedAt: '2026-08-10T00:00:00.000Z',
      expiresAt: '2026-08-11T00:00:00.000Z',
      sourceRevision: 'model-registry-source-001',
      models: [
        {
          modelKey: 'coding-fast',
          providerKey: 'azure-openai',
          apiFamilies: ['openai-chat-completions', 'openai-responses'],
          lifecycle: 'generally-available',
          safetyPolicy: 'local-default-policy',
        },
      ],
      applications: [],
    },
    { evaluationTime: NOW, principalTenantId: TENANT },
  );
}

function row(overrides = {}) {
  return {
    correlationId: 'correlation-000000000001',
    observedAt: '2026-08-10T03:15:00.000Z',
    teamKey: 'platform-engineering',
    subjectKey: 'subject-0000000000000001',
    applicationKey: 'application-000000000001',
    requestedModel: 'coding-fast',
    effectiveModel: 'coding-fast',
    outcome: 'served',
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    tokenQuality: 'reported',
    exchangeState: 'complete',
    ...overrides,
  };
}

function projector(store, { rows = [row()], readModelRegistry = async () => registry(), recordSink = store } = {}) {
  return createRollupProjector({
    usageQuery: {
      async readWindow() {
        return { rows, state: 'complete', rowCount: rows.length, revision: 'window-revision-1' };
      },
    },
    rollupStore: store,
    recordSink,
    readModelRegistry,
    clock: { nowIso: () => NOW },
    config: { scopeGroupId: SCOPE, windowSeconds: 3600, ingestionLagSeconds: 300 },
  });
}

test('a projected window writes one record per request, not only the aggregate', async () => {
  const store = createInMemoryGovernanceStore();

  const result = await projector(store).runWindow(WINDOW);

  assert.equal(result.records.state, 'kept');
  assert.equal(result.records.written, 1);
  const stored = await store.queryUsageRecords({ scopeGroupId: SCOPE, sinceObservedAt: WINDOW.windowStart });
  assert.equal(stored.length, 1);
  assert.equal(stored[0].correlationId, 'correlation-000000000001');
  // Only a record carries per-request usage; the aggregate the same run wrote cannot.
  assert.equal(stored[0].usage.totalTokens > 0, true);
  assert.equal(stored[0].configVersion, 7);
});

test('replaying the same window writes nothing new and reports no disagreement', async () => {
  const store = createInMemoryGovernanceStore();
  await projector(store).runWindow(WINDOW);

  const second = await projector(store).runWindow(WINDOW);

  assert.equal(second.records.written, 0);
  assert.equal(second.records.conflicts, 0);
  const stored = await store.queryUsageRecords({ scopeGroupId: SCOPE, sinceObservedAt: WINDOW.windowStart });
  assert.equal(stored.length, 1);
});

test('a replay that disagrees is reported, and the stored record still wins', async () => {
  const store = createInMemoryGovernanceStore();
  await projector(store).runWindow(WINDOW);

  const second = await projector(store, { rows: [row({ totalTokens: 300, promptTokens: 200, completionTokens: 100 })] })
    .runWindow(WINDOW);

  assert.equal(second.records.conflicts, 1);
  assert.equal(second.records.reasonCode, 'records-written-with-conflicts');
  const [stored] = await store.queryUsageRecords({ scopeGroupId: SCOPE, sinceObservedAt: WINDOW.windowStart });
  assert.equal(stored.usage.totalTokens, 150, 'overwriting the record would erase the finding');
});

test('no catalogue means no record, said out loud, rather than a record priced at zero', async () => {
  const store = createInMemoryGovernanceStore();

  const result = await projector(store, { readModelRegistry: async () => null }).runWindow(WINDOW);

  assert.equal(result.records.state, 'skipped');
  assert.equal(result.records.reasonCode, 'model-catalogue-unavailable');
  assert.equal(result.documentsWritten > 0, true, 'the aggregate is still written');
  const stored = await store.queryUsageRecords({ scopeGroupId: SCOPE, sinceObservedAt: WINDOW.windowStart });
  assert.equal(stored.length, 0);
});

test('a catalogue read that throws is the same answer as no catalogue', async () => {
  const store = createInMemoryGovernanceStore();

  const result = await projector(store, {
    readModelRegistry: async () => {
      throw new Error('store unreachable');
    },
  }).runWindow(WINDOW);

  assert.equal(result.records.reasonCode, 'model-catalogue-unavailable');
});

test('a deployment that keeps no records says so instead of appearing to write them', async () => {
  const store = createInMemoryGovernanceStore();

  const result = await projector(store, { recordSink: null, readModelRegistry: undefined }).runWindow(WINDOW);

  assert.equal(result.records.state, 'not-kept');
  assert.equal(result.records.reasonCode, 'records-not-configured');
});

test('omitting the sink is refused, because forgetting and deciding look identical afterwards', () => {
  const store = createInMemoryGovernanceStore();
  const build = (extra) =>
    createRollupProjector({
      usageQuery: { readWindow: async () => ({ rows: [], state: 'complete', rowCount: 0, revision: 'r' }) },
      rollupStore: store,
      clock: { nowIso: () => NOW },
      config: { scopeGroupId: SCOPE },
      ...extra,
    });

  assert.throws(() => build({}), /recordSink is required/);
  assert.throws(() => build({ recordSink: store }), /readModelRegistry is required/);
  assert.throws(
    () => build({ recordSink: { putUsageRecord: async () => {} }, readModelRegistry: async () => null }),
    /read back what it wrote/,
  );
});
