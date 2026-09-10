import assert from 'node:assert/strict';
import test from 'node:test';

import { projectUsage } from '../../app/control-api/usage-read-model-projector.mjs';

const generatedAt = '2026-08-08T00:00:00.000Z';

const ALICE = 'sk1-local-platform-engineering-1';
const BOB = 'sk1-local-platform-engineering-2';
const CARLA = 'sk1-local-developer-experience-1';

function authorization(permittedReadScopes, permittedTeamKeys = ['platform-engineering']) {
  return {
    contractVersion: 'v1',
    readAuthority: 'authoritative',
    permittedReadScopes,
    permittedTeamKeys,
    reasonCode: 'authorized',
  };
}

function record({
  correlationId,
  subjectKey = ALICE,
  teamKey = 'platform-engineering',
  modelKey = 'coding-primary',
  requestedModelKey = null,
  applicationQuality = 'generic',
  applicationReasonCode = 'application-registered',
  outcome = 'served',
  promptTokens = 100,
  completionTokens = 20,
  tokenQuality = 'reported',
  cost,
} = {}) {
  const total = outcome === 'refused' ? 0 : promptTokens + completionTokens;
  return {
    contractVersion: 'v1',
    documentType: 'usage-record',
    id: `usage-record|platform-engineering|${correlationId}`,
    correlationId,
    outcome,
    attribution: {
      teamKey,
      subjectKey,
      applicationKey: 'ak1-local-console-0000',
      applicationQuality,
      applicationReasonCode,
    },
    requested: { modelKey: requestedModelKey ?? modelKey, providerKey: 'azure-openai' },
    effective: { modelKey, providerKey: 'azure-openai' },
    usage: {
      promptTokens: outcome === 'refused' ? 0 : promptTokens,
      completionTokens: outcome === 'refused' ? 0 : completionTokens,
      totalTokens: total,
      tokenQuality,
    },
  };
}

const completeWindow = Object.freeze({
  windowStart: '2026-08-07T21:00:00.000Z',
  windowEnd: '2026-08-08T00:00:00.000Z',
  asOf: generatedAt,
  completeness: { state: 'complete', reason: 'window-closed' },
  freshness: { state: 'fresh', reportedAt: '2026-08-08T00:00:00.000Z', lagSeconds: 300 },
});

function project(records, { scope = 'global', view = 'users', teamKey = null, viewer = null, window = completeWindow, scopes = ['self', 'team', 'global'] } = {}) {
  return projectUsage({
    authorization: authorization(scopes),
    records,
    window,
    selection: { view, scope, teamKey, generatedAt },
    viewer,
  });
}

test('a user row aggregates that user\'s requests, tokens, outcomes and models', () => {
  const readModel = project([
    record({ correlationId: 'r1' }),
    record({ correlationId: 'r2', modelKey: 'coding-fast', promptTokens: 40, completionTokens: 10 }),
    record({ correlationId: 'r3', subjectKey: BOB }),
  ]);

  assert.equal(readModel.readModelVersion, 'usage.v1');
  assert.deepEqual(readModel.records.map((row) => row.entityKey), [ALICE, BOB]);

  const alice = readModel.records[0];
  assert.equal(alice.entityKind, 'user');
  assert.equal(alice.requests, 2);
  assert.equal(alice.promptTokens, 140);
  assert.equal(alice.completionTokens, 30);
  assert.equal(alice.totalTokens, 170);
  assert.deepEqual(alice.outcomes, { served: 2, refused: 0, failed: 0 });
  assert.deepEqual(alice.byModel.map((entry) => entry.modelKey), ['coding-fast', 'coding-primary']);
  assert.equal(readModel.totals.requests, 3);
});

test('the groups view aggregates by team rather than by subject', () => {
  const readModel = project(
    [
      record({ correlationId: 'r1' }),
      record({ correlationId: 'r2', subjectKey: BOB }),
      record({ correlationId: 'r3', subjectKey: CARLA, teamKey: 'developer-experience' }),
    ],
    { view: 'groups' },
  );

  assert.deepEqual(
    readModel.records.map((row) => [row.entityKind, row.entityKey, row.requests]),
    [['group', 'developer-experience', 1], ['group', 'platform-engineering', 2]],
  );
});

test('a team scope sees only its own team, and a self scope only its own subject', () => {
  const records = [
    record({ correlationId: 'r1' }),
    record({ correlationId: 'r2', subjectKey: BOB }),
    record({ correlationId: 'r3', subjectKey: CARLA, teamKey: 'developer-experience' }),
  ];

  const team = project(records, { scope: 'team', teamKey: 'platform-engineering' });
  assert.deepEqual(team.records.map((row) => row.entityKey), [ALICE, BOB]);
  assert.equal(team.selection.teamKey, 'platform-engineering');

  const self = project(records, { scope: 'self', viewer: { subjectKey: BOB } });
  assert.deepEqual(self.records.map((row) => row.entityKey), [BOB]);
  assert.equal(self.totals.requests, 1);
});

test('a self scope cannot read a group aggregate built from other principals', () => {
  assert.throws(
    () => project([record({ correlationId: 'r1' })], { scope: 'self', view: 'groups', viewer: { subjectKey: ALICE } }),
    (error) => error.code === 'view-not-permitted-for-scope',
  );
});

test('a self scope with no known subject key is refused rather than shown an empty screen', () => {
  assert.throws(
    () => project([record({ correlationId: 'r1' })], { scope: 'self' }),
    (error) => error.code === 'viewer-subject-key-unavailable',
  );
});

test('an unpermitted scope is denied before any aggregate is built', () => {
  assert.throws(
    () => project([record({ correlationId: 'r1' })], { scope: 'global', scopes: ['self'] }),
    (error) => error.code === 'scope-denied',
  );
});

test('one estimated request makes the whole aggregate mixed', () => {
  const readModel = project([
    record({ correlationId: 'r1' }),
    record({ correlationId: 'r2', tokenQuality: 'estimated' }),
  ]);

  assert.equal(readModel.records[0].tokenQuality, 'mixed');
});

test('a degraded window publishes no counts at all', () => {
  const readModel = project([record({ correlationId: 'r1' })], {
    window: { ...completeWindow, completeness: { state: 'degraded', reason: 'source-unavailable' } },
  });

  assert.equal(readModel.quality.state, 'degraded');
  assert.equal(readModel.quality.countsMeasured, false);
  assert.equal(readModel.quality.reasonCode, 'source-unavailable');
  assert.equal(readModel.totals, null);
  assert.deepEqual(readModel.records, []);
});

test('an open window still reports its counts, marked partial', () => {
  const readModel = project([record({ correlationId: 'r1' })], {
    window: { ...completeWindow, completeness: { state: 'partial', reason: 'window-open' } },
  });

  assert.equal(readModel.quality.state, 'partial');
  assert.equal(readModel.quality.countsMeasured, true);
  assert.equal(readModel.records[0].requests, 1);
  assert.equal(readModel.window.completenessReason, 'window-open');
});

test('how late the reading is must be stated, not assumed to be current', () => {
  const { freshness: _omitted, ...withoutFreshness } = completeWindow;
  assert.throws(
    () => project([record({ correlationId: 'r1' })], { window: withoutFreshness }),
    /window\.freshness is required/,
  );

  for (const freshness of [
    { state: 'whenever', reportedAt: completeWindow.windowEnd, lagSeconds: 60 },
    { state: 'fresh', reportedAt: completeWindow.windowEnd, lagSeconds: -1 },
    { state: 'fresh', reportedAt: 'not-an-instant', lagSeconds: 60 },
  ]) {
    assert.throws(
      () => project([record({ correlationId: 'r1' })], { window: { ...completeWindow, freshness } }),
      TypeError,
      JSON.stringify(freshness),
    );
  }

  const stale = project([record({ correlationId: 'r1' })], {
    window: {
      ...completeWindow,
      freshness: { state: 'stale', reportedAt: '2026-08-07T23:00:00.000Z', lagSeconds: 7_200 },
    },
  });
  assert.equal(stale.quality.freshnessState, 'stale');
  assert.equal(stale.window.reportedAt, '2026-08-07T23:00:00.000Z');
  assert.equal(stale.window.lagSeconds, 7_200);
  // Late is not the same as incomplete: what was observed is still published.
  assert.equal(stale.quality.countsMeasured, true);
  assert.equal(stale.records[0].requests, 1);
});

test('the read model carries no request body and no raw principal identifier', () => {
  const serialized = JSON.stringify(project([record({ correlationId: 'r1' })]));
  for (const forbidden of ['prompt', 'completion', 'subjectId', 'applicationId', 'requestBody', 'responseBody']) {
    assert.ok(!serialized.includes(`"${forbidden}"`), `read model must not carry ${forbidden}`);
  }
});

test('an aggregate never claims a specific client for traffic that came through a shared tool', () => {
  const readModel = project([
    record({ correlationId: 'r1', applicationQuality: 'strong' }),
    record({ correlationId: 'r2', applicationQuality: 'generic' }),
    record({ correlationId: 'r3', applicationQuality: null, applicationReasonCode: 'application-unregistered' }),
  ]);

  const attribution = readModel.records[0].attribution;
  assert.equal(attribution.state, 'mixed');
  assert.equal(attribution.strongRequests, 1);
  assert.equal(attribution.genericRequests, 1);
  assert.equal(attribution.unavailableRequests, 1);
  assert.deepEqual(attribution.reasonCodes, ['application-unregistered']);

  // One request through a shared tool is enough to stop the aggregate claiming the
  // stronger answer for all of them.
  const allStrong = project([
    record({ correlationId: 's1', applicationQuality: 'strong' }),
    record({ correlationId: 's2', applicationQuality: 'strong' }),
  ]);
  assert.equal(allStrong.records[0].attribution.state, 'strong');

  const oneShared = project([
    record({ correlationId: 's1', applicationQuality: 'strong' }),
    record({ correlationId: 's2', applicationQuality: 'generic' }),
  ]);
  assert.notEqual(oneShared.records[0].attribution.state, 'strong');

  // Nothing known is reported as nothing known rather than as a count of zero that
  // reads like an answer.
  const noneKnown = project([
    record({ correlationId: 'u1', applicationQuality: null, applicationReasonCode: 'application-unregistered' }),
  ]);
  assert.equal(noneKnown.records[0].attribution.state, 'unavailable');
});

test('a request served by a different model than it asked for says so', () => {
  const readModel = project([
    record({ correlationId: 'r1', modelKey: 'coding-fast', requestedModelKey: 'coding-primary' }),
    record({ correlationId: 'r2', modelKey: 'coding-fast' }),
    record({ correlationId: 'r3', modelKey: 'coding-primary' }),
  ]);

  const row = readModel.records[0];
  assert.equal(row.substitutedRequests, 1);
  const fast = row.byModel.find((entry) => entry.modelKey === 'coding-fast');
  assert.equal(fast.substitutedRequests, 1);
  assert.deepEqual(fast.requestedModelKeys, ['coding-fast', 'coding-primary']);

  const primary = row.byModel.find((entry) => entry.modelKey === 'coding-primary');
  assert.equal(primary.substitutedRequests, 0);
  assert.deepEqual(primary.requestedModelKeys, ['coding-primary']);

  // The totals are merged through the same pair of functions as a per-entity bucket,
  // because each building the shape separately is how a field reached one and not the
  // other.
  assert.equal(readModel.totals.substitutedRequests, 1);
  assert.deepEqual(
    readModel.totals.byModel.find((entry) => entry.modelKey === 'coding-fast').requestedModelKeys,
    ['coding-fast', 'coding-primary'],
  );
  assert.equal(readModel.totals.attribution.genericRequests, 3);
});
