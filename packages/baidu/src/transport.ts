/**
 * The only place that touches the network. Everything above it takes a `Transport`, so tests and the
 * offline demo can swap in `ReplayTransport`, which answers from recorded responses.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { BaiduUpstreamError } from './errors.js';
import { maskUrl } from './sign.js';

export interface TransportRequest {
  url: string;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}

/** `json` is null when the body was not JSON. Baidu errors arrive as HTTP 200 + JSON status. */
export interface TransportResponse {
  httpStatus: number;
  json: unknown;
}

/**
 * One HTTP GET. Throw a `BaiduUpstreamError` with `kind: 'network', retryable: true` when the request
 * never reached Baidu; the scheduler retries those and the ledger does not bill them.
 */
export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

export interface FetchTransportOptions {
  fetch?: typeof globalThis.fetch;
  userAgent?: string;
}

export function createFetchTransport(opts: FetchTransportOptions = {}): Transport {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const userAgent = opts.userAgent ?? 'zoudedao-baidu/0.1';
  return async ({ url, timeoutMs, signal }) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let httpStatus: number;
    let text: string;
    try {
      const res = await doFetch(url, {
        signal: combined,
        headers: { 'user-agent': userAgent, accept: 'application/json' },
      });
      httpStatus = res.status;
      text = await res.text();
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? err;
      const why = timeout.aborted ? `请求超时（${timeoutMs} ms）` : describeNetworkError(err);
      throw new BaiduUpstreamError(`网络错误：${why}`, {
        kind: 'network',
        retryable: true,
        cause: err,
        hint: '请求没有到达百度（网络、代理或 TLS 问题），已自动重试；不计入配额',
      });
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { httpStatus, json };
  };
}

function describeNetworkError(err: unknown): string {
  const cause = (err as { cause?: { code?: unknown; message?: unknown } } | null)?.cause;
  const detail = cause?.code ?? cause?.message ?? (err instanceof Error ? err.message : String(err));
  return maskUrl(String(detail));
}

// ---------------------------------------------------------------- replay

/** One recorded exchange, as saved by research/api-probe/probe.py: `{ _meta: { request, http_status }, response }`. */
export interface ReplayFixture {
  name: string;
  /** Request URL; ak/sn are masked and ignored when matching. */
  request: string;
  /** 0 = the recording is a network failure. */
  httpStatus: number;
  response: unknown;
}

/**
 * Params that identify a request, per path. Others (output, scope, coord_type …) are ignored, so a
 * recording made with slightly different optional params still replays. Coordinates match to 1e-6°.
 */
export const REPLAY_KEY_PARAMS: Readonly<Record<string, readonly string[]>> = {
  '/geocoding/v3/': ['address', 'city'],
  '/reverse_geocoding/v3/': ['location'],
  '/geoconv/v2/': ['coords', 'model'],
  '/place/v3/around': ['query', 'location', 'radius', 'page_num'],
  '/place/v3/region': ['query', 'region', 'page_num'],
  '/routematrix/v2/walking': ['origins', 'destinations', 'road_prefer'],
  '/directionlite/v1/walking': ['origin', 'destination', 'origin_uid', 'destination_uid'],
};

const PARAM_DEFAULTS: Readonly<Record<string, string>> = { page_num: '0' };
const IGNORED = new Set(['ak', 'sn', 'timestamp']);
const COORD_TOLERANCE = 1.01e-6;

export interface ReplayOptions {
  /**
   * `sequence` (default): repeated matches are served in the given order, then the last one repeats —
   * e.g. a recorded 401 followed by the recorded success. `first-ok`: always the first status-0 match.
   */
  order?: 'sequence' | 'first-ok';
  keyParams?: Readonly<Record<string, readonly string[]>>;
}

export interface ReplayDirOptions extends ReplayOptions {
  /** Skip files larger than this (research dirs also hold multi-MB OSM extracts). Default 1 MB. */
  maxBytes?: number;
}

interface Entry {
  fx: ReplayFixture;
  path: string;
  params: URLSearchParams;
  ok: boolean;
}

export class ReplayTransport {
  /** Fixture names in the order they were served. */
  readonly served: string[] = [];
  /** Masked URLs that matched nothing. */
  readonly misses: string[] = [];
  private readonly entries: Entry[];
  private readonly cursors = new Map<string, number>();
  private readonly order: 'sequence' | 'first-ok';
  private readonly keyParams: Readonly<Record<string, readonly string[]>>;

  constructor(fixtures: readonly ReplayFixture[], opts: ReplayOptions = {}) {
    this.order = opts.order ?? 'sequence';
    this.keyParams = opts.keyParams ?? REPLAY_KEY_PARAMS;
    this.entries = fixtures.map((fx) => {
      const u = new URL(fx.request);
      const status = (fx.response as { status?: unknown } | null)?.status;
      return {
        fx,
        path: u.pathname,
        params: u.searchParams,
        ok: fx.httpStatus === 200 && Number(status) === 0,
      };
    });
  }

  /** Parses one probe.py recording; null if the object is not one. */
  static parseFixture(name: string, data: unknown): ReplayFixture | null {
    const meta = (data as { _meta?: { request?: unknown; http_status?: unknown } } | null)?._meta;
    if (!meta || typeof meta.request !== 'string' || !/^https?:\/\//.test(meta.request)) return null;
    const httpStatus = typeof meta.http_status === 'number' ? meta.http_status : 0;
    return {
      name,
      request: meta.request,
      httpStatus,
      response: (data as { response?: unknown }).response ?? null,
    };
  }

  /** Loads every recording (`*.json` with `_meta.request`) in the given directories, sorted by file name. */
  static async fromDirs(dirs: readonly string[], opts: ReplayDirOptions = {}): Promise<ReplayTransport> {
    const maxBytes = opts.maxBytes ?? 1_000_000;
    const fixtures: ReplayFixture[] = [];
    for (const dir of dirs) {
      const names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort();
      for (const n of names) {
        const file = join(dir, n);
        if ((await stat(file)).size > maxBytes) continue;
        let data: unknown;
        try {
          data = JSON.parse(await readFile(file, 'utf8'));
        } catch {
          continue;
        }
        const fx = ReplayTransport.parseFixture(n.replace(/\.json$/, ''), data);
        if (fx) fixtures.push(fx);
      }
    }
    return new ReplayTransport(fixtures, { order: 'first-ok', ...opts });
  }

  get size(): number {
    return this.entries.length;
  }

  /** Recordings that would answer `url`, in serving order. */
  match(url: string): ReplayFixture[] {
    return this.candidates(url).map((e) => e.fx);
  }

  readonly send: Transport = async ({ url }) => {
    const candidates = this.candidates(url);
    const pick = this.pick(candidates);
    if (!pick) {
      this.misses.push(maskUrl(url));
      throw new BaiduUpstreamError(`回放数据中没有这个请求：${maskUrl(url)}`, {
        kind: 'replay_miss',
        hint: '离线回放只能重放录制过的请求：请换用样例社区，或配置 Key 进入实时模式',
      });
    }
    this.served.push(pick.fx.name);
    if (pick.fx.httpStatus === 0) {
      throw new BaiduUpstreamError(`网络错误（回放：${pick.fx.name}）`, { kind: 'network', retryable: true });
    }
    return { httpStatus: pick.fx.httpStatus, json: structuredClone(pick.fx.response) };
  };

  private pick(candidates: Entry[]): Entry | undefined {
    if (this.order === 'first-ok') return candidates.find((e) => e.ok) ?? candidates[0];
    if (candidates.length === 0) return undefined;
    const key = candidates.map((e) => e.fx.name).join('\n');
    const i = this.cursors.get(key) ?? 0;
    this.cursors.set(key, i + 1);
    return candidates[Math.min(i, candidates.length - 1)];
  }

  private candidates(url: string): Entry[] {
    const u = new URL(url);
    const keys = this.keyParams[u.pathname];
    return this.entries.filter((e) => {
      if (e.path !== u.pathname) return false;
      const names =
        keys ?? [...new Set([...e.params.keys(), ...u.searchParams.keys()])].filter((k) => !IGNORED.has(k));
      return names.every((k) => sameParam(paramOf(e.params, k), paramOf(u.searchParams, k)));
    });
  }
}

function paramOf(params: URLSearchParams, name: string): string | undefined {
  return params.get(name) ?? PARAM_DEFAULTS[name];
}

/** Equal as strings, or token-wise equal with numeric tokens (coordinates) within 1e-6. */
export function sameParam(a: string | undefined, b: string | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  const ta = a.split(/([,;|$])/);
  const tb = b.split(/([,;|$])/);
  if (ta.length !== tb.length) return false;
  return ta.every((x, i) => {
    const y = tb[i] ?? '';
    if (x === y) return true;
    if (x === '' || y === '') return false;
    const nx = Number(x);
    const ny = Number(y);
    return Number.isFinite(nx) && Number.isFinite(ny) && Math.abs(nx - ny) <= COORD_TOLERANCE;
  });
}
