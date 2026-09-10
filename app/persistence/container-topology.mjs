const CONTAINER_ID = /^[a-z][a-z0-9-]{1,62}$/;
const PARTITION_KEY_PATH = /^\/[A-Za-z][A-Za-z0-9]{0,62}$/;
const MAX_HIERARCHICAL_PARTITION_KEY_PATHS = 3;

export const DEPLOYMENT_PROFILES = Object.freeze(['always', 'event-stream']);

/**
 * Declares the container set. `event-stream` containers exist only in the escalation
 * profile described in ADR-0005; the default profile never writes to them.
 */
export const CONTAINER_TOPOLOGY = Object.freeze([
  Object.freeze({
    id: 'governance',
    partitionKeyPaths: Object.freeze(['/scopeGroupId']),
    profile: 'always',
    provisionedBy: 'infrastructure',
    createdAtRuntime: false,
    defaultTimeToLiveSeconds: null,
    writtenBy: Object.freeze(['control-api']),
    purpose: 'Configuration, effective policy documents, publication lifecycle state, and the usage records, notifications, directory readings, and schedule checkpoints the default profile keeps here.',
  }),
  Object.freeze({
    id: 'rollups',
    partitionKeyPaths: Object.freeze(['/scopeGroupId']),
    profile: 'always',
    provisionedBy: 'infrastructure',
    createdAtRuntime: false,
    defaultTimeToLiveSeconds: null,
    writtenBy: Object.freeze(['rollup-projector']),
    purpose: 'Pre-aggregated usage views carrying their own freshness and completeness.',
  }),
  Object.freeze({
    id: 'events',
    partitionKeyPaths: Object.freeze(['/scopeGroupId', '/dateBucket']),
    profile: 'event-stream',
    provisionedBy: 'infrastructure',
    createdAtRuntime: false,
    defaultTimeToLiveSeconds: 34560000,
    writtenBy: Object.freeze(['ingestion-consumer']),
    // Not where usage records live today. The default profile writes them to the
    // governance container; this one belongs to the escalation profile, whose
    // consumer is not built, and naming it as their home read as if it were.
    purpose: 'Append-only body-free usage records for the escalation profile, retained by time to live.',
  }),
  Object.freeze({
    id: 'leases',
    partitionKeyPaths: Object.freeze(['/id']),
    profile: 'event-stream',
    provisionedBy: 'infrastructure',
    createdAtRuntime: false,
    defaultTimeToLiveSeconds: null,
    writtenBy: Object.freeze(['change-feed-processor']),
    purpose: 'Change feed processor leases.',
  }),
]);

export function containersForProfile(profile) {
  if (!DEPLOYMENT_PROFILES.includes(profile)) {
    throw new TypeError(`Unknown deployment profile: ${profile}`);
  }
  return CONTAINER_TOPOLOGY.filter(
    (container) => container.profile === 'always' || container.profile === profile,
  );
}

export function assertContainerTopology(topology = CONTAINER_TOPOLOGY) {
  if (!Array.isArray(topology) || topology.length === 0) {
    throw new TypeError('topology must be a non-empty array.');
  }

  const seen = new Set();
  for (const container of topology) {
    if (container === null || typeof container !== 'object' || Array.isArray(container)) {
      throw new TypeError('topology entries must be objects.');
    }

    const { id, partitionKeyPaths, profile, createdAtRuntime, defaultTimeToLiveSeconds } = container;

    if (typeof id !== 'string' || !CONTAINER_ID.test(id)) {
      throw new TypeError(`Container id is not a bounded lowercase identifier: ${String(id)}`);
    }
    if (seen.has(id)) throw new TypeError(`Duplicate container id: ${id}`);
    seen.add(id);

    if (!DEPLOYMENT_PROFILES.includes(profile)) {
      throw new TypeError(`${id} declares an unknown deployment profile.`);
    }

    if (!Array.isArray(partitionKeyPaths) || partitionKeyPaths.length === 0) {
      throw new TypeError(`${id} must declare at least one partition key path.`);
    }
    if (partitionKeyPaths.length > MAX_HIERARCHICAL_PARTITION_KEY_PATHS) {
      throw new TypeError(`${id} exceeds the hierarchical partition key depth limit.`);
    }
    const paths = new Set();
    for (const path of partitionKeyPaths) {
      if (typeof path !== 'string' || !PARTITION_KEY_PATH.test(path)) {
        throw new TypeError(`${id} declares an invalid partition key path: ${String(path)}`);
      }
      if (paths.has(path)) throw new TypeError(`${id} repeats partition key path ${path}.`);
      paths.add(path);
    }

    // Creating containers is not an allowed data-plane operation for a managed identity,
    // so every container must exist before the application starts.
    if (createdAtRuntime !== false) {
      throw new TypeError(`${id} must not be created at runtime.`);
    }
    if (container.provisionedBy !== 'infrastructure') {
      throw new TypeError(`${id} must be provisioned by infrastructure code.`);
    }

    if (defaultTimeToLiveSeconds !== null) {
      if (!Number.isSafeInteger(defaultTimeToLiveSeconds) || defaultTimeToLiveSeconds < 1) {
        throw new TypeError(`${id} declares an invalid default time to live.`);
      }
    }

    if (!Array.isArray(container.writtenBy) || container.writtenBy.length === 0) {
      throw new TypeError(`${id} must declare at least one writer.`);
    }
  }

  return true;
}
