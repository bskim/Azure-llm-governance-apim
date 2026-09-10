import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createGatewayTokenHelper } from '../../app/governance-domain/identity/gateway-token-helper.mjs';
import { createAuthBridge } from '../../tools/agent-auth-bridge/agent-auth-bridge.mjs';
import { buildOpenCodexGatewayConfig } from '../helpers/opencodex-fixture.mjs';
import { createGatewayMock } from '../mock/gateway-mock.mjs';

const launcher = process.env.OPENCODEX_LAUNCHER?.trim() ?? '';
const packageRoot = launcher.length > 0 ? path.resolve(path.dirname(launcher), '..') : '';
const bun = packageRoot.length > 0 ? path.resolve(packageRoot, '..', '..', 'bun', 'bin', 'bun.exe') : '';
const embeddedHost = path.resolve(new URL('../helpers/opencodex-embedded-host.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const hasOpenCodex = launcher.length > 0 && existsSync(launcher) && existsSync(bun);
const expectedVersion = '2.32.0';
const audience = 'api://llm-governance-gateway';
const scope = `${audience}/Gateway.Access`;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function freePort() {
  const reservation = createServer();
  return new Promise((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', () => {
      const { port } = reservation.address();
      reservation.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function collect(stream, limit = 64 * 1024) {
  let value = '';
  stream?.setEncoding('utf8');
  stream?.on('data', (chunk) => {
    value = `${value}${chunk}`.slice(-limit);
  });
  return () => value;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = collect(child.stdout);
    const stderr = collect(child.stderr);
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`command timed out: ${[command, ...args].join(' ')}\n${stderr()}`));
    }, options.timeoutMs ?? 30_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout: stdout(), stderr: stderr() });
    });
  });
}

async function waitUntilReady(origin, child, diagnostics) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`OpenCodex exited before readiness (${child.exitCode}).\n${diagnostics()}`);
    }
    try {
      const response = await fetch(`${origin}/readyz`);
      if (response.status === 200 && (await response.json()).status === 'ready') return;
    } catch {
      // The listener may not exist until Bun has loaded the provider catalogue.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`OpenCodex did not become ready.\n${diagnostics()}`);
}

async function closeServer(server) {
  server.closeAllConnections?.();
  await Promise.race([
    new Promise((resolve) => server.close(() => resolve())),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
}

function isolatedEnvironment(root, configHome) {
  const profile = path.join(root, 'profile');
  const env = {
    ...process.env,
    OPENCODEX_HOME: configHome,
    OCX_TEST_HOME_GUARD: '1',
    OCX_REAL_HOME: process.env.USERPROFILE || homedir(),
    HOME: profile,
    USERPROFILE: profile,
    APPDATA: path.join(profile, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(profile, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(profile, '.config'),
    CODEX_HOME: path.join(profile, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(profile, '.claude'),
    CI: '1',
    NO_COLOR: '1',
    OPENCODEX_PACKAGE_ROOT: packageRoot,
  };
  delete env.OPENCODEX_API_AUTH_TOKEN;
  delete env.OCX_SERVICE;
  return { env, profile };
}

async function postJson(url, body, headers = {}) {
  const requestHeaders = {
    authorization: 'Bearer local-client-placeholder',
    'content-type': 'application/json',
    ...headers,
  };
  for (const [name, value] of Object.entries(requestHeaders)) {
    if (value === undefined) delete requestHeaders[name];
  }
  return fetch(url, {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify(body),
  });
}

async function check(name, action) {
  try {
    await action();
  } catch (error) {
    throw new Error(`check failed: ${name}`, { cause: error });
  }
}

test('OpenCodex routes coding-agent wires through the existing Entra bridge contract', {
  skip: hasOpenCodex ? false : 'set OPENCODEX_LAUNCHER to the pinned OpenCodex npm launcher',
  timeout: 90_000,
}, async () => {
  const packageJsonPath = path.join(packageRoot, 'package.json');
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  assert.equal(packageJson.name, '@bitkyc08/opencodex');
  assert.equal(packageJson.version, expectedVersion);

  const root = await mkdtemp(path.join(tmpdir(), 'llm-governance-opencodex-'));
  const configHome = path.join(root, 'opencodex-home');
  const proxyPort = await freePort();
  const mock = createGatewayMock({
    allowedModels: ['coding-primary', 'coding-throttled'],
    rateLimitedModels: ['coding-throttled'],
    retryAfter: '7',
  });
  const mockOrigin = await mock.listen();
  let issued = 0;
  const helper = createGatewayTokenHelper({
    audience,
    scope,
    profile: 'device-code',
    acquireToken: async () => {
      issued += 1;
      return {
        token: `tok.${issued}.sig`,
        expiresOnEpochSeconds: Math.floor(Date.now() / 1000) + 3_600,
      };
    },
  });
  const bridgeEvents = [];
  const bridge = createAuthBridge({
    upstream: mockOrigin,
    helper,
    onEvent: (event) => bridgeEvents.push(event),
  });
  const bridgeOrigin = await listen(bridge);
  const { env, profile } = isolatedEnvironment(root, configHome);
  await mkdir(path.join(profile, 'AppData', 'Roaming'), { recursive: true });
  await mkdir(path.join(profile, 'AppData', 'Local'), { recursive: true });
  await mkdir(env.CODEX_HOME, { recursive: true });
  await mkdir(env.CLAUDE_CONFIG_DIR, { recursive: true });
  await mkdir(configHome, { recursive: true });
  const configPath = path.join(configHome, 'config.json');
  const config = buildOpenCodexGatewayConfig({
    port: proxyPort,
    bridgeBaseUrl: `${bridgeOrigin}/v1`,
    modelAlias: 'coding-primary',
    claudeCodeModelId: 'claude-sonnet-4-20250514',
    providerName: 'gateway-bridge',
  });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  let child = null;
  let childStdout = () => '';
  let childStderr = () => '';
  const diagnostics = () => `${childStdout()}\n${childStderr()}`;
  const proxyOrigin = `http://127.0.0.1:${proxyPort}`;
  let stage = 'configuration validation';

  try {
    const validate = await run(process.execPath, [launcher, 'config', 'validate', configPath, '--json'], { env });
    assert.equal(validate.code, 0, validate.stderr || validate.stdout);
    assert.equal(JSON.parse(validate.stdout).ok, true);

    stage = 'startup readiness';
    env.OPENCODEX_TEST_PORT = String(proxyPort);
    child = spawn(bun, [embeddedHost], {
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    childStdout = collect(child.stdout);
    childStderr = collect(child.stderr);
    await waitUntilReady(proxyOrigin, child, diagnostics);

    stage = 'static model discovery';
    await check('publishes the static routed model without querying the gateway model list', async () => {
      const response = await fetch(`${proxyOrigin}/v1/models`, {
        headers: { authorization: 'Bearer local-client-placeholder' },
      });
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.ok(payload.data.some((model) => model.id === 'gateway-bridge/coding-primary'));
      assert.equal(mock.requests.some((request) => request.path === '/v1/models'), false);
    });

    stage = 'Responses and tools';
    await check('preserves Responses, tools, model routing, and credential replacement', async () => {
      mock.requests.length = 0;
      const response = await postJson(`${proxyOrigin}/v1/responses`, {
        model: 'gateway-bridge/coding-primary',
        input: 'Use the lookup tool.',
        tools: [{
          type: 'function',
          name: 'lookup',
          description: 'Looks up a value.',
          parameters: { type: 'object', properties: {} },
        }],
      });
      assert.equal(response.status, 200, response.status === 200 ? undefined : await response.clone().text());
  const payload = await response.json();
  assert.equal(payload.object, 'response');
      assert.equal(mock.requests.length, 1);
      assert.equal(mock.requests[0].path, '/v1/responses');
      assert.equal(mock.requests[0].model, 'coding-primary');
      assert.deepEqual(mock.requests[0].toolTypes, ['function']);
      assert.deepEqual(mock.requests[0].duplicatedCredentialHeaders, []);
      assert.notEqual(mock.requests[0].credentialSha256, sha256('placeholder-replaced-by-bridge'));
      assert.notEqual(mock.requests[0].credentialSha256, sha256('local-client-placeholder'));
    });

    stage = 'Responses streaming';
    await check('streams a Responses answer without buffering it into JSON', async () => {
      mock.requests.length = 0;
      const response = await postJson(`${proxyOrigin}/v1/responses`, {
        model: 'gateway-bridge/coding-primary',
        input: 'Stream a short answer.',
        stream: true,
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
      const body = await response.text();
      assert.match(body, /response\.completed/);
      assert.equal(mock.requests[0].streamRequested, true);
    });

    stage = '401 refresh';
    await check('lets the bridge refresh once after 401', async () => {
      mock.requests.length = 0;
      mock.markStale(`tok.${issued}.sig`);
      const before = issued;
      const response = await postJson(`${proxyOrigin}/v1/responses`, {
        model: 'gateway-bridge/coding-primary',
        input: 'Refresh once.',
      });
      assert.equal(response.status, 200, response.status === 200 ? undefined : await response.clone().text());
      assert.equal(issued, before + 1);
      assert.deepEqual(mock.requests.map((request) => request.outcome), ['stale-token', 'served']);
      assert.notEqual(mock.requests[0].credentialSha256, mock.requests[1].credentialSha256);
      assert.ok(bridgeEvents.some((event) => event.kind === 'refreshing'));
    });

    stage = '403 refusal';
    await check('does not retry a gateway 403', async () => {
      mock.requests.length = 0;
      const before = issued;
      const response = await postJson(`${proxyOrigin}/v1/responses`, {
        model: 'gateway-bridge/coding-denied',
        input: 'This model is denied.',
      });
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error.code, 'model_not_allowed');
      assert.equal(issued, before);
      assert.deepEqual(mock.requests.map((request) => request.outcome), ['model-not-allowed']);
    });

    stage = '429 preservation';
    await check('preserves 429 and Retry-After without an implicit retry', async () => {
      mock.requests.length = 0;
      const response = await postJson(`${proxyOrigin}/v1/responses`, {
        model: 'gateway-bridge/coding-throttled',
        input: 'This model is throttled.',
      });
      assert.equal(response.status, 429);
      assert.equal(response.headers.get('retry-after'), '7');
      assert.equal((await response.json()).error.code, 'rate_limit_exceeded');
      assert.deepEqual(mock.requests.map((request) => request.outcome), ['rate-limited']);
    });

    stage = 'Anthropic translation';
    await check('translates Anthropic Messages ingress to the governed Responses route', async () => {
      mock.requests.length = 0;
      const response = await postJson(`${proxyOrigin}/v1/messages`, {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 32,
        messages: [{ role: 'user', content: 'Reply briefly.' }],
      }, {
        authorization: undefined,
        'x-api-key': 'local-client-placeholder',
        'anthropic-version': '2023-06-01',
      });
      assert.equal(response.status, 200, response.status === 200 ? undefined : await response.clone().text());
      const payload = await response.json();
      assert.equal(payload.type, 'message');
      assert.equal(mock.requests.length, 1);
      assert.equal(mock.requests[0].path, '/v1/responses');
      assert.equal(mock.requests[0].model, 'coding-primary');
      assert.deepEqual(mock.requests[0].duplicatedCredentialHeaders, []);
    });

    assert.equal(mock.requests.some((request) => request.path === '/v1/models'), false);
    assert.equal(JSON.stringify(bridgeEvents).includes('tok.'), false);
  } catch (error) {
    process.stderr.write(`OpenCodex integration failed during ${stage}: ${error.stack ?? error}\n${diagnostics()}\n`);
    throw error;
  } finally {
    if (child?.exitCode === null) child.kill('SIGTERM');
    if (child?.exitCode === null) {
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
    if (child?.exitCode === null) {
      child.kill();
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }
    await closeServer(bridge);
    await Promise.race([mock.close(), new Promise((resolve) => setTimeout(resolve, 2_000))]);
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    assert.equal(existsSync(root), false, 'the disposable OpenCodex profile must be removed');
  }
});
