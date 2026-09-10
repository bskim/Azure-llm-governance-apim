#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { pathToFileURL } from 'node:url';

import {
  createGatewayTokenHelper,
  resolveExpiry,
} from '../../app/governance-domain/identity/gateway-token-helper.mjs';

/**
 * A loopback bridge that attaches a Microsoft Entra token to requests from a
 * coding agent.
 *
 * Some agents can acquire and refresh a credential themselves. Others take a
 * static value at startup, retry a refusal with the same value, and have nowhere
 * to put a fresh one — so a session that runs longer than a token simply fails
 * with no way back. This closes that gap without asking the agent to change.
 *
 * What it deliberately does not do: it does not translate between wire formats,
 * rewrite bodies, or choose models. The request that arrives is the request that
 * leaves, so the gateway still sees the caller's own traffic and attributes it to
 * the person who signed in.
 */

const CREDENTIAL_HEADERS = ['authorization', 'x-api-key', 'api-key', 'ocp-apim-subscription-key'];
// Hop-by-hop headers belong to this connection, not to the forwarded one.
const HOP_HEADERS = ['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authorization'];

function fail(message) {
  process.stderr.write(`agent-auth-bridge: ${message}\n`);
  process.exit(1);
}

/**
 * Runs the sign-in command and reads its JSON.
 *
 * A shell is never used. Concatenating arguments into one command line is how a
 * value that came from configuration becomes a command, so a batch launcher is
 * invoked through the interpreter explicitly and everything else is executed
 * directly with its arguments kept separate.
 *
 * The Azure CLI reports both a local timestamp and an epoch; the shared helper
 * decides between them. Nothing here writes the token anywhere, and a failure
 * message carries the command's own error rather than its output.
 */
function commandAcquirer({ command, args }) {
  const isBatch = /\.(cmd|bat)$/i.test(command);
  const executable = isBatch ? process.env.COMSPEC ?? 'cmd.exe' : command;
  const argv = isBatch ? ['/d', '/s', '/c', command, ...args] : args;

  return () =>
    new Promise((resolve, reject) => {
      const child = spawn(executable, argv, { shell: false, windowsHide: true });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', (error) => reject(new Error(`sign-in command failed to start: ${error.message}`)));
      child.on('close', (code) => {
        if (code !== 0) {
          const detail = stderr.trim().split('\n').slice(-3).join(' ');
          reject(new Error(`sign-in required or command failed (exit ${code}): ${detail}`));
          return;
        }
        try {
          const parsed = JSON.parse(stdout);
          resolve({
            token: parsed.accessToken,
            expiresOnEpochSeconds: Number.isFinite(parsed.expires_on) ? parsed.expires_on : undefined,
            expiresOnIso: parsed.expiresOn,
          });
        } catch (error) {
          reject(new Error(`could not read the sign-in command output: ${error.message}`));
        }
      });
    });
}

const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Acquires the token by device code, using the client the gateway approves.
 *
 * The Azure CLI cannot serve this gateway. It is not preauthorized for the audience,
 * and even with consent the token it mints carries the CLI's own `azp`, which the
 * gateway refuses by design. So a helper that shells out to `az` can never satisfy a
 * gateway that pins an approved client, and the sign-in has to be performed as that
 * client instead.
 *
 * The refresh token stays in this process. Nothing here writes either credential to a
 * file, an argument list, or an event; the prompt carries only the user code and the
 * verification address, which are useless without the user.
 */
function deviceCodeAcquirer({
  tenantId,
  clientId,
  scope,
  onPrompt,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = 420_000,
  now = () => Date.now(),
}) {
  if (!GUID.test(tenantId ?? '')) throw new TypeError('tenantId must be a directory identifier.');
  if (!GUID.test(clientId ?? '')) throw new TypeError('clientId must be an application identifier.');
  if (typeof scope !== 'string' || scope.length === 0) throw new TypeError('scope is required.');
  if (typeof onPrompt !== 'function') throw new TypeError('onPrompt is required.');

  const authority = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0`;
  // Kept in memory so a session outliving one token does not need a second sign-in.
  let refreshToken = null;

  async function post(path, form) {
    const response = await fetchImpl(`${authority}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
    const payload = await response.json();
    return { ok: response.ok, payload };
  }

  function toResult(payload) {
    if (typeof payload.access_token !== 'string' || payload.access_token.length === 0) {
      throw new Error('the sign-in response carried no access token');
    }
    if (typeof payload.refresh_token === 'string') refreshToken = payload.refresh_token;
    const expiresIn = Number.parseInt(payload.expires_in, 10);
    if (!Number.isFinite(expiresIn)) throw new Error('the sign-in response carried no expiry');
    return {
      token: payload.access_token,
      expiresOnEpochSeconds: Math.floor(now() / 1000) + expiresIn,
    };
  }

  async function refreshSilently() {
    if (refreshToken === null) return null;
    const { ok, payload } = await post('token', {
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: refreshToken,
      scope,
    });
    if (ok) return toResult(payload);
    // A refresh that is refused means the session is gone, not that the run failed;
    // the caller falls back to an interactive sign-in.
    refreshToken = null;
    return null;
  }

  async function signInInteractively() {
    const started = await post('devicecode', { client_id: clientId, scope });
    if (!started.ok) {
      throw new Error(`device code request refused: ${started.payload.error ?? 'unknown'}`);
    }
    onPrompt({
      verificationUri: started.payload.verification_uri,
      userCode: started.payload.user_code,
      expiresInSeconds: Number.parseInt(started.payload.expires_in, 10),
    });

    let intervalMs = Math.max(5, Number.parseInt(started.payload.interval, 10) || 5) * 1000;
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      await sleep(intervalMs);
      const { ok, payload } = await post('token', {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: clientId,
        device_code: started.payload.device_code,
      });
      if (ok) return toResult(payload);
      // Only two of these mean "keep waiting". Treating every refusal as pending
      // would hide a declined or expired sign-in behind a timeout.
      if (payload.error === 'slow_down') intervalMs += 5000;
      else if (payload.error !== 'authorization_pending') {
        throw new Error(`device code sign-in failed: ${payload.error ?? 'unknown'}`);
      }
    }
    throw new Error('device code sign-in did not complete before the deadline');
  }

  return async () => (await refreshSilently()) ?? (await signInInteractively());
}

function forwardHeaders(incoming, upstreamHost) {
  const headers = {};
  for (const [name, value] of Object.entries(incoming)) {
    const lower = name.toLowerCase();
    // A client's placeholder key must not travel; the gateway authenticates the
    // person, and a second credential in the request is only ambiguity.
    if (CREDENTIAL_HEADERS.includes(lower) || HOP_HEADERS.includes(lower)) continue;
    headers[name] = value;
  }
  headers.host = upstreamHost;
  return headers;
}

export function createAuthBridge({ upstream, helper, onEvent = () => {} }) {
  const target = new URL(upstream);
  // The client's base URL is the gateway's base URL, so the path is forwarded
  // verbatim. Prefixing it with a path from here would silently double whatever
  // the client already sent and produce a refusal that looks like a routing bug.
  if (target.pathname !== '/') {
    throw new TypeError('upstream must be an origin without a path, for example https://gateway.example.net');
  }
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;

  const forward = (clientRequest, clientResponse, authorization, body) =>
    new Promise((resolve) => {
      const upstreamRequest = send(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port,
          method: clientRequest.method,
          path: clientRequest.url,
          headers: { ...forwardHeaders(clientRequest.headers, target.host), authorization },
        },
        (upstreamResponse) => resolve(upstreamResponse),
      );
      upstreamRequest.on('error', (error) => {
        onEvent({ kind: 'upstream-error', detail: error.message });
        if (!clientResponse.headersSent) {
          clientResponse.writeHead(502, { 'content-type': 'application/json' });
          clientResponse.end(
            JSON.stringify({
              error: { message: 'The bridge could not reach the gateway.', type: 'bridge_error', code: 'upstream_unreachable' },
            }),
          );
        }
        resolve(null);
      });
      if (body.length > 0) upstreamRequest.write(body);
      upstreamRequest.end();
    });

  return createServer(async (clientRequest, clientResponse) => {
    const chunks = [];
    for await (const chunk of clientRequest) chunks.push(chunk);
    const body = Buffer.concat(chunks);

    let token;
    try {
      token = await helper.getToken();
    } catch (error) {
      onEvent({ kind: 'sign-in-failed', detail: error.message });
      clientResponse.writeHead(401, { 'content-type': 'application/json' });
      clientResponse.end(
        JSON.stringify({
          error: { message: error.message, type: 'authentication_error', code: 'sign_in_required' },
        }),
      );
      return;
    }

    let upstreamResponse = await forward(clientRequest, clientResponse, `Bearer ${token}`, body);
    if (upstreamResponse === null) return;

    // One retry, because a refusal the agent cannot act on is exactly the gap this
    // bridge exists to close. A second refusal is about the caller, not the token.
    if (upstreamResponse.statusCode === 401) {
      upstreamResponse.resume();
      onEvent({ kind: 'refreshing' });
      try {
        const fresh = await helper.getToken({ forceRefresh: true });
        upstreamResponse = await forward(clientRequest, clientResponse, `Bearer ${fresh}`, body);
        if (upstreamResponse === null) return;
      } catch (error) {
        onEvent({ kind: 'sign-in-failed', detail: error.message });
      }
    }

    onEvent({ kind: 'forwarded', status: upstreamResponse.statusCode, path: clientRequest.url });
    clientResponse.writeHead(upstreamResponse.statusCode, upstreamResponse.headers);
    // Piped rather than buffered, so a streamed answer still arrives token by token.
    upstreamResponse.pipe(clientResponse);
  });
}

function parseArguments(argv) {
  const options = {
    port: 8787,
    upstream: process.env.GATEWAY_UPSTREAM ?? '',
    scope: process.env.GATEWAY_SCOPE ?? '',
    command: process.env.GATEWAY_SIGNIN_COMMAND ?? 'az',
    tenant: process.env.GATEWAY_TENANT_ID ?? '',
    client: process.env.GATEWAY_CLIENT_ID ?? '',
    quiet: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inline] = argv[index].split('=');
    const value = inline ?? argv[index + 1];
    const consume = () => {
      if (inline === undefined) index += 1;
    };
    if (flag === '--port') {
      options.port = Number.parseInt(value, 10);
      consume();
    } else if (flag === '--upstream') {
      options.upstream = value;
      consume();
    } else if (flag === '--scope') {
      options.scope = value;
      consume();
    } else if (flag === '--command') {
      options.command = value;
      consume();
    } else if (flag === '--tenant') {
      options.tenant = value;
      consume();
    } else if (flag === '--client') {
      options.client = value;
      consume();
    } else if (flag === '--quiet') {
      options.quiet = true;
    }
  }
  return options;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const options = parseArguments(process.argv.slice(2));
  if (!options.upstream) fail('--upstream is required, for example --upstream https://gateway.example.net');
  if (!options.scope) fail('--scope is required, for example --scope api://llm-governance-gateway/Gateway.Access');
  const audience = options.scope.slice(0, options.scope.lastIndexOf('/'));

  // Signing in as the approved client is the only path that works against a gateway
  // that pins one; the command path stays for deployments whose approved client is
  // whatever the configured command already signs in as.
  const useDeviceCode = options.tenant.length > 0 && options.client.length > 0;
  const helper = createGatewayTokenHelper({
    audience,
    scope: options.scope,
    profile: useDeviceCode ? 'device-code' : 'azure-cli',
    acquireToken: useDeviceCode
      ? deviceCodeAcquirer({
          tenantId: options.tenant,
          clientId: options.client,
          scope: `${options.scope} offline_access`,
          onPrompt: ({ verificationUri, userCode }) => {
            process.stderr.write(`agent-auth-bridge: open ${verificationUri} and enter ${userCode}\n`);
          },
        })
      : commandAcquirer({
          command: options.command,
          args: ['account', 'get-access-token', '--scope', options.scope, '--output', 'json'],
        }),
  });

  const server = createAuthBridge({
    upstream: options.upstream,
    helper,
    onEvent: (event) => {
      if (options.quiet) return;
      // Status and path only. A log a developer pastes into an issue must not be a
      // place a working credential can be recovered from.
      process.stderr.write(`${JSON.stringify(event)}\n`);
    },
  });

  server.listen(options.port, '127.0.0.1', () => {
    process.stdout.write(`http://127.0.0.1:${options.port}\n`);
  });
}

export { commandAcquirer, deviceCodeAcquirer, resolveExpiry };
