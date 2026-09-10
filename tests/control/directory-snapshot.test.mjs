import assert from 'node:assert/strict';
import test from 'node:test';

import { projectDirectorySnapshot } from '../../app/governance-domain/directory/directory-snapshot-projector.mjs';
import { assertDirectorySnapshotDocument } from '../../app/governance-domain/directory/directory-snapshot-validator.mjs';

const OBSERVED_AT = '2026-07-24T09:58:00.000Z';
const AS_OF = '2026-07-24T10:00:00.000Z';

function group(overrides = {}) {
  return {
    groupId: 'group-platform',
    teamCode: 'platform-engineering',
    displayCode: 'platform-engineering',
    members: [
      { subjectId: 'user-a', displayCode: 'alpha', membership: 'direct' },
      { subjectId: 'user-b', displayCode: 'bravo', membership: 'inherited' },
    ],
    ...overrides,
  };
}

function project(overrides = {}) {
  return projectDirectorySnapshot({
    groups: [group()],
    scopeGroupId: 'platform-engineering',
    configurationVersion: 'cfg-003',
    observedAt: OBSERVED_AT,
    asOf: AS_OF,
    source: { state: 'complete', revision: 'graph-001' },
    ...overrides,
  });
}

test('a confirmed observation inside its age limit may claim to be complete', () => {
  const snapshot = project();

  assert.equal(snapshot.completeness.state, 'complete');
  assert.equal(snapshot.completeness.reason, 'source-confirmed');
  assert.equal(snapshot.users.length, 2);
  assert.equal(snapshot.groups.length, 1);
});

test('direct and inherited membership are counted apart', () => {
  const snapshot = project();
  const [groupRecord] = snapshot.groups;

  assert.equal(groupRecord.directRelationCount, 1);
  assert.equal(groupRecord.inheritedRelationCount, 1);
  assert.equal(snapshot.users.find((user) => user.subjectId === 'user-b').inheritedRelationCount, 1);
});

test('an observation older than its age limit cannot claim to be current', () => {
  const snapshot = project({ observedAt: '2026-07-24T08:00:00.000Z' });

  assert.equal(snapshot.completeness.state, 'partial');
  assert.equal(snapshot.completeness.reason, 'observation-stale');
  for (const record of [...snapshot.users, ...snapshot.groups]) {
    assert.equal(record.resolutionState, 'incomplete');
  }
});

test('a source outage produces a snapshot that says so rather than an empty directory', () => {
  const snapshot = project({ source: { state: 'unavailable', revision: 'graph-outage' } });

  assert.equal(snapshot.completeness.state, 'degraded');
  assert.equal(snapshot.completeness.reason, 'source-unavailable');
  assert.equal(snapshot.users.every((user) => user.resolutionState === 'stale'), true);
});

test('a truncated read is partial rather than complete', () => {
  const snapshot = project({ source: { state: 'truncated', revision: 'graph-page-1' } });

  assert.equal(snapshot.completeness.state, 'partial');
  assert.equal(snapshot.completeness.reason, 'source-truncated');
});

test('a person seen in two teams remains complete and keeps both memberships', () => {
  const snapshot = project({
    groups: [
      group(),
      group({
        groupId: 'group-dx',
        teamCode: 'developer-experience',
        displayCode: 'developer-experience',
        members: [{ subjectId: 'user-a', displayCode: 'alpha', membership: 'direct' }],
      }),
    ],
  });

  const shared = snapshot.users.find((user) => user.subjectId === 'user-a');
  assert.equal(shared.teamCode, null);
  assert.equal(shared.resolutionState, 'complete');
  assert.equal(shared.directRelationCount, 2);
});

test('a person in no observed group cannot appear at all', () => {
  const snapshot = project({ groups: [group({ members: [] })] });

  assert.deepEqual(snapshot.users, []);
  assert.equal(snapshot.groups[0].directRelationCount, 0);
});

test('rewriting a scope replaces its snapshot rather than accumulating history', () => {
  const first = project();
  const second = project({ observedAt: '2026-07-24T09:59:00.000Z' });

  assert.equal(first.id, second.id);
  assert.match(first.id, /^directory-snapshot\|platform-engineering$/);
});

test('the projection is frozen so a caller cannot edit what it claimed', () => {
  const snapshot = project();

  assert.equal(Object.isFrozen(snapshot), true);
  assert.throws(() => {
    snapshot.completeness = { state: 'complete' };
  }, TypeError);
});

test('a claim the observation does not support is refused', () => {
  const snapshot = project();

  assert.throws(
    () =>
      assertDirectorySnapshotDocument({
        ...snapshot,
        observedAt: '2026-07-24T08:00:00.000Z',
      }),
    /cannot be complete/,
  );
  assert.throws(
    () =>
      assertDirectorySnapshotDocument({
        ...snapshot,
        completeness: { ...snapshot.completeness, reason: 'source-unavailable' },
      }),
    /cannot accompany/,
  );
});

test('a record cannot claim a team no observed group provides', () => {
  const snapshot = project();

  assert.throws(
    () =>
      assertDirectorySnapshotDocument({
        ...snapshot,
        users: snapshot.users.map((user) => ({ ...user, teamCode: 'no-such-team' })),
      }),
    /no group in this snapshot provides/,
  );
});

test('a malformed observation is refused before anything is stored', () => {
  assert.throws(() => project({ groups: [group({ teamCode: '' })] }), TypeError);
  assert.throws(() => project({ groups: [group({ members: [{ displayCode: 'x' }] })] }), TypeError);
  assert.throws(() => project({ source: { state: 'guessed', revision: 'x' } }), TypeError);
  assert.throws(() => project({ observedAt: 'not-a-time' }), TypeError);
});
