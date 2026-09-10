/**
 * Acquires and holds the gateway access token every coding agent needs.
 *
 * Each client injects a bearer token differently — Codex runs a command on a
 * refresh interval, OpenCode wraps `fetch`, Copilot CLI reads an environment
 * variable, Claude Code runs a key helper — but all four need the same thing
 * underneath: one short-lived token for the exact gateway audience, refreshed
 * before it expires, refreshed again if the gateway says it is stale, and never
 * written anywhere it could outlive the session.
 *
 * Acquisition is injected rather than performed here. That keeps process
 * spawning out of the domain and, more usefully, makes expiry, contention, and
 * failure classification testable without an identity provider.
 */

// Long enough that a request in flight when the check passes still arrives with a
// valid token, short enough not to discard most of a token's life.
const DEFAULT_SKEW_SECONDS = 300;

function fail(message) {
  throw new TypeError(message);
}

/**
 * `az account get-access-token` returns both `expiresOn` and `expires_on`. The
 * first is a local timestamp with no offset, so parsing it interprets the token
 * as expiring in whatever zone the reader happens to be in — which is correct
 * only in UTC and silently wrong by hours everywhere else. The epoch field is
 * unambiguous, so it wins whenever it is present.
 */
export function resolveExpiry(acquired) {
  if (acquired === null || typeof acquired !== 'object') fail('The acquired token must be an object.');
  if (typeof acquired.token !== 'string' || acquired.token.length === 0) {
    fail('The acquired token must carry a token value.');
  }
  if (Number.isSafeInteger(acquired.expiresOnEpochSeconds)) {
    return acquired.expiresOnEpochSeconds * 1000;
  }
  if (typeof acquired.expiresOnIso === 'string') {
    const parsed = Date.parse(acquired.expiresOnIso);
    if (!Number.isNaN(parsed)) return parsed;
  }
  fail('The acquired token must carry an unambiguous expiry.');
}

/**
 * A 401 means the token was not accepted, which a fresh one may fix. A 403 means
 * the caller is not entitled, which a fresh token cannot fix: retrying it doubles
 * the load and the request count while producing the same refusal. So only the
 * first is retried.
 */
export function isStaleCredential(response) {
  return response?.status === 401;
}

export function createGatewayTokenHelper({
  acquireToken,
  audience,
  scope,
  profile,
  now = () => Date.now(),
  skewSeconds = DEFAULT_SKEW_SECONDS,
} = {}) {
  if (typeof acquireToken !== 'function') fail('acquireToken is required.');
  if (typeof audience !== 'string' || audience.length === 0) fail('audience is required.');
  // The v2 scope is what carries `scp`, and the gateway validates it. Asking for a
  // bare resource yields a token the gateway will refuse for a reason that looks
  // like a configuration error rather than a missing scope.
  if (typeof scope !== 'string' || !scope.startsWith(`${audience}/`)) {
    fail('scope must be a delegated scope of the gateway audience.');
  }
  if (typeof profile !== 'string' || profile.length === 0) fail('profile is required.');
  if (!Number.isSafeInteger(skewSeconds) || skewSeconds < 0) fail('skewSeconds must be a whole number of seconds.');

  let cached = null;
  let inFlight = null;

  async function acquire() {
    // Without this, every parallel tool call in an agent turn starts its own
    // acquisition at the moment the cached token ages out, and a client that runs
    // ten tools spawns ten sign-in attempts.
    if (inFlight !== null) return inFlight;
    inFlight = (async () => {
      try {
        const acquired = await acquireToken({ audience, scope, profile });
        const expiresAtMs = resolveExpiry(acquired);
        if (expiresAtMs <= now()) fail('The acquired token is already expired.');
        cached = { token: acquired.token, expiresAtMs };
        return cached.token;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  async function getToken({ forceRefresh = false } = {}) {
    if (!forceRefresh && cached !== null && cached.expiresAtMs - skewSeconds * 1000 > now()) {
      return cached.token;
    }
    if (forceRefresh) cached = null;
    return acquire();
  }

  /**
   * Sends one request with a bearer token, and on a stale credential refreshes and
   * sends it exactly once more. Once, because a second failure is a fact about the
   * caller rather than the token, and a loop would turn an authorization problem
   * into a load problem.
   */
  async function authorize(send) {
    if (typeof send !== 'function') fail('send is required.');
    const first = await send({ authorization: `Bearer ${await getToken()}` });
    if (!isStaleCredential(first)) return first;
    return send({ authorization: `Bearer ${await getToken({ forceRefresh: true })}` });
  }

  /** What a usage record may say about this caller, and nothing more. */
  function describe() {
    return Object.freeze({
      profile,
      audience,
      scope,
      hasToken: cached !== null,
      expiresAtMs: cached?.expiresAtMs ?? null,
    });
  }

  return Object.freeze({ getToken, authorize, describe });
}

export { DEFAULT_SKEW_SECONDS };
