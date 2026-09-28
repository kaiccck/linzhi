import { BaiduError, BaiduUpstreamError, toApiError } from '@zoudedao/baidu';

/** docs/api.md error codes. */
export type EngineErrorCode = 'quota_exhausted' | 'auth' | 'upstream' | 'invalid_input';

/**
 * An expected failure. The message reaches users verbatim: Chinese, and never any key material
 * (Baidu errors only carry masked URLs).
 */
export class EngineError extends Error {
  override name = 'EngineError';
  readonly code: EngineErrorCode;
  /** What the operator can do about it, when known. */
  readonly hint: string | undefined;

  constructor(code: EngineErrorCode, message: string, options?: ErrorOptions & { hint?: string }) {
    super(message, options);
    this.code = code;
    this.hint = options?.hint;
  }
}

/**
 * The EngineError for an expected failure: engine errors as they are, Baidu errors through toApiError
 * (message + fix hint). Anything else is a bug and gets no code here: analyze() rethrows it unchanged,
 * so the server reports it as `internal` instead of blaming Baidu.
 */
export function toEngineError(err: unknown): EngineError | null {
  if (err instanceof EngineError) return err;
  if (err instanceof BaiduError) {
    const api = toApiError(err);
    const hint = api.hint || undefined;
    return new EngineError(api.error, hint ? `${api.message}；${hint}` : api.message, {
      cause: err,
      ...(hint ? { hint } : {}),
    });
  }
  return null;
}

/**
 * Transient upstream trouble (network, 401 after the backoff schedule, bad response) in a step the
 * result can do without. Key, permission and quota errors are never degradable: they fail the run.
 */
export function isDegradable(err: unknown): err is BaiduUpstreamError {
  return err instanceof BaiduUpstreamError;
}

/** Short Chinese reason for warnings. */
export function describeError(err: unknown): string {
  if (err instanceof BaiduError) return err.message;
  return err instanceof Error ? err.message : String(err);
}
