import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

/**
 * A local stand-in for the governed gateway, used to observe what each coding
 * client actually sends.
 *
 * It exists because almost everything worth knowing about a client — where it
 * takes a credential, whether it duplicates it, which wire format it speaks, what
 * it does with a 401 — is a property of the client and not of Azure. Proving those
 * here costs nothing and spends no request against the deployment's allowance,
 * which leaves only the genuinely cloud-dependent questions for a canary.
 *
 * The refusals below mirror the deployed policy's shapes rather than inventing
 * their own, so a client that satisfies this one is not being taught a contract
 * the gateway does not have.
 */

const ANTHROPIC_PATH = '/v1/messages';
const RESPONSES_PATH = '/v1/responses';
const CHAT_PATH = '/v1/chat/completions';
// The caller does not get to choose the backend; the gateway refuses these outright.
const ROUTING_INPUTS = ['deployment', 'deployment_id', 'backend', 'backend_url', 'api_version'];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function writeJson(response, statusCode, body, headers = {}) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  response.end(payload);
}

function writeSse(response, events) {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.write('data: [DONE]\n\n');
  response.end();
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function secureTokenMatch(received, expected) {
  return timingSafeEqual(Buffer.from(sha256(received)), Buffer.from(sha256(expected)));
}

/**
 * Everything observed about a request except the credential itself, which is
 * reduced to a digest so a capture file can be read and kept without holding a
 * usable token.
 */
function captureRequest(request, rawBody, parsedBody, outcome) {
  const authorization = request.headers.authorization ?? '';
  const [scheme, credential = ''] = authorization.split(' ');
  return {
    at: new Date().toISOString(),
    method: request.method,
    path: new URL(request.url, 'http://mock.local').pathname,
    outcome,
    authorizationScheme: scheme || null,
    credentialSha256: credential ? sha256(credential) : null,
    credentialLooksLikeJwt: credential.split('.').length === 3,
    // Claude Code copies its helper value into both headers, so the gateway has to
    // decide which one it trusts and remove the other.
    duplicatedCredentialHeaders: ['x-api-key', 'api-key', 'ocp-apim-subscription-key'].filter(
      (name) => request.headers[name] !== undefined,
    ),
    userAgent: request.headers['user-agent'] ?? null,
    anthropicVersion: request.headers['anthropic-version'] ?? null,
    streamRequested: parsedBody?.stream === true,
    model: parsedBody?.model ?? null,
    toolCount: Array.isArray(parsedBody?.tools) ? parsedBody.tools.length : 0,
    toolTypes: Array.isArray(parsedBody?.tools)
      ? [...new Set(parsedBody.tools.map((tool) => tool?.type ?? 'untyped'))].sort()
      : [],
    routingInputsSent: ROUTING_INPUTS.filter((name) => parsedBody?.[name] !== undefined),
    bodyBytes: Buffer.byteLength(rawBody),
  };
}

function anthropicMessage(sequence, model) {
  return {
    id: `msg_mock_${sequence}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: `GATEWAY_MOCK_OK ${sequence}` }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 11, output_tokens: 7 },
  };
}

function anthropicStream(sequence, model) {
  return [
    { type: 'message_start', message: { ...anthropicMessage(sequence, model), content: [] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `GATEWAY_MOCK_OK ${sequence}` } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } },
    { type: 'message_stop' },
  ];
}

function responseObject(sequence, model) {
  return {
    id: `resp_mock_${sequence}`,
    object: 'response',
    model,
    status: 'completed',
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: `GATEWAY_MOCK_OK ${sequence}` }],
      },
    ],
    usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
  };
}

function responseStream(sequence, model) {
  const completed = responseObject(sequence, model);
  return [
    { type: 'response.created', response: { ...completed, status: 'in_progress', output: [] } },
    { type: 'response.output_text.delta', delta: `GATEWAY_MOCK_OK ${sequence}` },
    { type: 'response.completed', response: completed },
  ];
}

function chatObject(sequence, model) {
  return {
    id: `chatcmpl_mock_${sequence}`,
    object: 'chat.completion',
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: `GATEWAY_MOCK_OK ${sequence}` },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  };
}

function chatStream(sequence, model) {
  return [
    {
      id: `chatcmpl_mock_${sequence}`,
      object: 'chat.completion.chunk',
      model,
      choices: [{ index: 0, delta: { role: 'assistant', content: `GATEWAY_MOCK_OK ${sequence}` } }],
    },
    {
      id: `chatcmpl_mock_${sequence}`,
      object: 'chat.completion.chunk',
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    },
  ];
}

export function createGatewayMock(options = {}) {
  const allowedModels = options.allowedModels ?? ['coding-primary', 'coding-fast'];
  const controlToken = options.controlToken ?? 'local-gateway-mock-control';
  const rateLimitedModels = new Set(options.rateLimitedModels ?? []);
  const retryAfter = options.retryAfter ?? '2';
  const gatewayOrigin = options.gatewayOrigin ?? 'https://gateway.example.net';
  const audience = options.audience ?? 'api://llm-governance-gateway';
  // A credential the mock refuses exactly once, so a client's refresh-and-retry
  // behaviour can be observed rather than assumed.
  const staleCredentials = new Set(options.staleCredentials ?? []);
  const requests = [];
  let sequence = 0;

  const unauthorized = (response, code, message) =>
    writeJson(
      response,
      401,
      { error: { message, type: 'authentication_error', param: null, code } },
      {
        'www-authenticate':
          `Bearer realm="llm-governance-gateway", error="invalid_token", resource_metadata="${gatewayOrigin}/.well-known/oauth-protected-resource/v1"`,
      },
    );

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://mock.local');

    if (request.method === 'GET' && url.pathname === '/healthz') {
      writeJson(response, 200, { status: 'ok' });
      return;
    }

    if (url.pathname === '/.well-known/oauth-protected-resource') {
      writeJson(response, 200, {
        resource: `${gatewayOrigin}/v1`,
        authorization_servers: [options.authorizationServer ?? 'https://login.microsoftonline.com/common/v2.0'],
        bearer_methods_supported: ['header'],
        scopes_supported: [`${audience}/Gateway.Access`],
      });
      return;
    }

    if (url.pathname === '/__test/requests') {
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

    if (request.method !== 'POST' || ![ANTHROPIC_PATH, RESPONSES_PATH, CHAT_PATH].includes(url.pathname)) {
      // Recorded like any other outcome: a client that reached the wrong path is
      // indistinguishable from one that never arrived unless the miss is kept.
      requests.push(captureRequest(request, '', null, 'operation-not-found'));
      writeJson(response, 404, {
        error: { message: 'No such gateway operation.', type: 'invalid_request_error', param: null, code: 'operation_not_found' },
      });
      return;
    }

    const rawBody = await readBody(request);
    let parsedBody = null;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      requests.push(captureRequest(request, rawBody, null, 'invalid-json'));
      writeJson(response, 400, {
        error: { message: 'Malformed JSON.', type: 'invalid_request_error', param: null, code: 'invalid_json' },
      });
      return;
    }

    const authorization = request.headers.authorization ?? '';
    const [scheme, credential = ''] = authorization.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || credential.length === 0) {
      requests.push(captureRequest(request, rawBody, parsedBody, 'no-bearer'));
      unauthorized(response, 'missing_token', 'A bearer token is required.');
      return;
    }
    if (staleCredentials.has(credential)) {
      // Consumed, so the retry that follows carries a different credential and can
      // be told apart from a client that simply resent the same one.
      staleCredentials.delete(credential);
      requests.push(captureRequest(request, rawBody, parsedBody, 'stale-token'));
      unauthorized(response, 'invalid_token', 'The token is no longer valid.');
      return;
    }

    const routingInputs = ROUTING_INPUTS.filter((name) => parsedBody?.[name] !== undefined);
    if (routingInputs.length > 0) {
      requests.push(captureRequest(request, rawBody, parsedBody, 'routing-input'));
      writeJson(response, 400, {
        error: { message: 'Backend selection is controlled by the gateway.', type: 'invalid_request_error', param: null, code: 'routing_input_not_allowed' },
      });
      return;
    }

    const model = parsedBody?.model;
    if (typeof model !== 'string' || model.length === 0) {
      requests.push(captureRequest(request, rawBody, parsedBody, 'missing-model'));
      writeJson(response, 400, {
        error: { message: 'The model field is required.', type: 'invalid_request_error', param: 'model', code: 'missing_model' },
      });
      return;
    }
    if (!allowedModels.includes(model)) {
      requests.push(captureRequest(request, rawBody, parsedBody, 'model-not-allowed'));
      writeJson(response, 403, {
        error: {
          message: 'The requested model is not allowed.',
          type: 'permission_error',
          param: 'model',
          code: 'model_not_allowed',
          allowed_models: allowedModels,
        },
      });
      return;
    }
    if (rateLimitedModels.has(model)) {
      requests.push(captureRequest(request, rawBody, parsedBody, 'rate-limited'));
      writeJson(
        response,
        429,
        {
          error: {
            message: 'The request rate limit was exceeded.',
            type: 'rate_limit_error',
            param: null,
            code: 'rate_limit_exceeded',
          },
        },
        { 'retry-after': retryAfter },
      );
      return;
    }

    requests.push(captureRequest(request, rawBody, parsedBody, 'served'));
    sequence += 1;

    const streaming = parsedBody.stream === true;
    if (url.pathname === ANTHROPIC_PATH) {
      if (streaming) writeSse(response, anthropicStream(sequence, model));
      else writeJson(response, 200, anthropicMessage(sequence, model));
      return;
    }
    if (url.pathname === RESPONSES_PATH) {
      if (streaming) writeSse(response, responseStream(sequence, model));
      else writeJson(response, 200, responseObject(sequence, model));
      return;
    }
    if (streaming) writeSse(response, chatStream(sequence, model));
    else writeJson(response, 200, chatObject(sequence, model));
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
        server.closeAllConnections?.();
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
    markStale(credential) {
      staleCredentials.add(credential);
    },
    requests,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const mock = createGatewayMock({
    allowedModels: process.env.GATEWAY_MOCK_MODELS?.split(',').map((value) => value.trim()),
    controlToken: process.env.GATEWAY_MOCK_CONTROL_TOKEN,
    // Lets a probe refuse a known first credential once, so a client's refresh
    // behaviour is observed rather than assumed.
    staleCredentials: process.env.GATEWAY_MOCK_STALE?.split(',').map((value) => value.trim()),
    rateLimitedModels: process.env.GATEWAY_MOCK_RATE_LIMITED_MODELS?.split(',').map((value) => value.trim()),
    retryAfter: process.env.GATEWAY_MOCK_RETRY_AFTER,
  });
  const url = await mock.listen(process.env.GATEWAY_MOCK_HOST ?? '127.0.0.1', Number.parseInt(process.env.GATEWAY_MOCK_PORT ?? '4310', 10));
  process.stdout.write(`${url}\n`);
}
