import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyLifecycleCommand,
  createRevision,
} from '../../app/governance-domain/lifecycle/configuration-lifecycle.mjs';
import {
  compareRevisionForOverwrite,
  describeOverwrite,
} from '../../app/governance-domain/lifecycle/configuration-conflict.mjs';

const SCOPE = 'platform-engineering';

function draft() {
  return createRevision({
    revisionId: 'revision-0007',
    scopeGroupId: SCOPE,
    revisionNumber: 7,
    authoredBy: 'admin-a',
    authoredAt: '2026-07-24T09:00:00.000Z',
    targets: ['gateway-policy'],
  });
}

function must(result) {
  if (result.ok !== true) throw new Error(result.code);
  return result.revision;
}

test('a revision nobody touched since it was read reports no conflict', () => {
  const loaded = draft();
  const comparison = compareRevisionForOverwrite({ loaded, current: loaded });

  assert.equal(comparison.conflicted, false);
  assert.equal(comparison.reasonCode, 'no-change-since-read');
  assert.deepEqual(comparison.discarded, []);
});

test('the other administrator\'s work is named, not just counted', () => {
  // The point of the warning: someone is about to lose an approval they made, and
  // "there was a conflict" does not tell them whose or what.
  const loaded = draft();
  const current = must(
    applyLifecycleCommand({
      revision: loaded,
      command: 'approve',
      actor: 'admin-b',
      at: '2026-07-24T09:05:00.000Z',
      expectedRevisionNumber: 7,
      reasonCode: 'change-reviewed',
    }),
  );

  const comparison = compareRevisionForOverwrite({ loaded, current });

  assert.equal(comparison.conflicted, true);
  assert.equal(comparison.reasonCode, 'changed-since-read');
  assert.equal(comparison.discarded.length, 1);
  assert.equal(comparison.discarded[0].actor, 'admin-b');
  assert.equal(comparison.discarded[0].command, 'approve');
  assert.equal(comparison.discarded[0].to, 'approved');
  assert.equal(comparison.currentState, 'approved');
});

test('every action taken since the read is listed, not only the last one', () => {
  const loaded = draft();
  const approved = must(
    applyLifecycleCommand({
      revision: loaded,
      command: 'approve',
      actor: 'admin-b',
      at: '2026-07-24T09:05:00.000Z',
      expectedRevisionNumber: 7,
      reasonCode: 'change-reviewed',
    }),
  );
  const current = must(
    applyLifecycleCommand({
      revision: approved,
      command: 'publish',
      actor: 'admin-b',
      at: '2026-07-24T09:06:00.000Z',
      expectedRevisionNumber: approved.revisionNumber,
      publishingRevisionId: null,
      reasonCode: 'publish-requested',
    }),
  );

  const comparison = compareRevisionForOverwrite({ loaded, current });

  assert.deepEqual(
    comparison.discarded.map((entry) => entry.command),
    ['approve', 'publish'],
  );
});

test('a stored revision that is not the one that was read is refused rather than diffed', () => {
  // Two different lineages produce a difference that looks like recent work but is
  // not. Presenting it as "what somebody just did" would be a guess.
  const loaded = draft();
  const rewritten = {
    ...loaded,
    history: [{ ...loaded.history[0], actor: 'someone-else' }],
  };

  const comparison = compareRevisionForOverwrite({ loaded, current: rewritten });

  assert.equal(comparison.conflicted, true);
  assert.equal(comparison.reasonCode, 'history-diverged');
  assert.deepEqual(comparison.discarded, []);
});

test('two readings of different revisions cannot be compared at all', () => {
  const loaded = draft();
  const other = createRevision({
    revisionId: 'revision-0008',
    scopeGroupId: SCOPE,
    revisionNumber: 8,
    authoredBy: 'admin-a',
    authoredAt: '2026-07-24T09:00:00.000Z',
    targets: ['gateway-policy'],
  });

  assert.throws(() => compareRevisionForOverwrite({ loaded, current: other }), /same revision/);
});

test('choosing to overwrite leaves a record of whose work went', () => {
  // Without this the only trace of the discarded change is its absence.
  const loaded = draft();
  const current = must(
    applyLifecycleCommand({
      revision: loaded,
      command: 'approve',
      actor: 'admin-b',
      at: '2026-07-24T09:05:00.000Z',
      expectedRevisionNumber: 7,
      reasonCode: 'change-reviewed',
    }),
  );
  const comparison = compareRevisionForOverwrite({ loaded, current });

  const record = describeOverwrite({
    comparison,
    actor: 'admin-a',
    at: '2026-07-24T09:07:00.000Z',
  });

  assert.equal(record.category, 'publish');
  assert.equal(record.actorCode, 'admin-a');
  assert.deepEqual(record.discardedActors, ['admin-b']);
  assert.deepEqual(record.discardedCommands, ['approve']);
  assert.equal(record.overwrittenRevisionNumber, current.revisionNumber);
});

test('an overwrite record cannot be produced for a save that conflicted with nothing', () => {
  const loaded = draft();
  const comparison = compareRevisionForOverwrite({ loaded, current: loaded });

  assert.throws(
    () => describeOverwrite({ comparison, actor: 'admin-a', at: '2026-07-24T09:07:00.000Z' }),
    /needs a conflict/,
  );
});
