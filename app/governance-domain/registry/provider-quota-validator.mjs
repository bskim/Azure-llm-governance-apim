/**
 * Semantic validation for a provider quota snapshot.
 *
 * Two different numbers are easy to confuse here and the contract keeps them apart.
 * A deployment's rate limit is what the provider will serve for that deployment. A
 * quota pool is what the subscription is allowed to allocate across every deployment
 * of that model and SKU. A dashboard that shows one and calls it the other tells an
 * administrator they have headroom they do not have.
 */

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MODEL_NAME = /^[A-Za-z0-9._-]{1,128}$/;
const REGION = /^[a-z0-9-]{1,64}$/;
const MATCH_QUALITIES = new Set(['exact', 'normalized']);
const POOL_REASONS = new Set(['pool-not-matched', 'pool-unavailable']);
// A snapshot travels into a store and a dashboard; neither is a place for a secret
// or for a resource path that names the subscription.
const FORBIDDEN_VALUE = /(https?:\/\/|bearer\s|api-key|sk-[A-Za-z0-9]{8}|\/subscriptions\/)/i;

function fail(message) {
  throw new TypeError(message);
}

function assertCount(value, name) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) fail(`${name} must be a whole count or null.`);
  return value;
}

function assertInstant(value, name) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    fail(`${name} must be an ISO-8601 instant.`);
  }
  return Date.parse(value);
}

function assertNoForbiddenValues(value, path) {
  if (typeof value === 'string') {
    if (FORBIDDEN_VALUE.test(value)) fail(`${path} carries a value that must not be stored.`);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) assertNoForbiddenValues(child, `${path}.${key}`);
}

function assertPool(pool, path) {
  if (typeof pool.poolKey !== 'string' || !SAFE_ID.test(pool.poolKey)) {
    fail(`${path}.poolKey must be a bounded identifier.`);
  }
  const allocated = assertCount(pool.allocated, `${path}.allocated`);
  const limit = assertCount(pool.limit, `${path}.limit`);
  if (allocated === null || limit === null) fail(`${path} must carry both allocated and limit.`);
  if (!MATCH_QUALITIES.has(pool.matchQuality)) {
    // A pool matched by normalising two spellings is still a match, but a reader has
    // to be able to tell it apart from one the provider named identically.
    fail(`${path}.matchQuality must say how the pool was matched.`);
  }
  if (typeof pool.unit !== 'string' || pool.unit.length === 0) fail(`${path}.unit is required.`);
}

function assertDeployment(deployment, path) {
  for (const [name, pattern] of [
    ['deploymentName', SAFE_ID],
    ['modelName', MODEL_NAME],
    ['skuName', SAFE_ID],
    ['modelFormat', SAFE_ID],
  ]) {
    if (typeof deployment[name] !== 'string' || !pattern.test(deployment[name])) {
      fail(`${path}.${name} must be a bounded identifier.`);
    }
  }
  for (const flag of ['chatCompletion', 'responses']) {
    if (typeof deployment.capabilities?.[flag] !== 'boolean') {
      fail(`${path}.capabilities.${flag} must state whether the provider advertises it.`);
    }
  }
  for (const name of ['residencyArea', 'raiPolicyName']) {
    if (deployment[name] !== null && (typeof deployment[name] !== 'string' || !SAFE_ID.test(deployment[name]))) {
      fail(`${path}.${name} must be a bounded identifier or null.`);
    }
  }
  if (deployment.modelVersion !== null && (typeof deployment.modelVersion !== 'string' || !SAFE_ID.test(deployment.modelVersion))) {
    fail(`${path}.modelVersion must be a bounded identifier or null.`);
  }
  assertCount(deployment.capacity, `${path}.capacity`);
  assertCount(deployment.requestsPerMinute, `${path}.requestsPerMinute`);
  assertCount(deployment.tokensPerMinute, `${path}.tokensPerMinute`);
  if (typeof deployment.provisioningState !== 'string' || !SAFE_ID.test(deployment.provisioningState)) {
    fail(`${path}.provisioningState must be a bounded identifier.`);
  }
  if (deployment.pool === null) {
    if (!POOL_REASONS.has(deployment.poolReasonCode)) {
      fail(`${path}.poolReasonCode must explain why no pool is attached.`);
    }
    return;
  }
  if (deployment.poolReasonCode !== null) fail(`${path} cannot carry both a pool and a reason.`);
  assertPool(deployment.pool, `${path}.pool`);
}

export function assertProviderQuotaSnapshotV1(snapshot, { evaluationTime } = {}) {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    fail('snapshot must be an object.');
  }
  if (snapshot.contractVersion !== 'v1') fail('snapshot.contractVersion must be v1.');
  if (typeof snapshot.snapshotId !== 'string' || !SAFE_ID.test(snapshot.snapshotId)) {
    fail('snapshot.snapshotId must be a bounded identifier.');
  }
  if (!['complete', 'degraded'].includes(snapshot.status)) fail('snapshot.status is unsupported.');
  if (typeof snapshot.region !== 'string' || !REGION.test(snapshot.region)) {
    fail('snapshot.region must be an Azure region name.');
  }
  if (typeof snapshot.sourceRevision !== 'string' || snapshot.sourceRevision.length === 0) {
    fail('snapshot.sourceRevision is required.');
  }
  const capturedAt = assertInstant(snapshot.capturedAt, 'snapshot.capturedAt');
  const expiresAt = assertInstant(snapshot.expiresAt, 'snapshot.expiresAt');
  if (expiresAt <= capturedAt) fail('snapshot.expiresAt must follow snapshot.capturedAt.');
  if (evaluationTime !== undefined && Date.parse(evaluationTime) < capturedAt) {
    fail('snapshot.capturedAt cannot be in the future.');
  }
  if (!Array.isArray(snapshot.deployments)) fail('snapshot.deployments must be an array.');

  const seen = new Set();
  snapshot.deployments.forEach((deployment, index) => {
    assertDeployment(deployment, `snapshot.deployments[${index}]`);
    if (seen.has(deployment.deploymentName)) {
      fail(`snapshot.deployments[${index}] repeats a deployment name.`);
    }
    seen.add(deployment.deploymentName);
  });
  assertNoForbiddenValues(snapshot, 'snapshot');
  return snapshot;
}

/** Two spellings of the same model differ only in punctuation and case. */
export function normalisePoolKey(value) {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
}
