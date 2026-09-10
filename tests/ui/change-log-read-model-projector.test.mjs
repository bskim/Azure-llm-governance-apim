import assert from 'node:assert/strict';
import test from 'node:test';

import { projectChangeLog, buildChangeLogExport } from '../../app/control-api/change-log-read-model-projector.mjs';
import { deriveChangeEntries } from '../../app/governance-domain/change-log/derive-change-entries.mjs';
import {
  applyLifecycleCommand,
  createRevision,
  recordTargetOutcome,
} from '../../app/governance-domain/lifecycle/configuration-lifecycle.mjs';

const GENERATED_AT = '2026-08-19T09:00:00.000Z';

/**
 * Built through the reducer that actually writes this history. A hand-written
 * revision would encode a belief about the shape rather than the shape itself, and
 * this deriver was wrong about exactly that until it met the real one.
 */
function revision() {
  let held = createRevision({
    revisionId: 'revision-0009',
    scopeGroupId: 'platform-engineering',
    revisionNumber: 9,
    authoredBy: 'operator-one',
    authoredAt: '2026-08-19T07:00:00.000Z',
    targets: ['governance-snapshot-budget', 'governance-snapshot-entitlement'],
  });
  const apply = (command, actor, at, extra = {}) => {
    const outcome = applyLifecycleCommand({
      revision: held,
      command,
      actor,
      at,
      expectedRevisionNumber: held.revisionNumber,
      publishingRevisionId: null,
      selfApprovalGranted: false,
      ...extra,
    });
    if (outcome.ok !== true) throw new Error(`${command}: ${outcome.code}`);
    held = outcome.revision;
  };
  apply('approve', 'operator-two', '2026-08-19T07:05:00.000Z');
  apply('publish', 'operator-two', '2026-08-19T07:08:00.000Z');
  for (const targetCode of ['governance-snapshot-budget', 'governance-snapshot-entitlement']) {
    for (const outcome of ['written', 'verified']) {
      const recorded = recordTargetOutcome({
        revision: held,
        targetCode,
        outcome,
        at: '2026-08-19T07:10:00.000Z',
      });
      if (recorded.ok !== true) throw new Error(`${targetCode} ${outcome}: ${recorded.code}`);
      held = recorded.revision;
    }
  }
  return held;
}

function notification(overrides = {}) {
  return {
    key: 'notification-key-one',
    kind: 'usage-drift-detected',
    raisedAt: '2026-08-19T08:00:00.000Z',
    scope: 'organization',
    scopeKey: null,
    ...overrides,
  };
}

function authorization(permittedReadScopes, effectiveRoles = ['auditor']) {
  return {
    contractVersion: 'v1',
    readAuthority: 'authoritative',
    permittedReadScopes,
    permittedTeamKeys: ['platform-engineering'],
    effectiveRoles,
  };
}

const selection = (scope = 'global') => ({ scope, teamKey: null, generatedAt: GENERATED_AT });

test('a publication is one change per target it touched, plus its lifecycle steps', () => {
  const entries = deriveChangeEntries({ revisions: [revision()], notifications: [] });

  const byCategory = entries.reduce((counts, entry) => {
    counts[entry.category] = (counts[entry.category] ?? 0) + 1;
    return counts;
  }, {});
  // create, approve and publish are lifecycle steps; the budget and entitlement
  // targets are each written and then verified.
  assert.deepEqual(byCategory, { publish: 3, budget: 2, permission: 2 });
  assert.equal(entries.every((entry) => !('sequence' in entry) && !('hash' in entry)), true);
});

test('a drift notification is a drift change, and an ordinary one is not', () => {
  const entries = deriveChangeEntries({
    revisions: [],
    notifications: [notification(), notification({ key: 'notification-key-two', kind: 'budget-exhausted' })],
  });

  assert.deepEqual(entries.map((entry) => entry.category).sort(), ['drift', 'notification']);
  assert.equal(entries.every((entry) => entry.actorKind === 'system'), true);
});

test('entries read newest first', () => {
  const entries = deriveChangeEntries({ revisions: [revision()], notifications: [notification()] });

  const times = entries.map((entry) => Date.parse(entry.occurredAt));
  assert.deepEqual(times, [...times].sort((left, right) => right - left));
});

test('a global reader sees every source and the model says so', () => {
  const entries = deriveChangeEntries({ revisions: [revision()], notifications: [notification()] });

  const model = projectChangeLog({
    authorization: authorization(['global', 'team', 'self']),
    entries,
    selection: selection('global'),
  });

  assert.equal(model.readModelVersion, 'change-log.v1');
  assert.equal(model.quality.state, 'complete');
  assert.equal(model.quality.reasonCode, 'change-log-read');
  assert.equal(model.summary.total, entries.length);
  assert.equal(model.records[0].occurredAt, entries[0].occurredAt, 'newest first survives projection');
});

test('a self-scoped reader gets their own configuration surface, and is told it is narrowed', () => {
  const entries = deriveChangeEntries({
    revisions: [revision()],
    notifications: [notification({ kind: 'budget-exhausted' })],
  });

  const model = projectChangeLog({
    authorization: authorization(['self']),
    entries,
    selection: selection('self'),
  });

  assert.equal(model.quality.state, 'partial');
  assert.equal(model.quality.reasonCode, 'categories-limited-by-scope');
  assert.equal(model.records.some((record) => record.category === 'publish'), false);
  assert.equal(model.records.some((record) => record.category === 'permission'), false);
});

test('no record carries a linkage field a reader could mistake for proof', () => {
  const entries = deriveChangeEntries({ revisions: [revision()], notifications: [notification()] });
  const model = projectChangeLog({
    authorization: authorization(['global']),
    entries,
    selection: selection('global'),
  });

  const serialised = JSON.stringify(model);
  for (const forbidden of ['previousHash', '"hash"', '"sequence"', 'chainState']) {
    assert.equal(serialised.includes(forbidden), false, forbidden);
  }
});

test('taking a copy away is a separate permission from reading', () => {
  const entries = deriveChangeEntries({ revisions: [revision()], notifications: [] });
  const reader = authorization(['global'], ['end-user']);

  const model = projectChangeLog({ authorization: reader, entries, selection: selection('global') });
  assert.equal(model.export.permitted, false);
  assert.equal(model.export.manifest, null);

  assert.throws(
    () =>
      buildChangeLogExport({
        entries,
        authorization: reader,
        selection: selection('global'),
        generatedAt: GENERATED_AT,
      }),
    (error) => error.code === 'export-not-permitted',
  );
});

test('an export states what it never carries, as classes rather than as the words themselves', () => {
  const entries = deriveChangeEntries({ revisions: [revision()], notifications: [] });

  const copy = buildChangeLogExport({
    entries,
    authorization: authorization(['global']),
    selection: selection('global'),
    generatedAt: GENERATED_AT,
  });

  assert.equal(copy.documentType, 'change-log-export');
  assert.deepEqual([...copy.manifest.excluded], ['message-bodies', 'token-counts', 'credentials']);
  assert.equal(copy.rows.length, entries.length);
  assert.equal(Object.hasOwn(copy.manifest, 'chainState'), false);
});

test('a raw directory identifier is refused wherever an actor would be shown', () => {
  const held = revision();
  const withRawActor = {
    ...held,
    history: [
      { ...held.history[0], actor: '11111111-1111-4111-8111-111111111111' },
      ...held.history.slice(1),
    ],
  };

  assert.throws(
    () => deriveChangeEntries({ revisions: [withRawActor], notifications: [] }),
    (error) => error.code === 'actor-not-pseudonymous',
  );
});
