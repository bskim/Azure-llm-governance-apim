/**
 * Where notifications are sent, chosen by an administrator rather than by whoever
 * deployed the app.
 *
 * The endpoint is a bearer secret — Slack says so outright, and a Teams workflow URL
 * carries its signature in the query — so it is stored on its own rather than in the
 * published governance set, which is projected into read models, audit records and
 * exports. Only the host is safe to show, and only the host is ever returned.
 */

const SAFE_CODE = /^[a-z][a-z0-9-]{2,63}$/;
const KINDS = new Set(['teams', 'slack']);
const MAX_ENDPOINT_LENGTH = 2048;

// A hostname that resolves inside the deployment's own network turns an administrator
// field into a request the gateway's identity can make on their behalf. Names are
// refused by shape here; a literal address is refused outright.
const IP_LITERAL = /^\[?[0-9a-f.:]+\]?$/i;
const LOOPBACK_OR_INTERNAL = /(^|\.)(localhost|local|internal|home\.arpa)$/i;

function fail(message) {
  throw new TypeError(message);
}

/** Carries which rule refused, so a caller can say so without repeating the value. */
function refuse(reasonCode, message) {
  throw Object.assign(new TypeError(message), { reasonCode });
}

function assertPrivateAddress(hostname) {
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (!IP_LITERAL.test(bare)) return;
  // An address rather than a name: there is no legitimate channel at one, and the
  // ranges that matter are exactly the ones a name would have had to resolve to.
  fail('endpoint must name a host rather than an address.');
}

export function assertChannelEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length === 0) fail('endpoint is required.');
  if (endpoint.length > MAX_ENDPOINT_LENGTH) fail('endpoint is longer than a webhook URL can be.');

  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    return fail('endpoint must be a URL.');
  }
  if (parsed.protocol !== 'https:') fail('endpoint must be https.');
  if (parsed.username !== '' || parsed.password !== '') fail('endpoint must not carry credentials.');
  assertPrivateAddress(parsed.hostname);
  if (LOOPBACK_OR_INTERNAL.test(parsed.hostname)) fail('endpoint must not name a host inside the deployment.');
  if (!parsed.hostname.includes('.')) fail('endpoint must name a fully qualified host.');
  return parsed;
}

export function notificationChannelDocumentId({ scopeGroupId }) {
  if (typeof scopeGroupId !== 'string' || scopeGroupId.length === 0) fail('scopeGroupId is required.');
  return `notification-channel|${scopeGroupId}`;
}

export function createNotificationChannelRecord({ scopeGroupId, channelKind, endpoint, updatedByCode, at }) {
  // Named separately from the endpoint rule: an operator told "that address cannot be
  // used" when the channel kind was the problem goes looking at their webhook.
  if (!KINDS.has(channelKind)) refuse('channel-kind-unsupported', 'channelKind must be a supported channel.');
  if (typeof updatedByCode !== 'string' || !SAFE_CODE.test(updatedByCode)) {
    fail('updatedByCode must be a bounded lower-case code.');
  }
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) fail('at must be an ISO-8601 instant.');
  const parsed = assertChannelEndpoint(endpoint);

  return Object.freeze({
    documentType: 'notification-channel',
    id: notificationChannelDocumentId({ scopeGroupId }),
    scopeGroupId,
    channelKind,
    endpoint,
    // Kept beside the secret so a reader never has to parse the secret to describe it.
    endpointHost: parsed.hostname,
    updatedByCode,
    updatedAt: at,
  });
}

export function assertNotificationChannelRecord(document) {
  if (document === null || typeof document !== 'object') fail('A notification channel is required.');
  if (document.documentType !== 'notification-channel') fail('documentType must be notification-channel.');
  if (!KINDS.has(document.channelKind)) fail('channelKind must be a supported channel.');
  const parsed = assertChannelEndpoint(document.endpoint);
  if (document.endpointHost !== parsed.hostname) fail('endpointHost must describe the stored endpoint.');
  if (document.id !== notificationChannelDocumentId({ scopeGroupId: document.scopeGroupId })) {
    fail('id must be derived from scopeGroupId.');
  }
  return document;
}

/**
 * What a reader is allowed to know: which channel, which host, who set it and when.
 * The endpoint itself never leaves the store.
 */
export function describeNotificationChannel(document) {
  if (document === null) return Object.freeze({ configured: false });
  return Object.freeze({
    configured: true,
    channelKind: document.channelKind,
    endpointHost: document.endpointHost,
    updatedByCode: document.updatedByCode,
    updatedAt: document.updatedAt,
  });
}

export const SUPPORTED_CHANNEL_KINDS = Object.freeze([...KINDS].sort());
