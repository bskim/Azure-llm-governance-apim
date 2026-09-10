import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { createFoundryMock } from './foundry-mock.mjs';

const controlToken = 'test-control-token';
const managedIdentityToken = 'Bearer test-token';
const expectedModel = 'gpt-5.4-mini';
const mock = createFoundryMock({ expectedModel, controlToken });
let baseUrl;
const responsesPath = '/openai/v1/responses';
const chatCompletionsPath = '/openai/v1/chat/completions';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function capturedRequests() {
  const response = await fetch(`${baseUrl}/__test/requests`, {
    headers: { 'x-mock-control-token': controlToken },
  });
  assert.equal(response.status, 200);
  return (await response.json()).requests;
}

async function post(path, body) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      authorization: managedIdentityToken,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

before(async () => {
  baseUrl = await mock.listen();
});

beforeEach(async () => {
  const response = await fetch(`${baseUrl}/__test/requests`, {
    method: 'DELETE',
    headers: { 'x-mock-control-token': controlToken },
  });
  assert.equal(response.status, 204);
});

after(async () => {
  await mock.close();
});

test('returns a deterministic Responses object and captures a sanitized request', async () => {
  const response = await post(responsesPath, {
    model: expectedModel,
    input: 'hello',
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json');
  const body = await response.json();
  assert.equal(body.id, 'resp_mock_0001');
  assert.equal(body.model, expectedModel);
  assert.deepEqual(body.usage, { input_tokens: 3, output_tokens: 2, total_tokens: 5 });

  const requests = await capturedRequests();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, responsesPath);
  assert.equal(requests[0].query, '');
  assert.equal(requests[0].authorizationScheme, 'Bearer');
  assert.equal(requests[0].authorizationSha256, sha256(managedIdentityToken));
  assert.equal(requests[0].apiKeyPresent, false);
  assert.deepEqual(requests[0].routingHeaders, []);
  assert.equal(requests[0].body.model, expectedModel);
  assert.equal(JSON.stringify(requests[0]).includes('test-token'), false);
});

test('returns a deterministic Chat Completions object', async () => {
  const response = await post(chatCompletionsPath, {
    model: expectedModel,
    messages: [{ role: 'user', content: 'hello' }],
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.id, 'chatcmpl_mock_0001');
  assert.equal(body.object, 'chat.completion');
  assert.equal(body.choices[0].message.content, 'mock response');
});

test('streams Responses events with usage and a terminal marker', async () => {
  const response = await post(responsesPath, {
    model: expectedModel,
    input: 'hello',
    stream: true,
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const stream = await response.text();
  assert.match(stream, /event: response\.created/);
  assert.match(stream, /event: response\.output_text\.delta/);
  assert.match(stream, /event: response\.completed/);
  assert.match(stream, /"total_tokens":5/);
  assert.match(stream, /data: \[DONE\]\n\n$/);
});

test('streams Chat Completions chunks with usage and a terminal marker', async () => {
  const response = await post(chatCompletionsPath, {
    model: expectedModel,
    messages: [{ role: 'user', content: 'hello' }],
    stream: true,
  });
  assert.equal(response.status, 200);
  const stream = await response.text();
  assert.match(stream, /"object":"chat\.completion\.chunk"/);
  assert.match(stream, /"total_tokens":5/);
  assert.match(stream, /data: \[DONE\]\n\n$/);
});

test('rejects an unexpected deployment and still captures the attempted backend call', async () => {
  const response = await post(responsesPath, {
    model: 'unapproved-deployment',
    input: 'hello',
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, 'mock_unexpected_model');
  assert.equal((await capturedRequests()).length, 1);
});

test('rejects undeclared backend operations without adding a valid-operation capture', async () => {
  const response = await post('/openai/v1/models', {
    model: expectedModel,
  });
  assert.equal(response.status, 404);
  assert.equal((await capturedRequests()).length, 0);
});

test('rejects the Enabled project endpoint backend to prevent same-gateway recursion', async () => {
  const response = await post('/api/projects/mock-project/openai/v1/responses', {
    model: expectedModel,
    input: 'hello',
  });
  assert.equal(response.status, 404);
  assert.equal((await capturedRequests()).length, 0);
});

test('protects the capture control endpoint', async () => {
  const response = await fetch(`${baseUrl}/__test/requests`);
  assert.equal(response.status, 403);
});