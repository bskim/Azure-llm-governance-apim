import {
  assertDirectorySnapshotDocument,
  directorySnapshotDocumentId,
} from './directory-snapshot-validator.mjs';

/**
 * Projects observed group membership into a directory snapshot.
 *
 * The source is asked only about the groups governance already maps to a team, so
 * this never holds a picture of the whole directory. Everything about how trustworthy
 * the result is comes from here: the projection decides what the snapshot may claim,
 * and it never upgrades that claim to make a screen look settled.
 */

const MAX_OBSERVATION_AGE_SECONDS = 3600;

function fail(message) {
  throw new TypeError(message);
}

function assertInstant(value, name) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    fail(`${name} must be an ISO-8601 instant.`);
  }
  return Date.parse(value);
}

/**
 * Completeness is derived, never supplied. A caller reports what the source did;
 * this decides what that entitles the snapshot to say about itself.
 */
function resolveCompleteness({ observedAt, asOf, source, maxObservationAgeSeconds }) {
  if (source.state === 'unavailable') {
    return { state: 'degraded', reason: 'source-unavailable', maxObservationAgeSeconds };
  }
  if (source.state === 'truncated') {
    return { state: 'partial', reason: 'source-truncated', maxObservationAgeSeconds };
  }
  if ((Date.parse(asOf) - Date.parse(observedAt)) / 1000 > maxObservationAgeSeconds) {
    return { state: 'partial', reason: 'observation-stale', maxObservationAgeSeconds };
  }
  return { state: 'complete', reason: 'source-confirmed', maxObservationAgeSeconds };
}

/**
 * A record is only as resolved as the observation behind it. A degraded source
 * cannot produce a complete record. Multiple governed teams are preserved on the
 * record and are a complete observation, not an ambiguity to resolve here.
 */
function resolveRecordState(completenessState, teamCount) {
  if (teamCount === 0) return 'incomplete';
  if (completenessState === 'degraded') return 'stale';
  if (completenessState === 'partial') return 'incomplete';
  return 'complete';
}

function assertSource(source) {
  if (source === null || typeof source !== 'object') fail('source is required.');
  if (!['complete', 'truncated', 'unavailable'].includes(source.state)) {
    fail('source.state is unsupported.');
  }
  if (typeof source.revision !== 'string' || source.revision.length === 0) {
    fail('source.revision is required.');
  }
}

function assertObservedGroup(group, index) {
  if (group === null || typeof group !== 'object') fail(`groups[${index}] must be an object.`);
  for (const field of ['groupId', 'teamCode', 'displayCode']) {
    if (typeof group[field] !== 'string' || group[field].length === 0) {
      fail(`groups[${index}].${field} is required.`);
    }
  }
  if (!Array.isArray(group.members)) fail(`groups[${index}].members must be an array.`);
}

export function projectDirectorySnapshot({
  groups,
  scopeGroupId,
  configurationVersion,
  observedAt,
  asOf,
  source,
  maxObservationAgeSeconds = MAX_OBSERVATION_AGE_SECONDS,
}) {
  if (!Array.isArray(groups)) fail('groups must be an array.');
  if (typeof scopeGroupId !== 'string' || scopeGroupId.length === 0) fail('scopeGroupId is required.');
  assertInstant(observedAt, 'observedAt');
  assertInstant(asOf, 'asOf');
  assertSource(source);
  groups.forEach(assertObservedGroup);

  const completeness = resolveCompleteness({ observedAt, asOf, source, maxObservationAgeSeconds });

  const groupRecords = groups.map((group) => ({
    recordKey: `directory-group-${group.groupId}`,
    displayCode: group.displayCode,
    entityKind: 'group',
    teamCode: group.teamCode,
    lifecycleState: group.lifecycleState ?? 'active',
    resolutionState: resolveRecordState(completeness.state, 1),
    // Pseudonyms, and the same ones the user records carry. Without them a reader can
    // be told how many people are in a group but never whether they are one of them.
    memberSubjectIds: group.members.map((member) => member.subjectId).sort(),
    directRelationCount: group.members.filter((member) => member.membership !== 'inherited').length,
    inheritedRelationCount: group.members.filter((member) => member.membership === 'inherited').length,
  }));

  // A member is collected across every group that observed them, so a person in two
  // teams is visible as such instead of being silently assigned to one.
  const bySubject = new Map();
  for (const group of groups) {
    for (const member of group.members) {
      if (typeof member?.subjectId !== 'string' || member.subjectId.length === 0) {
        fail('a member must carry a subject identifier.');
      }
      if (!bySubject.has(member.subjectId)) {
        bySubject.set(member.subjectId, {
          subjectId: member.subjectId,
          displayCode: member.displayCode ?? member.subjectId,
          lifecycleState: member.lifecycleState ?? 'active',
          teams: new Set(),
          direct: 0,
          inherited: 0,
        });
      }
      const entry = bySubject.get(member.subjectId);
      entry.teams.add(group.teamCode);
      if (member.membership === 'inherited') entry.inherited += 1;
      else entry.direct += 1;
    }
  }

  const userRecords = [...bySubject.values()]
    .sort((a, b) => a.subjectId.localeCompare(b.subjectId))
    .map((entry) => {
      const resolutionState = resolveRecordState(completeness.state, entry.teams.size);
      return {
        recordKey: `directory-user-${entry.subjectId}`,
        subjectId: entry.subjectId,
        displayCode: entry.displayCode,
        entityKind: 'user',
        // A person in more than one team has no single team, and saying so is the
        // answer rather than picking one.
        teamCode: entry.teams.size === 1 ? [...entry.teams][0] : null,
        lifecycleState: entry.lifecycleState,
        resolutionState,
        directRelationCount: entry.direct,
        inheritedRelationCount: entry.inherited,
      };
    });

  const document = {
    contractVersion: 'v1',
    documentType: 'directory-snapshot',
    id: directorySnapshotDocumentId({ scopeGroupId }),
    scopeGroupId,
    configurationVersion,
    observedAt,
    asOf,
    completeness,
    sourceRevision: source.revision,
    users: userRecords,
    groups: groupRecords.sort((a, b) => a.recordKey.localeCompare(b.recordKey)),
  };

  assertDirectorySnapshotDocument(document);
  return Object.freeze(document);
}
