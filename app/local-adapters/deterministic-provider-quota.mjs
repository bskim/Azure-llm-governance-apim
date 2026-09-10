import { assertProviderQuotaSnapshotV1 } from '../governance-domain/registry/provider-quota-validator.mjs';

/**
 * A deterministic provider quota snapshot for local development.
 *
 * It is shaped by the same contract the live reader produces, so the screen that
 * renders it locally is rendering the structure a deployment would actually store.
 * One pool is fully allocated on purpose: an exhausted quota is the condition this
 * column exists to reveal, and a fixture that only shows healthy headroom would let
 * the exhausted case ship unseen.
 */

const CAPTURED_AT = '2026-07-24T09:56:00.000Z';

const SNAPSHOT = Object.freeze(
  assertProviderQuotaSnapshotV1({
    contractVersion: 'v1',
    snapshotId: 'provider-quota-local-001',
    status: 'complete',
    region: 'eastus2',
    capturedAt: CAPTURED_AT,
    expiresAt: '2026-07-24T10:11:00.000Z',
    sourceRevision: 'local-provider-quota-001',
    deployments: [
      {
        deploymentName: 'deploy-coding-fast',
        modelName: 'coding-fast',
        modelVersion: '2026-03-17',
        modelFormat: 'OpenAI',
        skuName: 'GlobalStandard',
        capabilities: { chatCompletion: true, responses: true },
        residencyArea: 'US',
        raiPolicyName: 'local-default-policy',
        capacity: 50,
        requestsPerMinute: 50,
        tokensPerMinute: 50_000,
        provisioningState: 'Succeeded',
        pool: {
          poolKey: 'OpenAI.GlobalStandard.coding-fast',
          allocated: 50,
          limit: 3_000,
          unit: 'Count',
          matchQuality: 'exact',
        },
        poolReasonCode: null,
      },
      {
        deploymentName: 'deploy-coding-primary',
        modelName: 'coding-primary',
        modelVersion: '2026-03-05',
        modelFormat: 'OpenAI',
        skuName: 'GlobalStandard',
        capabilities: { chatCompletion: true, responses: true },
        residencyArea: 'US',
        raiPolicyName: 'local-default-policy',
        capacity: 1_000,
        requestsPerMinute: 1_000,
        tokensPerMinute: 1_000_000,
        provisioningState: 'Succeeded',
        pool: {
          poolKey: 'OpenAI.GlobalStandard.coding-primary',
          allocated: 1_000,
          limit: 1_000,
          unit: 'Count',
          matchQuality: 'exact',
        },
        poolReasonCode: null,
      },
      {
        // Present on the account but published under no quota pool, which the live
        // provider does for some model and SKU pairs. It also carries the shape a
        // non-OpenAI publisher has: no Responses API and no stated area.
        deploymentName: 'deploy-unpooled',
        modelName: 'coding-experimental',
        modelVersion: null,
        modelFormat: 'MoonshotAI',
        skuName: 'DataZoneStandard',
        capabilities: { chatCompletion: true, responses: false },
        residencyArea: null,
        raiPolicyName: 'local-default-policy',
        capacity: 250,
        requestsPerMinute: 250,
        tokensPerMinute: 250_000,
        provisioningState: 'Succeeded',
        pool: null,
        poolReasonCode: 'pool-not-matched',
      },
    ],
  }),
);

export function getDeterministicProviderQuota() {
  return SNAPSHOT;
}
