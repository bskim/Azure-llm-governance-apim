import assert from 'node:assert/strict';
import test from 'node:test';

import {
  planDriftNotifications,
  planPublishNotifications,
} from '../../app/governance-domain/usage/governance-event-notifications.mjs';
import { detectUsageDrift } from '../../app/governance-domain/usage/drift-detector.mjs';
import { createRevision, applyLifecycleCommand } from '../../app/governance-domain/lifecycle/configuration-lifecycle.mjs';

const SCOPE = 'platform-engineering';
const NOW = '2026-08-10T12:00:00.000Z';

function publishing({ at = '2026-08-10T10:00:00.000Z' } = {}) {
  const draft = createRevision({
    revisionId: 'revision-0042',
    scopeGroupId: SCOPE,
    revisionNumber: 42,
    authoredBy: 'admin-a',
    authoredAt: '2026-08-10T09:00:00.000Z',
    targets: ['gateway-policy', 'gateway-backend'],
  });
  const approved = applyLifecycleCommand({
    revision: draft,
    command: 'approve',
    actor: 'admin-b',
    at: '2026-08-10T09:30:00.000Z',
    expectedRevisionNumber: 42,
    reasonCode: 'change-reviewed',
  }).revision;
  return applyLifecycleCommand({
    revision: approved,
    command: 'publish',
    actor: 'admin-b',
    at,
    expectedRevisionNumber: 42,
    reasonCode: 'publish-approved',
    publishingRevisionId: null,
  }).revision;
}

function failed({ at = '2026-08-10T10:00:00.000Z' } = {}) {
  return applyLifecycleCommand({
    revision: publishing({ at }),
    command: 'fail',
    actor: 'admin-b',
    at: '2026-08-10T10:05:00.000Z',
    expectedRevisionNumber: 42,
    reasonCode: 'gateway-write-rejected',
  }).revision;
}

test('a failed publish is raised, with the reason it failed for', () => {
  const { planned } = planPublishNotifications({
    scopeGroupId: SCOPE,
    revisions: [failed()],
    evaluationTime: NOW,
  });

  assert.equal(planned.length, 1);
  assert.equal(planned[0].kind, 'publish-failed');
  assert.equal(planned[0].severity, 'critical');
  assert.equal(planned[0].scope, 'organization');
  assert.match(planned[0].key, /gateway-write-rejected/);
});

test('a publish that is still running or already active raises nothing', () => {
  const { planned } = planPublishNotifications({
    scopeGroupId: SCOPE,
    revisions: [publishing()],
    evaluationTime: NOW,
  });

  assert.deepEqual(planned, []);
});

test('a second failure after a retry is a new fact, not the same one', () => {
  // The revision number does not move when a publish is retried, so keying on it
  // would silence every failure after the first.
  const first = failed({ at: '2026-08-10T10:00:00.000Z' });
  const retried = applyLifecycleCommand({
    revision: first,
    command: 'retry',
    actor: 'admin-b',
    at: '2026-08-10T11:00:00.000Z',
    expectedRevisionNumber: 42,
    reasonCode: 'publish-retried',
  }).revision;
  const secondFailure = applyLifecycleCommand({
    revision: retried,
    command: 'fail',
    actor: 'admin-b',
    at: '2026-08-10T11:05:00.000Z',
    expectedRevisionNumber: 42,
    reasonCode: 'gateway-write-rejected',
  }).revision;

  const one = planPublishNotifications({ scopeGroupId: SCOPE, revisions: [first], evaluationTime: NOW });
  const two = planPublishNotifications({
    scopeGroupId: SCOPE,
    revisions: [secondFailure],
    evaluationTime: NOW,
  });

  assert.notEqual(one.planned[0].key, two.planned[0].key);
});

test('the same failure seen twice is suppressed rather than repeated', () => {
  const revision = failed();
  const first = planPublishNotifications({ scopeGroupId: SCOPE, revisions: [revision], evaluationTime: NOW });
  const second = planPublishNotifications({
    scopeGroupId: SCOPE,
    revisions: [revision],
    evaluationTime: NOW,
    alreadyNotified: new Set(first.planned.map((notification) => notification.key)),
  });

  assert.deepEqual(second.planned, []);
  assert.deepEqual(
    second.suppressed.map((entry) => entry.reasonCode),
    ['already-notified'],
  );
});

function drift(overrides = {}) {
  return detectUsageDrift({
    windowStart: '2026-08-10T09:00:00.000Z',
    windowEnd: '2026-08-10T10:00:00.000Z',
    internal: { requests: 100, totalTokens: 1000, completeness: 'complete' },
    provider: { requests: 100, totalTokens: 1000, completeness: 'complete' },
    evaluationTime: NOW,
    ...overrides,
  });
}

test('a window the two sides agree on raises nothing', () => {
  const { planned } = planDriftNotifications({ scopeGroupId: SCOPE, drift: drift(), evaluationTime: NOW });
  assert.deepEqual(planned, []);
});

test('a disputed window is raised against the window it disputes', () => {
  const { planned } = planDriftNotifications({
    scopeGroupId: SCOPE,
    drift: drift({ provider: { requests: 140, totalTokens: 1400, completeness: 'complete' } }),
    evaluationTime: NOW,
  });

  assert.equal(planned.length, 1);
  assert.equal(planned[0].kind, 'usage-drift-detected');
  assert.equal(planned[0].periodStart, '2026-08-10T09:00:00.000Z');
  assert.match(planned[0].key, /2026-08-10T09:00:00\.000Z/);
});

test('a comparison that could not be made is raised as unverifiable, never as agreement', () => {
  // Nothing was compared, so nothing is disputed — but reporting silence here would
  // present an unchecked window as a checked one.
  const { planned } = planDriftNotifications({
    scopeGroupId: SCOPE,
    drift: drift({ provider: { requests: 0, totalTokens: 0, completeness: 'partial' } }),
    evaluationTime: NOW,
  });

  assert.equal(planned.length, 1);
  assert.equal(planned[0].kind, 'usage-drift-unverifiable');
  assert.equal(planned[0].severity, 'warning');
  assert.match(planned[0].key, /provider-incomplete/);
});

test('a notification kind the product does not define is refused', () => {
  assert.throws(
    () =>
      planPublishNotifications({
        scopeGroupId: SCOPE,
        revisions: [failed()],
        evaluationTime: NOW,
        kind: 'publish-exploded',
      }),
    /kind/,
  );
});

test('a raised event carries no actor, body, or credential vocabulary', () => {
  const { planned } = planPublishNotifications({
    scopeGroupId: SCOPE,
    revisions: [failed()],
    evaluationTime: NOW,
  });
  const serialized = JSON.stringify(planned);
  for (const forbidden of ['prompt', 'completion', 'secret', 'authorization', 'admin-b']) {
    assert.doesNotMatch(serialized, new RegExp(forbidden, 'i'));
  }
});
