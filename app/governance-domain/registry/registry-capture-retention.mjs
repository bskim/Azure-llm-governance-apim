/**
 * How long a captured model registry remains part of a published governance set.
 *
 * The registry contains deployment identity and wire-contract descriptors. Provider
 * quota and rate observations are read live and are not retained here. This window is
 * therefore a liveness contract on governance publication, not a cache of provider
 * consumption. Expiry still refuses policy resolution rather than serving stale data.
 */
export const REGISTRY_CAPTURE_RETENTION_SECONDS = 30 * 24 * 3600;
export const REGISTRY_EXPIRY_WARNING_SECONDS = 7 * 24 * 3600;