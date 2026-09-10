/**
 * Compares the internal picture of a window against the provider's own evidence.
 *
 * This exists to tell an administrator the picture is wrong. It never computes an
 * amount owed: `ADR-0007` puts money owed outside this product, and a detector
 * that produced a figure someone could invoice would have quietly reintroduced the
 * settlement subsystem `ADR-0002` removed.
 *
 * The failure mode worth designing against is a comparison that looks clean
 * because one side had nothing to say. Two incomplete sources agree perfectly and
 * mean nothing, so an unusable side produces `indeterminate` rather than
 * agreement.
 */

const VARIANCE_TARGET_BASIS_POINTS = 100;

function fail(message) {
  throw new TypeError(message);
}

function assertCount(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${name} must be a whole count.`);
  return value;
}

function assertSide(side, name) {
  if (side === null || typeof side !== 'object') fail(`${name} is required.`);
  assertCount(side.requests, `${name}.requests`);
  assertCount(side.totalTokens, `${name}.totalTokens`);
  if (typeof side.completeness !== 'string') fail(`${name}.completeness is required.`);
  return side;
}

/**
 * Signed and relative to the provider, because the provider is the side with
 * independent evidence. An unsigned figure would hide which direction the picture
 * is wrong in, and the two directions have different causes.
 */
function variance(internal, provider) {
  if (provider === 0) return internal === 0 ? 0 : null;
  return Math.round(((internal - provider) / provider) * 10_000);
}

function exceeds(basisPoints, target) {
  return basisPoints !== null && Math.abs(basisPoints) > target;
}

export function detectUsageDrift({
  windowStart,
  windowEnd,
  internal,
  provider,
  duplicateCorrelationIds = [],
  conflictingCorrelationIds = [],
  aggregateIds = [],
  targetBasisPoints = VARIANCE_TARGET_BASIS_POINTS,
  evaluationTime,
}) {
  if (typeof windowStart !== 'string' || typeof windowEnd !== 'string') {
    fail('windowStart and windowEnd are required.');
  }
  if (typeof evaluationTime !== 'string') fail('evaluationTime is required.');
  assertSide(internal, 'internal');
  assertSide(provider, 'provider');
  if (!Number.isSafeInteger(targetBasisPoints) || targetBasisPoints < 0) {
    fail('targetBasisPoints must be a whole number of basis points.');
  }

  const findings = [];
  // Recorded before the completeness check, because a duplicate is a defect in the
  // internal picture whatever the provider was able to report.
  for (const correlationId of duplicateCorrelationIds) {
    findings.push({ code: 'duplicate-record', correlationId });
  }
  for (const correlationId of conflictingCorrelationIds) {
    findings.push({ code: 'conflicting-record', correlationId });
  }

  const unusable =
    internal.completeness !== 'complete'
      ? 'internal-incomplete'
      : provider.completeness !== 'complete'
        ? 'provider-incomplete'
        : null;

  if (unusable !== null) {
    return Object.freeze({
      contractVersion: 'v1',
      documentType: 'usage-drift',
      windowStart,
      windowEnd,
      state: 'indeterminate',
      reasonCode: unusable,
      targetBasisPoints,
      variance: null,
      findings: Object.freeze(findings),
      // Nothing is disputed, because nothing was compared. Marking aggregates here
      // would attribute a source outage to the data it failed to describe.
      disputedAggregateIds: Object.freeze([]),
      evaluatedAt: evaluationTime,
    });
  }

  const requestVariance = variance(internal.requests, provider.requests);
  const tokenVariance = variance(internal.totalTokens, provider.totalTokens);

  if (requestVariance === null || tokenVariance === null) {
    findings.push({ code: 'provider-reports-none', internalRequests: internal.requests });
  }
  if (internal.requests < provider.requests) {
    findings.push({
      code: 'records-missing',
      shortfall: provider.requests - internal.requests,
    });
  }
  if (internal.requests > provider.requests) {
    findings.push({
      code: 'records-unexpected',
      excess: internal.requests - provider.requests,
    });
  }
  if (exceeds(tokenVariance, targetBasisPoints)) {
    findings.push({ code: 'token-variance-exceeded', varianceBasisPoints: tokenVariance });
  }

  const disputed =
    findings.length > 0 ||
    exceeds(requestVariance, targetBasisPoints) ||
    exceeds(tokenVariance, targetBasisPoints);

  return Object.freeze({
    contractVersion: 'v1',
    documentType: 'usage-drift',
    windowStart,
    windowEnd,
    state: disputed ? 'disputed' : 'agreed',
    reasonCode: disputed ? 'variance-detected' : 'within-target',
    targetBasisPoints,
    variance: Object.freeze({ requests: requestVariance, tokens: tokenVariance }),
    findings: Object.freeze(findings),
    // The aggregates a reader would otherwise trust. Marking them is the whole
    // point: the number stays visible and stops being presented as settled.
    disputedAggregateIds: Object.freeze(disputed ? [...aggregateIds] : []),
    evaluatedAt: evaluationTime,
  });
}

export { VARIANCE_TARGET_BASIS_POINTS };
