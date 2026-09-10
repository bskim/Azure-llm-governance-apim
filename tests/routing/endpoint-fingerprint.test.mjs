import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { captureEndpointFingerprint } from '../../app/gateway/endpoint-fingerprint-query.mjs';
import {
  DIMENSION_FIELDS,
  FINGERPRINT_DIMENSIONS,
  GOVERNANCE_MODES,
  assertEndpointFingerprint,
  assertReadOnlySource,
  buildEndpointFingerprint,
  compareEndpointFingerprints,
  readDimension,
  renderComparison,
  unreadableDimension,
} from '../../app/governance-domain/routing/endpoint-fingerprint.mjs';

const TOOL_SOURCES = [
  'app/governance-domain/routing/endpoint-fingerprint.mjs',
  'app/gateway/endpoint-fingerprint-query.mjs',
  'tools/azure/capture-endpoint-fingerprint.mjs',
];

const READINGS = {
  endpoint: {
    baseUrlClass: 'apim-gateway/v1',
    hostDigest: '1111222233334444',
    routes: ['operation|POST|/chat/completions', 'operation|POST|/responses'],
  },
  auth: {
    audience: 'api://00000000-0000-0000-0000-000000000001',
    acceptedClientIds: ['00000000-0000-0000-0000-000000000002'],
    requiredScope: 'Gateway.Access',
    requiredAppRole: 'disabled',
  },
  topology: {
    apis: ['inference|v1'],
    backends: ['example-pool|Pool|5555666677778888'],
    policyScopes: ['api:inference|aaaabbbbccccdddd', 'service|eeeeffff00001111'],
    namedValueNames: ['entra-audience', 'gateway-policy-version'],
    projectRoutingState: 'enabled',
  },
  metric: {
    counters: ['apim-service|Requests|Total', 'provider-account|TotalTokens|Total'],
    counterSources: ['apim-service|9999888877776666', 'provider-account|4444333322221111'],
  },
  compatibility: {
    callerClasses: ['codex-cli', 'copilot-cli'],
    declarationSource: 'rollback-plan',
  },
};

function completeDimensions(overrides = {}) {
  return Object.fromEntries(FINGERPRINT_DIMENSIONS.map((name) => [
    name,
    overrides[name] ?? readDimension(structuredClone(READINGS[name])),
  ]));
}

function fingerprint({ mode = 'ExplicitApim', capturedAt = '2026-08-18T00:00:00Z', overrides = {} } = {}) {
  return buildEndpointFingerprint({
    mode,
    capturedAt,
    sourceRevision: 'arm-2024-05-01',
    dimensions: completeDimensions(overrides),
  });
}

function compare(baseline, observed, restores = [], documentedResiduals = []) {
  return compareEndpointFingerprints({ baseline, observed, restores, documentedResiduals });
}

function dimensionOf(comparison, name) {
  return comparison.dimensions.find((entry) => entry.dimension === name);
}

test('a complete capture names every dimension and declares itself complete', () => {
  const captured = fingerprint();
  assert.equal(captured.completeness, 'complete');
  assert.deepEqual(captured.unreadableDimensions, []);
  assert.deepEqual(Object.keys(captured.dimensions).sort(), [...FINGERPRINT_DIMENSIONS].sort());
});

test('a dimension that could not be read makes the capture partial and names itself', () => {
  const captured = fingerprint({ overrides: { metric: unreadableDimension('metric-definitions-unreadable') } });
  assert.equal(captured.completeness, 'partial');
  assert.deepEqual(captured.unreadableDimensions, ['metric']);
  assert.equal(captured.dimensions.metric.reasonCode, 'metric-definitions-unreadable');
  assert.equal(captured.dimensions.metric.reading, undefined);
});

test('a capture that claims to be complete while a dimension is unreadable is refused', () => {
  const forged = fingerprint({ overrides: { metric: unreadableDimension('metric-definitions-unreadable') } });
  forged.completeness = 'complete';
  forged.unreadableDimensions = [];
  assert.throws(() => assertEndpointFingerprint(forged), /unreadableDimensions must list exactly/);

  const stillForged = fingerprint({ overrides: { auth: unreadableDimension('named-values-unreadable') } });
  stillForged.completeness = 'complete';
  assert.throws(() => assertEndpointFingerprint(stillForged), (error) =>
    error.code === 'fingerprint-completeness-misdeclared');
});

test('an omitted dimension is refused rather than defaulted to unreadable', () => {
  const partial = completeDimensions();
  delete partial.topology;
  assert.throws(
    () => buildEndpointFingerprint({
      mode: 'ExplicitApim',
      capturedAt: '2026-08-18T00:00:00Z',
      sourceRevision: 'arm-2024-05-01',
      dimensions: partial,
    }),
    /dimensions must name every dimension; \[topology\] were omitted/,
  );
});

test('a reading missing one field is refused instead of published as a smaller reading', () => {
  const short = structuredClone(READINGS.auth);
  delete short.requiredAppRole;
  assert.throws(
    () => fingerprint({ overrides: { auth: readDimension(short) } }),
    /fingerprint.dimensions.auth.reading must carry exactly/,
  );
});

test('an unreadable dimension cannot smuggle a reading alongside its reason code', () => {
  const smuggled = { state: 'unreadable', reasonCode: 'named-values-unreadable', reading: READINGS.auth };
  assert.throws(() => fingerprint({ overrides: { auth: smuggled } }), /must carry exactly \[reasonCode, state\]/);
});

test('an unreadable dimension never compares equal to a read one carrying the same reading', () => {
  const baseline = fingerprint();
  const observed = fingerprint({ overrides: { auth: unreadableDimension('named-values-unreadable') } });

  const forward = compare(baseline, observed);
  const auth = dimensionOf(forward, 'auth');
  assert.equal(auth.state, 'not-compared');
  assert.equal(auth.verdict, 'unrestored');
  assert.equal(auth.reasonCode, 'dimension-unreadable');
  assert.notEqual(auth.verdict, 'restored');
  assert.equal(forward.comparable, false);
  assert.equal(forward.verdict, 'rollback-unverifiable');

  // The same refusal in the other direction: an unread baseline cannot certify an
  // observation either.
  const backward = compare(observed, baseline);
  assert.equal(dimensionOf(backward, 'auth').verdict, 'unrestored');
  assert.equal(backward.comparable, false);
});

test('two dimensions that were both unreadable for the same reason are still not restored', () => {
  const left = fingerprint({ overrides: { metric: unreadableDimension('metric-definitions-unreadable') } });
  const right = fingerprint({ overrides: { metric: unreadableDimension('metric-definitions-unreadable') } });
  const comparison = compare(left, right);
  assert.equal(dimensionOf(comparison, 'metric').verdict, 'unrestored');
  assert.equal(dimensionOf(comparison, 'metric').reasonCode, 'dimension-unreadable');
  assert.equal(comparison.summary.notCompared, 1);
  assert.equal(comparison.verdict, 'rollback-unverifiable');
});

test('two identical complete captures verify the rollback', () => {
  const comparison = compare(fingerprint(), fingerprint({ capturedAt: '2026-08-18T01:00:00Z' }));
  assert.equal(comparison.verdict, 'rollback-verified');
  assert.equal(comparison.comparable, true);
  assert.equal(comparison.summary.restored, FINGERPRINT_DIMENSIONS.length);
  assert.equal(comparison.summary.unexpected, 0);
});

test('a field the plan said would be restored and was not is unrestored, and says so in words', () => {
  const moved = structuredClone(READINGS.endpoint);
  moved.baseUrlClass = 'foundry-project/example-project';
  const comparison = compare(
    fingerprint(),
    fingerprint({ overrides: { endpoint: readDimension(moved) } }),
    ['endpoint.baseUrlClass'],
  );

  const difference = dimensionOf(comparison, 'endpoint').differences[0];
  assert.equal(difference.verdict, 'unrestored');
  assert.equal(difference.documented, false);
  assert.equal(difference.reasonCode, 'restore-did-not-take-effect');
  assert.match(difference.statement, /endpoint\.baseUrlClass changed from "apim-gateway\/v1"/);
  assert.match(difference.statement, /to "foundry-project\/example-project"/);
  assert.equal(comparison.verdict, 'rollback-incomplete');
  assert.equal(comparison.summary.unexpected, 0);
});

test('a change nobody asked for is named unexpected rather than folded into the expected ones', () => {
  const widened = structuredClone(READINGS.auth);
  widened.acceptedClientIds = [...widened.acceptedClientIds, '00000000-0000-0000-0000-000000000009'];
  const moved = structuredClone(READINGS.endpoint);
  moved.baseUrlClass = 'foundry-project/example-project';

  const comparison = compare(
    fingerprint(),
    fingerprint({ overrides: { auth: readDimension(widened), endpoint: readDimension(moved) } }),
    ['endpoint.baseUrlClass'],
  );

  const unexpected = dimensionOf(comparison, 'auth').differences[0];
  assert.equal(unexpected.verdict, 'unexpected');
  assert.equal(unexpected.reasonCode, 'change-outside-rollback-plan');
  assert.match(unexpected.statement, /auth\.acceptedClientIds gained "00000000-0000-0000-0000-000000000009"/);
  assert.equal(comparison.summary.unexpected, 1);
  assert.equal(comparison.summary.unrestored, 1);
  assert.equal(comparison.verdict, 'rollback-unexpected-change');
});

test('a documented residual is unrestored and marked documented rather than reported as a fault', () => {
  const kept = structuredClone(READINGS.topology);
  kept.apis = [...kept.apis, 'generated-api|generated'];
  const comparison = compare(
    fingerprint(),
    fingerprint({ overrides: { topology: readDimension(kept) } }),
    [],
    ['topology.apis'],
  );

  const difference = dimensionOf(comparison, 'topology').differences[0];
  assert.equal(difference.verdict, 'unrestored');
  assert.equal(difference.documented, true);
  assert.equal(difference.reasonCode, 'documented-residual');
  assert.equal(comparison.verdict, 'rollback-verified');
});

test('a comparison without a declared plan is refused rather than assuming one', () => {
  const baseline = fingerprint();
  assert.throws(
    () => compareEndpointFingerprints({ baseline, observed: baseline, documentedResiduals: [] }),
    /restores must be an array; omitting it is not a declaration/,
  );
  assert.throws(
    () => compareEndpointFingerprints({ baseline, observed: baseline, restores: [] }),
    /documentedResiduals must be an array; omitting it is not a declaration/,
  );
});

test('a plan naming a field that does not exist is refused', () => {
  const baseline = fingerprint();
  assert.throws(
    () => compare(baseline, baseline, ['endpoint.baseUrl']),
    /restores names endpoint.baseUrl, which is not a fingerprint field/,
  );
});

test('captures of two different modes are refused rather than compared', () => {
  assert.throws(
    () => compare(fingerprint({ mode: 'ExplicitApim' }), fingerprint({ mode: 'PrivateNoBypass' })),
    (error) => error.code === 'fingerprint-mode-mismatch',
  );
});

test('the rendered comparison states each dimension and its differences in words', () => {
  const moved = structuredClone(READINGS.metric);
  moved.counters = ['apim-service|Requests|Total'];
  const rendered = renderComparison(compare(
    fingerprint(),
    fingerprint({ overrides: { metric: readDimension(moved) } }),
    ['metric.counters'],
  ));
  assert.match(rendered, /Mode ExplicitApim: rollback-incomplete/);
  assert.match(rendered, /metric\.counters lost "provider-account\|TotalTokens\|Total"\./);
  assert.match(rendered, /endpoint \[restored\]/);
});

test('the four governance modes are the ones the operating guide names', () => {
  assert.deepEqual([...GOVERNANCE_MODES], [
    'FoundryIntegrated',
    'ExplicitApim',
    'PrivateNoBypass',
    'DirectResourceAllowed',
  ]);
  assert.equal(GOVERNANCE_MODES.includes('ExclusiveApim'), false);
});

test('a credential-shaped value cannot be carried in a reading', () => {
  const leaked = structuredClone(READINGS.endpoint);
  leaked.baseUrlClass = 'sk-abcd1234efgh';
  assert.throws(() => fingerprint({ overrides: { endpoint: readDimension(leaked) } }), (error) =>
    error.code === 'record-value-refused');
});

test('every source file behind the tool is structurally read-only', async () => {
  for (const path of TOOL_SOURCES) {
    const source = await readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
    assert.equal(assertReadOnlySource(source, { path }), true, `${path} must be read-only.`);
  }
});

test('the read-only scan fires on a mutating verb rather than reporting a clean file', () => {
  const cases = [
    ['const options = { method: "POST" };', 'request-method'],
    ['await fetch(url, { method: "DELETE" });', 'http-method'],
    ['// run az cognitiveservices account create first', 'cli-verb'],
    ['await fetch(url, { body: payload });', 'request-body'],
  ];
  for (const [source, expected] of cases) {
    assert.throws(() => assertReadOnlySource(source, { path: 'fabricated' }), (error) => {
      assert.equal(error.code, 'source-is-not-read-only');
      assert.ok(error.findings.some((finding) => finding.startsWith(expected)), `${expected} not found`);
      return true;
    });
  }
});

function armFixture(overrides = {}) {
  const responses = {
    'Microsoft.ApiManagement/service/example-gateway?': {
      properties: { gatewayUrl: 'https://gateway.example.com' },
    },
    '/apis/inference?': { properties: { path: 'v1' } },
    '/apis/inference/operations?': {
      value: [
        { properties: { method: 'POST', urlTemplate: '/responses' } },
        { properties: { method: 'POST', urlTemplate: '/chat/completions' } },
      ],
    },
    '/apis?': { value: [{ name: 'inference', properties: { path: 'v1' } }] },
    '/backends?': {
      value: [{
        name: 'example-pool',
        properties: { type: 'Pool', url: 'https://example-account.cognitiveservices.azure.com/openai/v1' },
      }],
    },
    // The collection read genuinely omits `value`; only a per-name read carries it.
    '/namedValues?': {
      value: [
        { name: 'entra-api-audience', properties: { secret: false } },
        { name: 'entra-client-application-id', properties: { secret: false } },
        { name: 'entra-required-scope', properties: { secret: false } },
        { name: 'entra-workload-app-role', properties: { secret: false } },
        { name: 'gateway-signing-material', properties: { secret: true } },
      ],
    },
    '/namedValues/entra-api-audience?': {
      properties: { value: 'api://00000000-0000-0000-0000-000000000001' },
    },
    '/namedValues/entra-client-application-id?': {
      properties: { value: '00000000-0000-0000-0000-000000000002' },
    },
    '/namedValues/entra-required-scope?': { properties: { value: 'Gateway.Access' } },
    '/namedValues/entra-workload-app-role?': { properties: { value: 'disabled' } },
    '/policies/policy?': { properties: { value: '<policies><inbound /></policies>' } },
    'Microsoft.Resources/links?': {
      value: [{ properties: { targetId: '/subscriptions/x/providers/Microsoft.ApiManagement/service/example-gateway' } }],
    },
    'Microsoft.ApiManagement/service/example-gateway/providers/Microsoft.Insights/metricDefinitions?': {
      value: [{ name: { value: 'Requests' }, primaryAggregationType: 'Total' }],
    },
    'Microsoft.CognitiveServices/accounts/example-account/providers/Microsoft.Insights/metricDefinitions?': {
      value: [{ name: { value: 'TotalTokens' }, primaryAggregationType: 'Total' }],
    },
    ...overrides,
  };

  return async (url) => {
    // Longest match wins so a general collection route cannot answer for a child.
    const key = Object.keys(responses)
      .filter((candidate) => url.includes(candidate))
      .sort((left, right) => right.length - left.length)[0];
    if (key === undefined) {
      const error = new Error('arm-read-failed');
      error.code = 'arm-read-failed';
      throw error;
    }
    if (responses[key] === null) throw Object.assign(new Error('arm-read-failed'), { code: 'arm-read-failed' });
    return responses[key];
  };
}

const TARGET = {
  subscriptionId: '00000000-0000-0000-0000-0000000000aa',
  apimResourceGroupName: 'example-gateway-group',
  apimName: 'example-gateway',
  governedApiName: 'inference',
  providerResourceGroupName: 'example-provider-group',
  providerAccountName: 'example-account',
  projectName: 'example-project',
};

const CREDENTIAL = { getToken: async () => ({ token: 'fixture' }) };

async function captureFixture(options = {}) {
  return captureEndpointFingerprint({
    mode: 'ExplicitApim',
    target: TARGET,
    compatibility: { callerClasses: ['codex-cli'], declarationSource: 'rollback-plan' },
    credential: CREDENTIAL,
    transport: armFixture(options.responses),
    now: () => '2026-08-18T00:00:00Z',
    ...options.capture,
  });
}

test('the reader captures every dimension offline through the injected transport', async () => {
  const captured = await captureFixture();
  assert.equal(captured.completeness, 'complete');
  assert.equal(captured.dimensions.endpoint.reading.baseUrlClass, 'apim-gateway/v1');
  assert.deepEqual(captured.dimensions.auth.reading.acceptedClientIds, ['00000000-0000-0000-0000-000000000002']);
  assert.equal(captured.dimensions.topology.reading.projectRoutingState, 'enabled');
  assert.deepEqual(captured.dimensions.metric.reading.counters, [
    'apim-service|Requests|Total',
    'provider-account|TotalTokens|Total',
  ]);
  assert.deepEqual(captured.dimensions.compatibility.reading.callerClasses, ['codex-cli']);
});

test('the captured document carries no host, no credential-shaped value and no message content', async () => {
  const serialised = JSON.stringify(await captureFixture());
  // Each of these is a host the fixture actually supplies, so an assertion that stops
  // failing means the digest started leaking, not that the input changed.
  for (const host of ['http', 'gateway.example.com', 'cognitiveservices', 'Bearer']) {
    assert.equal(serialised.includes(host), false, `${host} reached the fingerprint.`);
  }
  // Field names, because a route legitimately spells a word that a message-bearing
  // field would also spell.
  for (const key of ['prompt', 'completion', 'messages', 'requestBody', 'responseBody', 'value']) {
    assert.equal(serialised.includes(`"${key}"`), false, `a ${key} field reached the fingerprint.`);
  }
  assert.match(serialised, /"hostDigest":"[0-9a-f]{16}"/);
});

test('a secret named value contributes its name only, marked, and never its value', async () => {
  const captured = await captureFixture();
  assert.ok(captured.dimensions.topology.reading.namedValueNames.includes('gateway-signing-material|protected'));
});

test('one unreadable collection degrades only its own dimension', async () => {
  const captured = await captureFixture({ responses: { '/namedValues?': null } });
  assert.equal(captured.completeness, 'partial');
  assert.deepEqual(captured.unreadableDimensions, ['auth', 'topology']);
  assert.equal(captured.dimensions.endpoint.state, 'read');
  assert.equal(captured.dimensions.metric.state, 'read');
});

test('a backend that declares no type is recorded as a single backend, not as an absent one', async () => {
  // The deployed collection omits `type` for an ordinary backend.
  const untyped = {
    '/backends?': { value: [{ name: 'example-backend', properties: { url: 'https://example-account.azure.com/v1' } }] },
  };
  const captured = await captureFixture({ responses: untyped });
  assert.match(captured.dimensions.topology.reading.backends[0], /^example-backend\|Single\|[0-9a-f]{16}$/);
});

test('a named value the auth contract needs but cannot read makes the dimension unreadable, never partly read', async () => {
  // A needed name marked secret is never fetched, so the contract is incomplete
  // rather than unread. The two are different answers and carry different codes.
  const secretScope = await captureFixture({
    responses: {
      '/namedValues?': {
        value: [
          { name: 'entra-api-audience', properties: { secret: false } },
          { name: 'entra-client-application-id', properties: { secret: false } },
          { name: 'entra-required-scope', properties: { secret: true } },
          { name: 'entra-workload-app-role', properties: { secret: false } },
        ],
      },
    },
  });
  assert.equal(secretScope.dimensions.auth.state, 'unreadable');
  assert.equal(secretScope.dimensions.auth.reasonCode, 'reading-incomplete');

  const unreadableScope = await captureFixture({ responses: { '/namedValues/entra-required-scope?': null } });
  assert.equal(unreadableScope.dimensions.auth.state, 'unreadable');
  assert.equal(unreadableScope.dimensions.auth.reasonCode, 'named-values-unreadable');
});

test('an auth field is read per name, because the collection read omits every value', async () => {
  const requested = [];
  const responses = armFixture();
  const captured = await captureEndpointFingerprint({
    mode: 'ExplicitApim',
    target: TARGET,
    compatibility: { callerClasses: ['codex-cli'], declarationSource: 'rollback-plan' },
    credential: CREDENTIAL,
    now: () => '2026-08-18T00:00:00Z',
    transport: async (url, options) => {
      requested.push(url);
      return responses(url, options);
    },
  });
  assert.equal(captured.dimensions.auth.state, 'read');
  assert.equal(requested.some((url) => url.includes('/namedValues/entra-api-audience?')), true);
  assert.equal(captured.dimensions.auth.reading.audience, 'api://00000000-0000-0000-0000-000000000001');
});

test('compatibility must be declared or explicitly absent; omitting it is refused', async () => {
  await assert.rejects(
    () => captureFixture({ capture: { compatibility: undefined } }),
    /compatibility must be declared or explicitly null/,
  );
  const captured = await captureFixture({ capture: { compatibility: null } });
  assert.equal(captured.dimensions.compatibility.state, 'unreadable');
  assert.equal(captured.dimensions.compatibility.reasonCode, 'compatibility-not-declared');
});

test('every declared dimension field is compared, so a new field cannot be added unwatched', () => {
  const changed = FINGERPRINT_DIMENSIONS.flatMap((dimension) => DIMENSION_FIELDS[dimension].map((field) => {
    const reading = structuredClone(READINGS[dimension]);
    const current = reading[field];
    reading[field] = Array.isArray(current) ? [...current, 'added-member'] : `${current}-moved`;
    const comparison = compare(fingerprint(), fingerprint({ overrides: { [dimension]: readDimension(reading) } }));
    return comparison.summary.unexpected;
  }));
  assert.equal(changed.every((count) => count === 1), true);
});
