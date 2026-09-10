/**
 * Bridges a Node HTTP request onto the shape the Functions host passes handlers.
 *
 * This exists so the local development server and the Functions host execute the
 * same handler code rather than two implementations of the same endpoint. It is
 * a transport shim only: it adds no behaviour and makes no decisions.
 */

class AdaptedRequest {
  #request;
  #url;

  constructor(request, url) {
    this.#request = request;
    this.#url = url;
    this.method = request.method;
    this.params = Object.freeze({});
  }

  get url() {
    return this.#url.href;
  }

  get query() {
    return this.#url.searchParams;
  }

  get headers() {
    const source = this.#request.headers;
    return {
      get(name) {
        const value = source[name.toLowerCase()];
        return Array.isArray(value) ? value.join(', ') : (value ?? null);
      },
    };
  }

  async text() {
    const chunks = [];
    for await (const chunk of this.#request) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
  }

  async json() {
    return JSON.parse(await this.text());
  }
}

export function adaptRequest(request, url) {
  return new AdaptedRequest(request, url);
}

export function writeHandlerResponse(response, result) {
  const headers = { ...(result.headers ?? {}) };
  const body = result.jsonBody === undefined ? result.body : JSON.stringify(result.jsonBody);
  if (result.jsonBody !== undefined && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json; charset=utf-8';
  }
  response.writeHead(result.status ?? 200, headers);
  response.end(body ?? '');
}

export function createInvocationContext(invocationId) {
  const noop = () => {};
  return { invocationId, log: noop, error: noop, warn: noop, info: noop, debug: noop };
}
