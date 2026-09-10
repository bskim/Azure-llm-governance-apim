import test from 'node:test';
import assert from 'node:assert/strict';

import { createAzureMonitorProviderUsage } from '../../app/telemetry/azure-monitor-provider-usage.mjs';

const RESOURCE_ID =
  '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/example-group' +
  '/providers/Microsoft.CognitiveServices/accounts/example-account';

const WINDOW = { windowStart: '2026-08-13T15:00:00.000Z', windowEnd: '2026-08-13T16:00:00.000Z' };

function body(metrics) {
  return {
    value: Object.entries(metrics).map(([name, points]) => ({
      name: { value: name },
      timeseries: [{ data: points.map((total) => ({ total })) }],
    })),
  };
}

function reader(reply, capture = {}) {
  return createAzureMonitorProviderUsage({
    resourceId: RESOURCE_ID,
    sendMetrics: async (request) => {
      Object.assign(capture, request);
      return reply;
    },
  });
}

test('the window is read as a total of the provider\'s own per-minute points', async () => {
  const capture = {};
  const usage = reader({ status: 200, body: body({ ModelRequests: [2], TotalTokens: [222] }) }, capture);

  assert.deepEqual(await usage.readWindow(WINDOW), { requests: 2, totalTokens: 222 });
  assert.equal(capture.timespan, `${WINDOW.windowStart}/${WINDOW.windowEnd}`);
  assert.equal(capture.resourceId, RESOURCE_ID);
});

test('points the provider left empty count as no traffic in that minute, not as a gap', async () => {
  const usage = reader({ status: 200, body: body({ ModelRequests: [1, null, 1], TotalTokens: [100, null, 122] }) });

  assert.deepEqual(await usage.readWindow(WINDOW), { requests: 2, totalTokens: 222 });
});

test('a window the provider served nothing in is zero rather than a refusal to answer', async () => {
  const usage = reader({ status: 200, body: body({ ModelRequests: [], TotalTokens: [] }) });

  assert.deepEqual(await usage.readWindow(WINDOW), { requests: 0, totalTokens: 0 });
});

test('a failed read raises rather than reporting a window the provider served nothing in', async () => {
  // The caller turns a raised error into an unavailable side. A zero here would
  // report the gateway as having invented every request in the window.
  const usage = reader({ status: 403, body: {} });

  await assert.rejects(() => usage.readWindow(WINDOW), /answered 403/);
});

test('half an answer is refused', async () => {
  // A returned request count beside an absent token metric would read as a window
  // whose every token went missing.
  const usage = reader({ status: 200, body: body({ ModelRequests: [2] }) });

  await assert.rejects(() => usage.readWindow(WINDOW), /both the request and the token metric/);
});

test('an absent metric is not read as a zero total', async () => {
  const usage = reader({ status: 200, body: { value: [] } });

  await assert.rejects(() => usage.readWindow(WINDOW), /both the request and the token metric/);
});

test('the resource identifier cannot carry a path of its own into the request', async () => {
  for (const resourceId of [
    '../../subscriptions/x',
    '/subscriptions/not-a-guid/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/a',
    `${RESOURCE_ID}/providers/Microsoft.Insights/metrics`,
    '',
  ]) {
    assert.throws(
      () => createAzureMonitorProviderUsage({ resourceId, sendMetrics: async () => ({ status: 200, body: {} }) }),
      TypeError,
      `${resourceId} must be refused`,
    );
  }
});

test('a source with neither a credential nor a sender is refused at construction', () => {
  assert.throws(() => createAzureMonitorProviderUsage({ resourceId: RESOURCE_ID }), TypeError);
});
