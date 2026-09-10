import assert from 'node:assert/strict';
import test from 'node:test';

import {
  detectUsageDrift,
  VARIANCE_TARGET_BASIS_POINTS,
} from '../../app/governance-domain/usage/drift-detector.mjs';

const windowStart = '2026-08-06T00:00:00.000Z';
const windowEnd = '2026-08-07T00:00:00.000Z';
const evaluationTime = '2026-08-07T01:00:00.000Z';

function detect(overrides = {}) {
  return detectUsageDrift({
    windowStart,
    windowEnd,
    internal: { requests: 1_000, totalTokens: 1_000_000, completeness: 'complete' },
    provider: { requests: 1_000, totalTokens: 1_000_000, completeness: 'complete' },
    aggregateIds: ['usage-rollup|developer-experience|organization||2026-08-06T00:00:00.000Z'],
    evaluationTime,
    ...overrides,
  });
}

test('two sides that agree leave the aggregates alone', () => {
  const result = detect();

  assert.equal(result.state, 'agreed');
  assert.equal(result.reasonCode, 'within-target');
  assert.deepEqual(result.variance, { requests: 0, tokens: 0 });
  assert.deepEqual(result.disputedAggregateIds, []);
  assert.equal(result.targetBasisPoints, VARIANCE_TARGET_BASIS_POINTS);
});

test('token variance inside the target is agreement, not a rounding argument', () => {
  const result = detect({
    internal: { requests: 1_000, totalTokens: 1_009_000, completeness: 'complete' },
  });

  assert.equal(result.variance.tokens, 90);
  assert.equal(result.state, 'agreed');
});

test('token variance past the target disputes the aggregates it affects', () => {
  const result = detect({
    internal: { requests: 1_000, totalTokens: 1_020_000, completeness: 'complete' },
  });

  assert.equal(result.state, 'disputed');
  assert.equal(result.variance.tokens, 200);
  assert.deepEqual(result.findings, [{ code: 'token-variance-exceeded', varianceBasisPoints: 200 }]);
  // The number stays visible and stops being presented as settled.
  assert.equal(result.disputedAggregateIds.length, 1);
});

test('a shortfall and an excess are different findings, because they have different causes', () => {
  const missing = detect({
    internal: { requests: 900, totalTokens: 1_000_000, completeness: 'complete' },
  });
  assert.ok(missing.findings.some((finding) => finding.code === 'records-missing' && finding.shortfall === 100));

  const unexpected = detect({
    internal: { requests: 1_100, totalTokens: 1_000_000, completeness: 'complete' },
  });
  assert.ok(unexpected.findings.some((finding) => finding.code === 'records-unexpected' && finding.excess === 100));
});

test('a single missing record is detected even though its token variance is tiny', () => {
  const result = detect({
    internal: { requests: 999, totalTokens: 999_000, completeness: 'complete' },
  });

  assert.equal(result.state, 'disputed');
  // Ten basis points is well inside the target, so counting alone is what catches it.
  assert.equal(result.variance.tokens, -10);
  assert.ok(result.findings.some((finding) => finding.code === 'records-missing'));
});

test('duplicates and conflicts are findings in their own right', () => {
  const result = detect({
    duplicateCorrelationIds: ['request-1'],
    conflictingCorrelationIds: ['request-2'],
  });

  assert.equal(result.state, 'disputed');
  assert.deepEqual(result.findings, [
    { code: 'duplicate-record', correlationId: 'request-1' },
    { code: 'conflicting-record', correlationId: 'request-2' },
  ]);
});

test('an incomplete side is indeterminate rather than agreement', () => {
  for (const [side, reasonCode] of [
    ['internal', 'internal-incomplete'],
    ['provider', 'provider-incomplete'],
  ]) {
    const result = detect({
      [side]: { requests: 1_000, totalTokens: 1_000_000, completeness: 'partial' },
    });

    assert.equal(result.state, 'indeterminate');
    assert.equal(result.reasonCode, reasonCode);
    assert.equal(result.variance, null);
    // Nothing was compared, so attributing a source outage to the data it failed to
    // describe would mark aggregates that may be perfectly correct.
    assert.deepEqual(result.disputedAggregateIds, []);
  }
});

test('an incomplete window still reports a duplicate it already knows about', () => {
  const result = detect({
    internal: { requests: 1_000, totalTokens: 1_000_000, completeness: 'degraded' },
    duplicateCorrelationIds: ['request-1'],
  });

  assert.equal(result.state, 'indeterminate');
  assert.deepEqual(result.findings, [{ code: 'duplicate-record', correlationId: 'request-1' }]);
});

test('a provider that reports nothing while the gateway did is a finding, not a division', () => {
  const result = detect({
    provider: { requests: 0, totalTokens: 0, completeness: 'complete' },
  });

  assert.equal(result.state, 'disputed');
  assert.equal(result.variance.requests, null);
  assert.ok(result.findings.some((finding) => finding.code === 'provider-reports-none'));
});

test('two genuinely empty sides agree', () => {
  const result = detect({
    internal: { requests: 0, totalTokens: 0, completeness: 'complete' },
    provider: { requests: 0, totalTokens: 0, completeness: 'complete' },
  });

  assert.equal(result.state, 'agreed');
  assert.deepEqual(result.variance, { requests: 0, tokens: 0 });
});

test('the result carries no amount owed and no adjustment to post', () => {
  const result = detect({
    internal: { requests: 1_100, totalTokens: 1_500_000, completeness: 'complete' },
  });

  const serialized = JSON.stringify(result);
  for (const forbidden of ['amount', 'owed', 'currency', 'minor', 'adjustment', 'settlement', 'invoice']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.findings));
});

test('the target is configurable, because a tighter one is a stricter promise', () => {
  const result = detect({
    internal: { requests: 1_000, totalTokens: 1_005_000, completeness: 'complete' },
    targetBasisPoints: 10,
  });

  assert.equal(result.state, 'disputed');
  assert.equal(result.targetBasisPoints, 10);
});
