import { assertProviderQuotaSnapshotV1, normalisePoolKey } from '../governance-domain/registry/provider-quota-validator.mjs';

/**
 * Reads provider-side quota for a Microsoft Foundry account.
 *
 * Two read-only ARM collections answer two different questions, and the product
 * needs both. A deployment's rate limits say what the provider will serve for that
 * deployment. The regional usage list says how much of the subscription's quota for
 * that model and SKU is already allocated, which is the only number that says
 * whether another deployment could be created at all.
 *
 * Nothing here mutates. The reader is pure over its transport so it can be exercised
 * without a network, and the transport is injected so a test never reaches Azure.
 */

const ARM_API_VERSION = '2024-10-01';
const MANAGEMENT_SCOPE = 'https://management.azure.com/.default';
const DEFAULT_VALIDITY_SECONDS = 900;

function fail(message) {
  throw new TypeError(message);
}

function rateFor(rateLimits, key) {
  if (!Array.isArray(rateLimits)) return null;
  const entry = rateLimits.find((limit) => limit.key === key && limit.renewalPeriod === 60);
  if (entry === undefined || !Number.isFinite(entry.count)) return null;
  return Math.trunc(entry.count);
}

/**
 * A pool key is `{family}.{sku}.{model}`, and the family is not derivable from the
 * deployment: the provider files OpenAI models under `OpenAI` and everything else
 * under `AIServices`, while the deployment declares its publisher instead. So the
 * match is made on the part that is knowable, and two families publishing the same
 * SKU and model is ambiguous rather than a coin toss.
 *
 * The provider also does not spell the model the way its own deployment does
 * (`gpt-4.1` becomes `gpt4.1`), so an exact match is tried first and a punctuation
 * insensitive one second. Which one matched is carried forward, because a normalised
 * match is a weaker claim.
 */
function matchPool(pools, { skuName, modelName }) {
  const suffixOf = (key) => key.split('.').slice(1).join('.');
  const wanted = `${skuName}.${modelName}`;

  const exact = pools.filter((pool) => suffixOf(pool.key) === wanted);
  if (exact.length === 1) return { pool: exact[0], matchQuality: 'exact' };
  if (exact.length > 1) return null;

  const normalised = normalisePoolKey(wanted);
  const candidates = pools.filter((pool) => normalisePoolKey(suffixOf(pool.key)) === normalised);
  if (candidates.length !== 1) return null;
  return { pool: candidates[0], matchQuality: 'normalized' };
}

function projectPools(usages) {
  return usages
    .filter((usage) => typeof usage?.name?.value === 'string')
    .map((usage) => ({
      key: usage.name.value,
      allocated: Number.isFinite(usage.currentValue) ? Math.trunc(usage.currentValue) : null,
      limit: Number.isFinite(usage.limit) ? Math.trunc(usage.limit) : null,
      unit: typeof usage.unit === 'string' && usage.unit.length > 0 ? usage.unit : 'Count',
    }))
    .filter((pool) => pool.allocated !== null && pool.limit !== null);
}

function capabilityFlag(capabilities, name) {
  // ARM states capabilities as the strings 'true'/'false', and omits the key entirely
  // for a capability the deployment does not advertise.
  return capabilities?.[name] === 'true';
}

function projectDeployment(deployment, pools, poolsAvailable) {
  const model = deployment.properties?.model ?? {};
  const capabilities = deployment.properties?.capabilities ?? {};
  const skuName = deployment.sku?.name ?? 'unknown';
  const modelName = model.name ?? 'unknown';
  const matched = poolsAvailable ? matchPool(pools, { skuName, modelName }) : null;

  return {
    deploymentName: deployment.name,
    modelName,
    modelVersion: typeof model.version === 'string' ? model.version : null,
    modelFormat: typeof model.format === 'string' && model.format.length > 0 ? model.format : 'unknown',
    skuName,
    capabilities: {
      chatCompletion: capabilityFlag(capabilities, 'chatCompletion'),
      responses: capabilityFlag(capabilities, 'responses'),
    },
    // Three of this account's deployments carry no area at all, so an absent one is
    // unknown rather than a geography nobody stated.
    residencyArea:
      typeof capabilities.area === 'string' && capabilities.area.length > 0 ? capabilities.area : null,
    raiPolicyName:
      typeof deployment.properties?.raiPolicyName === 'string' && deployment.properties.raiPolicyName.length > 0
        ? deployment.properties.raiPolicyName
        : null,
    capacity: Number.isSafeInteger(deployment.sku?.capacity) ? deployment.sku.capacity : null,
    // Taken from the provider's own statement rather than derived from capacity, so
    // a SKU whose capacity unit differs cannot silently produce a wrong rate.
    requestsPerMinute: rateFor(deployment.properties?.rateLimits, 'request'),
    tokensPerMinute: rateFor(deployment.properties?.rateLimits, 'token'),
    provisioningState: deployment.properties?.provisioningState ?? 'Unknown',
    pool: matched === null
      ? null
      : {
          poolKey: matched.pool.key,
          allocated: matched.pool.allocated,
          limit: matched.pool.limit,
          unit: matched.pool.unit,
          matchQuality: matched.matchQuality,
        },
    poolReasonCode: matched === null ? (poolsAvailable ? 'pool-not-matched' : 'pool-unavailable') : null,
  };
}

export function buildProviderQuotaSnapshot({
  deployments,
  usages,
  usagesAvailable = true,
  region,
  snapshotId,
  sourceRevision,
  capturedAt,
  validitySeconds = DEFAULT_VALIDITY_SECONDS,
}) {
  if (!Array.isArray(deployments)) fail('deployments must be an array.');
  const pools = usagesAvailable ? projectPools(usages ?? []) : [];

  const snapshot = {
    contractVersion: 'v1',
    snapshotId,
    status: 'complete',
    region,
    capturedAt,
    expiresAt: new Date(Date.parse(capturedAt) + validitySeconds * 1000).toISOString(),
    sourceRevision,
    deployments: deployments
      .map((deployment) => projectDeployment(deployment, pools, usagesAvailable))
      .sort((left, right) => left.deploymentName.localeCompare(right.deploymentName)),
  };
  return assertProviderQuotaSnapshotV1(snapshot);
}

async function armGet(url, { getToken }) {
  const token = await getToken();
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!response.ok) {
    const error = new Error(`arm-read-failed`);
    error.code = 'arm-read-failed';
    error.status = response.status;
    throw error;
  }
  return response.json();
}

/**
 * Where the account lives, asked of the account.
 *
 * The alternative was a second app setting naming the region, which a deployment can
 * forget to set and which can then disagree with the account it names. This read is
 * covered by the same grant the deployment list needs.
 */
export async function readAccountRegion({
  subscriptionId,
  resourceGroupName,
  accountName,
  credential,
  transport = armGet,
}) {
  for (const [name, value] of Object.entries({ subscriptionId, resourceGroupName, accountName })) {
    if (typeof value !== 'string' || value.length === 0) fail(`${name} is required.`);
  }
  const getToken = async () => {
    const token = await credential.getToken(MANAGEMENT_SCOPE);
    if (token?.token === undefined) fail('The credential returned no management token.');
    return token.token;
  };
  const account = await transport(
    `https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}` +
      `/providers/Microsoft.CognitiveServices/accounts/${accountName}?api-version=${ARM_API_VERSION}`,
    { getToken },
  );
  if (typeof account?.location !== 'string' || account.location.length === 0) {
    fail('The account did not report a location.');
  }
  return account.location;
}

/**
 * Reads the live account. Read-only: two GETs, no inference call, and no gateway
 * operation, so it consumes no request allowance.
 */
export async function readProviderQuota({
  subscriptionId,
  resourceGroupName,
  accountName,
  region,
  credential,
  now = () => new Date().toISOString(),
  transport = armGet,
}) {
  for (const [name, value] of Object.entries({ subscriptionId, resourceGroupName, accountName, region })) {
    if (typeof value !== 'string' || value.length === 0) fail(`${name} is required.`);
  }
  const getToken = async () => {
    const token = await credential.getToken(MANAGEMENT_SCOPE);
    if (token?.token === undefined) fail('The credential returned no management token.');
    return token.token;
  };

  const base = 'https://management.azure.com';
  const deploymentsUrl =
    `${base}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}` +
    `/providers/Microsoft.CognitiveServices/accounts/${accountName}/deployments?api-version=${ARM_API_VERSION}`;
  const usagesUrl =
    `${base}/subscriptions/${subscriptionId}/providers/Microsoft.CognitiveServices` +
    `/locations/${region}/usages?api-version=${ARM_API_VERSION}`;

  const deployments = await transport(deploymentsUrl, { getToken });

  // A missing quota pool is a weaker answer than a missing deployment list, so it
  // degrades the pool column rather than the whole snapshot.
  let usages = null;
  let usagesAvailable = true;
  try {
    usages = await transport(usagesUrl, { getToken });
  } catch {
    usagesAvailable = false;
  }

  const capturedAt = now();
  return buildProviderQuotaSnapshot({
    deployments: deployments.value ?? [],
    usages: usages?.value ?? [],
    usagesAvailable,
    region,
    snapshotId: `provider-quota-${accountName}`,
    sourceRevision: `arm-${ARM_API_VERSION}`,
    capturedAt,
  });
}
