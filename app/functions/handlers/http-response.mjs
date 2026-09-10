/**
 * Response shaping shared by every HTTP function.
 *
 * The gateway and the browser both read these responses, so the headers below are
 * applied centrally rather than per handler: a governed policy document must never
 * be cached by an intermediary, and no response from this app should ever be
 * content-sniffed or framed.
 */

const SECURITY_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
});

export function jsonResponse(status, jsonBody, { requestId } = {}) {
  return {
    status,
    jsonBody,
    headers: {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      ...(requestId ? { 'X-Request-Id': requestId } : {}),
    },
  };
}

export function errorResponse(status, code, { requestId, reasonCode } = {}) {
  const error = { code };
  if (reasonCode) error.reasonCode = reasonCode;
  return jsonResponse(status, { error }, { requestId });
}

/**
 * Reads a JSON body with an explicit ceiling. The host enforces its own limits,
 * but a governed endpoint should reject an oversized body itself rather than
 * inherit whatever the platform default happens to be.
 */
export async function readJsonBody(request, limitBytes = 8_192) {
  const declared = Number.parseInt(request.headers.get('content-length') ?? '', 10);
  if (Number.isInteger(declared) && declared > limitBytes) {
    throw new TypeError('body-too-large');
  }
  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > limitBytes) throw new TypeError('body-too-large');
  if (text.length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new TypeError('body-not-json');
  }
}

export { SECURITY_HEADERS };
