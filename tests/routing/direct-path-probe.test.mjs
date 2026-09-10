import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DIRECT_CALL_OUTCOMES,
  GATEWAY_CALL_OUTCOMES,
  METRIC_UNREADABLE_REASON_CODES,
  PROBE_LIFECYCLE_RESOURCE_STATES,
  PROBE_VERDICTS,
  assertProbeLifecycleRecord,
  buildProbeLifecycleRecord,
  classifyDirectPathProbe,
} from '../../app/governance-domain/routing/direct-path-probe.mjs';

const CODE = /^[a-z][a-z0-9-]{2,63}$/;

function precondition(overrides = {}) {
  return {
    tokenValid: true,
    tenantMatches: true,
    audienceMatches: true,
    notExpired: true,
    principalMatches: true,
    ...overrides,
  };
}

function evidence(overrides = {}) {
  return {
    precondition: precondition(overrides.precondition),
    directCall: overrides.directCall ?? { outcome: 'authorization-refused' },
    metric: overrides.metric ?? { state: 'read', count: 0 },
    gatewayCall: overrides.gatewayCall ?? { outcome: 'succeeded' },
  };
}

test('a healthy probe run proves the control', () => {
  const result = classifyDirectPathProbe(evidence());
  assert.equal(result.verdict, 'control-proven');
  assert.equal(result.reasonCode, 'direct-refused-metric-zero-gateway-succeeded');
});

test('omitting the precondition entirely throws, and a supplied failing precondition is a different, non-throwing outcome', () => {
  const { precondition: _omitted, ...rest } = evidence();
  assert.throws(() => classifyDirectPathProbe(rest), TypeError);

  const result = classifyDirectPathProbe(evidence({ precondition: { tokenValid: false } }));
  assert.equal(result.verdict, 'inconclusive');
  assert.equal(result.reasonCode, 'precondition-token-invalid');
});

test('omitting directCall, metric, or gatewayCall also throws rather than defaulting', () => {
  const full = evidence();
  assert.throws(() => classifyDirectPathProbe({ precondition: full.precondition, metric: full.metric, gatewayCall: full.gatewayCall }), TypeError);
  assert.throws(() => classifyDirectPathProbe({ precondition: full.precondition, directCall: full.directCall, gatewayCall: full.gatewayCall }), TypeError);
  assert.throws(() => classifyDirectPathProbe({ precondition: full.precondition, directCall: full.directCall, metric: full.metric }), TypeError);
});

test('each failing precondition field is reported with its own reason code, checked in a fixed priority order', () => {
  const cases = [
    [{ tokenValid: false }, 'precondition-token-invalid'],
    [{ tenantMatches: false }, 'precondition-tenant-mismatch'],
    [{ audienceMatches: false }, 'precondition-audience-mismatch'],
    [{ notExpired: false }, 'precondition-token-expired'],
    [{ principalMatches: false }, 'precondition-principal-mismatch'],
  ];
  for (const [overrides, reasonCode] of cases) {
    const result = classifyDirectPathProbe(evidence({ precondition: overrides }));
    assert.equal(result.verdict, 'inconclusive');
    assert.equal(result.reasonCode, reasonCode);
  }

  // Two fields fail at once: the one named first in the requirement wins, so a
  // caller with several broken fields still gets a single deterministic reason.
  const both = classifyDirectPathProbe(evidence({ precondition: { tokenValid: false, principalMatches: false } }));
  assert.equal(both.reasonCode, 'precondition-token-invalid');
});

test('an unreadable or not-yet-arrived metric never yields a pass', () => {
  for (const reasonCode of METRIC_UNREADABLE_REASON_CODES) {
    const result = classifyDirectPathProbe(evidence({ metric: { state: 'unreadable', reasonCode } }));
    assert.notEqual(result.verdict, 'control-proven');
    assert.equal(result.verdict, 'inconclusive');
    assert.equal(result.reasonCode, reasonCode);
  }
});

test('a metric that was read and is zero, with everything else present, does yield a pass', () => {
  const result = classifyDirectPathProbe(evidence({ metric: { state: 'read', count: 0 } }));
  assert.equal(result.verdict, 'control-proven');
});

test('a nonzero metric contradicts the refusal and is inconclusive rather than proven', () => {
  const result = classifyDirectPathProbe(evidence({ metric: { state: 'read', count: 3 } }));
  assert.equal(result.verdict, 'inconclusive');
  assert.equal(result.reasonCode, 'metric-nonzero-despite-refusal');
});

test('a served direct call disproves the control even if every other signal looks healthy', () => {
  const result = classifyDirectPathProbe(evidence({ directCall: { outcome: 'served' } }));
  assert.equal(result.verdict, 'control-disproven');
  assert.equal(result.reasonCode, 'direct-call-served');
});

test('a direct call outcome that is neither served nor an authorization refusal is inconclusive', () => {
  for (const outcome of ['unrelated-refusal', 'routing-error', 'network-failure']) {
    const result = classifyDirectPathProbe(evidence({ directCall: { outcome } }));
    assert.equal(result.verdict, 'inconclusive');
    assert.equal(result.reasonCode, `direct-call-${outcome}`);
  }
});

test('a refused direct call with no successful gateway call is not a pass', () => {
  const notAttempted = classifyDirectPathProbe(evidence({ gatewayCall: { outcome: 'not-attempted' } }));
  assert.equal(notAttempted.verdict, 'inconclusive');
  assert.equal(notAttempted.reasonCode, 'gateway-call-not-attempted');

  const failed = classifyDirectPathProbe(evidence({ gatewayCall: { outcome: 'failed' } }));
  assert.equal(failed.verdict, 'inconclusive');
  assert.equal(failed.reasonCode, 'gateway-call-failed');
});

test('an outcome outside the declared enums is refused rather than silently accepted', () => {
  assert.throws(() => classifyDirectPathProbe(evidence({ directCall: { outcome: 'bogus' } })), TypeError);
  assert.throws(() => classifyDirectPathProbe(evidence({ gatewayCall: { outcome: 'bogus' } })), TypeError);
  assert.throws(() => classifyDirectPathProbe(evidence({ metric: { state: 'bogus' } })), TypeError);
});

test('the verdict, outcome, and unreadable-reason sets are closed and exact', () => {
  assert.deepEqual(PROBE_VERDICTS, ['control-proven', 'control-disproven', 'inconclusive']);
  assert.deepEqual(DIRECT_CALL_OUTCOMES, [
    'served',
    'authorization-refused',
    'unrelated-refusal',
    'routing-error',
    'network-failure',
  ]);
  assert.deepEqual(GATEWAY_CALL_OUTCOMES, ['succeeded', 'failed', 'not-attempted']);
  assert.deepEqual(METRIC_UNREADABLE_REASON_CODES, ['metric-not-attempted', 'metric-ingestion-lag', 'metric-query-failed']);
});

test('every reason code produced by the classifier is a bounded lower-case code, never free text', () => {
  const scenarios = [
    evidence(),
    evidence({ precondition: { tokenValid: false } }),
    evidence({ metric: { state: 'unreadable', reasonCode: 'metric-ingestion-lag' } }),
    evidence({ metric: { state: 'read', count: 7 } }),
    evidence({ directCall: { outcome: 'served' } }),
    evidence({ directCall: { outcome: 'routing-error' } }),
    evidence({ gatewayCall: { outcome: 'failed' } }),
  ];
  for (const scenario of scenarios) {
    const result = classifyDirectPathProbe(scenario);
    assert.match(result.reasonCode, CODE);
  }
});

function lifecycleRecord(overrides = {}) {
  return buildProbeLifecycleRecord({
    probeCode: overrides.probeCode ?? 'probe-net-002-alpha',
    createdAt: overrides.createdAt ?? '2026-08-18T00:00:00Z',
    resources: overrides.resources ?? [
      { resourceCode: 'probe-principal', removalState: 'removed-confirmed', removalConfirmedAt: '2026-08-18T01:00:00Z' },
    ],
  });
}

test('a lifecycle record is outstanding while any resource is not confirmed removed', () => {
  const created = lifecycleRecord({
    resources: [{ resourceCode: 'probe-principal', removalState: 'created', removalConfirmedAt: null }],
  });
  assert.equal(created.outstanding, true);

  const attempted = lifecycleRecord({
    resources: [{ resourceCode: 'probe-principal', removalState: 'removal-attempted', removalConfirmedAt: null }],
  });
  assert.equal(attempted.outstanding, true);
});

test('a lifecycle record reads as removed only once every resource is confirmed removed', () => {
  const record = lifecycleRecord();
  assert.equal(record.outstanding, false);
});

test('a resource cannot claim removed-confirmed without the instant that confirmed it', () => {
  assert.throws(
    () => lifecycleRecord({
      resources: [{ resourceCode: 'probe-principal', removalState: 'removed-confirmed', removalConfirmedAt: null }],
    }),
    (error) => error.code === 'lifecycle-removal-confirmed-without-instant',
  );
});

test('a lifecycle record that misdeclares outstanding is refused, not silently trusted', () => {
  const dishonest = {
    contractVersion: 'direct-path-probe-lifecycle.v1',
    probeCode: 'probe-net-002-alpha',
    createdAt: '2026-08-18T00:00:00Z',
    resources: [{ resourceCode: 'probe-principal', removalState: 'created', removalConfirmedAt: null }],
    outstanding: false,
  };
  assert.throws(() => assertProbeLifecycleRecord(dishonest), (error) => error.code === 'lifecycle-outstanding-misdeclared');
});

test('a raw directory identifier as the probe code or a resource code is refused', () => {
  assert.throws(
    () => lifecycleRecord({ probeCode: '11111111-2222-3333-4444-555555555555' }),
    (error) => error.code === 'actor-not-pseudonymous',
  );
  assert.throws(
    () => lifecycleRecord({
      resources: [{
        resourceCode: '22222222-3333-4444-5555-666666666666',
        removalState: 'removed-confirmed',
        removalConfirmedAt: '2026-08-18T01:00:00Z',
      }],
    }),
    (error) => error.code === 'actor-not-pseudonymous',
  );
});

test('a credential-shaped value anywhere in the lifecycle record is refused', () => {
  assert.throws(
    () => lifecycleRecord({
      resources: [{
        resourceCode: 'role-assignment-secret-marker',
        removalState: 'removed-confirmed',
        removalConfirmedAt: '2026-08-18T01:00:00Z',
      }],
    }),
    (error) => error.code === 'record-value-refused',
  );
});

test('the declared lifecycle resource states are exact', () => {
  assert.deepEqual(PROBE_LIFECYCLE_RESOURCE_STATES, ['created', 'removal-attempted', 'removed-confirmed']);
});
