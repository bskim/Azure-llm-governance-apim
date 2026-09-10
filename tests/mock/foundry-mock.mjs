import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function writeJson(response, statusCode, body) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'x-mock-backend': 'foundry',
  });
  response.end(payload);
}

function writeSse(response, events) {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-mock-backend': 'foundry',
  });

  let eventIndex = 0;
  const writeNext = () => {
    if (eventIndex >= events.length) {
      response.end();
      return;
    }

    response.write(events[eventIndex]);
    eventIndex += 1;
    setImmediate(writeNext);
  };
  writeNext();
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function secureTokenMatch(received, expected) {
  const receivedHash = Buffer.from(sha256(received));
  const expectedHash = Buffer.from(sha256(expected));
  return timingSafeEqual(receivedHash, expectedHash);
}

function captureRequest(request, rawBody, parsedBody) {
  const authorization = request.headers.authorization ?? '';
  const routingHeaders = [
    'forwarded',
    'x-backend-url',
    'x-deployment-id',
    'x-forwarded-host',
    'x-original-host',
    'x-original-url',
    'x-rewrite-url',
  ].filter((headerName) => request.headers[headerName] !== undefined);

  return {
    method: request.method,
    path: new URL(request.url, 'http://mock.local').pathname,
    query: new URL(request.url, 'http://mock.local').search,
    contentType: request.headers['content-type'] ?? null,
    authorizationScheme: authorization.split(' ', 1)[0] || null,
    authorizationSha256: authorization ? sha256(authorization) : null,
    apiKeyPresent:
      request.headers['api-key'] !== undefined ||
      request.headers['ocp-apim-subscription-key'] !== undefined,
    routingHeaders,
    bodySha256: sha256(rawBody),
    body: parsedBody,
  };
}

function responseObject(sequence, model) {
  return {
    id: `resp_mock_${String(sequence).padStart(4, '0')}`,
    object: 'response',
    status: 'completed',
    model,
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'mock response' }],
      },
    ],
    usage: {
      input_tokens: 3,
      output_tokens: 2,
      total_tokens: 5,
    },
  };
}

function chatCompletionObject(sequence, model) {
  return {
    id: `chatcmpl_mock_${String(sequence).padStart(4, '0')}`,
    object: 'chat.completion',
    created: 1_700_000_000,
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'mock response' },
        finish_reason: 'stop',
      },
    ],
    usage: {
      input_tokens: 3,
      output_tokens: 2,
      total_tokens: 5,
    },
  };
}

function responseStream(sequence, model) {
  const response = responseObject(sequence, model);
  return [
    `event: response.created\ndata: ${JSON.stringify({
      type: 'response.created',
      response: { ...response, status: 'in_progress', output: [], usage: null },
    })}\n\n`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({
      type: 'response.output_text.delta',
      delta: 'mock response',
    })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({
      type: 'response.completed',
      response,
    })}\n\n`,
    'data: [DONE]\n\n',
  ];
}

function chatCompletionStream(sequence, model) {
  const id = `chatcmpl_mock_${String(sequence).padStart(4, '0')}`;
  return [
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created: 1_700_000_000,
      model,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    })}\n\n`,
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created: 1_700_000_000,
      model,
      choices: [{ index: 0, delta: { content: 'mock response' }, finish_reason: null }],
    })}\n\n`,
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created: 1_700_000_000,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    })}\n\n`,
    'data: [DONE]\n\n',
  ];
}

export function createFoundryMock(options = {}) {
  const expectedModel = options.expectedModel ?? 'gpt-5.4-mini';
  const controlToken = options.controlToken ?? 'local-test-control-token';
  const responsesPath = '/openai/v1/responses';
  const chatCompletionsPath = '/openai/v1/chat/completions';
  const requests = [];
  let sequence = 0;

  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url, 'http://mock.local');

    if (request.method === 'GET' && requestUrl.pathname === '/healthz') {
      writeJson(response, 200, { status: 'ok' });
      return;
    }

    if (requestUrl.pathname === '/__test/requests') {
      if (!secureTokenMatch(request.headers['x-mock-control-token'] ?? '', controlToken)) {
        writeJson(response, 403, { error: 'forbidden' });
        return;
      }

      if (request.method === 'GET') {
        writeJson(response, 200, { requests });
        return;
      }

      if (request.method === 'DELETE') {
        requests.length = 0;
        sequence = 0;
        response.writeHead(204);
        response.end();
        return;
      }
    }

    if (
      request.method !== 'POST' ||
      ![responsesPath, chatCompletionsPath].includes(requestUrl.pathname)
    ) {
      writeJson(response, 404, {
        error: {
          message: 'Unexpected mock backend operation.',
          type: 'invalid_request_error',
          param: null,
          code: 'mock_operation_not_found',
        },
      });
      return;
    }

    const rawBody = await readBody(request);
    let parsedBody;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      writeJson(response, 400, {
        error: {
          message: 'Mock backend received malformed JSON.',
          type: 'invalid_request_error',
          param: null,
          code: 'mock_invalid_json',
        },
      });
      return;
    }

    requests.push(captureRequest(request, rawBody, parsedBody));

    if (parsedBody.model !== expectedModel) {
      writeJson(response, 400, {
        error: {
          message: 'Mock backend received an unexpected deployment name.',
          type: 'invalid_request_error',
          param: 'model',
          code: 'mock_unexpected_model',
        },
      });
      return;
    }

    sequence += 1;
    if (parsedBody.stream === true) {
      const events =
        requestUrl.pathname === responsesPath
          ? responseStream(sequence, expectedModel)
          : chatCompletionStream(sequence, expectedModel);
      writeSse(response, events);
      return;
    }

    const body =
      requestUrl.pathname === responsesPath
        ? responseObject(sequence, expectedModel)
        : chatCompletionObject(sequence, expectedModel);
    writeJson(response, 200, body);
  });

  return {
    listen(host = '127.0.0.1', port = 0) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          const address = server.address();
          resolve(`http://${address.address}:${address.port}`);
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
    requests,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const mock = createFoundryMock({
    expectedModel: process.env.MOCK_EXPECTED_MODEL,
    projectName: process.env.MOCK_PROJECT_NAME,
    controlToken: process.env.MOCK_CONTROL_TOKEN,
  });
  const host = process.env.MOCK_HOST ?? '127.0.0.1';
  const port = Number.parseInt(process.env.MOCK_PORT ?? '4010', 10);
  const url = await mock.listen(host, port);
  process.stdout.write(`${url}\n`);
}