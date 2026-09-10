import test from 'node:test';
import assert from 'node:assert/strict';

import { getDeterministicGovernanceSnapshots } from '../../app/local-adapters/deterministic-governance-snapshots.mjs';
import { AUTHORED_POLICY_RETENTION_SECONDS } from '../../app/governance-domain/lifecycle/authored-policy-retention.mjs';
import {
  addTeam,
  removeTeam,
  TEAM_CATALOG_EDIT_REASONS,
  TeamCatalogEditRefusedError,
} from '../../app/governance-domain/authorization/team-catalog-edit.mjs';

const AT = '2026-07-24T10:00:00.000Z';

function snapshot() {
  return getDeterministicGovernanceSnapshots().entitlementSnapshot;
}

function refusal(action) {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof TeamCatalogEditRefusedError, `expected a refusal, got ${error.name}`);
    return error;
  }
  assert.fail('the edit was accepted when it should have been refused');
}

// An authorization edit carries the same window as a budget edit, and for the same
// reason: the set is republished whole and every snapshot in it must be unexpired.
test('a catalogue edit governs for thirty days, or for whatever the caller states', () => {
  const byDefault = addTeam({
    snapshot: snapshot(),
    teamKey: 'data-platform',
    membershipGroupId: 'group-data-platform',
    at: AT,
  });
  assert.equal(
    Date.parse(byDefault.expiresAt) - Date.parse(byDefault.capturedAt),
    AUTHORED_POLICY_RETENTION_SECONDS * 1000,
  );

  const stated = addTeam({
    snapshot: snapshot(),
    teamKey: 'data-platform',
    membershipGroupId: 'group-data-platform',
    at: AT,
    retentionSeconds: 3600,
  });
  assert.equal(Date.parse(stated.expiresAt) - Date.parse(stated.capturedAt), 3_600_000);
});

test('adding a team maps a directory group and produces the next whole snapshot', () => {
  const before = snapshot();
  const next = addTeam({
    snapshot: before,
    teamKey: 'data-platform',
    membershipGroupId: 'group-data-platform',
    at: AT,
  });

  assert.equal(next.version, before.version + 1);
  assert.equal(next.capturedAt, AT);
  assert.deepEqual(
    next.teamCatalog.find((mapping) => mapping.teamKey === 'data-platform'),
    { teamKey: 'data-platform', membershipGroupId: 'group-data-platform' },
  );
  // The bindings are untouched: this edit answers which group is which team, not who
  // may reach which model.
  assert.deepEqual(next.bindings, before.bindings);
});

test('the catalogue stays sorted, because the snapshot validator requires it', () => {
  // 'a-team' sorts before every fixture entry, so appending it would fail validation.
  const next = addTeam({
    snapshot: snapshot(),
    teamKey: 'a-team',
    membershipGroupId: 'group-a-team',
    at: AT,
  });
  const keys = next.teamCatalog.map((mapping) => mapping.teamKey);
  assert.deepEqual(keys, [...keys].sort());
  assert.equal(keys[0], 'a-team');
});

test('a team key already in the catalogue is refused rather than duplicated', () => {
  const error = refusal(() =>
    addTeam({
      snapshot: snapshot(),
      teamKey: 'platform-engineering',
      membershipGroupId: 'group-something-else',
      at: AT,
    }));
  assert.equal(error.code, TEAM_CATALOG_EDIT_REASONS.duplicateTeam);
});

test('one group cannot name two teams, and the refusal says which team already has it', () => {
  const error = refusal(() =>
    addTeam({
      snapshot: snapshot(),
      teamKey: 'data-platform',
      membershipGroupId: 'group-governance-admin',
      at: AT,
    }));
  assert.equal(error.code, TEAM_CATALOG_EDIT_REASONS.groupAlreadyMapped);
  assert.equal(error.detail, 'platform-engineering');
});

test('removing a team a binding still targets is refused, naming the bindings', () => {
  const error = refusal(() =>
    removeTeam({
      snapshot: snapshot(),
      teamKey: 'platform-engineering',
      reasonCode: 'team-dissolved',
      at: AT,
    }));
  assert.equal(error.code, TEAM_CATALOG_EDIT_REASONS.teamInUse);
  assert.deepEqual(error.detail, ['binding-team-platform-engineering-001']);
});

test('a team no binding targets can be removed, and the result still validates', () => {
  const before = snapshot();
  const withoutBindings = {
    ...before,
    bindings: before.bindings.filter((binding) => binding.target.key !== 'developer-experience'),
  };
  const next = removeTeam({
    snapshot: withoutBindings,
    teamKey: 'developer-experience',
    reasonCode: 'team-dissolved',
    at: AT,
  });
  assert.deepEqual(next.teamCatalog.map((mapping) => mapping.teamKey), ['platform-engineering']);
});

test('removal states why, in a code rather than in typed prose', () => {
  const before = snapshot();
  const withoutBindings = {
    ...before,
    bindings: before.bindings.filter((binding) => binding.target.key !== 'developer-experience'),
  };
  for (const reasonCode of [undefined, '', 'Team Dissolved', 'the team was dissolved last quarter']) {
    const error = refusal(() =>
      removeTeam({ snapshot: withoutBindings, teamKey: 'developer-experience', reasonCode, at: AT }));
    assert.equal(error.code, TEAM_CATALOG_EDIT_REASONS.reasonRequired);
  }
});

test('an unknown team is refused before anything is rewritten', () => {
  const error = refusal(() =>
    removeTeam({ snapshot: snapshot(), teamKey: 'no-such-team', reasonCode: 'team-dissolved', at: AT }));
  assert.equal(error.code, TEAM_CATALOG_EDIT_REASONS.teamUnknown);
});

test('a value the snapshot validator refuses comes back as a refusal, not an exception', () => {
  const error = refusal(() =>
    addTeam({
      snapshot: snapshot(),
      teamKey: 'not a safe id',
      membershipGroupId: 'group-data-platform',
      at: AT,
    }));
  assert.equal(error.code, TEAM_CATALOG_EDIT_REASONS.resultInvalid);
});

test('an omitted instant throws rather than dating the snapshot from the clock', () => {
  assert.throws(
    () => addTeam({ snapshot: snapshot(), teamKey: 'data-platform', membershipGroupId: 'group-data-platform' }),
    /at must be an ISO-8601 instant/,
  );
});
