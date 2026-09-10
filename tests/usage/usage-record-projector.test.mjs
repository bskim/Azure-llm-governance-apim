import assert from 'node:assert/strict';
import test from 'node:test';

import { projectUsageRecords } from '../../app/governance-domain/usage/usage-record-projector.mjs';
import { assertUsageRecordDocument } from '../../app/governance-domain/usage/usage-record-validator.mjs';
import { assertModelRegistrySnapshotV1 } from '../../app/governance-domain/registry/model-registry-validator.mjs';

const evaluationTime = '2026-08-07T00:00:00.000Z';
const tenantId = 'tenant-local-demo';
const scopeGroupId = 'developer-experience';

function model(modelKey) {
  return {
    modelKey,
    providerKey: 'azure-openai',
    apiFamilies: ['openai-chat-completions'],
    lifecycle: 'generally-available',
    safetyPolicy: 'local-default-policy',
  };
}

function registry({ models = [model('coding-primary')], applications = [], status = 'complete' } = {}) {
  return assertModelRegistrySnapshotV1(
    {
      contractVersion: 'v1',
      snapshotId: 'model-registry-001',
      tenantId,
      version: 1,
      status,
      capturedAt: '2026-08-06T23:55:00.000Z',
      expiresAt: '2026-08-07T00:30:00.000Z',
      sourceRevision: 'model-registry-source-001',
      models,
      applications,
    },
    { evaluationTime, principalTenantId: tenantId },
  );
}

function row(overrides = {}) {
  return {
    correlationId: 'request-0001',
    observedAt: '2026-08-06T23:40:00.000Z',
    teamKey: 'developer-experience',
    subjectKey: 'sk1-abcdefghijklmnop',
    applicationKey: 'ak1-abcdefghijklmnop',
    applicationId: 'app-reviewed-agent',
    requestedModel: 'coding-primary',
    effectiveModel: 'coding-primary',
    promptTokens: 1_000_000,
    completionTokens: 500_000,
    outcome: 'served',
    tokenQuality: 'reported',
    ...overrides,
  };
}

function project(rows, overrides = {}) {
  return projectUsageRecords({
    rows,
    scopeGroupId,
    registry: registry(),
    configVersion: 7,
    sourceRevision: 'usage-source-001',
    projectedAt: evaluationTime,
    ...overrides,
  });
}

test('a served request becomes one immutable record of the tokens it used', () => {
  const { records } = project([row()]);
  assert.equal(records.length, 1);
  const [record] = records;

  assert.equal(record.id, `usage-record|${scopeGroupId}|request-0001`);
  assert.equal(record.usage.totalTokens, 1_500_000);
  assert.equal(record.effective.providerKey, 'azure-openai');
  assert.ok(Object.isFrozen(record));
  assert.ok(Object.isFrozen(record.usage));
  assert.ok(assertUsageRecordDocument(record));
});

test('a request with no single team remains attributable without inventing one', () => {
  const { records, rejected } = project([row({ teamKey: null })]);

  assert.equal(rejected.length, 0);
  assert.equal(records.length, 1);
  assert.equal(records[0].attribution.teamKey, null);
  assert.equal(records[0].attribution.subjectKey, 'sk1-abcdefghijklmnop');
  assert.equal(records[0].attribution.applicationKey, 'ak1-abcdefghijklmnop');
});

test('an abandoned stream keeps the tokens the gateway already charged for', () => {
  // The quota was debited before the client walked away. Recording zero would hide
  // budget that was genuinely spent, which is the one outcome this must not produce.
  const [record] = project([
    row({ tokenQuality: 'estimated', exchangeState: 'abandoned', promptTokens: 1200, completionTokens: 0 }),
  ]).records;

  assert.equal(record.usage.totalTokens, 1200);
  assert.equal(record.usage.exchangeState, 'abandoned');
});

test('an abandoned request cannot claim its count was reported', () => {
  const [record] = project([row()]).records;

  assert.equal(record.usage.exchangeState, 'complete');
  assert.throws(
    () =>
      assertUsageRecordDocument({
        ...record,
        usage: { ...record.usage, exchangeState: 'abandoned', tokenQuality: 'reported' },
      }),
    /abandoned request cannot carry a reported/,
  );
});

test('an unknown token count is dropped rather than silently zeroed into an aggregate', () => {
  const [record] = project([
    row({ tokenQuality: 'unknown', promptTokens: 900, completionTokens: 900 }),
  ]).records;

  // The counts are dropped rather than kept, because nothing vouches for them, and
  // keeping them would let an unverifiable number into every aggregate above.
  assert.equal(record.usage.totalTokens, 0);
  assert.equal(record.usage.tokenQuality, 'unknown');
});

test('a refused request carries no usage', () => {
  const [record] = project([
    row({ outcome: 'refused', promptTokens: 0, completionTokens: 0, tokenQuality: 'unknown' }),
  ]).records;

  assert.equal(record.outcome, 'refused');
  assert.equal(record.usage.totalTokens, 0);
});

test('an unregistered model leaves the provider absent rather than invented', () => {
  const unregistered = project([row({ requestedModel: 'not-in-catalogue', effectiveModel: 'not-in-catalogue' })]);
  assert.equal(unregistered.records[0].effective.providerKey, null);
});

test('an absent catalogue produces a record without inventing a provider', () => {
  const [record] = projectUsageRecords({
    rows: [row()],
    scopeGroupId,
    registry: null,
    configVersion: 7,
    sourceRevision: 'usage-source-001',
    projectedAt: evaluationTime,
  }).records;

  assert.equal(record.effective.providerKey, null);
  assert.equal(record.attribution.applicationQuality, null);
  assert.equal(record.attribution.applicationReasonCode, 'model-registry-unavailable');
});

test('an unregistered calling application is unavailable rather than reported as a shared tool', () => {
  const [record] = project([row({ applicationId: 'unknown-client' })]).records;

  assert.equal(record.attribution.applicationQuality, null);
  assert.equal(record.attribution.applicationReasonCode, 'application-unregistered');
});

test('a request seen twice in one read is counted once', () => {
  const { records, rejected } = project([row(), row()]);

  assert.equal(records.length, 1);
  assert.deepEqual(rejected, [{ correlationId: 'request-0001', reasonCode: 'duplicate-in-window' }]);
});

test('a row with no request identity is refused rather than counted on every read', () => {
  const { records, rejected } = project([row({ correlationId: undefined })]);

  assert.equal(records.length, 0);
  assert.deepEqual(rejected, [{ reasonCode: 'correlation-id-absent' }]);
});

test('re-projecting an unchanged request writes nothing and reports nothing wrong', () => {
  const [first] = project([row()]).records;
  const again = project([row()], {
    existingById: new Map([[first.id, first]]),
    projectedAt: '2026-08-07T01:00:00.000Z',
  });

  assert.equal(again.records.length, 0);
  assert.equal(again.conflicts.length, 0);
  assert.deepEqual(again.unchanged, [first]);
});

test('a re-projection that disagrees is a conflict, and the stored record is kept', () => {
  const [first] = project([row()]).records;
  const again = project([row({ completionTokens: 900_000 })], {
    existingById: new Map([[first.id, first]]),
  });

  assert.equal(again.records.length, 0);
  assert.deepEqual(again.conflicts, [{ id: first.id, correlationId: 'request-0001' }]);
  // The disagreement is what drift detection exists to surface, so overwriting the
  // stored record would erase the finding.
  assert.equal(first.usage.completionTokens, 500_000);
});

test('a record that cannot satisfy the contract is rejected rather than stored partially formed', () => {
  const { records, rejected } = project([row({ teamKey: 'Not A Team Key' })]);

  assert.equal(records.length, 0);
  assert.equal(rejected[0].reasonCode, 'record-invalid');
  assert.match(rejected[0].detail, /teamKey/);
});

test('the validator refuses claims a record cannot support', () => {
  const [valid] = project([row()]).records;

  assert.throws(
    () => assertUsageRecordDocument({ ...valid, outcome: 'refused' }),
    /refused request cannot report token usage/,
  );
  assert.throws(
    () => assertUsageRecordDocument({ ...valid, usage: { ...valid.usage, tokenQuality: 'unknown' } }),
    /unknown cannot also carry a token count/,
  );
  assert.throws(
    () => assertUsageRecordDocument({ ...valid, projectedAt: '2026-08-06T00:00:00.000Z' }),
    /cannot precede/,
  );
  assert.throws(
    () => assertUsageRecordDocument({ ...valid, id: 'usage-record|elsewhere|request-0001' }),
    /must be derived from/,
  );
});

test('a record never carries a value that must not be stored', () => {
  const [valid] = project([row()]).records;

  assert.throws(
    () => assertUsageRecordDocument({ ...valid, sourceRevision: 'https://logs.example/query' }),
    /must not be stored/,
  );
  const serialized = JSON.stringify(valid);
  for (const forbidden of ['prompt"', 'completion"', 'messages', 'subjectId', 'applicationId']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});
