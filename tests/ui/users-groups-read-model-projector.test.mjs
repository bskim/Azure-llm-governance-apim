import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateEffectiveEntitlementBindings } from '../../app/governance-domain/authorization/governance-authorization-evaluator.mjs';
import { projectUsersGroupsReadModel } from '../../app/control-api/users-groups-read-model-projector.mjs';
import { getDeterministicGovernanceSnapshots } from '../../app/local-adapters/deterministic-governance-snapshots.mjs';
import { getUsersGroupsFixture } from '../../app/local-adapters/users-groups-fixtures.mjs';

const evaluationTime = '2026-07-24T10:00:00.000Z';

function authorization(scopes = ['self', 'team', 'global'], decision = 'allow', readAuthority = scopes.length > 0 ? 'authoritative' : 'unavailable') {
  return {
    contractVersion: 'v1',
    decision,
    readAuthority,
    reasonCode: decision === 'unavailable' ? 'membership-evidence-stale' : 'most-restrictive-policy',
    permittedReadScopes: scopes,
    permittedTeamKeys: ['developer-experience', 'platform-engineering'],
  };
}

function context({
  subjectId = 'user-local-admin',
  groupId = 'group-governance-admin',
  status = 'complete',
  expiresAt = '2026-07-24T10:30:00.000Z',
} = {}) {
  return {
    subject: { subjectId },
    memberships: {
      status,
      expiresAt,
      groups: [{ groupId, membership: 'direct', authorizationRelevant: true }],
    },
  };
}

function project({
  fixture = 'complete',
  scope = 'global',
  view = 'users',
  principal = context(),
  authority = authorization(),
} = {}) {
  return projectUsersGroupsReadModel({
    context: principal,
    authorization: authority,
    entitlementSnapshot: getDeterministicGovernanceSnapshots().entitlementSnapshot,
    fixture: getUsersGroupsFixture(fixture),
    selection: {
      scope,
      view,
      teamKey: scope === 'team' ? 'platform-engineering' : null,
    },
  });
}

test('projects direct, inherited, and most-restrictive effective policy observations', () => {
  const readModel = project();
  assert.equal(readModel.readModelVersion, 'users-groups.v1');
  assert.equal(readModel.records.length, 3);

  const admin = readModel.records.find((record) => record.displayCode === 'local-admin');
  assert.equal(admin.policyInspection.direct.length, 1);
  assert.equal(admin.policyInspection.inherited.length, 2);
  assert.deepEqual(admin.policyInspection.effective.modelCodes, ['coding-primary']);
  assert.deepEqual(admin.policyInspection.effective.limits, {
    requestsPerMinute: 80,
    tokensPerMinute: 80_000,
  });
  assert.ok(admin.policyInspection.direct.some((source) =>
    source.limits.tokenQuota === 6_000_000 &&
    source.limits.quotaPeriod === 'Monthly'));

  const endUser = readModel.records.find((record) => record.displayCode === 'local-end-user');
  assert.equal(endUser.policyInspection.effective.decisionCode, 'allow');
  assert.equal(endUser.policyInspection.effective.reasonCode, 'most-restrictive-policy');
  assert.deepEqual(endUser.policyInspection.effective.modelCodes, ['coding-primary']);
  assert.deepEqual(endUser.policyInspection.effective.limits, {
    requestsPerMinute: 40,
    tokensPerMinute: 40_000,
  });

  const snapshot = getDeterministicGovernanceSnapshots().entitlementSnapshot;
  const expectedAdmin = evaluateEffectiveEntitlementBindings(
    snapshot.bindings.filter((binding) =>
      binding.target.kind === 'global' ||
      (binding.target.kind === 'team' && binding.target.key === 'platform-engineering') ||
      (binding.target.kind === 'subject' && binding.target.key === 'user-local-admin')),
  );
  assert.deepEqual(admin.policyInspection.effective, {
    decisionCode: expectedAdmin.decision,
    reasonCode: expectedAdmin.reasonCode,
    modelCodes: expectedAdmin.modelAllowlist,
    limits: expectedAdmin.limits,
    configurationVersion: 'cfg-local-003',
  });
});

test('a global-only caller is shown as unentitled just as the gateway refuses it', () => {
  const snapshots = getDeterministicGovernanceSnapshots();
  const entitlementSnapshot = structuredClone(snapshots.entitlementSnapshot);
  entitlementSnapshot.bindings = entitlementSnapshot.bindings.filter(
    (binding) => binding.target.kind === 'global',
  );
  const readModel = projectUsersGroupsReadModel({
    context: context(),
    authorization: authorization(),
    entitlementSnapshot,
    fixture: getUsersGroupsFixture('complete'),
    selection: { scope: 'global', view: 'users', teamKey: null },
  });
  const admin = readModel.records.find((record) => record.displayCode === 'local-admin');

  assert.equal(admin.policyInspection.effective.decisionCode, 'deny');
  assert.equal(admin.policyInspection.effective.reasonCode, 'principal-not-entitled');
  assert.deepEqual(admin.policyInspection.effective.modelCodes, []);
});

test('filters self, team, and global records before calculating visible summaries', () => {
  const self = project({ scope: 'self' });
  const team = project({ scope: 'team' });
  const global = project({ scope: 'global' });

  assert.deepEqual(self.records.map((record) => record.displayCode), ['local-admin']);
  assert.deepEqual(team.records.map((record) => record.displayCode), ['local-admin', 'local-auditor']);
  assert.equal(global.records.length, 3);
  assert.equal(self.summary.visibleUsers, 1);
  assert.equal(self.summary.visibleGroups, 1);
  assert.equal(self.summary.directMemberships, 1);
  assert.equal(self.summary.inheritedMemberships, 1);
  assert.equal(team.summary.visibleUsers, 2);
  assert.equal(team.summary.visibleGroups, 1);
  assert.equal(team.summary.directMemberships, 2);
  assert.equal(team.summary.inheritedMemberships, 1);
  assert.equal(global.summary.visibleUsers, 3);
  assert.equal(global.summary.visibleGroups, 2);
  assert.equal(global.summary.directMemberships, 3);
  assert.equal(global.summary.inheritedMemberships, 2);
  assert.equal('directRelations' in global.summary, false);
  assert.equal('inheritedRelations' in global.summary, false);

  const developerExperience = projectUsersGroupsReadModel({
    context: context(),
    authorization: authorization(),
    entitlementSnapshot: getDeterministicGovernanceSnapshots().entitlementSnapshot,
    fixture: getUsersGroupsFixture('complete'),
    selection: { scope: 'team', view: 'users', teamKey: 'developer-experience' },
  });
  assert.deepEqual(
    developerExperience.records.map((record) => record.displayCode),
    ['local-end-user'],
  );

  assert.throws(
    () => projectUsersGroupsReadModel({
      context: context(),
      authorization: {
        ...authorization(['self', 'team']),
        permittedTeamKeys: ['team-alpha'],
      },
      entitlementSnapshot: getDeterministicGovernanceSnapshots().entitlementSnapshot,
      fixture: getUsersGroupsFixture('complete'),
      selection: { scope: 'team', view: 'users', teamKey: 'platform-engineering' },
    }),
    /team-scope-denied/,
  );
});

test('end user can inspect only self and own applicable group summary', () => {
  const principal = context({
    subjectId: 'user-local-end-user',
    groupId: 'group-end-user',
  });
  const users = project({ scope: 'self', principal });
  const groups = project({ scope: 'self', view: 'groups', principal });
  assert.deepEqual(users.records.map((record) => record.displayCode), ['local-end-user']);
  assert.deepEqual(groups.records.map((record) => record.displayCode), ['developer-experience']);
  assert.throws(
    () => project({ scope: 'team', principal, authority: authorization(['self']) }),
    /scope-denied/,
  );
  assert.throws(
    () => project({ scope: 'global', principal, authority: authorization(['self']) }),
    /scope-denied/,
  );
});

test('stale and partial required policy evidence never claims an effective allow', () => {
  const stale = project({ fixture: 'stale' });
  assert.ok(stale.records.every(
    (record) => record.policyInspection.effective.reasonCode === 'directory-evidence-stale',
  ));
  assert.equal(stale.summary.unavailableOutcomes, 5);

  const partial = project({ fixture: 'partial' });
  const admin = partial.records.find((record) => record.displayCode === 'local-admin');
  assert.equal(admin.policyInspection.effective.decisionCode, 'unavailable');
  assert.equal(admin.policyInspection.effective.reasonCode, 'required-policy-unavailable');
});

test('empty projection and group view preserve a locale-neutral body-free contract', () => {
  const empty = project({ fixture: 'empty' });
  assert.deepEqual(empty.records, []);
  assert.equal(empty.summary.visibleUsers, 0);
  assert.equal(empty.summary.visibleGroups, 0);

  const groups = project({ view: 'groups' });
  assert.equal(groups.records.length, 2);
  assert.ok(groups.records.every((record) => record.entityKind === 'group'));
  const serialized = JSON.stringify(groups);
  for (const forbidden of [
    'subjectId', 'groupId', 'memberSubjectIds', 'recordKey', 'role', 'roles', 'membership',
    'memberships', 'permissions', 'accessToken', 'prompt', 'completion', 'backendUrl',
  ]) {
    assert.equal(serialized.includes(`"${forbidden}"`), false, forbidden);
  }
  assert.equal(serialized.includes('Platform engineering'), false);
});

test('degraded caller membership fails closed before directory projection', () => {
  for (const status of ['stale', 'incomplete', 'ambiguous', 'source-unavailable']) {
    assert.throws(
      () => project({
        scope: 'self',
        principal: context({ status }),
        authority: authorization([], 'unavailable'),
      }),
      /membership-not-authoritative/,
    );
  }
});