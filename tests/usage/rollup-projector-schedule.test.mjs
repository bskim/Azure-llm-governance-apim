import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRollupProjector,
  resolveWindow,
} from '../../app/functions/handlers/rollup-projector.mjs';
import { createRollupStore } from '../../app/functions/composition-root.mjs';
import { createFixedClock } from '../../app/local-adapters/deterministic-time.mjs';

const NOW = '2026-08-04T02:07:00.000Z';

function row(overrides = {}) {
  return {
    teamKey: 'platform-engineering',
    subjectKey: 'sk1-aaaaaaaaaaaaaaaaaaaa',
    applicationKey: 'ak1-bbbbbbbbbbbbbbbbbbbb',
    requestedModel: 'coding-primary',
    effectiveModel: 'coding-primary',
    promptTokens: 10,
    completionTokens: 5,
    tokenQuality: 'reported',
    outcome: 'succeeded',
    ...overrides,
  };
}

function createHarness({ readWindow, config } = {}) {
  const written = [];
  const projector = createRollupProjector({
    usageQuery: {
      readWindow:
        readWindow ??
        (async () => ({ rows: [row()], state: 'complete', rowCount: 1, revision: 'run-1' })),
    },
    rollupStore: {
      async putRollup(document) {
        written.push(document);
      },
    },
    recordSink: null,
    clock: createFixedClock(NOW),
    config: { scopeGroupId: 'platform-engineering', ...config },
  });
  return { projector, written };
}

test('the window is aligned to the schedule grain and lagged behind the source', () => {
  // 02:07 with an hourly grain and a five minute lag summarizes 00:00-01:00,
  // because 02:02 aligns down to 02:00 and the window before it has closed.
  const window = resolveWindow(NOW, 3600, 300);

  assert.equal(window.windowStart, '2026-08-04T01:00:00.000Z');
  assert.equal(window.windowEnd, '2026-08-04T02:00:00.000Z');
});

test('two runs inside the same grain resolve the same window', () => {
  const first = resolveWindow('2026-08-04T02:07:00.000Z', 3600, 300);
  const second = resolveWindow('2026-08-04T02:41:00.000Z', 3600, 300);

  assert.deepEqual(first, second, 'a retry must rewrite the same window, not a new one');
});

test('a run writes one document per grain and reports what it wrote', async () => {
  const { projector, written } = createHarness();
  const result = await projector.run();

  assert.equal(result.documentsWritten, written.length);
  assert.equal(result.completeness, 'complete');
  assert.deepEqual(
    [...new Set(written.map((document) => document.grain))].sort(),
    ['application', 'organization', 'subject', 'team'],
  );
});

test('rewriting a window produces identical identifiers', async () => {
  const first = createHarness();
  const second = createHarness();
  await first.projector.run();
  await second.projector.run();

  assert.deepEqual(
    first.written.map((document) => document.id),
    second.written.map((document) => document.id),
  );
});

test('a source failure still writes a window that says so', async () => {
  const { projector, written } = createHarness({
    readWindow: async () => {
      throw new Error('query timed out');
    },
  });
  const result = await projector.run();

  assert.equal(result.completeness, 'degraded');
  assert.ok(written.length > 0, 'a source outage must not look like a quiet hour');
  assert.equal(written[0].completeness.reason, 'source-unavailable');
  assert.equal(written[0].totals.requests, 0);
});

test('a truncated source is written as degraded rather than complete', async () => {
  const { projector, written } = createHarness({
    readWindow: async () => ({
      rows: [row()],
      state: 'complete',
      rowCount: 1000,
      rowLimit: 1000,
      revision: 'run-truncated',
    }),
  });
  await projector.run();

  assert.equal(written[0].completeness.state, 'degraded');
  assert.equal(written[0].completeness.reason, 'source-truncated');
});

test('the projector refuses a configuration without a scope', () => {
  assert.throws(
    () =>
      createRollupProjector({
        usageQuery: { readWindow: async () => ({}) },
        rollupStore: { putRollup: async () => {} },
        clock: createFixedClock(NOW),
        config: {},
      }),
    /scopeGroupId is required/,
  );
});

test('a window shorter than a minute is refused', () => {
  assert.throws(() => resolveWindow(NOW, 30), /at least 60/);
});

test('an unconfigured store keeps rollups in memory and says so', () => {
  const sink = createRollupStore({});

  assert.equal(sink.durability, 'ephemeral');
  assert.deepEqual(sink.written, []);
});

test('a configured store persists rollups and says so', () => {
  const store = createRollupStore({
    GOVERNANCE_STORE_ENDPOINT: 'https://store.documents.azure.com:443/',
    GOVERNANCE_DATABASE_NAME: 'governance',
  });

  assert.equal(store.durability, 'durable');
  assert.equal(typeof store.putRollup, 'function');
  assert.equal(store.written, undefined);
});

test('a half-configured store is not mistaken for a durable one', () => {
  for (const partial of [
    { GOVERNANCE_STORE_ENDPOINT: 'https://store.documents.azure.com:443/' },
    { GOVERNANCE_DATABASE_NAME: 'governance' },
  ]) {
    assert.equal(createRollupStore(partial).durability, 'ephemeral');
  }
});
