import {
  buildEndpointFingerprint,
  digestOf,
  readDimension,
  unreadableDimension,
} from '../governance-domain/routing/endpoint-fingerprint.mjs';

/**
 * Captures an endpoint fingerprint from the deployed control plane.
 *
 * Every call is a read. There is no parameter through which a request payload could
 * be supplied and no code path that names a mutating verb, which is a property of
 * this file rather than an intention, and `assertReadOnlySource` is run over it.
 *
 * Each dimension is read independently and a failure degrades only that dimension,
 * because a capture that reports four dimensions and hides the fifth is worse than
 * one that says which fifth it could not read.
 */

const APIM_API_VERSION = '2024-05-01';
const PROVIDER_API_VERSION = '2024-10-01';
const LINKS_API_VERSION = '2016-09-01';
const METRICS_API_VERSION = '2018-01-01';
const AUTHORIZATION_API_VERSION = '2022-04-01';
const MANAGEMENT_SCOPE = 'https://management.azure.com/.default';
const ARM = 'https://management.azure.com';

// The counters a rollback must not cause to double-count. Named rather than
// discovered, so a provider that stops publishing one shows up as a lost counter.
const TRACKED_COUNTERS = Object.freeze(['Requests', 'ModelRequests', 'TotalTokens', 'InputTokens', 'OutputTokens']);

const DEFAULT_AUTH_NAMED_VALUES = Object.freeze({
  audience: 'entra-api-audience',
  acceptedClientIds: ['entra-client-application-id', 'entra-developer-client-application-id'],
  requiredScope: 'entra-required-scope',
  requiredAppRole: 'entra-workload-app-role',
});

const ENDPOINT_CLASS_BY_MODE = Object.freeze({
  FoundryIntegrated: 'foundry-project',
  ExplicitApim: 'apim-gateway',
  PrivateNoBypass: 'apim-gateway',
  DirectResourceAllowed: 'provider-account',
});

function fail(message) {
  throw new TypeError(message);
}

function hostOf(url) {
  try {
    return digestOf(new URL(url).host);
  } catch {
    return digestOf(String(url));
  }
}

async function armGet(url, { getToken }) {
  const token = await getToken();
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!response.ok) {
    const error = new Error('arm-read-failed');
    error.code = 'arm-read-failed';
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function apimScope({ subscriptionId, apimResourceGroupName, apimName }) {
  return `${ARM}/subscriptions/${subscriptionId}/resourceGroups/${apimResourceGroupName}`
    + `/providers/Microsoft.ApiManagement/service/${apimName}`;
}

function providerScope({ subscriptionId, providerResourceGroupName, providerAccountName }) {
  return `${ARM}/subscriptions/${subscriptionId}/resourceGroups/${providerResourceGroupName}`
    + `/providers/Microsoft.CognitiveServices/accounts/${providerAccountName}`;
}

async function readApimRoutes(read, scope, apiName) {
  const operations = await read(`${scope}/apis/${apiName}/operations?api-version=${APIM_API_VERSION}`);
  return (operations.value ?? [])
    .map((operation) => `operation|${operation.properties?.method ?? 'unknown'}|${operation.properties?.urlTemplate ?? '/'}`)
    .sort();
}

async function readEndpoint(read, mode, target) {
  const baseClass = ENDPOINT_CLASS_BY_MODE[mode];

  if (mode === 'DirectResourceAllowed') {
    if (!target.providerAccountName) return unreadableDimension('dimension-not-attempted');
    const account = await read(`${providerScope(target)}?api-version=${PROVIDER_API_VERSION}`);
    const deployments = await read(`${providerScope(target)}/deployments?api-version=${PROVIDER_API_VERSION}`);
    return readDimension({
      baseUrlClass: `${baseClass}/openai/v1`,
      hostDigest: hostOf(account.properties?.endpoint ?? ''),
      routes: (deployments.value ?? []).map((deployment) => `deployment|${deployment.name}`).sort(),
    });
  }

  if (!target.apimName || !target.governedApiName) return unreadableDimension('dimension-not-attempted');
  const service = await read(`${apimScope(target)}?api-version=${APIM_API_VERSION}`);
  const api = await read(`${apimScope(target)}/apis/${target.governedApiName}?api-version=${APIM_API_VERSION}`);
  const routes = await readApimRoutes(read, apimScope(target), target.governedApiName);
  const path = api.properties?.path ?? '';

  return readDimension({
    // For the Foundry-integrated mode the caller keeps the project endpoint, so the
    // class names the project while the routes still come from the associated
    // gateway; those are two different facts and the delta must keep them apart.
    baseUrlClass: mode === 'FoundryIntegrated'
      ? `${baseClass}/${target.projectName ?? 'unnamed'}`
      : `${baseClass}/${path}`,
    hostDigest: hostOf(service.properties?.gatewayUrl ?? ''),
    routes,
  });
}

function namedValueMap(namedValues) {
  return new Map((namedValues.value ?? []).map((entry) => [entry.name, entry.properties ?? {}]));
}

/**
 * Reads one named value's configured value.
 *
 * The collection read omits `value` entirely, so a caller that trusted the list
 * would find every field absent and report an empty auth contract. A secret-marked
 * entry is not fetched at all: this tool never asks for one.
 */
async function readNamedValue(read, target, entries, name) {
  const entry = entries.get(name);
  if (entry === undefined || entry.secret === true) return null;
  const single = await read(`${apimScope(target)}/namedValues/${name}?api-version=${APIM_API_VERSION}`);
  const value = single.properties?.value;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

async function readGatewayAuth(read, target, authNames) {
  const entries = namedValueMap(await read(`${apimScope(target)}/namedValues?api-version=${APIM_API_VERSION}`));
  const audience = await readNamedValue(read, target, entries, authNames.audience);
  const requiredScope = await readNamedValue(read, target, entries, authNames.requiredScope);
  const requiredAppRole = await readNamedValue(read, target, entries, authNames.requiredAppRole);
  const acceptedClientIds = [];
  for (const name of authNames.acceptedClientIds) {
    const value = await readNamedValue(read, target, entries, name);
    if (value !== null) acceptedClientIds.push(value);
  }

  if (audience === null || requiredScope === null || requiredAppRole === null || acceptedClientIds.length === 0) {
    // Three of four fields is not a smaller answer about the caller contract.
    return unreadableDimension('reading-incomplete');
  }
  return readDimension({ audience, acceptedClientIds: acceptedClientIds.sort(), requiredScope, requiredAppRole });
}

async function readDirectAuth(read, target) {
  if (!target.providerAccountName) return unreadableDimension('dimension-not-attempted');
  const scope = providerScope(target);
  const assignments = await read(
    `${scope}/providers/Microsoft.Authorization/roleAssignments?api-version=${AUTHORIZATION_API_VERSION}`,
  );
  const rows = assignments.value ?? [];
  if (rows.length === 0) return unreadableDimension('reading-incomplete');
  return readDimension({
    audience: 'provider-account',
    acceptedClientIds: [...new Set(rows.map((row) => digestOf(row.properties?.principalId ?? '')))].sort(),
    requiredScope: digestOf(scope),
    requiredAppRole: [...new Set(rows.map((row) => String(row.properties?.roleDefinitionId ?? '').split('/').pop()))]
      .sort()
      .join('|'),
  });
}

async function readTopology(read, target) {
  const scope = apimScope(target);
  const apis = await read(`${scope}/apis?api-version=${APIM_API_VERSION}`);
  const backends = await read(`${scope}/backends?api-version=${APIM_API_VERSION}`);
  const namedValues = await read(`${scope}/namedValues?api-version=${APIM_API_VERSION}`);
  const servicePolicy = await read(`${scope}/policies/policy?api-version=${APIM_API_VERSION}&format=rawxml`);

  const policyScopes = [`service|${digestOf(servicePolicy.properties?.value ?? '')}`];
  if (target.governedApiName) {
    const apiPolicy = await read(
      `${scope}/apis/${target.governedApiName}/policies/policy?api-version=${APIM_API_VERSION}&format=rawxml`,
    );
    policyScopes.push(`api:${target.governedApiName}|${digestOf(apiPolicy.properties?.value ?? '')}`);
  }

  let projectRoutingState = 'unknown';
  try {
    const links = await read(
      `${providerScope(target)}/providers/Microsoft.Resources/links?api-version=${LINKS_API_VERSION}`,
    );
    const routed = (links.value ?? []).some((link) =>
      String(link.properties?.targetId ?? '').toLowerCase().includes('/microsoft.apimanagement/service/'));
    projectRoutingState = routed ? 'enabled' : 'disabled';
  } catch {
    projectRoutingState = 'unreadable';
  }

  return readDimension({
    apis: (apis.value ?? []).map((api) => `${api.name}|${api.properties?.path ?? ''}`).sort(),
    backends: (backends.value ?? [])
      .map((backend) => `${backend.name}|${backend.properties?.type ?? 'Single'}|${hostOf(backend.properties?.url ?? '')}`)
      .sort(),
    policyScopes: policyScopes.sort(),
    namedValueNames: (namedValues.value ?? [])
      .map((entry) => (entry.properties?.secret === true ? `${entry.name}|protected` : entry.name))
      .sort(),
    projectRoutingState,
  });
}

async function readMetricCatalogue(read, resourceScope, sourceClass) {
  const definitions = await read(`${resourceScope}/providers/Microsoft.Insights/metricDefinitions?api-version=${METRICS_API_VERSION}`);
  return (definitions.value ?? [])
    .filter((definition) => TRACKED_COUNTERS.includes(definition.name?.value))
    .map((definition) => `${sourceClass}|${definition.name.value}|${definition.primaryAggregationType ?? 'Total'}`)
    .sort();
}

async function readMetric(read, target) {
  const counters = [
    ...await readMetricCatalogue(read, apimScope(target), 'apim-service'),
    ...await readMetricCatalogue(read, providerScope(target), 'provider-account'),
  ].sort();
  if (counters.length === 0) return unreadableDimension('reading-incomplete');
  return readDimension({
    counters,
    counterSources: [
      `apim-service|${digestOf(apimScope(target))}`,
      `provider-account|${digestOf(providerScope(target))}`,
    ].sort(),
  });
}

function readCompatibility(compatibility) {
  if (compatibility === undefined) fail('compatibility must be declared or explicitly null.');
  if (compatibility === null) return unreadableDimension('compatibility-not-declared');
  const { callerClasses, declarationSource } = compatibility;
  if (!Array.isArray(callerClasses) || callerClasses.length === 0 || typeof declarationSource !== 'string') {
    return unreadableDimension('compatibility-not-declared');
  }
  return readDimension({ callerClasses: [...callerClasses].sort(), declarationSource });
}

async function attempt(reader, reasonCode) {
  try {
    return await reader();
  } catch {
    return unreadableDimension(reasonCode);
  }
}

export async function captureEndpointFingerprint({
  mode,
  target,
  compatibility,
  credential,
  transport = armGet,
  authNamedValues = DEFAULT_AUTH_NAMED_VALUES,
  now = () => new Date().toISOString(),
}) {
  if (target === null || typeof target !== 'object') fail('target must be an object.');
  if (typeof target.subscriptionId !== 'string' || target.subscriptionId.length === 0) {
    fail('target.subscriptionId is required.');
  }

  const getToken = async () => {
    const token = await credential.getToken(MANAGEMENT_SCOPE);
    if (token?.token === undefined) fail('The credential returned no management token.');
    return token.token;
  };
  const read = (url) => transport(url, { getToken });

  const dimensions = {
    endpoint: await attempt(() => readEndpoint(read, mode, target), 'gateway-unreadable'),
    auth: mode === 'DirectResourceAllowed'
      ? await attempt(() => readDirectAuth(read, target), 'named-values-unreadable')
      : await attempt(() => readGatewayAuth(read, target, authNamedValues), 'named-values-unreadable'),
    topology: await attempt(() => readTopology(read, target), 'policy-unreadable'),
    metric: await attempt(() => readMetric(read, target), 'metric-definitions-unreadable'),
    compatibility: readCompatibility(compatibility),
  };

  return buildEndpointFingerprint({
    mode,
    capturedAt: now(),
    sourceRevision: `arm-${APIM_API_VERSION}`,
    dimensions,
  });
}

export { DEFAULT_AUTH_NAMED_VALUES, TRACKED_COUNTERS };
