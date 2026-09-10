import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildProviderQuotaSnapshot,
  readAccountRegion,
  readProviderQuota,
} from '../../app/providers/foundry-quota-query.mjs';
import { assertProviderQuotaSnapshotV1 } from '../../app/governance-domain/registry/provider-quota-validator.mjs';

const capturedAt = '2026-07-24T09:56:00.000Z';

// Shaped exactly as the live ARM responses observed on the target account, including
// the spellings that do not agree between the two collections.
function deployment(
  name,
  { model, sku = 'GlobalStandard', capacity, rpm, tpm, format = 'OpenAI', capabilities, raiPolicyName },
) {
  return {
    name,
    sku: { name: sku, capacity },
    properties: {
      model: { name: model, version: '2026-03-05', format },
      provisioningState: 'Succeeded',
      ...(capabilities === undefined ? {} : { capabilities }),
      ...(raiPolicyName === undefined ? {} : { raiPolicyName }),
      rateLimits: [
        { key: 'request', count: rpm, renewalPeriod: 60 },
        { key: 'token', count: tpm, renewalPeriod: 60 },
        { key: 'token', count: tpm * 10, renewalPeriod: 600 },
      ],
    },
  };
}

function usage(key, currentValue, limit) {
  return { name: { value: key }, currentValue, limit, unit: 'Count' };
}

function build(deployments, usages, overrides = {}) {
  return buildProviderQuotaSnapshot({
    deployments,
    usages,
    region: 'eastus2',
    snapshotId: 'provider-quota-test',
    sourceRevision: 'test',
    capturedAt,
    ...overrides,
  });
}

test('a deployment reports the rate the provider stated, not one derived from capacity', () => {
  const snapshot = build(
    [deployment('gpt-5.4-mini', { model: 'gpt-5.4-mini', capacity: 1_000, rpm: 1_000, tpm: 1_000_000 })],
    [usage('OpenAI.GlobalStandard.gpt-5.4-mini', 1_000, 1_000)],
  );
  const [entry] = snapshot.deployments;
  assert.equal(entry.requestsPerMinute, 1_000);
  assert.equal(entry.tokensPerMinute, 1_000_000);
  assert.equal(entry.capacity, 1_000);
  assert.equal(entry.pool.allocated, 1_000);
  assert.equal(entry.pool.limit, 1_000);
  assert.equal(entry.pool.matchQuality, 'exact');
});

test('capabilities the provider states as strings are carried as decided facts', () => {
  const snapshot = build(
    [
      deployment('gpt-5.4-mini', {
        model: 'gpt-5.4-mini',
        capacity: 1_000,
        rpm: 1_000,
        tpm: 1_000_000,
        capabilities: { chatCompletion: 'true', responses: 'true', area: 'US', assistants: 'true' },
        raiPolicyName: 'atb-indirect-attack',
      }),
    ],
    [],
  );
  const [entry] = snapshot.deployments;

  assert.equal(entry.modelFormat, 'OpenAI');
  assert.deepEqual(entry.capabilities, { chatCompletion: true, responses: true });
  assert.equal(entry.residencyArea, 'US');
  assert.equal(entry.raiPolicyName, 'atb-indirect-attack');
});

test('a publisher that advertises no Responses API and no area says so rather than defaulting', () => {
  // The live account has three such deployments. Inventing a geography for them
  // would put a residency claim on the registry that nobody made.
  const snapshot = build(
    [
      deployment('Kimi-K2.6-1', {
        model: 'Kimi-K2.6',
        capacity: 50,
        rpm: 50,
        tpm: 50_000,
        format: 'MoonshotAI',
        capabilities: { chatCompletion: 'true' },
      }),
    ],
    [],
  );
  const [entry] = snapshot.deployments;

  assert.equal(entry.capabilities.chatCompletion, true);
  assert.equal(entry.capabilities.responses, false);
  assert.equal(entry.residencyArea, null);
  assert.equal(entry.raiPolicyName, null);
});

test('the quota family is not guessed, so a non-OpenAI pool still matches', () => {
  const snapshot = build(
    [deployment('grok-4.3', { model: 'grok-4.3', capacity: 50, rpm: 50, tpm: 50_000, format: 'xAI' })],
    [usage('AIServices.GlobalStandard.grok-4.3', 50, 1_000)],
  );
  assert.equal(snapshot.deployments[0].pool.poolKey, 'AIServices.GlobalStandard.grok-4.3');
  assert.equal(snapshot.deployments[0].pool.matchQuality, 'exact');
});

test('a pool the provider spells differently matches, and says it was normalised', () => {
  const snapshot = build(
    [deployment('gpt-4.1', { model: 'gpt-4.1', sku: 'Standard', capacity: 10, rpm: 10, tpm: 10_000 })],
    [usage('OpenAI.Standard.gpt4.1', 10, 1_000)],
  );
  assert.equal(snapshot.deployments[0].pool.poolKey, 'OpenAI.Standard.gpt4.1');
  assert.equal(snapshot.deployments[0].pool.matchQuality, 'normalized');
});

test('two families publishing the same model and SKU is ambiguous, not a coin toss', () => {
  const snapshot = build(
    [deployment('shared', { model: 'shared-model', capacity: 10, rpm: 10, tpm: 10_000 })],
    [
      usage('OpenAI.GlobalStandard.shared-model', 10, 100),
      usage('AIServices.GlobalStandard.shared-model', 20, 200),
    ],
  );
  assert.equal(snapshot.deployments[0].pool, null);
  assert.equal(snapshot.deployments[0].poolReasonCode, 'pool-not-matched');
});

test('a model with no published pool keeps its own rate limits', () => {
  const snapshot = build(
    [deployment('FW-GLM-5.2', { model: 'FW-GLM-5.2', sku: 'DataZoneStandard', capacity: 250, rpm: 250, tpm: 250_000, format: 'Fireworks' })],
    [usage('AIServices.GlobalStandard.gpt-5.4', 1, 2)],
  );
  const [entry] = snapshot.deployments;
  assert.equal(entry.tokensPerMinute, 250_000);
  assert.equal(entry.pool, null);
  assert.equal(entry.poolReasonCode, 'pool-not-matched');
});

test('an unavailable usage list degrades the pool column, not the whole snapshot', () => {
  const snapshot = build(
    [deployment('gpt-5.4-mini', { model: 'gpt-5.4-mini', capacity: 1_000, rpm: 1_000, tpm: 1_000_000 })],
    [],
    { usagesAvailable: false },
  );
  assert.equal(snapshot.status, 'complete');
  assert.equal(snapshot.deployments[0].tokensPerMinute, 1_000_000);
  assert.equal(snapshot.deployments[0].poolReasonCode, 'pool-unavailable');
});

test('a deployment with no stated rate limit reports null rather than a guess', () => {
  const raw = deployment('odd', { model: 'odd-model', capacity: 7, rpm: 7, tpm: 7_000 });
  raw.properties.rateLimits = [{ key: 'token', count: 70_000, renewalPeriod: 600 }];
  const snapshot = build([raw], []);
  assert.equal(snapshot.deployments[0].requestsPerMinute, null);
  assert.equal(snapshot.deployments[0].tokensPerMinute, null);
  assert.equal(snapshot.deployments[0].capacity, 7);
});

test('the snapshot refuses to carry a subscription path or a credential', () => {
  assert.throws(
    () =>
      assertProviderQuotaSnapshotV1({
        ...build([deployment('a', { model: 'm', capacity: 1, rpm: 1, tpm: 1_000 })], []),
        sourceRevision: '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg',
      }),
    /must not be stored/,
  );
});

test('the reader issues only read-only ARM gets and never sends the token onward', async () => {
  const seen = [];
  const snapshot = await readProviderQuota({
    subscriptionId: 'sub-1',
    resourceGroupName: 'rg-1',
    accountName: 'account-1',
    region: 'eastus2',
    credential: { getToken: async () => ({ token: 'token-value' }) },
    now: () => capturedAt,
    transport: async (url) => {
      seen.push(url);
      return url.includes('/usages')
        ? { value: [usage('OpenAI.GlobalStandard.gpt-5.4-mini', 1_000, 1_000)] }
        : { value: [deployment('gpt-5.4-mini', { model: 'gpt-5.4-mini', capacity: 1_000, rpm: 1_000, tpm: 1_000_000 })] };
    },
  });

  assert.equal(seen.length, 2);
  assert.ok(seen.every((url) => url.startsWith('https://management.azure.com/')));
  assert.ok(seen.every((url) => url.includes('api-version=2024-10-01')));
  assert.equal(snapshot.deployments[0].pool.limit, 1_000);
  assert.equal(JSON.stringify(snapshot).includes('token-value'), false);
});

test('a failing usage read still produces a usable snapshot', async () => {
  const snapshot = await readProviderQuota({
    subscriptionId: 'sub-1',
    resourceGroupName: 'rg-1',
    accountName: 'account-1',
    region: 'eastus2',
    credential: { getToken: async () => ({ token: 'token-value' }) },
    now: () => capturedAt,
    transport: async (url) => {
      if (url.includes('/usages')) throw new Error('arm-read-failed');
      return { value: [deployment('gpt-5.4-mini', { model: 'gpt-5.4-mini', capacity: 1_000, rpm: 1_000, tpm: 1_000_000 })] };
    },
  });
  assert.equal(snapshot.deployments[0].poolReasonCode, 'pool-unavailable');
});

test('the region is asked of the account rather than configured beside it', async () => {
  // A second setting naming the region is one a deployment can forget, and one that
  // can disagree with the account it describes. The same grant covers this read.
  const seen = [];
  const region = await readAccountRegion({
    subscriptionId: 'sub-1',
    resourceGroupName: 'rg-1',
    accountName: 'account-1',
    credential: { getToken: async () => ({ token: 'token-value' }) },
    transport: async (url) => {
      seen.push(url);
      return { location: 'eastus2' };
    },
  });

  assert.equal(region, 'eastus2');
  assert.equal(seen.length, 1);
  assert.ok(seen[0].endsWith('/providers/Microsoft.CognitiveServices/accounts/account-1?api-version=2024-10-01'));
  assert.ok(!seen[0].includes('/deployments'));
});

test('an account that reports no location refuses rather than guessing one', async () => {
  await assert.rejects(
    () => readAccountRegion({
      subscriptionId: 'sub-1',
      resourceGroupName: 'rg-1',
      accountName: 'account-1',
      credential: { getToken: async () => ({ token: 'token-value' }) },
      transport: async () => ({}),
    }),
    TypeError,
  );
});
