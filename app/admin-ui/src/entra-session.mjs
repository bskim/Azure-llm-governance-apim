import { PublicClientApplication, InteractionRequiredAuthError } from '@azure/msal-browser';

/**
 * The Microsoft Entra session, bundled for the browser.
 *
 * Tokens are held by the library rather than by this application: nothing here
 * writes a token to storage, logs one, or puts one in a URL. The console only ever
 * receives the header to attach to its next request.
 */

function fail(message) {
  throw new TypeError(message);
}

export function createEntraSession(config) {
  for (const required of ['clientId', 'authority', 'scope']) {
    if (typeof config?.[required] !== 'string' || config[required].length === 0) {
      fail(`config.${required} is required.`);
    }
  }

  const client = new PublicClientApplication({
    auth: {
      clientId: config.clientId,
      authority: config.authority,
      redirectUri: config.redirectUri ?? globalThis.location?.origin,
      navigateToLoginRequestUrl: false,
    },
    cache: {
      // Session storage keeps a token out of other tabs and drops it when the
      // browser session ends, which suits an administrative console.
      cacheLocation: 'sessionStorage',
      storeAuthStateInCookie: false,
    },
  });

  const scopes = [config.scope];
  let ready = null;

  async function initialize() {
    ready ??= (async () => {
      await client.initialize();
      await client.handleRedirectPromise();
      const [account] = client.getAllAccounts();
      if (account) client.setActiveAccount(account);
    })();
    return ready;
  }

  async function acquireToken() {
    await initialize();
    const account = client.getActiveAccount();
    if (!account) return null;
    try {
      const result = await client.acquireTokenSilent({ scopes, account });
      return result.accessToken;
    } catch (error) {
      // Only a genuine interaction requirement escalates to a redirect. Any other
      // failure surfaces as an unauthenticated request the API can refuse.
      if (error instanceof InteractionRequiredAuthError) {
        await client.acquireTokenRedirect({ scopes, account });
      }
      return null;
    }
  }

  return Object.freeze({
    mode: 'entra',
    async getAuthorizationHeader() {
      const token = await acquireToken();
      return token ? { Authorization: `Bearer ${token}` } : {};
    },
    async signIn() {
      await initialize();
      if (client.getActiveAccount()) return;
      await client.loginRedirect({ scopes });
    },
    async signOut() {
      await initialize();
      await client.logoutRedirect({ account: client.getActiveAccount() ?? undefined });
    },
    describe() {
      const account = client.getActiveAccount();
      return { mode: 'entra', signedIn: Boolean(account), name: account?.username ?? null };
    },
  });
}
