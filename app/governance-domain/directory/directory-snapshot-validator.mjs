/**
 * Semantic validation for a directory snapshot document.
 *
 * A membership screen decides who may see what, so the freshness of the evidence
 * behind it is part of the answer rather than decoration. These rules exist so a
 * snapshot cannot claim to be current when nobody confirmed it recently, and so a
 * record cannot claim a team it was never resolved into.
 */

const STATES = new Set(['complete', 'partial', 'degraded']);
const REASONS = new Set([
  'source-confirmed',
  'source-truncated',
  'source-unavailable',
  'observation-stale',
]);
const RESOLUTION_STATES = new Set(['complete', 'incomplete', 'stale', 'ambiguous']);
const LIFECYCLE_STATES = new Set(['active', 'suspended', 'removed']);
const ENTITY_KINDS = new Set(['user', 'group']);
const SAFE_ID = /^[A-Za-z0-9._:-]+$/;

// A reason has to agree with the state it accompanies, or the pair tells a reader
// nothing they can act on.
const REASONS_BY_STATE = Object.freeze({
  complete: new Set(['source-confirmed']),
  partial: new Set(['source-truncated', 'observation-stale']),
  degraded: new Set(['source-unavailable', 'source-truncated']),
});

function fail(message) {
  throw new TypeError(message);
}

function assertInstant(value, name) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    fail(`${name} must be an ISO-8601 instant.`);
  }
  return Date.parse(value);
}

function assertSafeId(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) fail(`${name} is required.`);
  return value;
}

function assertCount(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${name} must be a whole count.`);
  return value;
}

export function directorySnapshotDocumentId({ scopeGroupId }) {
  assertSafeId(scopeGroupId, 'scopeGroupId');
  // One current snapshot per scope. History belongs to an audit trail, not to the
  // document a screen reads, so a projection replaces rather than accumulates.
  return `directory-snapshot|${scopeGroupId}`;
}

function assertRecord(record, path, expectedKind) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    fail(`${path} must be an object.`);
  }
  assertSafeId(record.recordKey, `${path}.recordKey`);
  assertSafeId(record.displayCode, `${path}.displayCode`);
  if (record.entityKind !== expectedKind) fail(`${path}.entityKind must be ${expectedKind}.`);
  if (!ENTITY_KINDS.has(record.entityKind)) fail(`${path}.entityKind is unsupported.`);
  if (!LIFECYCLE_STATES.has(record.lifecycleState)) fail(`${path}.lifecycleState is unsupported.`);
  if (!RESOLUTION_STATES.has(record.resolutionState)) fail(`${path}.resolutionState is unsupported.`);
  assertCount(record.directRelationCount, `${path}.directRelationCount`);
  assertCount(record.inheritedRelationCount, `${path}.inheritedRelationCount`);

  if (record.teamCode === null) {
    // No relationships means no team was resolved. With two or more relationships,
    // null means there is no single canonical team to print, which is complete evidence.
    if (record.resolutionState === 'complete' &&
        record.directRelationCount + record.inheritedRelationCount === 0) {
      fail(`${path} cannot be complete without a team.`);
    }
  } else {
    assertSafeId(record.teamCode, `${path}.teamCode`);
  }

  if (expectedKind === 'user') {
    assertSafeId(record.subjectId, `${path}.subjectId`);
  }

  if (expectedKind === 'group') {
    if (!Array.isArray(record.memberSubjectIds)) fail(`${path}.memberSubjectIds must be an array.`);
    record.memberSubjectIds.forEach((subjectId, index) =>
      assertSafeId(subjectId, `${path}.memberSubjectIds[${index}]`));
  }
}

export function assertDirectorySnapshotDocument(document) {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    fail('document must be an object.');
  }
  if (document.contractVersion !== 'v1') fail('contractVersion must be v1.');
  if (document.documentType !== 'directory-snapshot') fail('documentType must be directory-snapshot.');

  assertSafeId(document.scopeGroupId, 'scopeGroupId');
  assertSafeId(document.configurationVersion, 'configurationVersion');
  assertSafeId(document.sourceRevision, 'sourceRevision');
  if (document.id !== directorySnapshotDocumentId(document)) {
    fail('id must be derived from scopeGroupId.');
  }

  const observedAt = assertInstant(document.observedAt, 'observedAt');
  const asOf = assertInstant(document.asOf, 'asOf');
  if (observedAt > asOf) fail('observedAt cannot be after asOf.');

  const completeness = document.completeness;
  if (completeness === null || typeof completeness !== 'object') fail('completeness is required.');
  if (!STATES.has(completeness.state)) fail('completeness.state is unsupported.');
  if (!REASONS.has(completeness.reason)) fail('completeness.reason is unsupported.');
  if (!REASONS_BY_STATE[completeness.state].has(completeness.reason)) {
    fail(`completeness.reason ${completeness.reason} cannot accompany ${completeness.state}.`);
  }
  assertCount(completeness.maxObservationAgeSeconds, 'completeness.maxObservationAgeSeconds');

  // Only a snapshot the source confirmed inside its own age limit may claim to be
  // complete. Everything else is at best partial.
  if (completeness.state === 'complete') {
    const ageSeconds = (asOf - observedAt) / 1000;
    if (ageSeconds > completeness.maxObservationAgeSeconds) {
      fail('a snapshot older than its age limit cannot be complete.');
    }
  }

  for (const [collection, kind] of [['users', 'user'], ['groups', 'group']]) {
    if (!Array.isArray(document[collection])) fail(`${collection} must be an array.`);
    const seen = new Set();
    document[collection].forEach((record, index) => {
      const path = `${collection}[${index}]`;
      assertRecord(record, path, kind);
      if (seen.has(record.recordKey)) fail(`${path} repeats a record key.`);
      seen.add(record.recordKey);
    });
  }

  // A team a record claims has to be a team this snapshot actually observed, or a
  // screen would filter against a team that does not exist.
  const observedTeams = new Set(document.groups.map((group) => group.teamCode).filter(Boolean));
  for (const [index, user] of document.users.entries()) {
    if (user.teamCode !== null && !observedTeams.has(user.teamCode)) {
      fail(`users[${index}] claims a team no group in this snapshot provides.`);
    }
  }

  return document;
}
