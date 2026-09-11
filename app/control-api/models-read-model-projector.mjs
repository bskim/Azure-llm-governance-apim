import { assertAuthorizedReadScope } from './admin-read-authorization.mjs';
import { assertBodyFreeReadModel } from './admin-read-model-projector.mjs';
import { projectWindowFreshness } from './read-model-freshness.mjs';
import { captureModel } from '../governance-domain/registry/model-capture.mjs';
import { REGISTRY_EXPIRY_WARNING_SECONDS } from '../governance-domain/registry/registry-capture-retention.mjs';
import {
  accumulateUsage,
  newUsageBucket,
  sealUsageBucket,
  selectVisibleUsageRecords,
} from './usage-read-model-projector.mjs';

/**
 * Projects the model catalogue joined to what was actually served through it.
 *
 * Two things this screen must not do. It must not present a measure nobody
 * collected as a zero, so a quota reading that is missing says why it is missing
 * rather than rendering as unused capacity. And it must not drop a model that
 * served traffic but is missing from the registry, because that would quietly
 * remove real consumption from the only screen that lists it.
 */

const SAFE_READ_MODEL_KEYS = new Set([
  'readModelVersion',
  'generatedAt',
  'readModelId',
  'registry',
  'window',
  'quality',
  'records',
  'available',
  'selection',
]);

const NOT_COLLECTED = 'not-collected';

const UNREAD_QUOTA = Object.freeze({
  deploymentName: null,
  skuName: null,
  capacity: null,
  requestsPerMinute: null,
  tokensPerMinute: null,
  pool: null,
  source: NOT_COLLECTED,
});

function quotaSnapshotState(snapshot, evaluationTime) {
  if (snapshot === null || typeof snapshot !== 'object') return 'unavailable';
  if (snapshot.status !== 'complete') return 'unavailable';
  if (Date.parse(snapshot.expiresAt) <= Date.parse(evaluationTime)) return 'expired';
  return 'complete';
}

/**
 * How much of the subscription's allocatable quota for this model and SKU has been
 * handed out to deployments. This is capacity that exists, not capacity that was
 * used: the figure moves when a deployment is created or resized, never when a
 * request is served. Actual token consumption is the separate `consumption` field,
 * and conflating the two turns "no room for another deployment" into "out of
 * tokens", which are opposite operational problems.
 */
function projectPool(pool) {
  if (pool === null) return null;
  return {
    allocated: pool.allocated,
    limit: pool.limit,
    allocatable: pool.limit - pool.allocated,
    unit: pool.unit,
    matchQuality: pool.matchQuality,
    fullyAllocated: pool.allocated >= pool.limit,
  };
}

function projectProviderQuota({ descriptor, snapshot, snapshotState }) {
  if (descriptor === null || descriptor.providerDeploymentName === undefined) {
    return { ...UNREAD_QUOTA, reasonCode: 'deployment-not-declared' };
  }
  if (snapshotState !== 'complete') {
    return {
      ...UNREAD_QUOTA,
      reasonCode: snapshotState === 'expired' ? 'quota-snapshot-expired' : 'quota-snapshot-unavailable',
    };
  }
  const deployment = snapshot.deployments.find(
    (candidate) => candidate.deploymentName === descriptor.providerDeploymentName,
  );
  if (deployment === undefined) {
    return { ...UNREAD_QUOTA, reasonCode: 'deployment-not-found' };
  }
  return {
    deploymentName: deployment.deploymentName,
    skuName: deployment.skuName,
    capacity: deployment.capacity,
    requestsPerMinute: deployment.requestsPerMinute,
    tokensPerMinute: deployment.tokensPerMinute,
    pool: projectPool(deployment.pool),
    source: 'provider-deployment',
    reasonCode: deployment.poolReasonCode,
  };
}

function projectAvailable({ providerQuota, quotaState, registry, catalogueAvailable }) {
  // Both halves are needed to subtract one from the other. Without the catalogue every
  // deployment would read as ungoverned, which is the most misleading answer available.
  if (quotaState !== 'complete' || !catalogueAvailable) return [];

  const governed = new Set(
    registry.models
      .map((model) => model.providerDeploymentName)
      .filter((name) => typeof name === 'string'),
  );
  return providerQuota.deployments
    .filter((deployment) => !governed.has(deployment.deploymentName))
    .map((deployment) => ({
      deploymentName: deployment.deploymentName,
      modelName: deployment.modelName,
      modelVersion: deployment.modelVersion,
      modelFormat: deployment.modelFormat,
      skuName: deployment.skuName,
      apiFamilies: [
        ...(deployment.capabilities.chatCompletion ? ['openai-chat-completions'] : []),
        ...(deployment.capabilities.responses ? ['openai-responses'] : []),
      ],
      capacity: deployment.capacity,
      requestsPerMinute: deployment.requestsPerMinute,
      tokensPerMinute: deployment.tokensPerMinute,
    }));
}

// Internal rate limits belong to an entitlement binding, not to a model, so a single
// number here would be false for most callers. The range and the count of bindings
// that grant the model are both true, and together they say why it is a range.
function summariseInternalLimits(bindings) {
  if (bindings.length === 0) return null;
  const rates = bindings.map((binding) => binding.limits.requestsPerMinute);
  const tokens = bindings.map((binding) => binding.limits.tokensPerMinute);
  return {
    grantingBindings: bindings.length,
    requestsPerMinute: { min: Math.min(...rates), max: Math.max(...rates) },
    tokensPerMinute: { min: Math.min(...tokens), max: Math.max(...tokens) },
  };
}

function projectDescriptor(descriptor) {
  return {
    registrationState: 'registered',
    providerCode: descriptor.providerKey,
    providerDeploymentName: descriptor.providerDeploymentName ?? null,
    lifecycle: descriptor.lifecycle,
    apiFamilies: [...descriptor.apiFamilies],
    safetyPolicy: descriptor.safetyPolicy,
  };
}

const AGREEMENT_FIELDS = Object.freeze([
  ['providerKey', 'provider-code'],
  ['providerDeploymentName', 'deployment-name'],
  ['apiFamilies', 'api-families'],
  ['lifecycle', 'lifecycle'],
  ['safetyPolicy', 'safety-policy'],
]);

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function projectProviderAgreement({ descriptor, snapshot, snapshotState }) {
  if (descriptor === null || descriptor.providerDeploymentName === undefined) {
    return { state: 'unverified', reasonCode: 'deployment-not-declared', changedFields: [] };
  }
  if (snapshotState !== 'complete') {
    return {
      state: 'unverified',
      reasonCode: snapshotState === 'expired' ? 'quota-snapshot-expired' : 'quota-snapshot-unavailable',
      changedFields: [],
    };
  }
  const deployment = snapshot.deployments.find(
    (candidate) => candidate.deploymentName === descriptor.providerDeploymentName,
  );
  if (deployment === undefined) {
    return { state: 'deployment-absent', reasonCode: 'deployment-not-found', changedFields: [] };
  }

  let recaptured;
  try {
    recaptured = captureModel({ deployment, modelKey: descriptor.modelKey });
  } catch {
    return { state: 'diverged', reasonCode: 'provider-descriptor-unusable', changedFields: ['api-families'] };
  }
  const changedFields = AGREEMENT_FIELDS
    .filter(([field]) => !sameValue(descriptor[field], recaptured[field]))
    .map(([, code]) => code);
  return changedFields.length === 0
    ? { state: 'agrees', reasonCode: null, changedFields: [] }
    : { state: 'diverged', reasonCode: 'provider-descriptor-diverged', changedFields };
}

/** A model that served traffic but is absent from the registry is still a row. */
const UNREGISTERED = Object.freeze({
  registrationState: 'unregistered',
  providerCode: null,
  providerDeploymentName: null,
  lifecycle: null,
  apiFamilies: [],
  safetyPolicy: null,
});

function projectConsumption(bucket) {
  const { byModel: _byModel, ...sealed } = sealUsageBucket(bucket);
  return sealed;
}

function registryState(registry, evaluationTime) {
  if (registry === null || typeof registry !== 'object') return 'unavailable';
  if (registry.status !== 'complete') return 'unavailable';
  const remainingSeconds = (Date.parse(registry.expiresAt) - Date.parse(evaluationTime)) / 1000;
  if (remainingSeconds <= 0) return 'expired';
  if (remainingSeconds <= REGISTRY_EXPIRY_WARNING_SECONDS) return 'expiring';
  return 'complete';
}

export function projectModels({
  authorization,
  registry,
  entitlementSnapshot,
  records,
  window,
  selection,
  viewer = null,
  providerQuota = null,
}) {
  assertAuthorizedReadScope({
    authorization,
    scope: selection.scope,
    teamKey: selection.teamKey,
  });
  if (!Array.isArray(records)) throw new TypeError('records must be an array.');

  const completenessState = window?.completeness?.state;
  if (!['complete', 'partial', 'degraded'].includes(completenessState)) {
    throw new TypeError('window.completeness.state is unsupported.');
  }
  const countsMeasured = completenessState !== 'degraded';
  const freshness = projectWindowFreshness(window.freshness);
  const state = registryState(registry, selection.generatedAt);
  const catalogueAvailable = state === 'complete' || state === 'expiring' || state === 'expired';
  const quotaState = quotaSnapshotState(providerQuota, selection.generatedAt);

  const buckets = new Map();
  if (countsMeasured) {
    for (const record of selectVisibleUsageRecords({ records, selection, viewer })) {
      const key = record.effective.modelKey;
      if (!buckets.has(key)) buckets.set(key, newUsageBucket());
      accumulateUsage(buckets.get(key), record);
    }
  }

  const grantingBindings = new Map();
  for (const binding of catalogueAvailable ? entitlementSnapshot?.bindings ?? [] : []) {
    if (binding.state !== 'active') continue;
    for (const modelKey of binding.modelAllowlist) {
      if (!grantingBindings.has(modelKey)) grantingBindings.set(modelKey, []);
      grantingBindings.get(modelKey).push(binding);
    }
  }

  const modelKeys = new Set([
    ...(catalogueAvailable ? registry.models.map((model) => model.modelKey) : []),
    ...buckets.keys(),
  ]);

  const projected = [...modelKeys].sort((left, right) => left.localeCompare(right)).map((modelKey) => {
    const descriptor = catalogueAvailable
      ? registry.models.find((model) => model.modelKey === modelKey) ?? null
      : null;
    const bucket = buckets.get(modelKey);
    return {
      modelKey,
      ...(descriptor === null ? UNREGISTERED : projectDescriptor(descriptor)),
      internalLimits: summariseInternalLimits(grantingBindings.get(modelKey) ?? []),
      providerQuota: projectProviderQuota({
        descriptor,
        snapshot: providerQuota,
        snapshotState: quotaState,
      }),
      providerAgreement: projectProviderAgreement({
        descriptor,
        snapshot: providerQuota,
        snapshotState: quotaState,
      }),
      consumption: bucket === undefined ? null : projectConsumption(bucket),
    };
  });

  const readModel = {
    readModelVersion: 'models.v1',
    generatedAt: selection.generatedAt,
    readModelId: `models-${selection.scope}-${selection.teamKey ?? 'none'}`,
    registry: {
      state,
      version: catalogueAvailable ? registry.version : null,
      capturedAt: catalogueAvailable ? registry.capturedAt : null,
      expiresAt: catalogueAvailable ? registry.expiresAt : null,
      sourceRevision: catalogueAvailable ? registry.sourceRevision : null,
    },
    window: {
      windowStart: window.windowStart,
      windowEnd: window.windowEnd,
      asOf: window.asOf,
      completenessState,
      completenessReason: window.completeness.reason ?? null,
      reportedAt: freshness.reportedAt,
      lagSeconds: freshness.lagSeconds,
    },
    quality: {
      state: completenessState,
      freshnessState: freshness.state,
      countsMeasured,
      catalogueState: state,
      providerQuotaState: quotaState,
      providerQuotaCapturedAt: quotaState === 'unavailable' ? null : providerQuota.capturedAt,
      reasonCode: countsMeasured ? null : window.completeness.reason ?? 'window-not-observed',
    },
    records: projected,
    // Deployments the provider serves that governance does not carry yet. A model with
    // no traffic has no usage row and no registry entry, so without this the one thing
    // an administrator wants to add is the one thing the screen cannot show.
    available: projectAvailable({ providerQuota, quotaState, registry, catalogueAvailable }),
    selection: {
      scope: selection.scope,
      teamKey: selection.scope === 'team' ? selection.teamKey : null,
    },
  };

  assertBodyFreeReadModel(readModel, SAFE_READ_MODEL_KEYS);
  return readModel;
}
