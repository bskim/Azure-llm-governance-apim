import { PROVIDER_KEYS, assertModelRegistrySnapshotV1 } from './model-registry-validator.mjs';
import { REGISTRY_CAPTURE_RETENTION_SECONDS } from './registry-capture-retention.mjs';

/**
 * Brings one already-deployed provider model into the registry, and produces the
 * next whole registry snapshot with it added or removed.
 *
 * The registry is captured provider evidence, never a typed edit: nobody hand-types
 * a model descriptor, they capture what a Foundry deployment already is. But an ARM
 * deployment (`Microsoft.CognitiveServices/accounts/deployments`) only ever states
 * deployment name, model name, model format (the publisher), model version,
 * `sku.name`/`sku.capacity`, rate limits, the wire contracts it advertises, and the
 * Responsible AI policy attached to it. Everything the registry keeps is taken from
 * that reading, so bringing a model into governance needs no facts typed by hand.
 *
 * Maturity is the one derived value. The provider does not report it, but it names
 * its own preview deployments, so the label follows the name the publisher chose. It
 * is a label and not a gate: an administrator who deployed a model and pointed a
 * downgrade at it has already decided to use it.
 *
 * The one thing this module DOES infer rather than require is `apiFamilies`. Only 7
 * of this account's 14 deployments advertise Responses, so the wire contracts a model
 * serves are read from the deployment rather than assumed from the shared backend.
 *
 * A change producing the next whole snapshot follows `budget-edit.mjs` and
 * `entitlement-edit.mjs`: the snapshot's own validator decides what a model may say,
 * never restated here, and an edit that fails validation is refused by a typed error
 * rather than published invalid.
 */

const REASON_CODE = /^[a-z][a-z0-9-]{2,63}$/;
const MODEL_KEY_OVERRIDE = /^[A-Za-z0-9._-]{1,64}$/;

// The provider states `chatCompletion` and `responses` per deployment, and only 7 of
// this account's 14 advertise Responses, so the wire contracts a model serves are
// read from the deployment rather than assumed from the backend it sits behind.
const CAPABILITY_TO_API_FAMILY = Object.freeze({
  chatCompletion: 'openai-chat-completions',
  responses: 'openai-responses',
});

// ARM's `properties.model.format` names the publisher in whatever casing and
// spelling that publisher chose (observed: `OpenAI`, `xAI`, `DeepSeek`,
// `MoonshotAI`, `Fireworks`). Only the publishers this registry's closed
// `PROVIDER_KEYS` enum already names are mapped; everything else is `other`,
// which is exactly what that enum value exists for.
const FORMAT_TO_PROVIDER_KEY = Object.freeze({
  openai: 'azure-openai',
  anthropic: 'anthropic',
  meta: 'meta',
  metallama: 'meta',
  mistralai: 'mistral',
  mistral: 'mistral',
  cohere: 'cohere',
});

for (const providerKey of Object.values(FORMAT_TO_PROVIDER_KEY)) {
  if (!PROVIDER_KEYS.includes(providerKey)) {
    throw new TypeError(`model-capture.mjs maps a format to an unknown provider key: ${providerKey}.`);
  }
}

export const MODEL_CAPTURE_REASONS = Object.freeze({
  duplicateModel: 'model-capture-duplicate-model',
  modelUnknown: 'model-capture-model-unknown',
  lastModel: 'model-capture-last-model',
  modelEntitled: 'model-capture-model-entitled',
  reasonRequired: 'model-capture-reason-required',
  resultInvalid: 'model-capture-result-invalid',
  noApiFamily: 'model-capture-no-api-family',
  recaptureDeploymentAbsent: 'model-capture-recapture-deployment-absent',
});

export class ModelCaptureRefusedError extends Error {
  constructor(reasonCode, detail = null) {
    super(`The model capture was refused: ${reasonCode}.`);
    this.name = 'ModelCaptureRefusedError';
    this.code = reasonCode;
    this.detail = detail;
  }
}

function refuse(reasonCode, detail) {
  throw new ModelCaptureRefusedError(reasonCode, detail);
}

function mapProviderKey(modelFormat) {
  const normalised = modelFormat.toLowerCase().replaceAll(/[^a-z]/g, '');
  return FORMAT_TO_PROVIDER_KEY[normalised] ?? 'other';
}

function captureApiFamilies(capabilities) {
  const families = Object.entries(CAPABILITY_TO_API_FAMILY)
    .filter(([flag]) => capabilities?.[flag] === true)
    .map(([, family]) => family)
    .sort();
  if (families.length === 0) {
    refuse(MODEL_CAPTURE_REASONS.noApiFamily, 'The deployment advertises no wire contract this gateway serves.');
  }
  return families;
}

// A label, not a gate. The publisher marks its own preview deployments in the name it
// gives them, and nothing else it reports distinguishes maturity from health.
function captureLifecycle({ modelName, modelVersion }) {
  const marked = [modelName, modelVersion ?? ''].some((value) => /preview/i.test(value));
  return marked ? 'preview' : 'generally-available';
}

/**
 * @param deployment - the ARM facts: `{deploymentName, modelName, modelFormat}`.
 *   Nothing else ARM carries belongs on the registry entry (capacity and rate
 *   limits are provider-quota evidence, a separate document).
 * @param modelKey - the alias the product routes on. Defaults to the deployment
 *   name itself, matching how every model already in this registry's production
 *   set is keyed directly by its deployment name.
 */
export function captureModel({ deployment, modelKey }) {
  if (deployment === null || typeof deployment !== 'object' || Array.isArray(deployment)) {
    throw new TypeError('deployment must be an object.');
  }
  for (const field of ['deploymentName', 'modelName', 'modelFormat']) {
    if (typeof deployment[field] !== 'string' || deployment[field].length === 0) {
      throw new TypeError(`deployment.${field} is required.`);
    }
  }
  if (modelKey !== undefined && (typeof modelKey !== 'string' || !MODEL_KEY_OVERRIDE.test(modelKey))) {
    throw new TypeError('modelKey, when supplied, must be a bounded model alias.');
  }

  return {
    modelKey: modelKey ?? deployment.deploymentName,
    providerKey: mapProviderKey(deployment.modelFormat),
    providerDeploymentName: deployment.deploymentName,
    apiFamilies: captureApiFamilies(deployment.capabilities),
    lifecycle: captureLifecycle(deployment),
    safetyPolicy: deployment.raiPolicyName ?? null,
  };
}

function nextSnapshot(snapshot, models, at, retentionSeconds) {
  const next = {
    ...snapshot,
    version: snapshot.version + 1,
    capturedAt: at,
    expiresAt: new Date(Date.parse(at) + retentionSeconds * 1000).toISOString(),
    // The validator requires the entries sorted and unique by identifier, so an
    // added model takes its place in the order rather than being appended.
    models: [...models].sort((left, right) => left.modelKey.localeCompare(right.modelKey)),
  };
  try {
    assertModelRegistrySnapshotV1(next, { evaluationTime: at });
  } catch (error) {
    refuse(MODEL_CAPTURE_REASONS.resultInvalid, error.message);
  }
  return next;
}

/** Adds one captured model, expressed as the next whole registry snapshot. */
export function addModel({ snapshot, model, at, retentionSeconds = REGISTRY_CAPTURE_RETENTION_SECONDS }) {
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) {
    throw new TypeError('at must be an ISO-8601 instant.');
  }
  if (model === null || typeof model !== 'object' || Array.isArray(model)) {
    throw new TypeError('model must be an object.');
  }
  if (snapshot.models.some((entry) => entry.modelKey === model.modelKey)) {
    refuse(MODEL_CAPTURE_REASONS.duplicateModel, model.modelKey);
  }

  return nextSnapshot(snapshot, [...snapshot.models, model], at, retentionSeconds);
}

/** Refreshes every registered descriptor from the provider's current deployment rows. */
export function recaptureModels({ snapshot, deployments, at, retentionSeconds = REGISTRY_CAPTURE_RETENTION_SECONDS }) {
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) {
    throw new TypeError('at must be an ISO-8601 instant.');
  }
  if (!Array.isArray(deployments)) throw new TypeError('deployments must be an array.');
  const byName = new Map(deployments.map((deployment) => [deployment.deploymentName, deployment]));
  const models = snapshot.models.map((model) => {
    const deployment = byName.get(model.providerDeploymentName);
    if (deployment === undefined) {
      refuse(MODEL_CAPTURE_REASONS.recaptureDeploymentAbsent, model.modelKey);
    }
    return captureModel({ deployment, modelKey: model.modelKey });
  });
  return nextSnapshot(snapshot, models, at, retentionSeconds);
}

/**
 * Removes a model, expressed as the next whole registry snapshot without it.
 *
 * @param entitlementSnapshot - the current entitlement policy snapshot, checked so
 *   a model an entitlement still allows is not silently removed out from under it.
 *   Required, may be `null` when unavailable (the check is then skipped, the same
 *   convention `editEntitlementBinding`'s `registry` argument uses); omitting the
 *   argument entirely throws, because that is "never looked" rather than "looked
 *   and it was unavailable".
 */
export function removeModel({ snapshot, modelKey, reasonCode, entitlementSnapshot, at, retentionSeconds = REGISTRY_CAPTURE_RETENTION_SECONDS }) {
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) {
    throw new TypeError('at must be an ISO-8601 instant.');
  }
  if (entitlementSnapshot === undefined) {
    throw new TypeError('entitlementSnapshot must be supplied, or supplied as null when unavailable.');
  }
  if (typeof reasonCode !== 'string' || !REASON_CODE.test(reasonCode)) {
    refuse(MODEL_CAPTURE_REASONS.reasonRequired);
  }
  if (!snapshot.models.some((entry) => entry.modelKey === modelKey)) {
    refuse(MODEL_CAPTURE_REASONS.modelUnknown, modelKey);
  }
  // Removing the last model would produce a registry nothing could ever be
  // entitled against -- refused by name rather than published as an empty set,
  // the same posture `entitlement-edit.mjs` takes on an empty allowlist.
  if (snapshot.models.length === 1) {
    refuse(MODEL_CAPTURE_REASONS.lastModel, modelKey);
  }
  if (entitlementSnapshot !== null) {
    const stillAllowedBy = entitlementSnapshot.bindings
      .filter((binding) => Array.isArray(binding.modelAllowlist) && binding.modelAllowlist.includes(modelKey))
      .map((binding) => binding.bindingId);
    if (stillAllowedBy.length > 0) refuse(MODEL_CAPTURE_REASONS.modelEntitled, stillAllowedBy);
  }

  return nextSnapshot(
    snapshot,
    snapshot.models.filter((entry) => entry.modelKey !== modelKey),
    at,
    retentionSeconds,
  );
}
