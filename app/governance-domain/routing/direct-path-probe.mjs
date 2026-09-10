import { assertNoCredentialShapedValue, assertPseudonymousActor } from '../privacy/record-safety.mjs';

/**
 * Decides whether a direct-path probe (NET-002) actually proved the no-bypass
 * control, and separately models the lifecycle of the probe principal that made
 * the call. Creates and removes nothing; classifies evidence a caller already
 * collected and records what a future cloud-side script would repair from.
 *
 * A refused direct call proves nothing by itself: the credential could have been
 * missing, expired, or for the wrong tenant or audience, or the call could have
 * failed before it ever reached the provider. The only refusal that proves the
 * control is an authorization refusal against a caller whose credential was
 * genuinely valid, confirmed by zero usage in the provider's own metric for the
 * probe window, confirmed further by the same caller succeeding through the
 * gateway. Every other shape of "it was refused" reports `inconclusive`, never a
 * pass, and a metric that was never read or has not yet caught up with the
 * provider's own ingestion lag cannot be counted as the zero it might later be.
 */

export const PROBE_VERDICTS = Object.freeze(['control-proven', 'control-disproven', 'inconclusive']);

export const DIRECT_CALL_OUTCOMES = Object.freeze([
  'served',
  'authorization-refused',
  'unrelated-refusal',
  'routing-error',
  'network-failure',
]);

export const GATEWAY_CALL_OUTCOMES = Object.freeze(['succeeded', 'failed', 'not-attempted']);

export const METRIC_UNREADABLE_REASON_CODES = Object.freeze([
  'metric-not-attempted',
  'metric-ingestion-lag',
  'metric-query-failed',
]);

export const PROBE_LIFECYCLE_RESOURCE_STATES = Object.freeze(['created', 'removal-attempted', 'removed-confirmed']);

const CONTRACT_VERSION = 'direct-path-probe.v1';
const LIFECYCLE_CONTRACT_VERSION = 'direct-path-probe-lifecycle.v1';
const CODE = /^[a-z][a-z0-9-]{2,63}$/;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

const PRECONDITION_FIELDS = Object.freeze([
  'tokenValid',
  'tenantMatches',
  'audienceMatches',
  'notExpired',
  'principalMatches',
]);

// Checked in the order the requirement names them. Whichever fails first names the
// run inconclusive; a caller with several broken fields still learns about one.
const PRECONDITION_FAILURE_REASONS = Object.freeze({
  tokenValid: 'precondition-token-invalid',
  tenantMatches: 'precondition-tenant-mismatch',
  audienceMatches: 'precondition-audience-mismatch',
  notExpired: 'precondition-token-expired',
  principalMatches: 'precondition-principal-mismatch',
});

function fail(message) {
  throw new TypeError(message);
}

function refuse(code, detail = {}) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, detail);
  throw error;
}

function assertExactKeys(value, expected, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${path} must be an object.`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${path} must carry exactly [${wanted.join(', ')}] but carries [${actual.join(', ')}].`);
  }
}

function assertReasonCode(value, path) {
  if (typeof value !== 'string' || !CODE.test(value)) fail(`${path} must be a bounded lower-case code.`);
}

/**
 * The precondition evidence is required, not optional: a caller who never supplies
 * it has not looked, and that must not read the same as having looked and found it
 * satisfied. Every field must be an explicit boolean the caller actually measured.
 */
function assertPrecondition(precondition) {
  assertExactKeys(precondition, PRECONDITION_FIELDS, 'precondition');
  for (const field of PRECONDITION_FIELDS) {
    if (typeof precondition[field] !== 'boolean') fail(`precondition.${field} must be a boolean.`);
  }
}

function firstPreconditionFailure(precondition) {
  for (const field of PRECONDITION_FIELDS) {
    if (precondition[field] === false) return PRECONDITION_FAILURE_REASONS[field];
  }
  return null;
}

function assertDirectCallObservation(directCall) {
  assertExactKeys(directCall, ['outcome'], 'directCall');
  if (!DIRECT_CALL_OUTCOMES.includes(directCall.outcome)) fail('directCall.outcome is not a declared outcome.');
}

function assertGatewayCallObservation(gatewayCall) {
  assertExactKeys(gatewayCall, ['outcome'], 'gatewayCall');
  if (!GATEWAY_CALL_OUTCOMES.includes(gatewayCall.outcome)) fail('gatewayCall.outcome is not a declared outcome.');
}

/**
 * `state: 'read'` with a count is the only shape that can ever contribute to a
 * pass. `state: 'unreadable'` covers a query never attempted, one that ran and
 * came back empty during the provider's known ingestion lag, and one that failed
 * outright — three different reasons, but none of them is a zero.
 */
function assertMetricObservation(metric) {
  if (metric === null || typeof metric !== 'object' || Array.isArray(metric)) fail('metric must be an object.');
  if (metric.state === 'unreadable') {
    assertExactKeys(metric, ['state', 'reasonCode'], 'metric');
    if (!METRIC_UNREADABLE_REASON_CODES.includes(metric.reasonCode)) {
      fail('metric.reasonCode is not a declared unreadable reason.');
    }
    return;
  }
  if (metric.state !== 'read') fail('metric.state must be read or unreadable.');
  assertExactKeys(metric, ['state', 'count'], 'metric');
  if (!Number.isSafeInteger(metric.count) || metric.count < 0) fail('metric.count must be a non-negative integer.');
}

function assertProbeResult(result) {
  assertExactKeys(
    result,
    [
      'contractVersion',
      'verdict',
      'reasonCode',
      'precondition',
      'directCallOutcome',
      'metricState',
      'metricCount',
      'metricReasonCode',
      'gatewayCallOutcome',
    ],
    'result',
  );
  if (result.contractVersion !== CONTRACT_VERSION) fail('result.contractVersion is not recognised.');
  if (!PROBE_VERDICTS.includes(result.verdict)) fail('result.verdict is not a declared verdict.');
  assertReasonCode(result.reasonCode, 'result.reasonCode');
  assertPrecondition(result.precondition);
  if (!DIRECT_CALL_OUTCOMES.includes(result.directCallOutcome)) {
    fail('result.directCallOutcome is not a declared outcome.');
  }
  if (result.metricState !== 'read' && result.metricState !== 'unreadable') fail('result.metricState is unsupported.');
  if (result.metricState === 'read') {
    if (!Number.isSafeInteger(result.metricCount) || result.metricCount < 0) {
      fail('result.metricCount must be a non-negative integer.');
    }
    if (result.metricReasonCode !== null) fail('result.metricReasonCode must be null when the metric was read.');
  } else {
    if (result.metricCount !== null) fail('result.metricCount must be null when the metric is unreadable.');
    if (!METRIC_UNREADABLE_REASON_CODES.includes(result.metricReasonCode)) {
      fail('result.metricReasonCode is not a declared unreadable reason.');
    }
  }
  if (!GATEWAY_CALL_OUTCOMES.includes(result.gatewayCallOutcome)) {
    fail('result.gatewayCallOutcome is not a declared outcome.');
  }
  assertNoCredentialShapedValue(result, 'result');
  return result;
}

/**
 * Classifies one direct-path probe run. All four evidence objects are required:
 * an omitted one means the caller never looked, and that must throw rather than
 * silently read as a satisfied check. Shape is validated for all four before any
 * verdict is decided, so a malformed later argument cannot hide behind an earlier
 * short-circuit.
 */
export function classifyDirectPathProbe({ precondition, directCall, metric, gatewayCall } = {}) {
  if (precondition === undefined) fail('precondition evidence must be supplied; omitting it is not a check.');
  if (directCall === undefined) fail('directCall observation must be supplied; omitting it is not a check.');
  if (metric === undefined) fail('metric observation must be supplied; omitting it is not a check.');
  if (gatewayCall === undefined) fail('gatewayCall observation must be supplied; omitting it is not a check.');

  assertPrecondition(precondition);
  assertDirectCallObservation(directCall);
  assertMetricObservation(metric);
  assertGatewayCallObservation(gatewayCall);

  const build = (verdict, reasonCode) => assertProbeResult({
    contractVersion: CONTRACT_VERSION,
    verdict,
    reasonCode,
    precondition: { ...precondition },
    directCallOutcome: directCall.outcome,
    metricState: metric.state,
    metricCount: metric.state === 'read' ? metric.count : null,
    metricReasonCode: metric.state === 'unreadable' ? metric.reasonCode : null,
    gatewayCallOutcome: gatewayCall.outcome,
  });

  const preconditionFailure = firstPreconditionFailure(precondition);
  if (preconditionFailure !== null) return build('inconclusive', preconditionFailure);

  if (directCall.outcome === 'served') return build('control-disproven', 'direct-call-served');
  if (directCall.outcome !== 'authorization-refused') return build('inconclusive', `direct-call-${directCall.outcome}`);

  // The refusal alone is not enough: a metric that has not been read, or has not
  // yet caught up with the provider's own ingestion lag, is not evidence of zero.
  if (metric.state !== 'read') return build('inconclusive', metric.reasonCode);
  if (metric.count !== 0) return build('inconclusive', 'metric-nonzero-despite-refusal');

  if (gatewayCall.outcome !== 'succeeded') {
    return build(
      'inconclusive',
      gatewayCall.outcome === 'not-attempted' ? 'gateway-call-not-attempted' : 'gateway-call-failed',
    );
  }

  return build('control-proven', 'direct-refused-metric-zero-gateway-succeeded');
}

function assertLifecycleResource(resource, path) {
  assertExactKeys(resource, ['resourceCode', 'removalState', 'removalConfirmedAt'], path);
  assertPseudonymousActor(resource.resourceCode, `${path}.resourceCode`);
  if (!SAFE_ID.test(resource.resourceCode)) fail(`${path}.resourceCode must be a bounded identifier.`);
  if (!PROBE_LIFECYCLE_RESOURCE_STATES.includes(resource.removalState)) {
    fail(`${path}.removalState is not a declared lifecycle state.`);
  }
  if (resource.removalState === 'removed-confirmed') {
    if (typeof resource.removalConfirmedAt !== 'string' || !INSTANT.test(resource.removalConfirmedAt)) {
      // A removal cannot read as confirmed without the instant that confirmed it.
      refuse('lifecycle-removal-confirmed-without-instant', { path });
    }
  } else if (resource.removalConfirmedAt !== null) {
    fail(`${path}.removalConfirmedAt must be null until removal is confirmed.`);
  }
}

function outstandingOf(resources) {
  return resources.some((resource) => resource.removalState !== 'removed-confirmed');
}

/**
 * The state a future cloud-side script would persist and repair from: what the
 * probe created, when, and whether every one of those resources was confirmed
 * removed. `outstanding` is always derived here, never accepted from a caller, so
 * a probe cannot be declared removed while a resource still says otherwise.
 */
export function assertProbeLifecycleRecord(record) {
  assertExactKeys(record, ['contractVersion', 'probeCode', 'createdAt', 'resources', 'outstanding'], 'lifecycleRecord');
  if (record.contractVersion !== LIFECYCLE_CONTRACT_VERSION) fail('lifecycleRecord.contractVersion is not recognised.');
  assertPseudonymousActor(record.probeCode, 'lifecycleRecord.probeCode');
  if (!SAFE_ID.test(record.probeCode)) fail('lifecycleRecord.probeCode must be a bounded identifier.');
  if (typeof record.createdAt !== 'string' || !INSTANT.test(record.createdAt)) {
    fail('lifecycleRecord.createdAt must be an ISO-8601 instant.');
  }
  if (!Array.isArray(record.resources) || record.resources.length === 0) {
    fail('lifecycleRecord.resources must be a non-empty array.');
  }
  record.resources.forEach((resource, index) => assertLifecycleResource(resource, `lifecycleRecord.resources[${index}]`));

  if (record.outstanding !== outstandingOf(record.resources)) {
    // The one shape this record exists to make impossible: a probe with something
    // still unremoved that reads as fully removed.
    refuse('lifecycle-outstanding-misdeclared', { declared: record.outstanding });
  }

  assertNoCredentialShapedValue(record, 'lifecycleRecord');
  return record;
}

export function buildProbeLifecycleRecord({ probeCode, createdAt, resources }) {
  if (!Array.isArray(resources)) fail('resources must be an array.');
  return assertProbeLifecycleRecord({
    contractVersion: LIFECYCLE_CONTRACT_VERSION,
    probeCode,
    createdAt,
    resources,
    outstanding: outstandingOf(resources),
  });
}
