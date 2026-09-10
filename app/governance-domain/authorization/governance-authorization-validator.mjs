const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export const GOVERNANCE_ROLE_READ_SCOPES = Object.freeze({
  // An ordinary gateway caller administers nothing and reads nothing here. Model
  // access is a different resource from governance, not a smaller share of it.
  'end-user': Object.freeze([]),
  'team-viewer': Object.freeze(['self', 'team']),
  'team-admin': Object.freeze(['self', 'team']),
  auditor: Object.freeze(['self', 'team', 'global']),
  'governance-admin': Object.freeze(['self', 'team', 'global']),
  'configuration-approver': Object.freeze(['self', 'team', 'global']),
  'configuration-publisher': Object.freeze(['self', 'team', 'global']),
  'platform-operator': Object.freeze(['self', 'team', 'global']),
});

export const GOVERNANCE_ASSIGNMENT_RULES = Object.freeze([
  Object.freeze({ roleCode: 'team-viewer', assigneeKinds: Object.freeze(['subject', 'group']), scopeKinds: Object.freeze(['team']) }),
  Object.freeze({ roleCode: 'team-admin', assigneeKinds: Object.freeze(['subject', 'group']), scopeKinds: Object.freeze(['team']) }),
  Object.freeze({ roleCode: 'auditor', assigneeKinds: Object.freeze(['subject', 'group']), scopeKinds: Object.freeze(['global', 'team']) }),
  Object.freeze({ roleCode: 'governance-admin', assigneeKinds: Object.freeze(['subject', 'group']), scopeKinds: Object.freeze(['global']) }),
  Object.freeze({ roleCode: 'configuration-approver', assigneeKinds: Object.freeze(['subject', 'group']), scopeKinds: Object.freeze(['global']) }),
  Object.freeze({ roleCode: 'configuration-publisher', assigneeKinds: Object.freeze(['subject', 'group']), scopeKinds: Object.freeze(['global']) }),
  Object.freeze({ roleCode: 'platform-operator', assigneeKinds: Object.freeze(['subject', 'group', 'application']), scopeKinds: Object.freeze(['global']) }),
]);

const ASSIGNABLE_ROLES = new Set(GOVERNANCE_ASSIGNMENT_RULES.map((rule) => rule.roleCode));
const SNAPSHOT_STATUSES = new Set([
  'complete',
  'incomplete',
  'stale',
  'ambiguous',
  'source-unavailable',
]);
const RECORD_STATES = new Set(['active', 'revoked', 'expired']);
const ASSIGNEE_KINDS = new Set(['subject', 'group', 'application']);
const ASSIGNMENT_SCOPE_KINDS = new Set(['global', 'team']);
const BINDING_TARGET_KINDS = new Set(['global', 'team', 'subject', 'application']);
const ISSUER_KINDS = new Set(['subject', 'system']);

function assertRecord(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object.`);
  }
}

function assertExactKeys(value, required, optional, path) {
  assertRecord(value, path);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${path}.${key} is required.`);
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${path}.${key} is not allowed.`);
  }
}

function assertSafeId(value, path) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new TypeError(`${path} must be a bounded safe identifier.`);
  }
}

function assertPositiveInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${path} must be a positive integer.`);
  }
}

function assertNonnegativeInteger(value, path, maximum) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new TypeError(`${path} must be a nonnegative integer no greater than ${maximum}.`);
  }
}

function parseTime(value, path) {
  if (typeof value !== 'string') throw new TypeError(`${path} must be an RFC 3339 timestamp.`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new TypeError(`${path} must be an RFC 3339 timestamp.`);
  return timestamp;
}

function assertSortedUnique(values, path) {
  if (new Set(values).size !== values.length) throw new TypeError(`${path} contains duplicates.`);
  const sorted = [...values].sort((left, right) => left.localeCompare(right));
  if (values.some((value, index) => value !== sorted[index])) {
    throw new TypeError(`${path} must be sorted.`);
  }
}

function assertSnapshotEnvelope(snapshot, evaluationTime, path, collectionName) {
  assertExactKeys(
    snapshot,
    [
      'contractVersion',
      'snapshotId',
      'tenantId',
      'version',
      'status',
      'capturedAt',
      'expiresAt',
      'sourceRevision',
      collectionName,
    ],
    ['reason'],
    path,
  );
  if (snapshot.contractVersion !== 'v1') throw new TypeError(`${path}.contractVersion must be v1.`);
  for (const key of ['snapshotId', 'tenantId', 'sourceRevision']) {
    assertSafeId(snapshot[key], `${path}.${key}`);
  }
  assertPositiveInteger(snapshot.version, `${path}.version`);
  if (!SNAPSHOT_STATUSES.has(snapshot.status)) throw new TypeError(`${path}.status is unsupported.`);
  const capturedAt = parseTime(snapshot.capturedAt, `${path}.capturedAt`);
  const expiresAt = parseTime(snapshot.expiresAt, `${path}.expiresAt`);
  const now = parseTime(evaluationTime, 'evaluationTime');
  if (capturedAt > now) throw new RangeError(`${path} cannot be captured in the future.`);
  if (capturedAt >= expiresAt) throw new RangeError(`${path} capture must precede expiry.`);
  if (!Array.isArray(snapshot[collectionName])) {
    throw new TypeError(`${path}.${collectionName} must be an array.`);
  }
  if (snapshot.status !== 'complete') {
    if (typeof snapshot.reason !== 'string' || snapshot.reason.length === 0) {
      throw new TypeError(`${path} degraded status requires a reason.`);
    }
    if (snapshot[collectionName].length !== 0) {
      throw new TypeError(`${path} degraded status cannot carry authority records.`);
    }
  }
}

function assertNullableKey(target, path, allowedKinds) {
  assertExactKeys(target, ['kind', 'key'], [], path);
  if (!allowedKinds.has(target.kind)) throw new TypeError(`${path}.kind is unsupported.`);
  if (target.kind === 'global') {
    if (target.key !== null) throw new TypeError(`${path}.key must be null for global scope.`);
  } else {
    assertSafeId(target.key, `${path}.key`);
  }
}

function assertIssuer(issuer, path) {
  assertExactKeys(issuer, ['kind', 'key'], [], path);
  if (!ISSUER_KINDS.has(issuer.kind)) throw new TypeError(`${path}.kind is unsupported.`);
  assertSafeId(issuer.key, `${path}.key`);
}

function assertRecordWindow(record, evaluationTime, path) {
  if (!RECORD_STATES.has(record.state)) throw new TypeError(`${path}.state is unsupported.`);
  const validFrom = parseTime(record.validFrom, `${path}.validFrom`);
  const validUntil = record.validUntil === null
    ? Number.POSITIVE_INFINITY
    : parseTime(record.validUntil, `${path}.validUntil`);
  const now = parseTime(evaluationTime, 'evaluationTime');
  if (validFrom >= validUntil) throw new RangeError(`${path} validity window is empty.`);
  if (record.state === 'active' && (validFrom > now || validUntil <= now)) {
    throw new RangeError(`${path} active record is outside its validity window.`);
  }
  if (record.state === 'expired' && validUntil > now) {
    throw new RangeError(`${path} expired record has not expired.`);
  }
}

function assertRoleScope(assignment, path) {
  const teamScoped = new Set(['team-viewer', 'team-admin']);
  if (teamScoped.has(assignment.roleCode) && assignment.scope.kind !== 'team') {
    throw new TypeError(`${path} team role requires team scope.`);
  }
  if (
    !teamScoped.has(assignment.roleCode) &&
    assignment.roleCode !== 'auditor' &&
    assignment.scope.kind !== 'global'
  ) {
    throw new TypeError(`${path} global role cannot be team scoped.`);
  }
  if (
    assignment.assignee.kind === 'application' &&
    assignment.roleCode !== 'platform-operator'
  ) {
    throw new TypeError(`${path} application assignee cannot receive this role.`);
  }
  if (
    assignment.issuedBy.kind === 'subject' &&
    assignment.assignee.kind === 'subject' &&
    assignment.issuedBy.key === assignment.assignee.key
  ) {
    throw new TypeError(`${path} cannot grant a role to its issuer.`);
  }
}

export function assertGovernanceAssignmentSnapshotV1(
  snapshot,
  { evaluationTime, principalTenantId } = {},
) {
  assertSnapshotEnvelope(snapshot, evaluationTime, 'assignmentSnapshot', 'assignments');
  if (principalTenantId !== undefined && snapshot.tenantId !== principalTenantId) {
    throw new TypeError('Assignment snapshot tenant does not match the principal.');
  }

  const assignmentIds = [];
  const semanticKeys = [];
  for (const [index, assignment] of snapshot.assignments.entries()) {
    const path = `assignmentSnapshot.assignments[${index}]`;
    assertExactKeys(
      assignment,
      [
        'assignmentId',
        'assignmentVersion',
        'state',
        'roleCode',
        'assignee',
        'scope',
        'validFrom',
        'validUntil',
        'issuedBy',
        'reasonCode',
      ],
      [],
      path,
    );
    assertSafeId(assignment.assignmentId, `${path}.assignmentId`);
    assertPositiveInteger(assignment.assignmentVersion, `${path}.assignmentVersion`);
    if (!ASSIGNABLE_ROLES.has(assignment.roleCode)) {
      throw new TypeError(`${path}.roleCode is unsupported.`);
    }
    assertNullableKey(assignment.assignee, `${path}.assignee`, ASSIGNEE_KINDS);
    if (assignment.assignee.kind === 'global') throw new TypeError(`${path}.assignee cannot be global.`);
    assertNullableKey(assignment.scope, `${path}.scope`, ASSIGNMENT_SCOPE_KINDS);
    assertIssuer(assignment.issuedBy, `${path}.issuedBy`);
    assertSafeId(assignment.reasonCode, `${path}.reasonCode`);
    assertRecordWindow(assignment, evaluationTime, path);
    assertRoleScope(assignment, path);
    assignmentIds.push(assignment.assignmentId);
    semanticKeys.push([
      assignment.assignee.kind,
      assignment.assignee.key,
      assignment.roleCode,
      assignment.scope.kind,
      assignment.scope.key,
    ].join(':'));
  }
  assertSortedUnique(assignmentIds, 'assignmentSnapshot.assignments');
  if (new Set(semanticKeys).size !== semanticKeys.length) {
    throw new TypeError('Assignment snapshot contains overlapping semantic assignments.');
  }
  return snapshot;
}

function assertTeamCatalog(teamCatalog) {
  if (!Array.isArray(teamCatalog)) throw new TypeError('entitlementSnapshot.teamCatalog must be an array.');
  const teamKeys = [];
  const membershipGroupIds = [];
  for (const [index, mapping] of teamCatalog.entries()) {
    const path = `entitlementSnapshot.teamCatalog[${index}]`;
    assertExactKeys(mapping, ['teamKey', 'membershipGroupId'], [], path);
    assertSafeId(mapping.teamKey, `${path}.teamKey`);
    assertSafeId(mapping.membershipGroupId, `${path}.membershipGroupId`);
    teamKeys.push(mapping.teamKey);
    membershipGroupIds.push(mapping.membershipGroupId);
  }
  assertSortedUnique(teamKeys, 'entitlementSnapshot.teamCatalog');
  if (new Set(membershipGroupIds).size !== membershipGroupIds.length) {
    throw new TypeError('Entitlement team catalog maps one membership group more than once.');
  }
}

const QUOTA_PERIODS = new Set(['Hourly', 'Daily', 'Weekly', 'Monthly', 'Yearly']);

/**
 * A binding carries two independent axes. The rate axis shapes burst behaviour and
 * is refused with 429. The volume axis caps consumption over a period and is
 * refused with 403. A quota is meaningless without the period it accrues over, so
 * the two volume fields are required together or omitted together.
 */
function assertLimits(limits, path) {
  assertExactKeys(
    limits,
    [],
    ['requestsPerMinute', 'tokensPerMinute', 'tokenQuota', 'quotaPeriod'],
    path,
  );
  if (Object.hasOwn(limits, 'requestsPerMinute')) {
    assertNonnegativeInteger(limits.requestsPerMinute, `${path}.requestsPerMinute`, 1_000_000_000);
  }
  if (Object.hasOwn(limits, 'tokensPerMinute')) {
    assertNonnegativeInteger(limits.tokensPerMinute, `${path}.tokensPerMinute`, 1_000_000_000_000);
  }
  const hasQuota = Object.hasOwn(limits, 'tokenQuota');
  const hasPeriod = Object.hasOwn(limits, 'quotaPeriod');
  if (hasQuota !== hasPeriod) {
    throw new TypeError(`${path} must declare tokenQuota and quotaPeriod together.`);
  }
  if (hasQuota) {
    assertNonnegativeInteger(limits.tokenQuota, `${path}.tokenQuota`, Number.MAX_SAFE_INTEGER);
    if (limits.tokenQuota < 1) {
      throw new TypeError(`${path}.tokenQuota must be at least 1.`);
    }
    if (!QUOTA_PERIODS.has(limits.quotaPeriod)) {
      throw new TypeError(`${path}.quotaPeriod is unsupported.`);
    }
  }
}

export function assertEntitlementPolicySnapshotV1(
  snapshot,
  { evaluationTime, principalTenantId } = {},
) {
  assertExactKeys(
    snapshot,
    [
      'contractVersion',
      'snapshotId',
      'tenantId',
      'version',
      'status',
      'capturedAt',
      'expiresAt',
      'sourceRevision',
      'teamCatalog',
      'bindings',
    ],
    ['reason'],
    'entitlementSnapshot',
  );
  const envelope = { ...snapshot };
  delete envelope.teamCatalog;
  assertSnapshotEnvelope(
    { ...envelope, bindings: snapshot.bindings },
    evaluationTime,
    'entitlementSnapshot',
    'bindings',
  );
  if (principalTenantId !== undefined && snapshot.tenantId !== principalTenantId) {
    throw new TypeError('Entitlement snapshot tenant does not match the principal.');
  }
  assertTeamCatalog(snapshot.teamCatalog);

  const knownTeams = new Set(snapshot.teamCatalog.map((mapping) => mapping.teamKey));
  const bindingIds = [];
  const semanticKeys = [];
  let activeGlobalBindings = 0;
  for (const [index, binding] of snapshot.bindings.entries()) {
    const path = `entitlementSnapshot.bindings[${index}]`;
    assertExactKeys(
      binding,
      [
        'bindingId',
        'bindingVersion',
        'state',
        'target',
        'modelAllowlist',
        'limits',
        'validFrom',
        'validUntil',
        'issuedBy',
        'reasonCode',
      ],
      [],
      path,
    );
    assertSafeId(binding.bindingId, `${path}.bindingId`);
    assertPositiveInteger(binding.bindingVersion, `${path}.bindingVersion`);
    assertNullableKey(binding.target, `${path}.target`, BINDING_TARGET_KINDS);
    if (binding.target.kind === 'team' && !knownTeams.has(binding.target.key)) {
      throw new TypeError(`${path} references an unknown team.`);
    }
    if (!Array.isArray(binding.modelAllowlist)) {
      throw new TypeError(`${path}.modelAllowlist must be an array.`);
    }
    for (const [modelIndex, model] of binding.modelAllowlist.entries()) {
      assertSafeId(model, `${path}.modelAllowlist[${modelIndex}]`);
    }
    assertSortedUnique(binding.modelAllowlist, `${path}.modelAllowlist`);
    assertLimits(binding.limits, `${path}.limits`);
    assertIssuer(binding.issuedBy, `${path}.issuedBy`);
    assertSafeId(binding.reasonCode, `${path}.reasonCode`);
    assertRecordWindow(binding, evaluationTime, path);
    if (
      binding.issuedBy.kind === 'subject' &&
      binding.target.kind === 'subject' &&
      binding.issuedBy.key === binding.target.key
    ) {
      throw new TypeError(`${path} cannot grant an entitlement to its issuer.`);
    }
    if (binding.state === 'active' && binding.target.kind === 'global') activeGlobalBindings += 1;
    bindingIds.push(binding.bindingId);
    semanticKeys.push(`${binding.target.kind}:${binding.target.key}`);
  }
  assertSortedUnique(bindingIds, 'entitlementSnapshot.bindings');
  if (new Set(semanticKeys).size !== semanticKeys.length) {
    throw new TypeError('Entitlement snapshot contains overlapping target bindings.');
  }
  if (snapshot.status === 'complete' && activeGlobalBindings !== 1) {
    throw new TypeError('Complete entitlement snapshot requires exactly one active global binding.');
  }
  return snapshot;
}

export function getSnapshotAuthorityReason(snapshot, evaluationTime, prefix) {
  if (snapshot.status !== 'complete') return `${prefix}-snapshot-${snapshot.status}`;
  if (Date.parse(snapshot.expiresAt) <= Date.parse(evaluationTime)) return `${prefix}-snapshot-expired`;
  return null;
}