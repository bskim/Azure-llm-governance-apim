/**
 * Reads a closed window from the provider's own meter.
 *
 * Drift detection only means something if the two sides are independent. The
 * internal picture is built from API Management's logs, so comparing it against
 * those same logs would compare a number with itself. These are platform metrics
 * emitted by the Foundry account, which counts what it served whether or not the
 * gateway recorded it, and keeps counting when the gateway's logging is broken.
 *
 * A read that fails raises rather than returning zero. The caller treats an
 * unreachable provider as an unavailable side; a zero would report the gateway
 * inventing every request in the window.
 */

const METRICS_SCOPE = 'https://management.azure.com/.default';
const DEFAULT_ENDPOINT = 'https://management.azure.com';
const API_VERSION = '2018-01-01';

// `ModelRequests` counts calls the account served; `TotalTokens` is its own sum of
// input and output. Both are Total aggregations over the window.
const REQUEST_METRIC = 'ModelRequests';
const TOKEN_METRIC = 'TotalTokens';

function fail(message) {
  throw new TypeError(message);
}

/**
 * The identifier is placed in the request path, so it is checked against the shape
 * of an account resource identifier rather than trusted because it arrived as
 * configuration.
 */
function assertResourceId(resourceId) {
  if (typeof resourceId !== 'string') fail('resourceId is required.');
  const shape =
    /^\/subscriptions\/[0-9a-fA-F-]{36}\/resourceGroups\/[\w.()-]{1,90}\/providers\/Microsoft\.CognitiveServices\/accounts\/[\w-]{2,64}$/;
  if (!shape.test(resourceId)) fail('resourceId must be a Cognitive Services account resource identifier.');
}

function createMetricsSender({ credential, endpoint }) {
  return async function sendMetrics({ resourceId, timespan }) {
    const token = await credential.getToken(METRICS_SCOPE);
    const query = new URLSearchParams({
      'api-version': API_VERSION,
      metricnames: `${REQUEST_METRIC},${TOKEN_METRIC}`,
      aggregation: 'Total',
      timespan,
    });
    const response = await fetch(`${endpoint}${resourceId}/providers/Microsoft.Insights/metrics?${query}`, {
      headers: { authorization: `Bearer ${token.token}` },
    });
    return { status: response.status, body: await response.json() };
  };
}

/**
 * A metric the account never emitted in the window is absent, not zero, and the two
 * have to stay apart: a window in which the provider served nothing is a real
 * answer, but a window in which the metric was not returned at all is not.
 */
function totalFor(body, metricName) {
  const series = (body?.value ?? []).find((metric) => metric?.name?.value === metricName);
  if (!series) return null;
  const points = series.timeseries?.[0]?.data ?? [];
  return points.reduce((sum, point) => sum + (Number(point?.total) || 0), 0);
}

export function createAzureMonitorProviderUsage({
  resourceId,
  credential,
  sendMetrics,
  endpoint = DEFAULT_ENDPOINT,
} = {}) {
  assertResourceId(resourceId);
  const send = sendMetrics ?? (credential ? createMetricsSender({ credential, endpoint }) : null);
  if (typeof send !== 'function') fail('Either a credential or a sendMetrics function is required.');

  async function readWindow({ windowStart, windowEnd }) {
    if (typeof windowStart !== 'string' || typeof windowEnd !== 'string') {
      fail('windowStart and windowEnd are required.');
    }

    const result = await send({ resourceId, timespan: `${windowStart}/${windowEnd}` });
    if (result?.status !== 200) fail(`The provider meter answered ${result?.status}.`);

    const requests = totalFor(result.body, REQUEST_METRIC);
    const totalTokens = totalFor(result.body, TOKEN_METRIC);
    // Half an answer is not an answer. Comparing a returned request count against an
    // absent token count would report the whole window's tokens as missing.
    if (requests === null || totalTokens === null) {
      fail('The provider meter did not return both the request and the token metric.');
    }

    return { requests, totalTokens };
  }

  return Object.freeze({ readWindow });
}
