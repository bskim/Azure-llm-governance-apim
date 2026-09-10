#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

import { AzureCliCredential } from '@azure/identity';

/**
 * Repairs a fresh Flex Consumption Easy Auth deployment.
 *
 * `infra/modules/control-plane-authentication.bicep` authors the neutral principal
 * policy without an `allowedApplications` key, but App Service can still materialize
 * that key as an empty array on the first apply. An empty array is enforced as
 * deny-all and refuses every administration token with a bodyless 403; an absent key
 * is the intended no-client-allowlist posture. A second `azd provision` does not
 * repair this, because azd skips when it finds no template change.
 *
 * This is a full read-modify-write over the one live document: delete only the empty
 * key and send everything else back exactly as read, then read again and compare
 * every field to prove nothing else moved.
 */

const ARM_API_VERSION = '2024-04-01';
const MANAGEMENT_SCOPE = 'https://management.azure.com/.default';
const AUTHORIZATION_POLICY_PATH =
  'properties.identityProviders.azureActiveDirectory.validation.defaultAuthorizationPolicy';
const ALLOWED_APPLICATIONS_PATH = `${AUTHORIZATION_POLICY_PATH}.allowedApplications`;

// Names this repository already publishes through azd; a hook runs with the azd
// environment injected, so these arrive as ordinary process environment variables.
const REQUIRED_ENVIRONMENT = Object.freeze({
  subscriptionId: 'AZURE_SUBSCRIPTION_ID',
  resourceGroupName: 'GATEWAY_RESOURCE_GROUP_NAME',
  siteName: 'CONTROL_PLANE_FUNCTION_APP',
});

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

export function readRequiredEnvironment(env = process.env) {
  const values = {};
  for (const [key, name] of Object.entries(REQUIRED_ENVIRONMENT)) {
    const value = env[name];
    if (typeof value !== 'string' || value.length === 0) {
      throw failure('easy-auth-repair-environment-missing', `${name} is required but was not set.`);
    }
    values[key] = value;
  }
  return values;
}

export function buildConfigurationUrl({ subscriptionId, resourceGroupName, siteName }) {
  return (
    `https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}` +
    `/providers/Microsoft.Web/sites/${siteName}/config/authsettingsV2?api-version=${ARM_API_VERSION}`
  );
}

async function armRequest(url, { method, body, getToken }) {
  const token = await getToken();
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw Object.assign(new Error('arm-request-failed'), { code: 'arm-request-failed', status: response.status });
  }
  return response.json();
}

export function createArmTransport({ subscriptionId, resourceGroupName, siteName, credential, request = armRequest }) {
  const url = buildConfigurationUrl({ subscriptionId, resourceGroupName, siteName });
  const getToken = async () => {
    const token = await credential.getToken(MANAGEMENT_SCOPE);
    if (token?.token === undefined) {
      throw failure('easy-auth-repair-token-unavailable', 'The credential returned no management token.');
    }
    return token.token;
  };
  return {
    read: () => request(url, { method: 'GET', getToken }),
    write: (document) => request(url, { method: 'PUT', body: document, getToken }),
  };
}

function readPath(value, path) {
  return path.split('.').reduce((node, key) => (node === undefined || node === null ? undefined : node[key]), value);
}

// Compares every leaf value between two documents so a write that moved an unrelated
// field is reported rather than absorbed. An object with no keys of its own (such as
// an empty `allowedPrincipals: {}`) is treated as a leaf so it still compares equal.
function collectLeaves(value, prefix, into) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0) {
    for (const [key, child] of Object.entries(value)) collectLeaves(child, prefix ? `${prefix}.${key}` : key, into);
    return;
  }
  into.set(prefix, value);
}

export function diffDocuments(before, after, ignoredPaths = []) {
  const beforeLeaves = new Map();
  const afterLeaves = new Map();
  collectLeaves(before, '', beforeLeaves);
  collectLeaves(after, '', afterLeaves);
  const changed = [];
  for (const path of new Set([...beforeLeaves.keys(), ...afterLeaves.keys()])) {
    if (ignoredPaths.includes(path)) continue;
    if (JSON.stringify(beforeLeaves.get(path)) !== JSON.stringify(afterLeaves.get(path))) changed.push(path);
  }
  return changed.sort();
}

export async function repairEasyAuthClientAllowlist({ transport, log = () => {} }) {
  const before = await transport.read();
  const policy = readPath(before, AUTHORIZATION_POLICY_PATH);

  if (policy === undefined) {
    log('defaultAuthorizationPolicy is absent; there is no allowedApplications key to repair.');
    return { outcome: 'absent' };
  }
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) {
    throw failure('easy-auth-repair-unreadable-shape', 'The authentication document did not carry the expected policy shape.');
  }
  if (!('allowedApplications' in policy)) {
    log('allowedApplications is absent; the client allowlist key is already omitted. No action taken.');
    return { outcome: 'absent' };
  }
  if (!Array.isArray(policy.allowedApplications) || policy.allowedApplications.length > 0) {
    log('allowedApplications is present and non-empty; left unchanged.');
    return { outcome: 'populated' };
  }

  const repaired = structuredClone(before);
  delete readPath(repaired, AUTHORIZATION_POLICY_PATH).allowedApplications;
  await transport.write(repaired);

  const after = await transport.read();
  const drift = diffDocuments(before, after, [ALLOWED_APPLICATIONS_PATH]);
  if (drift.length > 0) {
    throw failure(
      'easy-auth-repair-unexpected-drift',
      `The write changed fields other than allowedApplications: ${drift.join(', ')}.`,
    );
  }
  log('allowedApplications was empty and has been removed.');
  return { outcome: 'repaired' };
}

async function main() {
  const environment = readRequiredEnvironment();
  const credential = new AzureCliCredential();
  const transport = createArmTransport({ ...environment, credential });
  const result = await repairEasyAuthClientAllowlist({ transport, log: (message) => console.log(message) });
  console.log(`easy-auth-client-allowlist-repair: ${result.outcome}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`${error.code ?? 'easy-auth-repair-failed'}: ${error.message}`);
    process.exitCode = 1;
  });
}
