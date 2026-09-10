import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildUsageWindowQuery,
  createLogAnalyticsUsageQuery,
} from '../../app/telemetry/log-analytics-usage-query.mjs';
import { projectUsageRollups } from '../../app/governance-domain/usage/usage-rollup-projector.mjs';
import { projectUsageRecords } from '../../app/governance-domain/usage/usage-record-projector.mjs';

const WINDOW = { windowStart: '2026-08-04T06:00:00.000Z', windowEnd: '2026-08-04T07:00:00.000Z' };

function response(rows) {
  return {
    status: 200,
    body: {
      tables: [
        {
          name: 'PrimaryResult',
          columns: [
            { name: 'correlationId' },
            { name: 'observedAt' },
            { name: 'teamKey' },
            { name: 'subjectKey' },
            { name: 'applicationKey' },
            { name: 'requestedModel' },
            { name: 'effectiveModel' },
            { name: 'promptTokens' },
            { name: 'completionTokens' },
            { name: 'outcome' },
            { name: 'tokenQuality' },
          ],
          rows,
        },
      ],
    },
  };
}

function createQuery(sendQuery, overrides = {}) {
  return createLogAnalyticsUsageQuery({
    workspaceId: 'workspace-0000',
    apiId: 'inference',
    sendQuery,
    ...overrides,
  });
}

test('the window is scoped by timespan rather than by literals in the query', async () => {
  let received;
  const query = createQuery(async (request) => {
    received = request;
    return response([]);
  });

  await query.readWindow(WINDOW);

  assert.equal(received.timespan, `${WINDOW.windowStart}/${WINDOW.windowEnd}`);
  assert.ok(!received.query.includes(WINDOW.windowStart), 'The window must not be interpolated into the query text.');
});

test('attribution and token counts are joined on the correlation identifier', () => {
  const query = buildUsageWindowQuery({ apiId: 'inference', rowLimit: 10 });

  assert.match(query, /ApiManagementGatewayLogs/);
  assert.match(query, /ApiManagementGatewayLlmLog/);
  assert.match(query, /join kind=leftouter \(usage\) on CorrelationId/);
});

test('a request the provider never reported on, but the gateway charged for, is counted as estimated', () => {
  // An abandoned stream is the case the ledger must not lose: the quota was already
  // debited, so reporting zero would hide budget that was actually spent.
  const query = buildUsageWindowQuery({ apiId: 'inference', rowLimit: 10 });

  assert.match(query, /GatewayTokens = max\(tolong\(bag\.ConsumedTokens\)\)/);
  assert.match(query, /Abandoned = NoProviderUsage and coalesce\(GatewayTokens, long\(0\)\) > 0/);
  assert.match(query, /promptTokens = iff\(Abandoned, GatewayTokens,/);
  assert.match(query, /Abandoned, 'estimated'/);
  // A request with neither a usage log nor a charge is still unknown, not zero-exact.
  assert.match(query, /NoProviderUsage, 'unknown'/);
  // Streaming and abandoning both read as estimated, so the record has to say which.
  assert.match(query, /exchangeState = iff\(Abandoned, 'abandoned'/);
  // `completion` is body vocabulary; a field named that would be refused downstream.
  assert.ok(!query.includes('\n    completion ='), 'the exchange state must not be named after the response body.');
});

test('a usage row that exists but carries nothing is treated as no provider figure', () => {
  // Deployed data shows both shapes: no row at all, and a row whose counts are zero.
  // A null check alone reads the second as a provider figure of zero, which is the
  // silent zero-exact record this requirement forbids.
  const query = buildUsageWindowQuery({ apiId: 'inference', rowLimit: 10 });

  assert.match(
    query,
    /NoProviderUsage = isnull\(PromptTokens\)\s*\n\s*or \(coalesce\(PromptTokens, long\(0\)\) == 0 and coalesce\(CompletionTokens, long\(0\)\) == 0\)/,
  );
});

test('the quality describes the number the row carries, not the gateway\'s parallel estimate', () => {
  // The projected counts come from the provider's log. Labelling them with the
  // gateway's assessment of its own estimate describes a different number, and read
  // every streamed request as estimated even where the provider reported exactly.
  const query = buildUsageWindowQuery({ apiId: 'inference', rowLimit: 10 });

  assert.ok(!query.includes('UsageQuality'), 'the gateway self-assessment must not qualify a provider count.');
  assert.match(query, /NoProviderUsage, 'unknown',\s*\n\s*'reported'\)/);
});

test('a refused request carries no usage quality of its own', () => {
  // It never reached a model, so it has nothing to qualify and must not drag a
  // window down to mixed.
  const query = buildUsageWindowQuery({ apiId: 'inference', rowLimit: 10 });

  assert.match(query, /tokenQuality = case\(\s*\n\s*set_has_element\(refusalCodes, ResponseCode\), 'unknown'/);
});

test('only the governed API is read, and only its governance trace records', () => {
  const query = buildUsageWindowQuery({ apiId: 'inference', rowLimit: 10 });

  assert.match(query, /ApiId == 'inference'/);
  assert.match(query, /startswith 'llm-governance'/);
  assert.match(
    query,
    /TeamKey = take_anyif\(\s*tostring\(bag\.TeamKey\),\s*isnotempty\(tostring\(bag\.TeamKey\)\) and tostring\(bag\.TeamKey\) != 'not-single-team'\)/,
  );
});

test('token totals are taken as a maximum so a split message is not counted twice', () => {
  const query = buildUsageWindowQuery({ apiId: 'inference', rowLimit: 10 });

  assert.match(query, /PromptTokens = max\(PromptTokens\)/);
  assert.doesNotMatch(query, /sum\(PromptTokens\)/);
});

// Kusto has no C-style width suffix; it reads `0L` as a column name and the query
// fails at the source. Every other test here inspects the query as text, so nothing
// else would notice.
test('numeric literals use the typed form Kusto accepts', () => {
  const query = buildUsageWindowQuery({ apiId: 'inference', rowLimit: 10 });

  assert.doesNotMatch(query, /\b\d+[LlUuFf]\b/);
  assert.match(query, /long\(0\)/);
});

test('each row carries the request identity and arrival time a record needs', () => {
  const query = buildUsageWindowQuery({ apiId: 'inference', rowLimit: 10 });

  assert.match(query, /correlationId = tostring\(CorrelationId\)/);
  // The earliest entry is when the request arrived. A later one is the same request
  // still being written, and taking it would move the record between reads.
  assert.match(query, /ObservedAt = min\(TimeGenerated\)/);
  assert.doesNotMatch(query, /max\(TimeGenerated\)/);
});

test('rows produced by the query satisfy the projector contract', async () => {
  const query = createQuery(async () =>
    response([
      ['request-1', '2026-08-04T06:10:00.000Z', 'team-alpha', 'sk1-aaaaaaaaaaaaaaaa', 'ak1-aaaaaaaaaaaaaaaa', 'coding-primary', 'coding-fast', 120, 30, 'served', 'reported'],
      ['request-2', '2026-08-04T06:20:00.000Z', 'team-alpha', 'sk1-bbbbbbbbbbbbbbbb', 'ak1-aaaaaaaaaaaaaaaa', 'coding-primary', 'coding-primary', 0, 0, 'refused', 'unknown'],
    ]),
  );

  const result = await query.readWindow(WINDOW);
  const documents = projectUsageRollups({
    rows: result.rows,
    scopeGroupId: 'platform-engineering',
    ...WINDOW,
    asOf: '2026-08-04T07:10:00.000Z',
    source: {
      state: result.state,
      rowCount: result.rowCount,
      rowLimit: result.rowLimit,
      revision: result.revision,
      ingestionLagSeconds: 300,
    },
  });

  const organization = documents.find((document) => document.grain === 'organization');
  assert.equal(organization.totals.requests, 2);
  assert.equal(organization.totals.totalTokens, 150);
  assert.equal(organization.totals.refusedRequests, 1);
  assert.equal(organization.totals.fallbackRequests, 1);
  // The refused row reports unknown quality, so the served row still decides the window.
  assert.equal(organization.totals.tokenQuality, 'reported');
  assert.equal(organization.completeness.state, 'complete');

  // The same rows feed the record projector, so one read produces the aggregate and
  // the per-request evidence rather than requiring two queries that could disagree.
  const { records } = projectUsageRecords({
    rows: result.rows,
    scopeGroupId: 'platform-engineering',
    configVersion: 1,
    sourceRevision: result.revision,
    projectedAt: '2026-08-04T07:10:00.000Z',
  });
  assert.deepEqual(records.map((record) => record.correlationId), ['request-1', 'request-2']);
  assert.equal(records[0].observedAt, '2026-08-04T06:10:00.000Z');
});

test('a row the record contract cannot attribute is refused, and the rollup still counts it', async () => {
  // The rollup groups by whatever key it is given; the record contract requires a
  // key of the shape the gateway actually emits. A short or absent key therefore
  // reaches the two projectors differently, and neither may fail the run.
  const query = createQuery(async () =>
    response([
      ['request-3', '2026-08-04T06:30:00.000Z', 'team-alpha', 'subject-1', 'app-1', 'coding-primary', 'coding-primary', 10, 5, 'served', 'reported'],
    ]),
  );
  const result = await query.readWindow(WINDOW);

  const { records, rejected } = projectUsageRecords({
    rows: result.rows,
    scopeGroupId: 'platform-engineering',
    configVersion: 1,
    sourceRevision: result.revision,
    projectedAt: '2026-08-04T07:10:00.000Z',
  });
  assert.equal(records.length, 0);
  assert.equal(rejected[0].reasonCode, 'record-invalid');

  const [organization] = projectUsageRollups({
    rows: result.rows,
    scopeGroupId: 'platform-engineering',
    grains: ['organization'],
    ...WINDOW,
    asOf: '2026-08-04T07:10:00.000Z',
    source: { state: result.state, rowCount: result.rowCount, rowLimit: result.rowLimit, revision: result.revision },
  });
  assert.equal(organization.totals.requests, 1);
});

test('a failed read reports an unavailable source rather than a quiet hour', async () => {
  for (const failure of [
    async () => ({ status: 403, body: {} }),
    async () => ({ status: 200, body: { error: { message: 'partial' } } }),
    async () => {
      throw new Error('socket hang up');
    },
  ]) {
    const result = await createQuery(failure).readWindow(WINDOW);

    assert.equal(result.state, 'unavailable');
    assert.equal(result.rows.length, 0);
    assert.ok(result.revision.startsWith('unavailable.'));
  }
});

test('an unavailable read degrades the window instead of failing the run', async () => {
  const result = await createQuery(async () => ({ status: 500, body: {} })).readWindow(WINDOW);
  const [document] = projectUsageRollups({
    rows: result.rows,
    scopeGroupId: 'platform-engineering',
    grains: ['organization'],
    ...WINDOW,
    asOf: '2026-08-04T07:10:00.000Z',
    source: {
      state: result.state,
      rowCount: result.rowCount,
      rowLimit: result.rowLimit,
      revision: result.revision,
      ingestionLagSeconds: 300,
    },
  });

  assert.equal(document.completeness.state, 'degraded');
  assert.equal(document.completeness.reason, 'source-unavailable');
});

test('a full page is reported as truncation rather than a complete window', async () => {
  const row = ['request-4', '2026-08-04T06:40:00.000Z', 'team-alpha', 'sk1-aaaaaaaaaaaaaaaa', 'ak1-aaaaaaaaaaaaaaaa', 'coding-fast', 'coding-fast', 1, 1, 'served', 'reported'];
  const query = createQuery(async () => response([row, row]), { rowLimit: 2 });

  const result = await query.readWindow(WINDOW);
  const [document] = projectUsageRollups({
    rows: result.rows,
    scopeGroupId: 'platform-engineering',
    grains: ['organization'],
    ...WINDOW,
    asOf: '2026-08-04T07:10:00.000Z',
    source: {
      state: result.state,
      rowCount: result.rowCount,
      rowLimit: result.rowLimit,
      revision: result.revision,
      ingestionLagSeconds: 300,
    },
  });

  assert.equal(document.completeness.state, 'degraded');
  assert.equal(document.completeness.reason, 'source-truncated');
});

test('a configuration gap is refused at construction rather than at the next scheduled run', () => {
  assert.throws(() => createLogAnalyticsUsageQuery({ apiId: 'inference', sendQuery: async () => {} }), TypeError);
  assert.throws(() => createLogAnalyticsUsageQuery({ workspaceId: 'w', apiId: 'inference' }), TypeError);
  assert.throws(() => createLogAnalyticsUsageQuery({ workspaceId: 'w', sendQuery: async () => {} }), TypeError);
});

test('the API identifier cannot carry query syntax into the source', () => {
  for (const hostile of ["inference' | union *", 'inference;drop', 'inference ', '-inference']) {
    assert.throws(() => buildUsageWindowQuery({ apiId: hostile, rowLimit: 10 }), TypeError);
  }
});
