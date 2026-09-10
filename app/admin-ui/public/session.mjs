/**
 * How the console obtains a caller identity.
 *
 * This is the whole contract between the interface and whatever authenticates it.
 * An implementation returns the headers a request should carry and nothing else,
 * so the interface never handles a token and an organization can replace the
 * mechanism without touching a single screen.
 *
 * A replacement must provide:
 *   mode                     a short identifier shown in diagnostics
 *   getAuthorizationHeader() headers to merge into a request; {} when anonymous
 *   signIn()                 establish a session, or a no-op when none is needed
 *   signOut()                discard it, or a no-op
 *   describe()               { mode, signedIn, name } for the interface to render
 */

const CONFIG_PATH = '/admin-config.json';

/**
 * Local development has no identity provider. Requests carry no credential and the
 * server decides what the selected persona may see, so the console cannot grant
 * itself anything by pretending to be signed in.
 */
export function createLocalSession() {
  return Object.freeze({
    mode: 'local',
    async getAuthorizationHeader() {
      return {};
    },
    async signIn() {},
    async signOut() {},
    describe() {
      return { mode: 'local', signedIn: false, name: null };
    },
  });
}

export function assertSessionContract(session) {
  for (const member of ['getAuthorizationHeader', 'signIn', 'signOut', 'describe']) {
    if (typeof session?.[member] !== 'function') {
      throw new TypeError(`A session must implement ${member}().`);
    }
  }
  if (typeof session.mode !== 'string' || session.mode.length === 0) {
    throw new TypeError('A session must name its mode.');
  }
  return session;
}

export async function readSessionConfig(fetchImpl = fetch) {
  try {
    const response = await fetchImpl(CONFIG_PATH, { headers: { Accept: 'application/json' } });
    if (!response.ok) return { mode: 'local' };
    const config = await response.json();
    return config?.mode === 'entra' ? config : { mode: 'local' };
  } catch {
    // No configuration means no identity provider, which is the local case rather
    // than a failure. A misconfigured deployment fails later, at the API, visibly.
    return { mode: 'local' };
  }
}

/**
 * The Entra implementation is bundled separately and loaded only when a deployment
 * asks for it, so a local run never downloads an authentication library it cannot use.
 */
export async function loadSession(config, importVendor = () => import('./vendor/entra-session.js')) {
  if (config?.mode !== 'entra') return createLocalSession();
  const { createEntraSession } = await importVendor();
  return assertSessionContract(createEntraSession(config));
}
