import assert from 'node:assert/strict';
import test from 'node:test';

import {
  notificationKey,
  planBudgetNotifications,
} from '../../app/governance-domain/usage/budget-notification-planner.mjs';

const scopeGroupId = 'developer-experience';
const periodStart = '2026-08-01T00:00:00.000Z';
const evaluationTime = '2026-08-07T00:00:00.000Z';

function entry(overrides = {}) {
  return {
    budgetId: 'budget-org',
    budgetVersion: 1,
    period: 'Monthly',
    modelScope: 'all-models',
    scope: 'organization',
    scopeKey: null,
    action: 'SOFT_WARNING',
    state: 'enforceable',
    reasonCode: 'token-budget-passthrough',
    enforcedTokenQuota: 1_000,
    warnThresholdPercent: 90,
    ...overrides,
  };
}

function publication(entries, overrides = {}) {
  return { state: 'published', reasonCode: 'budgets-published', entries, ...overrides };
}

function observation(overrides = {}) {
  return {
    budgetId: 'budget-org',
    budgetVersion: 1,
    period: 'Monthly',
    modelScope: 'all-models',
    scope: 'organization',
    scopeKey: null,
    consumedTokens: 0,
    completeness: 'complete',
    ...overrides,
  };
}

function plan(entries, observations, alreadyNotified = new Set()) {
  return planBudgetNotifications({
    scopeGroupId,
    publication: publication(entries),
    observations,
    periodStart,
    evaluationTime,
    alreadyNotified,
  });
}

test('a period below its threshold earns nothing', () => {
  const { planned } = plan([entry()], [observation({ consumedTokens: 899 })]);
  assert.deepEqual(planned, []);
});

test('reaching the threshold earns exactly one warning', () => {
  const { planned } = plan([entry()], [observation({ consumedTokens: 900 })]);

  assert.equal(planned.length, 1);
  assert.equal(planned[0].kind, 'budget-threshold-reached');
  assert.equal(planned[0].severity, 'warning');
  assert.equal(planned[0].consumedBasisPoints, 9_000);
  assert.equal(planned[0].atBasisPoints, 9_000);
});

test('the same crossing seen again is suppressed rather than sent twice', () => {
  const first = plan([entry()], [observation({ consumedTokens: 950 })]);
  const again = plan(
    [entry()],
    [observation({ consumedTokens: 960 })],
    new Set(first.planned.map((notification) => notification.key)),
  );

  assert.equal(again.planned.length, 0);
  assert.deepEqual(again.suppressed, [
    { key: first.planned[0].key, reasonCode: 'already-notified' },
  ]);
});

test('exhaustion is a separate event from the warning that preceded it', () => {
  const { planned } = plan([entry()], [observation({ consumedTokens: 1_000 })]);

  assert.deepEqual(planned.map((notification) => notification.kind).sort(), [
    'budget-exhausted',
    'budget-threshold-reached',
  ]);
  const exhausted = planned.find((notification) => notification.kind === 'budget-exhausted');
  assert.equal(exhausted.severity, 'critical');
  // One says traffic is about to be affected and the other says it already is, so a
  // reader who acknowledged the first still has to see the second.
  assert.notEqual(exhausted.key, planned.find((n) => n.kind === 'budget-threshold-reached').key);
});

test('a republished budget warns again, because it warns about a different number', () => {
  const first = plan([entry()], [observation({ consumedTokens: 950 })]);
  const republished = plan(
    [entry({ budgetVersion: 2, enforcedTokenQuota: 500 })],
    [observation({ budgetVersion: 2, consumedTokens: 950 })],
    new Set(first.planned.map((notification) => notification.key)),
  );

  assert.ok(republished.planned.some((notification) => notification.kind === 'budget-threshold-reached'));
});

test('a new period starts a new crossing', () => {
  const first = plan([entry()], [observation({ consumedTokens: 950 })]);
  const next = planBudgetNotifications({
    scopeGroupId,
    publication: publication([entry()]),
    observations: [observation({ consumedTokens: 950 })],
    periodStart: '2026-09-01T00:00:00.000Z',
    evaluationTime: '2026-09-07T00:00:00.000Z',
    alreadyNotified: new Set(first.planned.map((notification) => notification.key)),
  });

  assert.equal(next.planned.length, 1);
});

test('an incomplete window says so rather than reading as a quiet period', () => {
  const { planned } = plan(
    [entry()],
    [observation({ consumedTokens: 100, completeness: 'partial', completenessReason: 'ingestion-lag' })],
  );

  assert.equal(planned.length, 1);
  assert.equal(planned[0].kind, 'aggregate-stale');
  assert.equal(planned[0].reasonCode, 'ingestion-lag');
});

test('an incomplete window never suppresses a crossing by looking like low consumption', () => {
  const { planned } = plan(
    [entry()],
    [observation({ consumedTokens: 100, completeness: 'degraded' })],
  );

  // The measured figure is below the threshold, but nothing may conclude from it.
  assert.equal(planned.some((notification) => notification.kind === 'budget-threshold-reached'), false);
  assert.equal(planned[0].kind, 'aggregate-stale');
});

test('a budget that could not be published is reported rather than passed over', () => {
  const { planned } = plan(
    [entry({ state: 'unenforceable', reasonCode: 'model-not-entitled', enforcedTokenQuota: null })],
    [observation()],
  );

  assert.equal(planned.length, 1);
  assert.equal(planned[0].kind, 'budget-unenforceable');
  assert.equal(planned[0].reasonCode, 'model-not-entitled');
});

test('a publication that produced nothing at all is itself the notification', () => {
  const { planned } = planBudgetNotifications({
    scopeGroupId,
    publication: { state: 'unavailable', reasonCode: 'budget-snapshot-degraded', entries: [] },
    observations: [],
    periodStart,
    evaluationTime,
  });

  assert.equal(planned.length, 1);
  assert.equal(planned[0].kind, 'budget-unenforceable');
  assert.equal(planned[0].reasonCode, 'budget-snapshot-degraded');
});

test('a budget with no matching observation is suppressed with a reason, not assumed unused', () => {
  const { planned, suppressed } = plan(
    [entry({ scope: 'team', scopeKey: 'platform-engineering' })],
    [observation()],
  );

  assert.deepEqual(planned, []);
  assert.deepEqual(suppressed, [{ budgetId: 'budget-org', reasonCode: 'no-observation' }]);
});

test('scoped budgets are matched to their own scope key', () => {
  const { planned } = plan(
    [
      entry({ budgetId: 'budget-team-a', scope: 'team', scopeKey: 'team-a' }),
      entry({ budgetId: 'budget-team-b', scope: 'team', scopeKey: 'team-b' }),
    ],
    [
      observation({ budgetId: 'budget-team-a', scope: 'team', scopeKey: 'team-a', consumedTokens: 950 }),
      observation({ budgetId: 'budget-team-b', scope: 'team', scopeKey: 'team-b', consumedTokens: 10 }),
    ],
  );

  assert.deepEqual(planned.map((notification) => notification.budgetId), ['budget-team-a']);
});

test('the key is derived rather than supplied, and refuses an unsupported kind', () => {
  const key = notificationKey({
    scopeGroupId,
    kind: 'budget-threshold-reached',
    budgetId: 'budget-org',
    budgetVersion: 1,
    periodStart,
    scope: 'organization',
    scopeKey: null,
    atBasisPoints: 9_000,
  });

  assert.equal(key, `notification|${scopeGroupId}|budget-threshold-reached|budget-org|1|${periodStart}|organization||9000`);
  assert.throws(() => notificationKey({ scopeGroupId, kind: 'email-sent', periodStart }), /unsupported/);
});

test('notifications carry no body and no raw identifier', () => {
  const { planned } = plan([entry()], [observation({ consumedTokens: 1_000 })]);

  const serialized = JSON.stringify(planned);
  for (const forbidden of ['prompt', 'completion', 'messages', 'subjectId', 'correlationId', 'email']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  for (const notification of planned) assert.ok(Object.isFrozen(notification));
});

test('observations for another model, period, or budget version cannot trigger a warning', () => {
  const budget = entry({ modelScope: 'per-model', modelKey: 'coding-primary', period: 'Daily' });
  for (const mismatch of [
    { modelScope: 'all-models', modelKey: undefined },
    { modelKey: 'coding-fast' },
    { period: 'Monthly' },
    { budgetId: 'another-budget' },
    { budgetVersion: 2 },
  ]) {
    const { planned, suppressed } = plan([budget], [
      observation({ ...budget, consumedTokens: 1000, ...mismatch }),
    ]);
    assert.deepEqual(planned, []);
    assert.deepEqual(suppressed, [{ budgetId: budget.budgetId, reasonCode: 'no-observation' }]);
  }
});
