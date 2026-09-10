import assert from 'node:assert/strict';
import test from 'node:test';

import { projectUsageRollups } from '../../app/governance-domain/usage/usage-rollup-projector.mjs';
import {
  assertUsageRollupDocument,
  isUsageRollupDocumentValid,
} from '../../app/governance-domain/usage/usage-rollup-validator.mjs';

const WINDOW_START = '2026-08-04T00:00:00.000Z';
const WINDOW_END = '2026-08-04T01:00:00.000Z';
const AS_OF = '2026-08-04T01:05:00.000Z';

function source(overrides = {}) {
  return {
    state: 'complete',
    rowCount: 3,
    rowLimit: 5000,
    revision: 'projector-run-0001',
    ingestionLagSeconds: 0,
    ...overrides,
  };
}

function row(overrides = {}) {
  return {
    teamKey: 'platform-engineering',
    subjectKey: 'sk1-aaaaaaaaaaaaaaaaaaaa',
    applicationKey: 'ak1-bbbbbbbbbbbbbbbbbbbb',
    requestedModel: 'coding-primary',
    effectiveModel: 'coding-primary',
    promptTokens: 100,
    completionTokens: 50,
    tokenQuality: 'reported',
    outcome: 'succeeded',
    ...overrides,
  };
}

function project(rows, overrides = {}) {
  return projectUsageRollups({
    rows,
    scopeGroupId: 'platform-engineering',
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    asOf: AS_OF,
    source: source(),
    ...overrides,
  });
}

function organizationRollup(documents) {
  return documents.find((document) => document.grain === 'organization');
}

test('every grain is produced and each document validates', () => {
  const documents = project([row(), row({ teamKey: 'developer-experience' })]);
  const grains = [...new Set(documents.map((document) => document.grain))].sort();

  assert.deepEqual(grains, ['application', 'organization', 'subject', 'team']);
  for (const document of documents) assert.ok(isUsageRollupDocumentValid(document));
});

test('the per-model breakdown adds up to the totals', () => {
  const documents = project([
    row({ effectiveModel: 'coding-primary' }),
    row({ effectiveModel: 'coding-fast', promptTokens: 10, completionTokens: 5 }),
  ]);
  const totals = organizationRollup(documents);

  assert.equal(totals.totals.requests, 2);
  assert.equal(totals.totals.totalTokens, 165);
  assert.deepEqual(totals.byModel.map((entry) => entry.model), ['coding-fast', 'coding-primary']);
  assert.equal(
    totals.byModel.reduce((sum, entry) => sum + entry.measures.totalTokens, 0),
    totals.totals.totalTokens,
  );
});

test('one estimated row makes the whole window mixed rather than reported', () => {
  const documents = project([row(), row({ tokenQuality: 'estimated' })]);

  assert.equal(organizationRollup(documents).totals.tokenQuality, 'mixed');
});

test('a window whose rows all report keeps the reported label', () => {
  const documents = project([row(), row()]);

  assert.equal(organizationRollup(documents).totals.tokenQuality, 'reported');
});

test('a refused row cannot drag a window away from what its served rows measured', () => {
  // A refusal never reached a model, so it has no usage to qualify. The source is
  // expected to say so, but the window must not depend on it having remembered to.
  const documents = project([row(), row({ outcome: 'refused', tokenQuality: 'estimated' })]);
  const totals = organizationRollup(documents).totals;

  assert.equal(totals.tokenQuality, 'reported');
  assert.equal(totals.refusedRequests, 1);
});

test('a window of nothing but refusals measured no usage to qualify', () => {
  const documents = project([row({ outcome: 'refused', tokenQuality: 'reported' })]);

  assert.equal(organizationRollup(documents).totals.tokenQuality, 'unknown');
});

test('a request served by a different model is counted as a fallback', () => {
  const documents = project([
    row({ requestedModel: 'coding-primary', effectiveModel: 'coding-fast' }),
    row(),
  ]);

  assert.equal(organizationRollup(documents).totals.fallbackRequests, 1);
});

test('reaching the source row limit forbids claiming completeness', () => {
  const documents = project([row()], { source: source({ rowCount: 5000, rowLimit: 5000 }) });
  const completeness = organizationRollup(documents).completeness;

  assert.equal(completeness.state, 'degraded');
  assert.equal(completeness.reason, 'source-truncated');
});

test('an unavailable source degrades rather than reporting an empty window as complete', () => {
  const documents = project([], { source: source({ state: 'unavailable', rowCount: 0 }) });
  const completeness = organizationRollup(documents).completeness;

  assert.equal(completeness.state, 'degraded');
  assert.equal(completeness.reason, 'source-unavailable');
});

test('a window that has not closed yet is partial', () => {
  const documents = project([row()], { asOf: '2026-08-04T00:30:00.000Z' });
  const completeness = organizationRollup(documents).completeness;

  assert.equal(completeness.state, 'partial');
  assert.equal(completeness.reason, 'window-open');
});

test('a window summarized inside the ingestion lag is partial', () => {
  const documents = project([row()], {
    asOf: '2026-08-04T01:01:00.000Z',
    source: source({ ingestionLagSeconds: 300 }),
  });
  const completeness = organizationRollup(documents).completeness;

  assert.equal(completeness.state, 'partial');
  assert.equal(completeness.reason, 'ingestion-lag');
});

test('no traffic produces a zero organization window rather than nothing', () => {
  const documents = project([]);
  const totals = organizationRollup(documents);

  assert.ok(totals, 'a dashboard must be able to tell no traffic from no data');
  assert.equal(totals.totals.requests, 0);
  assert.equal(totals.completeness.state, 'complete');
  assert.deepEqual(totals.byModel, []);
});

test('a row that cannot be attributed at a grain is excluded from that grain only', () => {
  const documents = project([row(), row({ subjectKey: undefined })]);
  const subject = documents.filter((document) => document.grain === 'subject');

  assert.equal(subject.length, 1);
  assert.equal(subject[0].totals.requests, 1);
  assert.equal(organizationRollup(documents).totals.requests, 2, 'the organization still counts it');
});

test('the document identifier is derived from scope, grain, key, and window', () => {
  const documents = project([row()]);
  const team = documents.find((document) => document.grain === 'team');

  assert.equal(
    team.id,
    `usage-rollup|platform-engineering|team|platform-engineering|${WINDOW_START}`,
  );
});

test('a still-open window may not claim to be complete', () => {
  assert.throws(
    () =>
      assertUsageRollupDocument({
        contractVersion: 'v1',
        documentType: 'usage-rollup',
        id: `usage-rollup|team-a|organization||${WINDOW_START}`,
        scopeGroupId: 'team-a',
        grain: 'organization',
        windowStart: WINDOW_START,
        windowEnd: WINDOW_END,
        asOf: '2026-08-04T00:30:00.000Z',
        completeness: { state: 'complete', reason: 'window-closed' },
        sourceRevision: 'run-1',
        totals: {
          requests: 0,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          tokenQuality: 'unknown',
        },
        byModel: [],
      }),
    /cannot be reported complete before it ends/,
  );
});

test('a closed window may not describe itself as still open', () => {
  const documents = project([row()]);
  const candidate = {
    ...organizationRollup(documents),
    completeness: { state: 'partial', reason: 'window-open' },
  };

  assert.throws(() => assertUsageRollupDocument(candidate), /must be summarized before it ends/);
});

test('a completeness reason that contradicts its state is refused', () => {
  const documents = project([row()]);
  const candidate = { ...organizationRollup(documents), completeness: { state: 'complete', reason: 'window-open' } };

  assert.throws(() => assertUsageRollupDocument(candidate), /cannot accompany state/);
});

test('a breakdown that disagrees with the totals is refused', () => {
  const documents = project([row()]);
  const candidate = structuredClone(organizationRollup(documents));
  candidate.totals.requests = 5;

  assert.throws(() => assertUsageRollupDocument(candidate), /must sum to the total requests/);
});

test('the organization grain must not name a principal', () => {
  const documents = project([row()]);
  const candidate = { ...organizationRollup(documents), grainKey: 'someone' };

  assert.throws(() => assertUsageRollupDocument(candidate), /must not carry a key/);
});
