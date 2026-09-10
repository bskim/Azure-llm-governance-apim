const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
// Deliberately narrower than a safe identifier: the effective policy document
// rejects the colon, so a composite key would validate here and fail at composition.
const MODEL_ALIAS = /^[A-Za-z0-9._-]{1,64}$/;
const CURRENCY = /^[A-Z]{3}$/;
const REGION_KEY = /^[a-z][a-z0-9-]{1,62}$/;
const FORBIDDEN_VALUE = /(https?:\/\/|bearer\s|api-key|sk-[A-Za-z0-9]{8})/i;

const SNAPSHOT_STATUSES = new Set([
  'complete',
  'incomplete',
  'stale',
  'ambiguous',
  'source-unavailable',
]);

// Closed on purpose. An open string would let two spellings of one provider pass the
// equality comparison that keeps a downgrade from silently changing wire protocol.
export const PROVIDER_KEYS = Object.freeze([
  'azure-openai',
  'anthropic',
  'meta',
  'mistral',
  'cohere',
  'other',
]);

export const API_FAMILIES = Object.freeze([
  'anthropic-messages',
  'openai-chat-completions',
  'openai-responses',
]);

export const LIFECYCLE_STATES = Object.freeze([
  'preview',
  'generally-available',
  'deprecated',
  'retired',
]);

// The provider attaches a named content-safety policy to a deployment. It is a name,
// The provider attaches a named content-safety policy to a deployment. It is shown
// rather than enforced: the operator chose it when they deployed the model.
export const SAFETY_POLICY = /^[A-Za-z0-9._-]{1,128}$/;

export const ATTRIBUTION_QUALITIES = Object.freeze(['strong', 'generic']);

const MAX_MODELS = 256;
const MAX_APPLICATIONS = 256;
const MAX_REGION_KEYS = 32;

function fail(message) {
  throw new TypeError(message);
}

function assertRecord(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${path} must be an object.`);
  }
}

function assertExactKeys(value, required, optional, path) {
  assertRecord(value, path);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(`${path}.${key} is required.`);
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path}.${key} is not allowed.`);
  }
}

function assertSafeId(value, path) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    fail(`${path} must be a bounded safe identifier.`);
  }
}

function assertBoundedText(value, path) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    fail(`${path} must be text of at most 256 characters.`);
  }
}

function assertModelAlias(value, path) {
  if (typeof value !== 'string' || !MODEL_ALIAS.test(value)) {
    fail(`${path} must be a bounded model alias.`);
  }
}

function assertPositiveInteger(value, path, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail(`${path} must be a whole number between 1 and ${maximum}.`);
  }
}

function assertNonnegativeInteger(value, path, maximum) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    fail(`${path} must be a whole number between 0 and ${maximum}.`);
  }
}

function assertEnum(value, allowed, path) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    fail(`${path} must be one of: ${allowed.join(', ')}.`);
  }
}

function assertBoolean(value, path) {
  if (typeof value !== 'boolean') fail(`${path} must be a boolean.`);
}

function parseTime(value, path) {
  if (typeof value !== 'string') fail(`${path} must be an RFC 3339 timestamp.`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) fail(`${path} must be an RFC 3339 timestamp.`);
  return timestamp;
}

function assertSortedUnique(values, path) {
  if (new Set(values).size !== values.length) fail(`${path} contains duplicate entries.`);
  const sorted = [...values].sort((left, right) => left.localeCompare(right));
  if (values.some((value, index) => value !== sorted[index])) fail(`${path} must be sorted.`);
}

function assertNoForbiddenValues(node, path) {
  if (typeof node === 'string') {
    if (FORBIDDEN_VALUE.test(node)) fail(`${path} must not contain a URL or credential value.`);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, index) => assertNoForbiddenValues(item, `${path}[${index}]`));
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      assertNoForbiddenValues(value, `${path}.${key}`);
    }
  }
}

function assertModelDescriptor(descriptor, path) {
  assertExactKeys(
    descriptor,
    ['modelKey', 'providerKey', 'apiFamilies', 'lifecycle', 'safetyPolicy'],
    ['providerDeploymentName'],
    path,
  );
  assertModelAlias(descriptor.modelKey, `${path}.modelKey`);
  assertEnum(descriptor.providerKey, PROVIDER_KEYS, `${path}.providerKey`);
  // The alias the product routes on and the deployment the provider bills are not
  // the same name, so a quota reading can only be attached to a model that says
  // which deployment it is. Without it the join would be a guess.
  if (descriptor.providerDeploymentName !== undefined) {
    assertSafeId(descriptor.providerDeploymentName, `${path}.providerDeploymentName`);
  }

  if (!Array.isArray(descriptor.apiFamilies) || descriptor.apiFamilies.length === 0) {
    fail(`${path}.apiFamilies must list at least one wire contract.`);
  }
  descriptor.apiFamilies.forEach((family, index) => {
    assertEnum(family, API_FAMILIES, `${path}.apiFamilies[${index}]`);
  });
  assertSortedUnique(descriptor.apiFamilies, `${path}.apiFamilies`);

  assertEnum(descriptor.lifecycle, LIFECYCLE_STATES, `${path}.lifecycle`);
  if (
    descriptor.safetyPolicy !== null &&
    (typeof descriptor.safetyPolicy !== 'string' || !SAFETY_POLICY.test(descriptor.safetyPolicy))
  ) {
    fail(`${path}.safetyPolicy must name the attached content-safety policy, or be null.`);
  }
}

function assertApplicationDescriptor(descriptor, path) {
  assertExactKeys(descriptor, ['applicationId', 'attributionQuality', 'displayCode'], [], path);
  assertSafeId(descriptor.applicationId, `${path}.applicationId`);
  assertEnum(descriptor.attributionQuality, ATTRIBUTION_QUALITIES, `${path}.attributionQuality`);
  assertSafeId(descriptor.displayCode, `${path}.displayCode`);
}

function freezeModel(descriptor) {
  return Object.freeze({
    ...descriptor,
    apiFamilies: Object.freeze([...descriptor.apiFamilies]),
  });
}

/**
 * Validates a model catalogue snapshot and returns a frozen copy.
 *
 * Provider identity and application-attribution quality are required here rather
 * than derived later, because both are equality classes: a later slice that had to
 * infer them would have to guess, and a wrong guess is a silent protocol or
 * attribution change rather than a visible error.
 */
export function assertModelRegistrySnapshotV1(snapshot, { evaluationTime, principalTenantId } = {}) {
  assertExactKeys(
    snapshot,
    [
      'contractVersion',
      'snapshotId',
      'tenantId',
      'version',
      'status',
      'capturedAt',
      'expiresAt',
      'sourceRevision',
      'models',
      'applications',
    ],
    ['reason'],
    'modelRegistry',
  );

  if (snapshot.contractVersion !== 'v1') fail('modelRegistry.contractVersion must be v1.');
  for (const key of ['snapshotId', 'tenantId', 'sourceRevision']) {
    assertSafeId(snapshot[key], `modelRegistry.${key}`);
  }
  assertPositiveInteger(snapshot.version, 'modelRegistry.version', Number.MAX_SAFE_INTEGER);
  if (!SNAPSHOT_STATUSES.has(snapshot.status)) fail('modelRegistry.status is unsupported.');

  const capturedAt = parseTime(snapshot.capturedAt, 'modelRegistry.capturedAt');
  const expiresAt = parseTime(snapshot.expiresAt, 'modelRegistry.expiresAt');
  const now = parseTime(evaluationTime, 'evaluationTime');
  if (capturedAt > now) throw new RangeError('modelRegistry cannot be captured in the future.');
  if (capturedAt >= expiresAt) throw new RangeError('modelRegistry capture must precede expiry.');
  if (expiresAt <= now) throw new RangeError('modelRegistry has expired and carries no authority.');

  if (typeof principalTenantId === 'string' && snapshot.tenantId !== principalTenantId) {
    fail('modelRegistry.tenantId does not match the calling tenant.');
  }

  if (!Array.isArray(snapshot.models)) fail('modelRegistry.models must be an array.');
  if (!Array.isArray(snapshot.applications)) fail('modelRegistry.applications must be an array.');

  if (snapshot.status !== 'complete') {
    if (typeof snapshot.reason !== 'string' || snapshot.reason.length === 0) {
      fail('modelRegistry degraded status requires a reason.');
    }
    assertBoundedText(snapshot.reason, 'modelRegistry.reason');
    // A partially loaded catalogue is the dangerous case: the attribute that failed
    // to load is exactly the one that would have blocked an unsafe comparison.
    if (snapshot.models.length !== 0 || snapshot.applications.length !== 0) {
      fail('modelRegistry degraded status cannot carry catalogue records.');
    }
  } else if (Object.hasOwn(snapshot, 'reason')) {
    assertBoundedText(snapshot.reason, 'modelRegistry.reason');
  }

  if (snapshot.models.length > MAX_MODELS) fail(`modelRegistry.models exceeds ${MAX_MODELS} entries.`);
  if (snapshot.applications.length > MAX_APPLICATIONS) {
    fail(`modelRegistry.applications exceeds ${MAX_APPLICATIONS} entries.`);
  }

  snapshot.models.forEach((descriptor, index) => {
    assertModelDescriptor(descriptor, `modelRegistry.models[${index}]`);
  });
  assertSortedUnique(
    snapshot.models.map((descriptor) => descriptor.modelKey),
    'modelRegistry.models',
  );

  snapshot.applications.forEach((descriptor, index) => {
    assertApplicationDescriptor(descriptor, `modelRegistry.applications[${index}]`);
  });
  assertSortedUnique(
    snapshot.applications.map((descriptor) => descriptor.applicationId),
    'modelRegistry.applications',
  );

  assertNoForbiddenValues(snapshot, 'modelRegistry');

  return Object.freeze({
    ...snapshot,
    models: Object.freeze(snapshot.models.map(freezeModel)),
    applications: Object.freeze(snapshot.applications.map((entry) => Object.freeze({ ...entry }))),
  });
}

export function resolveModelDescriptor(registry, modelKey) {
  assertRecord(registry, 'registry');
  return registry.models.find((descriptor) => descriptor.modelKey === modelKey) ?? null;
}

/**
 * An application present in the caller context but absent from the catalogue stays
 * unavailable. Defaulting it to `generic` would hand an unreviewed client an
 * attribution label, and every downstream record would then look deliberate.
 */
export function resolveApplicationAttribution(registry, applicationId) {
  assertRecord(registry, 'registry');
  const descriptor = registry.applications.find((entry) => entry.applicationId === applicationId);
  if (descriptor === undefined) {
    return Object.freeze({ quality: null, displayCode: null, reasonCode: 'application-unregistered' });
  }
  return Object.freeze({
    quality: descriptor.attributionQuality,
    displayCode: descriptor.displayCode,
    reasonCode: 'application-registered',
  });
}
