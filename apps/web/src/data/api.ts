/**
 * Server calls beyond the sample catalogue (docs/api.md): health, and the event streams of the live
 * analysis (here) and of the 问询 advisor (ask.ts).
 * Errors always surface the server's Chinese `message`; the table below only fills in when a
 * response carries a code without one (unknown codes fall back to a generic line).
 */
import type { AnalysisResult } from '@zoudedao/core';

export interface Health {
  ok: boolean;
  mode: 'sample' | 'live';
  version?: string;
  /** "replay" = POST /api/analyze replays sample zj-a until the live analyzer is wired in */
  analyzer?: string;
  /** POST /api/ask: template answers, or a model (its name only) */
  advisor?: { mode: 'llm' | 'template'; model?: string };
}

const CODE_TEXT: Record<string, string> = {
  invalid_input: '请求参数不合法',
  quota_exhausted: '今日百度配额已用尽',
  auth: '百度 Key 校验失败',
  upstream: '百度服务暂时不可用',
  timeout: '分析超时',
  internal: '服务端内部错误',
  rate_limited: '请求太频繁，请稍后再试',
  busy: '同时进行的分析太多，请稍后再试',
  live_mode_disabled: '服务端为样例模式，不能分析新地点',
  not_found: '接口或样例不存在',
};

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const errorText = (code: string | undefined, message: unknown): string =>
  typeof message === 'string' && message.trim() ? message : ((code && CODE_TEXT[code]) ?? '请求失败');

export async function getHealth(signal?: AbortSignal): Promise<Health | null> {
  try {
    const res = await fetch('/api/health', { signal, headers: { accept: 'application/json' } });
    if (!res.ok || !/json/i.test(res.headers.get('content-type') ?? '')) return null;
    const body = (await res.json()) as Partial<Health>;
    return body && (body.mode === 'sample' || body.mode === 'live') ? (body as Health) : null;
  } catch {
    return null;
  }
}

export interface StageEvent {
  stage: string;
  message: string;
  progress: number;
}

/** A quota ledger update: calls of one Baidu service used so far today, and its daily limit. */
export interface QuotaEvent {
  service: string;
  used: number;
  limit?: number;
}

export interface AnalyzeHandlers {
  onStage?(e: StageEvent): void;
  /** shallow-merged partial result so far (docs/api.md: `{ ...prev, ...partial }`) */
  onPartial?(p: Partial<AnalysisResult>): void;
  onQuota?(q: QuotaEvent): void;
}

import type { BrowserPoi } from './nearby.js';

/** The request body of POST /api/analyze. */
export interface AnalyzeBody {
  center_bd09: [number, number];
  label: string;
  profile: 'adult' | 'elder';
  /** 浏览器端周边检索 (data/nearby.ts): shops the server's place search may leave out */
  browser_pois?: BrowserPoi[];
}

/** What streams a live check: `analyze` against the server, or a dev-only stand-in. */
export type AnalyzeFn = (
  body: AnalyzeBody,
  handlers: AnalyzeHandlers,
  signal: AbortSignal,
) => Promise<AnalysisResult>;

/**
 * POST `url` and read its event stream (EventSource cannot POST). `onEvent` returns a value to end
 * the stream with it; an `error` event throws its Chinese message. Non-stream answers (400, 429 …)
 * throw the server's `{ error, message }`.
 */
export async function postEvents<T>(
  url: string,
  body: unknown,
  onEvent: (event: string, payload: Record<string, unknown>) => T | undefined,
  signal: AbortSignal,
): Promise<T | undefined> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !/event-stream/i.test(res.headers.get('content-type') ?? '') || !res.body) {
    const j = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
    throw new ApiError(j?.error ?? `http_${res.status}`, errorText(j?.error, j?.message));
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value.replace(/\r\n?/g, '\n');
    let cut: number;
    while ((cut = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      let event = 'message';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) continue; // keep-alive ping
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      const payload = JSON.parse(data) as Record<string, unknown>;
      if (event === 'error') {
        const code = typeof payload.code === 'string' ? payload.code : 'upstream';
        throw new ApiError(code, errorText(code, payload.message));
      }
      const out = onEvent(event, payload);
      if (out !== undefined) {
        void reader.cancel().catch(() => {});
        return out;
      }
    }
  }
  return undefined;
}

/** POST /api/analyze and read the event stream. Resolves with `result`. */
export const analyze: AnalyzeFn = async (body, handlers, signal) => {
  let partial: Partial<AnalysisResult> = {};
  const result = await postEvents<AnalysisResult>(
    '/api/analyze',
    body,
    (event, payload) => {
      if (event === 'stage') handlers.onStage?.(payload as unknown as StageEvent);
      else if (event === 'partial') {
        partial = { ...partial, ...(payload as Partial<AnalysisResult>) };
        handlers.onPartial?.(partial);
      } else if (event === 'quota') {
        if (typeof payload.service === 'string' && typeof payload.used === 'number')
          handlers.onQuota?.(payload as unknown as QuotaEvent);
      } else if (event === 'result') return payload as unknown as AnalysisResult;
      return undefined;
    },
    signal,
  );
  if (!result) throw new ApiError('upstream', '分析连接意外结束');
  return result;
};
