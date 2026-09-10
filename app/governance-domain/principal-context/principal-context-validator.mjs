const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const PRINCIPAL_TYPES = new Set(['user', 'workload']);
const AUTHENTICATION_FLOWS = new Set(['delegated', 'application']);
const TRUST_SOURCES = new Set(['local-deterministic', 'entra-validated']);
const MEMBERSHIP_SOURCES = new Set([
  'local-fixture',
  'entra-adapter',
  'control-plane',
  'directory-claim',
]);
// Exported so the published contract and this validator cannot drift. They already had:
// the schema still listed a cached-directory source nothing produces and omitted
// directory-claim, which is the one a deployment actually resolves membership from.
export const MEMBERSHIP_SOURCE_NAMES = Object.freeze([...MEMBERSHIP_SOURCES]);
// Cached evidence may not be trusted indefinitely, so it carries a staleness budget.
// Evidence the credential itself asserts has no such budget: it is exactly as current
// as the authentication, and is bounded by that instead.
const CREDENTIAL_BOUND_SOURCES = new Set(['directory-claim']);
const MAX_CACHED_AGE_SECONDS = 3600;
const MEMBERSHIP_STATUSES = new Set([
  'complete',
  'empty-complete',
  'unmapped',
  'incomplete',
  'stale',
  'ambiguous',
  'source-unavailable',
]);
const GROUP_MEMBERSHIP_TYPES = new Set(['direct', 'nested', 'transitive']);
const STRICT_MEMBERSHIP_STATUSES = new Set(['complete', 'empty-complete']);

function assertRecord(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object.`);
  }
}

function assertExactKeys(value, required, optional, path) {
  assertRecord(value, path);
  const actual = Object.keys(value);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new TypeError(`${path}.${key} is required.`);
    }
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of actual) {
    if (!allowed.has(key)) {
      throw new TypeError(`${path}.${key} is not allowed.`);
    }
  }
}

function assertSafeId(value, path) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new TypeError(`${path} must be a bounded safe identifier.`);
  }
}

function parseTime(value, path) {
  if (typeof value !== 'string') {
    throw new TypeError(`${path} must be an RFC 3339 string.`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new TypeError(`${path} must be an RFC 3339 timestamp.`);
  }
  return timestamp;
}

function assertInteger(value, path, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${path} must be an integer between ${minimum} and ${maximum}.`);
  }
}

/**
 * Membership evidence, wherever it is being read.
 *
 * It is validated inside a principal context and again as a stored document, so the
 * rule lives here once. Two implementations of one rule diverge, and the direction
 * they diverge in is whichever one is checked less often.
 */
export function assertMembershipEvidence(
  memberships,
  { subject, evaluationTime, path = 'memberships', credentialExpiresAt },
) {
  const now = parseTime(evaluationTime, 'evaluationTime');
  assertExactKeys(
    memberships,
    [
      'snapshotId',
      'status',
      'source',
      'tenantId',
      'subjectId',
      'resolvedAt',
      'expiresAt',
      'maxAgeSeconds',
      'sourceRevision',
      'groups',
    ],
    ['reason'],
    path,
  );
  for (const key of ['snapshotId', 'tenantId', 'subjectId', 'sourceRevision']) {
    assertSafeId(memberships[key], `${path}.${key}`);
  }
  if (!MEMBERSHIP_STATUSES.has(memberships.status)) {
    throw new TypeError(`${path}.status is unsupported.`);
  }
  if (!MEMBERSHIP_SOURCES.has(memberships.source)) {
    throw new TypeError(`${path}.source is unsupported.`);
  }
  if (subject !== undefined) {
    if (memberships.tenantId !== subject.tenantId) {
      throw new TypeError('Membership tenant does not match the verified subject.');
    }
    if (memberships.subjectId !== subject.subjectId) {
      throw new TypeError('Membership subject does not match the verified subject.');
    }
  }
  const resolvedAt = parseTime(memberships.resolvedAt, `${path}.resolvedAt`);
  const expiresAt = parseTime(memberships.expiresAt, `${path}.expiresAt`);
  if (CREDENTIAL_BOUND_SOURCES.has(memberships.source)) {
    if (typeof credentialExpiresAt !== 'string') {
      throw new TypeError(`${path}.source ${memberships.source} requires credentialExpiresAt.`);
    }
    if (expiresAt > parseTime(credentialExpiresAt, 'credentialExpiresAt')) {
      throw new RangeError('Membership evidence cannot outlive the credential that asserted it.');
    }
    assertInteger(memberships.maxAgeSeconds, `${path}.maxAgeSeconds`, 0, Number.MAX_SAFE_INTEGER);
  } else {
    assertInteger(memberships.maxAgeSeconds, `${path}.maxAgeSeconds`, 0, MAX_CACHED_AGE_SECONDS);
  }
  if (resolvedAt > now) {
    throw new RangeError('Membership evidence cannot be resolved in the future.');
  }
  if (resolvedAt >= expiresAt) {
    throw new RangeError('Membership resolution must precede expiry.');
  }
  if (expiresAt - resolvedAt > memberships.maxAgeSeconds * 1000) {
    throw new RangeError('Membership lifetime exceeds maxAgeSeconds.');
  }
  if (STRICT_MEMBERSHIP_STATUSES.has(memberships.status) && expiresAt <= now) {
    throw new RangeError('Complete membership evidence is expired.');
  }
  if (
    !STRICT_MEMBERSHIP_STATUSES.has(memberships.status) &&
    (typeof memberships.reason !== 'string' || memberships.reason.length === 0)
  ) {
    throw new TypeError('Degraded membership evidence requires a reason.');
  }
  if (!Array.isArray(memberships.groups)) {
    throw new TypeError(`${path}.groups must be an array.`);
  }
  if (memberships.status === 'empty-complete' && memberships.groups.length !== 0) {
    throw new TypeError('empty-complete membership must contain no groups.');
  }
  if (memberships.status === 'complete' && memberships.groups.length === 0) {
    throw new TypeError('complete membership must contain at least one group.');
  }

  const groupIds = [];
  for (const [index, group] of memberships.groups.entries()) {
    const groupPath = `${path}.groups[${index}]`;
    assertExactKeys(group, ['groupId', 'membership', 'authorizationRelevant'], [], groupPath);
    assertSafeId(group.groupId, `${groupPath}.groupId`);
    if (!GROUP_MEMBERSHIP_TYPES.has(group.membership)) {
      throw new TypeError(`${groupPath}.membership is unsupported.`);
    }
    if (typeof group.authorizationRelevant !== 'boolean') {
      throw new TypeError(`${groupPath}.authorizationRelevant must be boolean.`);
    }
    groupIds.push(group.groupId);
  }
  if (new Set(groupIds).size !== groupIds.length) {
    throw new TypeError('Membership groups contain duplicate IDs.');
  }
  const sortedGroupIds = [...groupIds].sort((left, right) => left.localeCompare(right));
  if (groupIds.some((groupId, index) => groupId !== sortedGroupIds[index])) {
    throw new TypeError('Membership groups must be sorted by groupId.');
  }
  return memberships;
}

export function isStrictMembershipEligible(context, evaluationTime) {
  const now = parseTime(evaluationTime, 'evaluationTime');
  const expiresAt = parseTime(context.memberships.expiresAt, 'memberships.expiresAt');
  return STRICT_MEMBERSHIP_STATUSES.has(context.memberships.status) && expiresAt > now;
}

export function assertPrincipalContextV1(context, { evaluationTime }) {
  const now = parseTime(evaluationTime, 'evaluationTime');
  assertExactKeys(
    context,
    ['contractVersion', 'trust', 'subject', 'application', 'memberships', 'correlation'],
    [],
    'context',
  );
  if (context.contractVersion !== 'v1') {
    throw new TypeError('context.contractVersion must be v1.');
  }

  assertExactKeys(
    context.trust,
    [
      'source',
      'validationId',
      'validatedAt',
      'credentialExpiresAt',
      'validationState',
      'callerSupplied',
    ],
    [],
    'context.trust',
  );
  if (!TRUST_SOURCES.has(context.trust.source)) {
    throw new TypeError('context.trust.source is unsupported.');
  }
  assertSafeId(context.trust.validationId, 'context.trust.validationId');
  const validatedAt = parseTime(context.trust.validatedAt, 'context.trust.validatedAt');
  const credentialExpiresAt = parseTime(
    context.trust.credentialExpiresAt,
    'context.trust.credentialExpiresAt',
  );
  if (validatedAt >= credentialExpiresAt) {
    throw new RangeError('Identity validation must precede credential expiry.');
  }
  if (credentialExpiresAt <= now) {
    throw new RangeError('Verified identity evidence is expired.');
  }
  if (context.trust.callerSupplied !== false) {
    throw new TypeError('Principal context must be server constructed.');
  }
  const expectedValidationState =
    context.trust.source === 'local-deterministic' ? 'local-trusted' : 'validated';
  if (context.trust.validationState !== expectedValidationState) {
    throw new TypeError('Identity source and validation state do not match.');
  }

  assertExactKeys(
    context.subject,
    ['tenantId', 'subjectId', 'principalType'],
    [],
    'context.subject',
  );
  assertSafeId(context.subject.tenantId, 'context.subject.tenantId');
  assertSafeId(context.subject.subjectId, 'context.subject.subjectId');
  if (!PRINCIPAL_TYPES.has(context.subject.principalType)) {
    throw new TypeError('context.subject.principalType is unsupported.');
  }

  assertExactKeys(
    context.application,
    ['applicationId', 'authenticationFlow'],
    ['applicationInstanceId'],
    'context.application',
  );
  assertSafeId(context.application.applicationId, 'context.application.applicationId');
  if (Object.hasOwn(context.application, 'applicationInstanceId')) {
    assertSafeId(
      context.application.applicationInstanceId,
      'context.application.applicationInstanceId',
    );
  }
  if (!AUTHENTICATION_FLOWS.has(context.application.authenticationFlow)) {
    throw new TypeError('context.application.authenticationFlow is unsupported.');
  }
  const expectedFlow = context.subject.principalType === 'user' ? 'delegated' : 'application';
  if (context.application.authenticationFlow !== expectedFlow) {
    throw new TypeError('Principal type and authentication flow do not match.');
  }

  assertMembershipEvidence(context.memberships, {
    subject: context.subject,
    evaluationTime,
    path: 'context.memberships',
    credentialExpiresAt: context.trust.credentialExpiresAt,
  });

  assertExactKeys(
    context.correlation,
    ['source', 'requestId', 'attempt'],
    ['traceId', 'parentCorrelationId'],
    'context.correlation',
  );
  if (context.correlation.source !== 'server-generated') {
    throw new TypeError('Correlation must be server generated.');
  }
  assertSafeId(context.correlation.requestId, 'context.correlation.requestId');
  for (const key of ['traceId', 'parentCorrelationId']) {
    if (Object.hasOwn(context.correlation, key)) {
      assertSafeId(context.correlation[key], `context.correlation.${key}`);
    }
  }
  assertInteger(context.correlation.attempt, 'context.correlation.attempt', 1);

  return context;
}