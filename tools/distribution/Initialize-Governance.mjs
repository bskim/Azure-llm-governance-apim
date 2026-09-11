#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { AzureCliCredential } from '@azure/identity';

import { buildInitialGovernanceSet } from '../../app/governance-domain/policy/initial-governance-set.mjs';
import { readAccountRegion, readProviderQuota } from '../../app/providers/foundry-quota-query.mjs';
import { deviceCodeAcquirer } from '../agent-auth-bridge/agent-auth-bridge.mjs';

const REDIRECT_URI = 'http://localhost:4173/governance-bootstrap';
const PUBLISHING_ROLES = Object.freeze(['Governance.Administer', 'Governance.Own']);
const LOGIN_HOST = 'https://login.microsoftonline.com';
const PKCE_TIMEOUT_MS = 10 * 60 * 1000;
// Bootstrapping is interactive: the operator leaves the terminal, finds a browser, and
// signs in. This must stay above the provider's own device-code lifetime so the code
// expiring is what ends the wait, rather than a shorter deadline of our own.
const DEVICE_CODE_TIMEOUT_MS = 20 * 60 * 1000;
const SIGN_IN_MODES = Object.freeze(['device-code', 'browser']);

export const INITIALIZER_REASONS = Object.freeze({
  targetMismatch: 'initializer-target-mismatch',
  tokenUnreadable: 'initializer-token-unreadable',
  tokenTenantMismatch: 'initializer-token-tenant-mismatch',
  tokenAudienceMismatch: 'initializer-token-audience-mismatch',
  tokenClientMismatch: 'initializer-token-client-mismatch',
  tokenRoleAbsent: 'initializer-token-role-absent',
  tokenExpired: 'initializer-token-expired',
  controlPlaneNotReady: 'initializer-control-plane-not-ready',
  publishInProgress: 'publish-in-progress',
  resumeRevisionRequired: 'initializer-resume-revision-required',
  alreadyInitialized: 'governance-already-initialized',
  publishRefused: 'initializer-publish-refused',
  publishIncomplete: 'initializer-publish-incomplete',
});

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

export function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith('--')) throw new TypeError(`Unexpected argument ${flag}.`);
    const name = flag.slice(2);
    if (['dry-run', 'resume'].includes(name)) {
      options[name] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new TypeError(`${flag} requires a value.`);
    if (name === 'sign-in' && !SIGN_IN_MODES.includes(value)) {
      throw new TypeError(`--sign-in must be one of ${SIGN_IN_MODES.join(', ')}.`);
    }
    options[name] = value;
    index += 1;
  }
  return options;
}

export function createProcessRunner() {
  return (command, args) => new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${command} exited ${code}: ${stderr.trim().split('\n').at(-1) ?? ''}`));
    });
  });
}

const AZD_TARGETS = Object.freeze({
  controlPlaneEndpoint: 'CONTROL_PLANE_ENDPOINT',
  tenantId: 'ENTRA_TENANT_ID',
  audience: 'ENTRA_ADMIN_API_AUDIENCE',
  scope: 'ENTRA_ADMIN_API_SCOPE',
  clientId: 'ENTRA_ADMIN_SPA_APPLICATION_ID',
  foundryAccountResourceId: 'FOUNDRY_ACCOUNT_RESOURCE_ID',
  scopeGroupId: 'GOVERNANCE_SCOPE',
  knownTeamKeys: 'GOVERNANCE_TEAMS',
  membershipGroupIds: 'GOVERNANCE_MEMBERSHIP_GROUPS',
  membershipSource: 'GOVERNANCE_MEMBERSHIP_SOURCE',
});

export async function readAzdTargets({ environment, runProcess = createProcessRunner() }) {
  if (typeof environment !== 'string' || environment.length === 0) throw new TypeError('--environment is required.');
  const targets = {};
  for (const [key, name] of Object.entries(AZD_TARGETS)) {
    const value = await runProcess('azd', ['env', 'get-value', name, '--environment', environment]);
    if (value.length === 0) throw new Error(`azd reported no value for ${name}.`);
    targets[key] = value;
  }
  return targets;
}

export function parseFoundryAccountResourceId(resourceId) {
  const match = /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.CognitiveServices\/accounts\/([^/]+)$/i.exec(resourceId);
  if (match === null) throw new TypeError('FOUNDRY_ACCOUNT_RESOURCE_ID is not an account resource identifier.');
  return { subscriptionId: match[1], resourceGroupName: match[2], accountName: match[3] };
}

export function readTokenClaims(accessToken) {
  const parts = String(accessToken).split('.');
  if (parts.length !== 3) throw failure(INITIALIZER_REASONS.tokenUnreadable, 'The token is not readable.');
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw failure(INITIALIZER_REASONS.tokenUnreadable, 'The token is not readable.');
  }
}

export function assertTokenUsable(claims, { tenantId, audience, clientId, at }) {
  if (claims.tid !== tenantId) throw failure(INITIALIZER_REASONS.tokenTenantMismatch, 'The token belongs to another tenant.');
  if (!(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(audience)) {
    throw failure(INITIALIZER_REASONS.tokenAudienceMismatch, 'The token belongs to another audience.');
  }
  if (![claims.azp, claims.appid].includes(clientId)) {
    throw failure(INITIALIZER_REASONS.tokenClientMismatch, 'The token was issued to another client application.');
  }
  if (!Array.isArray(claims.roles) || !claims.roles.some((role) => PUBLISHING_ROLES.includes(role))) {
    throw failure(INITIALIZER_REASONS.tokenRoleAbsent, 'The token carries no publishing role.');
  }
  if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.parse(at)) {
    throw failure(INITIALIZER_REASONS.tokenExpired, 'The token has expired.');
  }
}

export function buildAuthorizationUrl({ tenantId, clientId, scope, state, challenge }) {
  const url = new URL(`${LOGIN_HOST}/${tenantId}/oauth2/v2.0/authorize`);
  url.search = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    response_mode: 'query',
    scope,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return url.toString();
}

export function createPkceAuthorizer({
  transport = fetch,
  writeLine = console.log,
  tokenRequestOrigin = null,
  createServerImpl = createServer,
} = {}) {
  return async function authorize({ tenantId, clientId, scope }) {
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const state = randomBytes(16).toString('base64url');
    const authorizeUrl = buildAuthorizationUrl({ tenantId, clientId, scope, state, challenge });
    const code = await new Promise((resolve, reject) => {
      let timer;
      const server = createServerImpl((request, response) => {
        const callback = new URL(request.url, REDIRECT_URI);
        if (request.method !== 'GET' || callback.pathname !== new URL(REDIRECT_URI).pathname) {
          response.writeHead(404).end();
          return;
        }
        const receivedState = callback.searchParams.get('state');
        const receivedCode = callback.searchParams.get('code');
        const receivedError = callback.searchParams.get('error');
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' });
        response.end(receivedCode ? 'Sign-in received. You can close this tab.' : 'Sign-in was not completed.');
        clearTimeout(timer);
        server.close();
        if (receivedState !== state) reject(new Error('The sign-in callback state did not match.'));
        else if (receivedError !== null) reject(new Error(`The sign-in was refused: ${receivedError}.`));
        else if (receivedCode === null) reject(new Error('The sign-in callback carried no authorization code.'));
        else resolve(receivedCode);
      });
      server.on('error', reject);
      server.listen(4173, '127.0.0.1', () => {
        timer = setTimeout(() => {
          server.close();
          reject(new Error('The sign-in did not complete within ten minutes.'));
        }, PKCE_TIMEOUT_MS);
        writeLine('Open this URL in your browser and select the assigned administrator account:');
        writeLine(authorizeUrl);
      });
    });
    const response = await transport(`${LOGIN_HOST}/${tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...(tokenRequestOrigin === null ? {} : { Origin: tokenRequestOrigin }),
      },
      body: new URLSearchParams({
        client_id: clientId,
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
        scope,
      }),
    });
    if (!response.ok) throw new Error('The token endpoint refused the authorization code.');
    const payload = await response.json();
    if (typeof payload.access_token !== 'string') throw new Error('The token endpoint returned no access token.');
    return payload.access_token;
  };
}

/**
 * Signs in by device code, so the tool also works where no browser can receive a
 * loopback redirect (a jump host, a container, an isolated network, CI).
 *
 * Reuses the bridge's own acquirer rather than a second implementation: it keeps the
 * refresh token in process memory, so a run that calls `authorize` more than once (a
 * `--resume` after a partial publish) does not ask for a second sign-in.
 */
export function createDeviceCodeAuthorizer({ writeLine = console.log, fetchImpl, sleep, now } = {}) {
  let acquire = null;
  return async function authorize({ tenantId, clientId, scope }) {
    if (acquire === null) {
      acquire = deviceCodeAcquirer({
        tenantId,
        clientId,
        scope: `${scope} offline_access`,
        timeoutMs: DEVICE_CODE_TIMEOUT_MS,
        onPrompt: ({ verificationUri, userCode, expiresInSeconds }) => {
          writeLine(`Open ${verificationUri} and enter code ${userCode}`);
          writeLine(`The code is valid for about ${Math.round(expiresInSeconds / 60)} minutes.`);
        },
        ...(fetchImpl === undefined ? {} : { fetchImpl }),
        ...(sleep === undefined ? {} : { sleep }),
        ...(now === undefined ? {} : { now }),
      });
    }
    const result = await acquire();
    return result.token;
  };
}

function assertTargetContract(input, targets) {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || !Array.isArray(input.teams)) {
    throw new TypeError('The input must be an object with a teams array.');
  }
  const expectedTeams = targets.knownTeamKeys.split(',').map((team) => team.trim()).sort();
  const inputTeams = input.teams.map((team) => team.teamKey).sort();
  const expectedGroups = targets.membershipGroupIds.split(',').filter(Boolean).sort();
  const inputGroups = input.teams.map((team) => team.membershipGroupId).sort();
  if (input.tenantId !== targets.tenantId
      || input.scopeGroupId !== targets.scopeGroupId
      || targets.membershipSource !== 'directory-claim'
      || JSON.stringify(inputTeams) !== JSON.stringify(expectedTeams)
      || JSON.stringify(inputGroups) !== JSON.stringify(expectedGroups)) {
    throw failure(INITIALIZER_REASONS.targetMismatch, 'The input tenant, scope, teams, or governed groups do not match the deployment settings.');
  }
}

function assertHttpsEndpoint(endpoint) {
  let url;
  try { url = new URL(endpoint); } catch { throw new TypeError('The control-plane endpoint must be an HTTPS URL.'); }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new TypeError('The control-plane endpoint must be an HTTPS URL without credentials.');
  }
}

export async function initializeGovernance({
  input,
  targets,
  readProvider,
  authorize,
  checkReadiness,
  publish,
  at,
  now = () => new Date().toISOString(),
  dryRun = false,
  resume = false,
  revisionId = null,
}) {
  assertTargetContract(input, targets);
  let built = null;
  if (!resume || dryRun) {
    const provider = await readProvider(targets);
    built = buildInitialGovernanceSet({ input, deployments: provider.deployments, at });
  }
  if (dryRun) return { outcome: 'validated', ...built.summary };
  if (resume && (typeof revisionId !== 'string' || !/^revision-[0-9]{4}$/.test(revisionId))) {
    throw failure(
      INITIALIZER_REASONS.resumeRevisionRequired,
      '--resume requires --revision-id for the held bootstrap revision.',
    );
  }
  assertHttpsEndpoint(targets.controlPlaneEndpoint);
  if (typeof checkReadiness !== 'function') {
    throw new TypeError('checkReadiness is required.');
  }
  const accessToken = await authorize(targets);
  assertTokenUsable(readTokenClaims(accessToken), {
    tenantId: targets.tenantId,
    audience: targets.audience,
    clientId: targets.clientId,
    at: now(),
  });
  const readiness = await checkReadiness({
    url: `${targets.controlPlaneEndpoint.replace(/\/$/, '')}/api/v1/admin/overview`,
    accessToken,
  });
  if (readiness.anonymousStatus !== 401 || readiness.anonymousBodyBytes !== 0 || readiness.status !== 200) {
    throw failure(
      INITIALIZER_REASONS.controlPlaneNotReady,
      `The administration route is not ready (anonymous HTTP ${readiness.anonymousStatus}/${readiness.anonymousBodyBytes} bytes, authenticated HTTP ${readiness.status}). No publication was attempted.`,
    );
  }
  const response = await publish({
    url: `${targets.controlPlaneEndpoint.replace(/\/$/, '')}/api/v1/admin/governance/publish`,
    accessToken,
    body: resume
      ? { initialOnly: true, resume: true, revisionId }
      : { content: built.content, initialOnly: true },
  });
  if (response.status === 409 && response.body?.reasonCode === 'publish-in-progress') {
    throw failure(INITIALIZER_REASONS.publishInProgress, 'A publication is already in progress; rerun with --resume.');
  }
  if (response.status === 409 && response.body?.reasonCode === 'governance-already-initialized') {
    throw failure(INITIALIZER_REASONS.alreadyInitialized, 'Governance is already initialized; use the administration console for later changes.');
  }
  if (response.status !== 200) {
    const serverCode = response.body?.error?.code ?? response.body?.reasonCode ?? 'unknown';
    throw failure(
      INITIALIZER_REASONS.publishRefused,
      `The publication route refused the request (HTTP ${response.status}): ${serverCode}.`,
    );
  }
  const verified = Array.isArray(response.body?.targets)
    && response.body.targets.length === 5
    && response.body.targets.every((target) => target.outcome === 'verified');
  if (response.body?.state !== 'active' || !verified) {
    const failed = Array.isArray(response.body?.targets)
      ? response.body.targets.filter((target) => target.outcome !== 'verified').map((target) => target.targetCode)
      : [];
    const message = failed.length === 0
      ? 'All five targets verified, but the revision did not become active.'
      : `The publication could not verify: ${failed.join(', ')}.`;
    throw failure(INITIALIZER_REASONS.publishIncomplete, message);
  }
  return {
    outcome: 'active',
    revisionId: response.body.revisionId,
    revisionNumber: response.body.revisionNumber,
    targets: response.body.targets,
    expiresAt: built?.summary.expiresAt ?? null,
  };
}

async function publishRequest({ url, accessToken, body }) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let responseBody = null;
  try { responseBody = await response.json(); } catch { /* refusal body may be empty */ }
  return { status: response.status, body: responseBody };
}

async function checkReadinessRequest({ url, accessToken }) {
  const anonymous = await fetch(url, { method: 'GET' });
  const anonymousBody = await anonymous.arrayBuffer();
  const overview = await fetch(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${accessToken}` },
  });
  return {
    anonymousStatus: anonymous.status,
    anonymousBodyBytes: anonymousBody.byteLength,
    status: overview.status,
  };
}

async function main(argv) {
  const options = parseArguments(argv);
  if (typeof options.input !== 'string' || typeof options.environment !== 'string') {
    throw new TypeError('--input and --environment are required.');
  }
  const input = JSON.parse(await readFile(options.input, 'utf8'));
  const targets = await readAzdTargets({ environment: options.environment });
  const account = parseFoundryAccountResourceId(targets.foundryAccountResourceId);
  const credential = new AzureCliCredential();
  const at = new Date().toISOString();
  const signInMode = options['sign-in'] ?? 'device-code';
  const result = await initializeGovernance({
    input,
    targets,
    at,
    dryRun: options['dry-run'] === true,
    resume: options.resume === true,
    revisionId: options['revision-id'] ?? null,
    readProvider: async () => {
      const region = await readAccountRegion({ ...account, credential });
      return readProviderQuota({ ...account, region, credential });
    },
    authorize: signInMode === 'browser' ? createPkceAuthorizer() : createDeviceCodeAuthorizer(),
    checkReadiness: checkReadinessRequest,
    publish: publishRequest,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`${error.code ?? 'initializer-failed'}: ${error.message}`);
    if (typeof error.detail === 'string') console.error(error.detail);
    process.exitCode = 1;
  });
}