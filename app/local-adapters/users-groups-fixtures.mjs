const BASE_USERS = Object.freeze([
  {
    subjectId: 'user-local-admin',
    teamCode: 'platform-engineering',
    recordKey: 'directory-user-001',
    displayCode: 'local-admin',
    entityKind: 'user',
    lifecycleState: 'active',
    resolutionState: 'complete',
    directRelationCount: 1,
    inheritedRelationCount: 1,
  },
  {
    subjectId: 'user-local-auditor',
    teamCode: 'platform-engineering',
    recordKey: 'directory-user-002',
    displayCode: 'local-auditor',
    entityKind: 'user',
    lifecycleState: 'active',
    resolutionState: 'complete',
    directRelationCount: 1,
    inheritedRelationCount: 0,
  },
  {
    subjectId: 'user-local-end-user',
    teamCode: 'developer-experience',
    recordKey: 'directory-user-003',
    displayCode: 'local-end-user',
    entityKind: 'user',
    lifecycleState: 'active',
    resolutionState: 'complete',
    directRelationCount: 1,
    inheritedRelationCount: 1,
  },
]);

const BASE_GROUPS = Object.freeze([
  {
    memberSubjectIds: ['user-local-admin', 'user-local-auditor'],
    teamCode: 'platform-engineering',
    recordKey: 'directory-group-001',
    displayCode: 'platform-engineering',
    entityKind: 'group',
    lifecycleState: 'active',
    resolutionState: 'complete',
    directRelationCount: 2,
    inheritedRelationCount: 0,
  },
  {
    memberSubjectIds: ['user-local-end-user'],
    teamCode: 'developer-experience',
    recordKey: 'directory-group-002',
    displayCode: 'developer-experience',
    entityKind: 'group',
    lifecycleState: 'active',
    resolutionState: 'complete',
    directRelationCount: 1,
    inheritedRelationCount: 1,
  },
]);

export const USERS_GROUPS_FIXTURE_NAMES = Object.freeze([
  'complete',
  'stale',
  'partial',
  'empty',
  'ambiguous',
  'denied',
  'error',
]);

export function getUsersGroupsFixture(name) {
  if (!USERS_GROUPS_FIXTURE_NAMES.includes(name)) {
    throw new TypeError(`Unsupported users and groups fixture: ${name}.`);
  }

  const fixture = {
    name,
    generatedAt: '2026-07-24T10:00:00.000Z',
    configurationVersion: 'cfg-local-003',
    quality: {
      reportedAt: '2026-07-24T09:58:00.000Z',
      lagSeconds: 60,
      state: 'fresh',
      aggregation: 'complete',
    },
    users: structuredClone(BASE_USERS),
    groups: structuredClone(BASE_GROUPS),
    // The deterministic personas are the same subjects the fixture records name, which
    // is what makes the self-scope view demonstrable at all locally.
    subjectsMatchCaller: true,
  };

  if (name === 'stale') {
    fixture.quality.state = 'stale';
    fixture.quality.lagSeconds = 1_140;
    for (const record of [...fixture.users, ...fixture.groups]) {
      record.resolutionState = 'stale';
    }
  }

  if (name === 'partial') {
    fixture.quality.state = 'partial';
    fixture.quality.aggregation = 'partial';
    fixture.quality.lagSeconds = 480;
    for (const record of [fixture.users[0], fixture.groups[0]]) {
      record.resolutionState = 'incomplete';
    }
  }

  if (name === 'empty') {
    fixture.users = [];
    fixture.groups = [];
  }

  return fixture;
}