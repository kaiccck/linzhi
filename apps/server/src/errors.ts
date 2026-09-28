import type { FastifyInstance } from 'fastify';

/** Body of every non-2xx JSON response (docs/api.md「错误格式」). */
export interface ErrorBody {
  error: string;
  message: string;
}

/**
 * HTTP status of each error code (docs/api.md「错误码」). Exception: requests that arrive while the
 * server shuts down get `internal` with 503, so proxies retry them elsewhere.
 */
export const ERROR_STATUS = {
  invalid_input: 400,
  bad_request: 400,
  forbidden: 403,
  not_found: 404,
  live_mode_disabled: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  rate_limited: 429,
  quota_exhausted: 429,
  internal: 500,
  upstream: 502,
  auth: 503,
  busy: 503,
  timeout: 504,
} as const;

/** An HTTP error whose code and Chinese message go to the client unchanged. */
export class ApiError extends Error {
  override name = 'ApiError';
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

interface ErrorLike {
  statusCode?: unknown;
  code?: unknown;
  validation?: unknown;
}

function toResponse(err: unknown): { status: number; body: ErrorBody } {
  if (err instanceof ApiError) {
    return { status: err.statusCode, body: { error: err.code, message: err.message } };
  }
  const e = (typeof err === 'object' && err !== null ? err : {}) as ErrorLike;
  const status =
    typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 600 ? e.statusCode : 500;
  const code = typeof e.code === 'string' ? e.code : '';

  if (e.validation) return { status: 400, body: { error: 'invalid_input', message: '请求参数不合法' } };
  if (status === 400 && (code.startsWith('FST_ERR_CTP_') || err instanceof SyntaxError)) {
    return { status, body: { error: 'invalid_input', message: '请求体不是合法的 JSON' } };
  }
  switch (status) {
    case 403:
      return { status, body: { error: 'forbidden', message: '禁止访问' } };
    case 404:
      return { status, body: { error: 'not_found', message: '资源不存在' } };
    case 413:
      return { status, body: { error: 'payload_too_large', message: '请求体过大' } };
    case 415:
      return {
        status,
        body: {
          error: 'unsupported_media_type',
          message: '请求体须为 JSON（Content-Type: application/json）',
        },
      };
    case 429:
      return { status, body: { error: 'rate_limited', message: '请求过于频繁，请稍后再试' } };
  }
  if (status < 500) return { status, body: { error: 'bad_request', message: '请求无效' } };
  return { status, body: { error: 'internal', message: '服务器内部错误，请稍后再试' } };
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, req, reply) => {
    const { status, body } = toResponse(err);
    // Internals stay in the log (secrets redacted by the err serializer); clients get the generic text.
    if (status >= 500) req.log.error({ err }, 'request failed');
    return reply.code(status).send(body);
  });
}
