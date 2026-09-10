import assert from 'node:assert/strict';
import test from 'node:test';

import { buildOverviewFromRollups } from '../../app/control-api/overview-usage-source.mjs';
import { getLocalRollups } from '../../app/local-adapters/rollup-fixtures.mjs';
import { projectAdminOverview } from '../../app/control-api/admin-read-model-projector.mjs';
import { MESSAGES, SUPPORTED_LOCALES } from '../../app/admin-ui/public/i18n.mjs';
import { CONFIGURATION_SUMMARY_STATES } from '../../app/functions/composition-root.mjs';

const AS_OF = '2026-07-24T10:00:00.000Z';
const CONFIGURATION = Object.freeze({
  activeVersion: 'cfg-local-003',
  state: 'active',
  publishedAt: '2026-07-24T09:30:00.000Z',
});

function build(overrides = {}) {
  return buildOverviewFromRollups({
    documents: getLocalRollups({ asOf: AS_OF }),
    asOf: AS_OF,
    configuration: CONFIGURATION,
    ...overrides,
  });
}

function metric(model, id) {
  return model.metrics.find((candidate) => candidate.id === id);
}

test('requests and tokens are summed from the rollup windows', () => {
  const documents = getLocalRollups({ asOf: AS_OF });
  const organization = documents.filter((document) => document.grain === 'organization');
  const expectedRequests = organization.reduce((total, document) => total + document.totals.requests, 0);
  const expectedTokens = organization.reduce((total, document) => total + document.totals.totalTokens, 0);

  const model = build();

  assert.equal(metric(model, 'requests').value, expectedRequests);
  assert.equal(metric(model, 'tokens').value, expectedTokens);
  assert.equal(metric(model, 'requests').source, 'gateway-usage-rollup');
});

test('measures the rollups do not carry are absent rather than zero', () => {
  const model = build();

  for (const id of ['latency', 'errors']) {
    assert.equal(metric(model, id).value, null, id);
    assert.equal(metric(model, id).quality, 'unknown', id);
    assert.equal(metric(model, id).source, 'not-collected', id);
  }
  for (const entry of model.modelUsage) {
    assert.equal(entry.quotaPercent, null);
    assert.equal(entry.errors, null);
  }
});

test('one estimated window makes the token measure estimated for the whole range', () => {
  const model = build();

  assert.equal(metric(model, 'tokens').quality, 'estimated');
  // The request count is a count, not a token estimate, so it stays reported.
  assert.equal(metric(model, 'requests').quality, 'reported');
});

test('the refusal ratio is derived rather than declared', () => {
  const documents = getLocalRollups({ asOf: AS_OF });
  const organization = documents.filter((document) => document.grain === 'organization');
  const refused = organization.reduce((total, document) => total + document.totals.refusedRequests, 0);
  const requests = organization.reduce((total, document) => total + document.totals.requests, 0);

  assert.ok(refused > 0, 'the fixture must contain a refusal for this to prove anything');
  assert.equal(metric(build(), 'rejections').value, refused / requests);
});

test('a team scope reads team documents and never the organization aggregate', () => {
  const global = build();
  const team = build({ scope: 'team', teamKey: 'developer-experience' });

  assert.ok(metric(team, 'requests').value < metric(global, 'requests').value);
  assert.deepEqual(
    team.modelUsage.map((entry) => entry.model),
    ['coding-fast'],
  );
});

test('an unknown team reports no data instead of another team data', () => {
  const model = build({ scope: 'team', teamKey: 'no-such-team' });

  assert.equal(metric(model, 'requests').value, null);
  assert.deepEqual(model.modelUsage, []);
  assert.equal(model.freshness.aggregation, 'unavailable');
  assert.equal(model.attention[0].titleCode, 'usage-window-degraded');
});

test('a range shorter than the available history narrows what is counted', () => {
  const wide = build({ range: '7d' });
  const narrow = buildOverviewFromRollups({
    documents: getLocalRollups({ asOf: AS_OF, windows: 3 }),
    asOf: AS_OF,
    range: '24h',
    configuration: CONFIGURATION,
  });

  assert.equal(metric(wide, 'requests').value, metric(narrow, 'requests').value);
  assert.equal(metric(wide, 'requests').value > 0, true);
});

test('a degraded window is reported as degraded rather than smoothed away', () => {
  const documents = getLocalRollups({ asOf: AS_OF });
  const degraded = documents.map((document, index) =>
    index === 0
      ? { ...document, completeness: { state: 'degraded', reason: 'source-unavailable' } }
      : document,
  );

  const model = buildOverviewFromRollups({ documents: degraded, asOf: AS_OF, configuration: CONFIGURATION });

  assert.equal(model.freshness.aggregation, 'partial');
  assert.equal(model.freshness.reconciliation, 'delayed');
  assert.equal(model.operatingState.find((entry) => entry.id === 'usage-aggregation').valueCode, 'partial');
  assert.equal(model.attention[0].severity, 'warning');
});

test('per-request activity is empty because rollups are aggregates', () => {
  assert.deepEqual(build().recentActivity, []);
});

test('the governance-configuration operating state reflects whether a configuration is genuinely active', () => {
  const active = build();
  const activeEntry = active.operatingState.find((entry) => entry.id === 'governance-configuration');
  assert.equal(activeEntry.valueCode, 'active');
  assert.equal(activeEntry.tone, 'success');

  for (const state of ['no-active-revision', 'unavailable']) {
    const model = build({ configuration: { activeVersion: null, state, publishedAt: null } });
    const entry = model.operatingState.find((entry) => entry.id === 'governance-configuration');
    assert.equal(entry.valueCode, state);
    assert.equal(entry.tone, 'warning');
  }
});

test('the rollup-backed model satisfies the body-free read-model contract', () => {
  const readModel = projectAdminOverview({
    authorization: {
      contractVersion: 'v1',
      readAuthority: 'authoritative',
      permittedReadScopes: ['global', 'team', 'self'],
      permittedTeamKeys: ['platform-engineering'],
    },
    fixture: build(),
    selection: { scope: 'global', range: '24h', teamKey: 'platform-engineering' },
  });

  assert.equal(readModel.readModelVersion, 'overview.v2');
  assert.equal(readModel.selection.fixture, 'gateway-usage-rollup');
});

test('every code the rollup source emits has a translation in every locale', () => {
  const model = build({ scope: 'team', teamKey: 'no-such-team' });
  const complete = build();
  const codes = [
    ...[...model.metrics, ...complete.metrics].map((entry) => `source.${entry.source}`),
    ...[...model.metrics, ...complete.metrics].map((entry) => `freshness.${entry.freshness}`),
    ...[...model.metrics, ...complete.metrics].map((entry) => `quality.${entry.quality}`),
    ...model.attention.flatMap((entry) => [`attention.${entry.titleCode}`, `attention.${entry.reasonCode}`]),
    ...complete.modelUsage.map((entry) => `quality.${entry.quality}`),
    `aggregation.${complete.freshness.aggregation}`,
    `aggregation.${model.freshness.aggregation}`,
    // A deployment's configuration state is read from the store rather than fixed,
    // so every state the reader may report has to be renderable, not just the one
    // this file's fixture happens to carry.
    ...CONFIGURATION_SUMMARY_STATES.map((state) => `status.${state}`),
  ];

  for (const locale of SUPPORTED_LOCALES) {
    for (const code of new Set(codes)) {
      assert.ok(Object.hasOwn(MESSAGES[locale], code), `${locale} is missing ${code}`);
    }
  }
});

test('a degraded window reports unknown counts rather than a measured zero', () => {
  const degraded = getLocalRollups({ asOf: AS_OF }).map((document) => ({
    ...document,
    completeness: { state: 'degraded', reason: 'source-unavailable' },
  }));

  const model = buildOverviewFromRollups({ documents: degraded, asOf: AS_OF, configuration: CONFIGURATION });

  for (const id of ['requests', 'tokens', 'rejections']) {
    assert.equal(metric(model, id).value, null, id);
    assert.equal(metric(model, id).quality, 'unknown', id);
  }
  // The breakdown still names the models seen, because that much was observed.
  assert.ok(model.modelUsage.length > 0);
});
