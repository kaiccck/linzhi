/**
 * Where analyses come from. HttpBackend talks to a running 走得到 server (docs/api.md); LocalBackend
 * reads data/samples/*.json directly and needs no server at all (judges without keys, MCP over stdio).
 * AnalysisStore keeps live and derived results in memory so follow-up tools can reference them by id.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AnalysisResult, LngLat } from '@zoudedao/core';
import { findCommunity, normName, toBd09 } from './analysis.js';
import { readSse } from './sse.js';
import type { AnalyzeEvent, AnalyzeInput, LocateResult, PlaceCandidate, SampleSummary } from './types.js';

export interface ZddBackend {
  /** 'http' | 'local', shown in answers ("样例模式"). */
  readonly kind: string;
  listSamples(signal?: AbortSignal): Promise<SampleSummary[]>;
  getAnalysis(id: string, signal?: AbortSignal): Promise<AnalysisResult>;
  /** Live health check; absent when the backend can only replay samples. */
  analyze?(
    input: AnalyzeInput,
    onEvent?: (event: AnalyzeEvent) => void,
    signal?: AbortSignal,
  ): Promise<AnalysisResult>;
  locate?(query: string, city?: string, signal?: AbortSignal): Promise<LocateResult>;
}

/** A failure the user should see; `message` is Chinese and never contains keys or URLs with keys. */
export class BackendError extends Error {
  override name = 'BackendError';
  readonly code: string;
  readonly status: number | undefined;

  constructor(code: string, message: string, status?: number, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.status = status;
  }
}

function isAnalysis(x: unknown): x is AnalysisResult {
  const r = x as Partial<AnalysisResult> | null;
  return (
    !!r &&
    typeof r === 'object' &&
    !!r.meta &&
    Array.isArray(r.meta.center_bd09) &&
    Array.isArray(r.communities) &&
    !!r.stats &&
    !!r.field &&
    !!r.contours
  );
}

function isLngLat(x: unknown): x is LngLat {
  return Array.isArray(x) && x.length === 2 && x.every((v) => typeof v === 'number' && Number.isFinite(v));
}

// ----------------------------------------------------------------------------------- HTTP

export interface HttpBackendOptions {
  /** Default: global fetch. */
  fetch?: typeof fetch;
  /** Per request (samples, analysis, locate). Default 20 s. */
  timeoutMs?: number;
  /** Whole live analysis including the stream. Default 200 s (the server's budget is 180 s). */
  analyzeTimeoutMs?: number;
}

const HTTP_DEFAULT_MESSAGES: Record<number, string> = {
  400: '请求参数不合法',
  404: '资源不存在',
  409: '服务端当前为样例模式（未配置百度服务端 Key），不能分析新地点，只能查看样例社区',
  429: '请求过于频繁或百度配额已用尽，请稍后再试',
  500: '走得到服务内部错误，请稍后再试',
  502: '地图服务暂时不可用，请稍后再试',
  503: '服务繁忙、正在重启或地图服务鉴权失败，请稍后再试',
  504: '请求超时，请稍后再试',
};

export class HttpBackend implements ZddBackend {
  readonly kind = 'http';
  readonly baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #analyzeTimeoutMs: number;

  constructor(baseUrl: string, opts: HttpBackendOptions = {}) {
    // accept both http://host:8787 and http://host:8787/api
    this.baseUrl = baseUrl.replace(/\/+$/, '').replace(/\/api$/, '');
    this.#fetch = opts.fetch ?? ((input, init) => fetch(input, init));
    this.#timeoutMs = opts.timeoutMs ?? 20_000;
    this.#analyzeTimeoutMs = opts.analyzeTimeoutMs ?? 200_000;
  }

  #networkError(err: unknown, timeout: AbortSignal, timeoutMs: number, signal?: AbortSignal): Error {
    if (signal?.aborted) return new BackendError('aborted', '请求已取消', undefined, { cause: err });
    if (timeout.aborted) {
      return new BackendError(
        'timeout',
        `走得到服务在 ${Math.round(timeoutMs / 1000)} 秒内没有响应`,
        undefined,
        {
          cause: err,
        },
      );
    }
    return new BackendError(
      'unreachable',
      `无法连接走得到服务（${this.baseUrl}），请确认服务已启动`,
      undefined,
      {
        cause: err,
      },
    );
  }

  async #fail(res: Response): Promise<BackendError> {
    let code = `http_${res.status}`;
    let message = HTTP_DEFAULT_MESSAGES[res.status] ?? `走得到服务返回错误（HTTP ${res.status}）`;
    try {
      const body = (await res.json()) as { error?: unknown; message?: unknown };
      if (typeof body.error === 'string') code = body.error;
      if (typeof body.message === 'string' && body.message) message = body.message;
    } catch {
      // not JSON: keep the generic message
    }
    if (code === 'live_mode_disabled') message = HTTP_DEFAULT_MESSAGES[409]!;
    return new BackendError(code, message, res.status);
  }

  async #json(path: string, signal?: AbortSignal): Promise<unknown> {
    // one deadline for headers and body: a 400 KB analysis over a slow link must not hang
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await this.#fetch(`${this.baseUrl}${path}`, {
        headers: { accept: 'application/json' },
        signal: combined,
      });
    } catch (err) {
      throw this.#networkError(err, timeout, this.#timeoutMs, signal);
    }
    if (!res.ok) throw await this.#fail(res);
    try {
      return await res.json();
    } catch (err) {
      if (combined.aborted) throw this.#networkError(err, timeout, this.#timeoutMs, signal);
      throw new BackendError('invalid_response', '走得到服务返回的不是合法 JSON', res.status, { cause: err });
    }
  }

  async listSamples(signal?: AbortSignal): Promise<SampleSummary[]> {
    const body = await this.#json('/api/samples', signal);
    if (!Array.isArray(body)) throw new BackendError('invalid_response', '样例列表格式不正确');
    return body.filter(
      (s): s is SampleSummary =>
        !!s && typeof s.id === 'string' && typeof s.name === 'string' && isLngLat(s.center_bd09),
    );
  }

  async getAnalysis(id: string, signal?: AbortSignal): Promise<AnalysisResult> {
    try {
      const body = await this.#json(`/api/analysis/${encodeURIComponent(id)}`, signal);
      if (!isAnalysis(body)) throw new BackendError('invalid_response', '分析结果格式不正确');
      return body;
    } catch (err) {
      if (err instanceof BackendError && err.status === 404) {
        throw new BackendError('not_found', `找不到分析 ${id}`, 404, { cause: err });
      }
      throw err;
    }
  }

  async analyze(
    input: AnalyzeInput,
    onEvent?: (event: AnalyzeEvent) => void,
    signal?: AbortSignal,
  ): Promise<AnalysisResult> {
    const timeout = AbortSignal.timeout(this.#analyzeTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await this.#fetch(`${this.baseUrl}/api/analyze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({
          center_bd09: input.center_bd09,
          ...(input.label ? { label: input.label.slice(0, 80) } : {}),
          profile: input.profile ?? 'adult',
        }),
        signal: combined,
      });
    } catch (err) {
      throw this.#networkError(err, timeout, this.#analyzeTimeoutMs, signal);
    }
    if (!res.ok) throw await this.#fail(res);
    if (!res.body) throw new BackendError('upstream', '分析服务没有返回数据流');
    try {
      for await (const msg of readSse(res.body)) {
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(msg.data) as Record<string, unknown>;
        } catch {
          continue;
        }
        switch (msg.event) {
          case 'stage':
            onEvent?.({
              type: 'stage',
              stage: String(payload.stage ?? ''),
              message: String(payload.message ?? ''),
              progress: Number(payload.progress ?? 0),
            });
            break;
          case 'partial':
            onEvent?.({ type: 'partial', data: payload as Partial<AnalysisResult> });
            break;
          case 'quota':
            onEvent?.({
              type: 'quota',
              service: String(payload.service ?? ''),
              used: Number(payload.used ?? 0),
              limit: Number(payload.limit ?? 0),
            });
            break;
          case 'result':
            if (!isAnalysis(payload)) throw new BackendError('invalid_response', '分析结果格式不正确');
            return payload;
          case 'error':
            throw new BackendError(
              typeof payload.code === 'string' ? payload.code : 'upstream',
              typeof payload.message === 'string' && payload.message
                ? payload.message
                : '分析失败，请稍后重试',
            );
        }
      }
    } catch (err) {
      if (err instanceof BackendError) throw err;
      throw this.#networkError(err, timeout, this.#analyzeTimeoutMs, signal);
    }
    throw new BackendError('upstream', '分析数据流在返回结果之前中断');
  }

  async locate(query: string, city?: string, signal?: AbortSignal): Promise<LocateResult> {
    const params = new URLSearchParams({ q: query });
    if (city) params.set('city', city);
    const body = (await this.#json(`/api/locate?${params.toString()}`, signal)) as Record<string, unknown>;
    const candidates = (Array.isArray(body.candidates) ? body.candidates : []).filter(
      (c): c is PlaceCandidate => !!c && typeof c.name === 'string' && isLngLat(c.center_bd09),
    );
    const best =
      body.best && isLngLat((body.best as PlaceCandidate).center_bd09) ? (body.best as PlaceCandidate) : null;
    // docs/api.md is moving to snake_case; accept the older camelCase spelling too
    const needs = body.needs_confirmation ?? body.needsConfirmation;
    return {
      query: typeof body.query === 'string' ? body.query : query,
      ...(typeof body.city === 'string' ? { city: body.city } : city ? { city } : {}),
      best: best ?? candidates[0] ?? null,
      candidates,
      needs_confirmation: typeof needs === 'boolean' ? needs : candidates.length !== 1,
      warnings: Array.isArray(body.warnings)
        ? body.warnings.filter((w): w is string => typeof w === 'string')
        : [],
    };
  }
}

// ----------------------------------------------------------------------------------- local

/** Sample ids are file names; they are only ever matched against the listing, never joined blindly. */
const SAMPLE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

interface CachedSample {
  size: number;
  mtimeMs: number;
  result: AnalysisResult;
}

export interface LocalBackendOptions {
  samplesDir: string;
}

export class LocalBackend implements ZddBackend {
  readonly kind = 'local';
  readonly samplesDir: string;
  readonly #cache = new Map<string, CachedSample>();

  constructor(opts: LocalBackendOptions) {
    this.samplesDir = opts.samplesDir;
  }

  async #ids(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.samplesDir);
    } catch (err) {
      if ((err as { code?: unknown }).code === 'ENOENT') return [];
      throw err;
    }
    return names
      .filter((n) => n.endsWith('.json'))
      .map((n) => n.slice(0, -'.json'.length))
      .filter((id) => SAMPLE_ID.test(id))
      .sort();
  }

  async #load(id: string): Promise<AnalysisResult | undefined> {
    const file = join(this.samplesDir, `${id}.json`);
    const info = await stat(file).catch(() => undefined);
    if (!info?.isFile()) return undefined;
    const hit = this.#cache.get(id);
    if (hit && hit.size === info.size && hit.mtimeMs === info.mtimeMs) return hit.result;
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!isAnalysis(parsed)) return undefined;
    this.#cache.set(id, { size: info.size, mtimeMs: info.mtimeMs, result: parsed });
    return parsed;
  }

  async listSamples(): Promise<SampleSummary[]> {
    const out: SampleSummary[] = [];
    for (const id of await this.#ids()) {
      const r = await this.#load(id).catch(() => undefined);
      if (!r) continue;
      out.push({
        id,
        name: r.meta.name,
        center_bd09: r.meta.center_bd09,
        ...(r.meta.center_label ? { center_label: r.meta.center_label } : {}),
      });
    }
    return out;
  }

  async getAnalysis(id: string): Promise<AnalysisResult> {
    if (!(await this.#ids()).includes(id)) throw new BackendError('not_found', `找不到样例 ${id}`, 404);
    const r = await this.#load(id);
    if (!r) throw new BackendError('invalid_response', `样例 ${id} 无法读取或格式不正确`);
    return r;
  }

  /**
   * Sample mode: matches sample names and centre labels first, then communities inside the samples.
   * A single sample-level hit is used without asking, even when other samples contain a community of
   * the same name (玉兰香苑 the area vs 玉兰香苑二期 inside a neighbouring sample).
   */
  async locate(query: string, city?: string): Promise<LocateResult> {
    const needle = normName(query);
    const areas: PlaceCandidate[] = [];
    const inside: PlaceCandidate[] = [];
    for (const id of await this.#ids()) {
      const r = await this.#load(id).catch(() => undefined);
      if (!r || !needle) continue;
      const name = normName(r.meta.name);
      const label = normName(r.meta.center_label ?? '');
      const bare = name.replace(/片区$|周边$/, '');
      if (name.includes(needle) || label.includes(needle) || (bare.length >= 2 && needle.includes(bare))) {
        areas.push({
          name: r.meta.name,
          ...(r.meta.center_label ? { address: r.meta.center_label } : {}),
          center_bd09: r.meta.center_bd09,
          source: 'sample',
          confidence: 1,
          reason: '样例社区的名称或中心点标注包含搜索词',
          sample_id: id,
        });
        continue;
      }
      const community = findCommunity(r, query);
      if (community) {
        inside.push({
          name: community.name,
          address: `样例 ${r.meta.name} 内的小区`,
          center_bd09: toBd09(r, community.centroid),
          source: 'sample',
          confidence: 0.8,
          reason: `属于样例社区“${r.meta.name}”`,
          sample_id: id,
        });
      }
    }
    const candidates = [...areas, ...inside];
    const decided = areas.length === 1 || (areas.length === 0 && inside.length === 1);
    return {
      query,
      ...(city ? { city } : {}),
      best: candidates[0] ?? null,
      candidates,
      needs_confirmation: !decided,
      warnings: ['当前为样例模式：只在内置样例社区中查找，不调用百度接口'],
    };
  }
}

// ----------------------------------------------------------------------------------- store

export interface StoredAnalysis {
  id: string;
  result: AnalysisResult;
  source: 'sample' | 'live' | 'derived';
  /** Insertion order, for listing newest first. */
  seq: number;
}

/** FNV-1a 32-bit: a short stable id without node:crypto. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * In-memory results by id, least recently used evicted first. Samples are cached here too (they can
 * always be re-read); a live result is only reachable while it stays in the store.
 */
export class AnalysisStore {
  readonly maxEntries: number;
  readonly #entries = new Map<string, StoredAnalysis>();
  #seq = 0;

  constructor(opts: { maxEntries?: number } = {}) {
    this.maxEntries = opts.maxEntries ?? 16;
  }

  /** Stable id of a live result: same centre, profile and generation time → same id. */
  static liveId(result: AnalysisResult): string {
    const m = result.meta as AnalysisResult['meta'] & { profile?: string };
    const key = JSON.stringify([
      m.center_bd09,
      m.generated,
      m.name,
      m.profile ?? 'adult',
      result.stats.n_samples,
    ]);
    return `live-${fnv1a(key)}`;
  }

  put(result: AnalysisResult, opts: { id?: string; source?: StoredAnalysis['source'] } = {}): string {
    const id = opts.id ?? AnalysisStore.liveId(result);
    this.#entries.delete(id);
    this.#entries.set(id, { id, result, source: opts.source ?? 'live', seq: ++this.#seq });
    for (const oldest of this.#entries.keys()) {
      if (this.#entries.size <= this.maxEntries) break;
      this.#entries.delete(oldest);
    }
    return id;
  }

  get(id: string): StoredAnalysis | undefined {
    const hit = this.#entries.get(id);
    if (hit) {
      // refresh recency
      this.#entries.delete(id);
      this.#entries.set(id, hit);
    }
    return hit;
  }

  has(id: string): boolean {
    return this.#entries.has(id);
  }

  /** Newest first. */
  list(): StoredAnalysis[] {
    return [...this.#entries.values()].sort((a, b) => b.seq - a.seq);
  }
}
