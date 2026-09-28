/**
 * Typed errors and the Baidu status policy (技术设计文档 §4.2).
 *
 * Baidu answers every error with HTTP 200 and a JSON `status`, so the policy is keyed on that status.
 * Every error carries a Chinese `hint` that the UI can show verbatim.
 */
import { SERVICE_LABEL, type BaiduService } from './types.js';

/** Error codes of the public API (docs/api.md). */
export type BaiduApiErrorCode = 'auth' | 'quota_exhausted' | 'upstream' | 'invalid_input';

export interface BaiduErrorInit {
  service?: BaiduService | undefined;
  status?: number | undefined;
  hint?: string | undefined;
  attempts?: number | undefined;
  cause?: unknown;
}

export abstract class BaiduError extends Error {
  abstract readonly apiCode: BaiduApiErrorCode;
  readonly service: BaiduService | undefined;
  /** Baidu JSON status, when the error came from one. */
  readonly status: number | undefined;
  /** What the operator should do, in Chinese. */
  readonly hint: string;
  /** HTTP attempts made before giving up (0 = refused locally). */
  readonly attempts: number;

  constructor(message: string, init: BaiduErrorInit = {}) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = new.target.name;
    this.service = init.service;
    this.status = init.status;
    this.hint = init.hint ?? '';
    this.attempts = init.attempts ?? 0;
  }

  /** Wire shape of docs/api.md: `{ error, message }` plus the fix hint. */
  toJSON(): {
    error: BaiduApiErrorCode;
    message: string;
    hint: string;
    service?: BaiduService;
    status?: number;
  } {
    return {
      error: this.apiCode,
      message: this.message,
      hint: this.hint,
      ...(this.service ? { service: this.service } : {}),
      ...(this.status !== undefined ? { status: this.status } : {}),
    };
  }
}

/** Key, permission or signing problem. Retrying cannot help; the operator must fix the configuration. */
export class BaiduConfigError extends BaiduError {
  readonly apiCode = 'auth' as const;
}

export type QuotaScope = 'daily' | 'soft' | 'hard';

/**
 * Quota refusal. `daily`: Baidu said 302 (or the breaker is open after one); `soft`: the local ledger
 * refused a cold call at 90 %; `hard`: the local ledger would exceed 100 %.
 */
export class BaiduQuotaError extends BaiduError {
  readonly apiCode = 'quota_exhausted' as const;
  readonly scope: QuotaScope;
  constructor(message: string, init: BaiduErrorInit & { scope: QuotaScope }) {
    super(message, init);
    this.scope = init.scope;
  }
}

export type UpstreamKind =
  | 'server' // status 1 after retries
  | 'bad_request' // status 2: our request was malformed
  | 'rate_limited' // 401/402 after the backoff schedule
  | 'network' // network/TLS/timeout after retries
  | 'http' // unexpected HTTP status
  | 'bad_response' // not JSON / missing fields
  | 'unknown_status'
  | 'replay_miss'; // ReplayTransport has no recording for the request

export class BaiduUpstreamError extends BaiduError {
  readonly apiCode = 'upstream' as const;
  readonly kind: UpstreamKind;
  /** Whether the scheduler may retry it (only meaningful for errors thrown by a transport). */
  readonly retryable: boolean;
  constructor(message: string, init: BaiduErrorInit & { kind: UpstreamKind; retryable?: boolean }) {
    super(message, init);
    this.kind = init.kind;
    this.retryable = init.retryable ?? false;
  }
}

/** The caller passed something unusable (swapped coordinates, empty address …). */
export class BaiduInputError extends BaiduError {
  readonly apiCode = 'invalid_input' as const;
}

/** Maps any thrown value to the docs/api.md error shape. */
export function toApiError(err: unknown): { error: BaiduApiErrorCode; message: string; hint?: string } {
  if (err instanceof BaiduError) return err.toJSON();
  return { error: 'upstream', message: err instanceof Error ? err.message : String(err) };
}

// ---------------------------------------------------------------- status policy

export type StatusAction =
  | { kind: 'ok' }
  /** Processed, but nothing found (directionlite 7, geocoding "无相关结果"). Cached briefly, not an error. */
  | { kind: 'empty' }
  | { kind: 'retry'; maxRetries: number; throttle: boolean }
  | { kind: 'config' }
  | { kind: 'quota' }
  | { kind: 'bad_request' }
  | { kind: 'unknown' };

export interface StatusRule {
  meaning: string;
  action: StatusAction;
  /** `{akVar}` is replaced with the env var that holds the AK used for the call. */
  hint?: string;
}

const OK: StatusAction = { kind: 'ok' };
const CONFIG: StatusAction = { kind: 'config' };
const QUOTA: StatusAction = { kind: 'quota' };
// Measured 2026-09-26: 401 behaves like a time-window limit; the same batch succeeds after waiting.
const THROTTLE: StatusAction = { kind: 'retry', maxRetries: 5, throttle: true };
const THROTTLE_HINT = '并发超限：已按 1、2、4、8、16 秒退避重试仍失败，请稍后再试';

export const STATUS_TABLE: Readonly<Record<number, StatusRule>> = {
  0: { meaning: '正常', action: OK },
  1: {
    meaning: '服务器内部错误',
    action: { kind: 'retry', maxRetries: 2, throttle: false },
    hint: '百度服务内部错误：已自动重试 2 次，请稍后再试',
  },
  2: {
    meaning: '请求参数非法',
    action: { kind: 'bad_request' },
    hint: '请求参数非法：这是客户端缺陷，请附上日志提交 Issue',
  },
  3: {
    meaning: '权限校验失败',
    action: CONFIG,
    hint: '权限校验失败：确认 {akVar} 是“服务端”类型的 AK，并在控制台开通了该服务',
  },
  4: {
    meaning: '配额校验失败',
    action: CONFIG,
    hint: '配额校验失败：在百度控制台检查该服务的配额与认证状态',
  },
  5: {
    meaning: 'AK 不存在或非法',
    action: CONFIG,
    hint: 'AK 不存在或非法：检查 {akVar} 是否填写正确（不要带空格或引号）',
  },
  7: { meaning: '无返回结果', action: { kind: 'empty' } },
  9: {
    meaning: '权限或配置错误',
    action: CONFIG,
    hint: '权限或配置错误：检查 {akVar} 是否开通该服务，鉴权方式（SN / IP 白名单）是否与控制台一致',
  },
  101: { meaning: '服务禁用', action: CONFIG, hint: '服务被禁用：在百度控制台为 {akVar} 开通该服务' },
  102: {
    meaning: '不通过白名单或者安全码不对',
    action: CONFIG,
    hint: '白名单或安全码校验失败：检查 {akVar} 的 IP 白名单或 SN 设置',
  },
  200: { meaning: 'APP 不存在', action: CONFIG, hint: 'AK 对应的应用不存在：检查 {akVar}' },
  210: {
    meaning: 'APP IP 校验失败',
    action: CONFIG,
    hint: 'IP 白名单校验失败：把本机出口 IP 加入 {akVar} 的白名单（VPN 或代理会改变出口 IP）',
  },
  211: {
    meaning: 'APP SN 校验失败',
    action: CONFIG,
    hint: 'SN 校验失败：检查 BAIDU_SERVER_SK，或批量算路改用 BAIDU_MATRIX_AK',
  },
  220: {
    meaning: 'APP Referer 校验失败',
    action: CONFIG,
    hint: 'Referer 校验失败：服务端请求不能使用浏览器端 AK，请改用服务端 AK',
  },
  240: {
    meaning: 'APP 服务被禁用',
    action: CONFIG,
    hint: '服务未开通：{akVar} 没有开通该服务（等时圈等高级服务需单独申请），请在控制台开通',
  },
  301: { meaning: '永久配额超限', action: QUOTA, hint: '永久配额已用尽：需联系百度地图开放平台调整' },
  302: {
    meaning: '天配额超限',
    action: QUOTA,
    hint: '今日配额已用尽：该服务今天停止调用，改用缓存或样例数据，北京时间次日 0 点恢复',
  },
  401: { meaning: '当前并发量已经超过约定并发配额', action: THROTTLE, hint: THROTTLE_HINT },
  402: { meaning: '当前并发量与服务总并发量均超过配额', action: THROTTLE, hint: THROTTLE_HINT },
};

/** Looks a status up, falling back to Baidu's ranges: 2xx = no permission, 3xx = quota. */
export function statusRule(status: number, message?: string): StatusRule {
  // Geocoding reports "nothing found" as status 1; retrying it would only burn quota.
  if (status === 1 && message?.includes('无相关结果'))
    return { meaning: '无相关结果', action: { kind: 'empty' } };
  const known = STATUS_TABLE[status];
  if (known) return known;
  if (status >= 200 && status < 300) {
    return {
      meaning: '无权限',
      action: CONFIG,
      hint: '无权限：检查 {akVar} 在控制台的服务开通、白名单与鉴权设置',
    };
  }
  if (status >= 300 && status < 400)
    return { meaning: '配额错误', action: QUOTA, hint: STATUS_TABLE[302]?.hint };
  return { meaning: '未知状态', action: { kind: 'unknown' } };
}

export interface StatusErrorContext {
  service: BaiduService;
  akVar?: string | undefined;
  attempts: number;
}

/** Builds the typed error for a non-success status (after any retries were spent). */
export function statusError(
  status: number,
  baiduMessage: string | undefined,
  ctx: StatusErrorContext,
): BaiduError {
  const rule = statusRule(status, baiduMessage);
  const hint = (rule.hint ?? '').replaceAll('{akVar}', ctx.akVar ?? 'BAIDU_SERVER_AK');
  const detail = baiduMessage ? `（${baiduMessage}）` : '';
  const message = `${SERVICE_LABEL[ctx.service]}失败：status ${status} ${rule.meaning}${detail}`;
  const init = { service: ctx.service, status, hint, attempts: ctx.attempts };
  switch (rule.action.kind) {
    case 'config':
      return new BaiduConfigError(message, init);
    case 'quota':
      return new BaiduQuotaError(message, { ...init, scope: 'daily' });
    case 'bad_request':
      return new BaiduUpstreamError(message, { ...init, kind: 'bad_request' });
    case 'retry':
      return new BaiduUpstreamError(message, {
        ...init,
        kind: rule.action.throttle ? 'rate_limited' : 'server',
      });
    default:
      return new BaiduUpstreamError(message, { ...init, kind: 'unknown_status' });
  }
}
