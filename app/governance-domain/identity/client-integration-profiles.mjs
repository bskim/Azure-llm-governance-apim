/**
 * How each required coding client reaches the governed gateway.
 *
 * The mechanisms below are the ones each product actually offers: where it takes
 * a bearer token, which wire format it speaks, and what it will not do. They are
 * separated from the endpoint and audience because the mechanism is a property of
 * the client and the endpoint is a property of this deployment.
 *
 * Two things this file exists to prevent, both of which appear in otherwise
 * correct direct-to-Foundry guidance:
 *
 * - A gateway subscription key standing in for caller identity. It authenticates
 *   the deployment, not the person, so a shared key makes per-caller entitlement,
 *   quota, and revocation unenforceable while still appearing to work.
 * - A client's model aliases pointed at a different vendor's models. It runs, and
 *   it makes every attribution and compatibility claim about that client false.
 */

const TOKEN_INJECTIONS = new Set([
  'command-on-interval',
  'fetch-wrapper',
  'environment-variable',
  'key-helper-command',
  'provider-native',
]);

const WIRE_FORMATS = new Set(['openai-responses', 'openai-chat-completions', 'anthropic-messages']);
const ATTRIBUTION_QUALITIES = new Set(['strong', 'generic']);
const EVIDENCE_STATES = new Set(['planned', 'local-pass', 'cloud-pass']);
// Whether the client can obtain a new credential without being restarted. Measured
// per client rather than assumed, because it decides whether a session can outlive
// its token and therefore whether a helper has anywhere to inject a fresh one.
const REFRESH_BEHAVIOURS = new Set(['client-reacquires', 'static-for-process', 'unknown']);

function fail(message) {
  throw new TypeError(message);
}

/**
 * Every profile, stated as what the client requires rather than as what a
 * particular deployment happens to configure.
 */
const PROFILES = Object.freeze([
  Object.freeze({
    clientId: 'codex-cli',
    displayCode: 'codex-cli',
    // Codex runs a command and refreshes it on an interval, so it needs no wrapper
    // and no stored credential.
    tokenInjection: 'command-on-interval',
    wireFormat: 'openai-responses',
    // Responses is the only wire format Codex speaks, so a Chat-Completions-only
    // model needs a translator and is out of scope for the governed path.
    wireFormatIsFixed: true,
    attributionQuality: 'generic',
    attributionReason: 'token-helper-is-a-shared-tool',
    requiresGatewayScope: true,
    // Measured: a refused request was followed by a second invocation of the token
    // command, so the retry carried a credential the client had just obtained.
    refreshBehaviour: 'client-reacquires',
    notes: Object.freeze([
      'Provider definitions are read only from the user-level configuration file.',
      'On Windows the token command must be wrapped, because the Azure CLI is a batch file.',
      'A token command cannot be combined with a static key or environment key.',
      'Sub-agent tools are sent with a non-function tool type that only Responses-native models accept.',
      'A refresh interval is part of the token command, so this is the one client that can re-acquire without a wrapper.',
      'A model list is requested at startup, and a route that does not answer it leaves the client reporting an error on every launch.',
    ]),
    evidence: 'local-pass',
  }),
  Object.freeze({
    clientId: 'copilot-cli',
    displayCode: 'copilot-cli',
    tokenInjection: 'environment-variable',
    wireFormat: 'openai-chat-completions',
    wireFormatIsFixed: false,
    attributionQuality: 'generic',
    attributionReason: 'token-helper-is-a-shared-tool',
    requiresGatewayScope: true,
    // Measured: a 401 is classified as transient and retried, but the environment
    // variable is fixed for the process, so the retry carries the same credential.
    refreshBehaviour: 'static-for-process',
    notes: Object.freeze([
      'The bearer variable takes precedence over the key variable, and is always sent as Authorization.',
      'Setting a key and a bearer together is ambiguous and the client warns against it.',
      'The wire format is selectable, so this client can speak Responses or Chat Completions.',
      'The provider type includes an Anthropic option, so it is not limited to OpenAI-shaped routes.',
      'Background utility calls for prompt refinement and session naming also reach the provider.',
    ]),
    evidence: 'local-pass',
  }),
  Object.freeze({
    clientId: 'copilot-vscode-byok',
    displayCode: 'copilot-vscode-byok',
    tokenInjection: 'provider-native',
    wireFormat: 'openai-responses',
    wireFormatIsFixed: false,
    // The editor cannot ask for a token for the gateway's audience, so something
    // outside it must, and the application named in the token is that helper.
    attributionQuality: 'generic',
    attributionReason: 'token-helper-is-a-shared-tool',
    requiresGatewayScope: true,
    // Not in the path: under the only supported route the credential is not the
    // editor's, so its native behaviour was never exercised.
    refreshBehaviour: 'unknown',
    notes: Object.freeze([
      'Models are declared with their tool-calling, vision, and token limits, which the gateway does not supply.',
      'The declaration has no field for a token audience, so the editor requests the one it assumes.',
      'Static request headers exist, but a shared secret in them is not caller identity.',
      'A provider is registered through the editor; its endpoint and model list are then readable configuration, and only the credential stays in the secret store.',
      'The endpoint is declared per model rather than per provider, and the model identifier is what is sent, so an empty one is accepted at registration and fails at the gateway.',
      'Because the audience cannot be declared, the supported route is a loopback address that attaches the correct token, which also removes the reason to store a key.',
      'Every observed request asked for a stream, so a notice injected into a response body cannot reach this client.',
      'Around a hundred function-typed tools and a body of a few hundred kilobytes were sent in one turn, which the request size limit on the route has to accommodate.',
    ]),
    evidence: 'local-pass',
  }),
  Object.freeze({
    clientId: 'claude-code',
    displayCode: 'claude-code',
    tokenInjection: 'key-helper-command',
    wireFormat: 'anthropic-messages',
    // The base URL must expose Anthropic Messages, so an OpenAI-shaped route
    // cannot serve this client whatever is behind it.
    wireFormatIsFixed: true,
    attributionQuality: 'generic',
    attributionReason: 'token-helper-is-a-shared-tool',
    requiresGatewayScope: true,
    // Measured on the environment-token path, which is the one that reliably wins.
    refreshBehaviour: 'static-for-process',
    notes: Object.freeze([
      'An existing signed-in session credential outranks the key helper, so the helper alone is not an injection point.',
      'The environment token is sent only as Authorization and is not duplicated into an api-key header.',
      'The key-helper path does produce a duplicate api-key header, which the gateway must remove before dispatch.',
      'A rejected request is retried, but the environment token is fixed for the process so the retry repeats it.',
      'Tools are sent untyped, which is why models that reject typed sub-agent tools still accept this client.',
      'Model aliases must name genuine Claude deployments; pointing them at another vendor is refused.',
    ]),
    evidence: 'local-pass',
  }),
  Object.freeze({
    clientId: 'opencode',
    displayCode: 'opencode',
    // A wrapper around the request is the only injection point that can see the
    // response status, which is what makes a refresh-and-retry possible.
    tokenInjection: 'fetch-wrapper',
    wireFormat: 'openai-chat-completions',
    wireFormatIsFixed: false,
    attributionQuality: 'strong',
    attributionReason: 'plugin-owned-client-identity',
    requiresGatewayScope: true,
    // Measured: the retry after a refusal carried a different credential.
    refreshBehaviour: 'client-reacquires',
    notes: Object.freeze([
      'Providers are declared with a placeholder key that the wrapper overwrites, so no key is stored.',
      'The wrapper sees the response status, so a refused request is retried with a newly acquired credential.',
      'Reasoning models reject a maximum-token field and a temperature other than one.',
    ]),
    evidence: 'local-pass',
  }),
]);

function assertProfile(profile, path) {
  if (!TOKEN_INJECTIONS.has(profile.tokenInjection)) fail(`${path}.tokenInjection is unsupported.`);
  if (!WIRE_FORMATS.has(profile.wireFormat)) fail(`${path}.wireFormat is unsupported.`);
  if (!ATTRIBUTION_QUALITIES.has(profile.attributionQuality)) {
    fail(`${path}.attributionQuality is unsupported.`);
  }
  if (!EVIDENCE_STATES.has(profile.evidence)) fail(`${path}.evidence is unsupported.`);
  if (!REFRESH_BEHAVIOURS.has(profile.refreshBehaviour)) fail(`${path}.refreshBehaviour is unsupported.`);
  // A client that cannot re-acquire needs the credential supplied from outside it,
  // so claiming a measured behaviour without having measured it would hide the gap.
  if (profile.evidence === 'planned' && profile.refreshBehaviour !== 'unknown') {
    fail(`${path}.refreshBehaviour cannot be known before the client was exercised.`);
  }
  // A profile that does not need the gateway scope is one that is not reaching the
  // gateway, which makes it a different endpoint mode rather than a client profile.
  if (profile.requiresGatewayScope !== true) fail(`${path} must require the gateway scope.`);
  if (!Array.isArray(profile.notes) || profile.notes.length === 0) {
    fail(`${path}.notes must record what the client requires.`);
  }
}

export function listClientProfiles() {
  return PROFILES;
}

/**
 * Clients that cannot obtain a new credential once started.
 *
 * These need the token supplied from outside the process, because a session that
 * outlives its token has no way back: the request is retried, the same expired
 * value is sent again, and the caller sees a failure it cannot act on.
 */
export function clientsNeedingExternalRefresh() {
  return Object.freeze(
    PROFILES.filter((profile) => profile.refreshBehaviour === 'static-for-process').map(
      (profile) => profile.clientId,
    ),
  );
}

export function resolveClientProfile(clientId) {
  return PROFILES.find((profile) => profile.clientId === clientId) ?? null;
}

/**
 * Whether a route may serve a client.
 *
 * A client whose wire format is fixed cannot be served by a route in another
 * format, however capable the model behind it. This is the check that stops a
 * client being declared supported because a translation happened to run.
 *
 * Nothing calls this at request time, and nothing can: no runtime moment exists in
 * which a route claims to serve a named client. It states the rule executably for
 * review, and must not be described as an enforcement point.
 */
export function assertRouteServesClient({ clientId, routeWireFormat, routeProviderKey }) {
  const profile = resolveClientProfile(clientId);
  if (profile === null) return Object.freeze({ serves: false, reasonCode: 'client-unregistered' });
  if (profile.wireFormat !== routeWireFormat) {
    return Object.freeze({
      serves: false,
      reasonCode: profile.wireFormatIsFixed ? 'wire-format-fixed' : 'wire-format-mismatch',
    });
  }
  // A client that speaks one vendor's protocol expects that vendor's model. Serving
  // it another vendor's model runs, and makes every claim about the client false.
  if (profile.wireFormat === 'anthropic-messages' && routeProviderKey !== 'anthropic') {
    return Object.freeze({ serves: false, reasonCode: 'provider-substitution-refused' });
  }
  return Object.freeze({ serves: true, reasonCode: 'route-serves-client' });
}

/**
 * The catalogue entries these profiles imply.
 *
 * Attribution quality belongs to the profile, so the catalogue is derived rather
 * than maintained beside it, and a client cannot be described one way here and
 * another way in a usage record.
 */
export function clientApplicationDescriptors() {
  return Object.freeze(
    PROFILES.map((profile) =>
      Object.freeze({
        applicationId: profile.clientId,
        attributionQuality: profile.attributionQuality,
        displayCode: profile.displayCode,
      }),
    )
      // The catalogue contract requires a sorted list, so the derivation produces one
      // rather than leaving each caller to remember.
      .sort((left, right) => left.applicationId.localeCompare(right.applicationId)),
  );
}

PROFILES.forEach((profile, index) => assertProfile(profile, `clientProfiles[${index}]`));

export { TOKEN_INJECTIONS, WIRE_FORMATS };
