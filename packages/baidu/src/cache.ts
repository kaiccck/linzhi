/**
 * Two-level response cache (技术设计文档 §4.3): an in-memory LRU in front of the shared KvStore
 * (node:sqlite file by default), plus singleflight so identical concurrent requests cost one call.
 */
import { MemoryStore, type KvStore } from './store.js';
import { BAIDU_SERVICES, type BaiduService } from './types.js';

export const DAY_MS = 86_400_000;

/** Walking routes ignore traffic (measured: duration = distance / 1.17 m/s), so they keep 30 days. */
export const DEFAULT_TTL_MS: Readonly<Record<BaiduService, number>> = {
  routematrix_walking: 30 * DAY_MS,
  directionlite_walking: 30 * DAY_MS,
  place: 7 * DAY_MS,
  geocoding: 30 * DAY_MS,
  reverse_geocoding: 30 * DAY_MS,
  geoconv: 30 * DAY_MS,
};

/** "No route" / "no result" answers are kept one day, so map fixes show up soon. */
export const EMPTY_TTL_MS = DAY_MS;

const CACHE_NS = 'baidu:v1';
const DROPPED_PARAMS = new Set(['ak', 'sn', 'timestamp', 'output', 'callback']);
const NUMERIC_LIST = /^[\d\s.,;|+-]+$/;

/** Rounds to 1e-5° (≈ 1 m) and prints without trailing zeros; integers stay as they are. */
export function roundCoord(x: number): string {
  if (Number.isInteger(x)) return String(x);
  const r = Number(x.toFixed(5));
  return String(r === 0 ? 0 : r);
}

/**
 * Canonical text of one param value: numbers and numeric lists ("lat,lng|lat,lng") are rounded to
 * 1e-5°; arrays of [lng, lat] become "lng,lat;lng,lat"; other strings are only trimmed.
 */
export function normalizeParam(v: unknown): string {
  if (typeof v === 'number') return roundCoord(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') {
    const s = v.trim();
    return NUMERIC_LIST.test(s) ? s.replace(/-?\d+\.\d+/g, (t) => roundCoord(Number(t))) : s;
  }
  if (Array.isArray(v)) {
    return v.map((x) => (Array.isArray(x) ? x.map(normalizeParam).join(',') : normalizeParam(x))).join(';');
  }
  return JSON.stringify(v) ?? '';
}

/** `scope?k=v&…` with params sorted by name and ak/sn/timestamp/output dropped. */
export function cacheKey(
  scope: string,
  params: Readonly<Record<string, unknown>> | Iterable<readonly [string, unknown]>,
): string {
  const entries = Symbol.iterator in params ? [...params] : Object.entries(params);
  const kept = entries
    .filter(([k, v]) => !DROPPED_PARAMS.has(k) && v !== undefined && v !== null && v !== '')
    .map(([k, v]): [string, string] => [k, normalizeParam(v)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `${scope}?${kept.map(([k, v]) => `${k}=${v}`).join('&')}`;
}

interface MemEntry {
  json: string;
  expiresAt: number | null;
}

/** Map-backed LRU: re-inserting on access keeps the most recent entries at the end. */
class Lru {
  private readonly map = new Map<string, MemEntry>();
  constructor(private readonly max: number) {}

  get(key: string): MemEntry | undefined {
    const e = this.map.get(key);
    if (e) {
      this.map.delete(key);
      this.map.set(key, e);
    }
    return e;
  }

  set(key: string, e: MemEntry): void {
    if (this.max <= 0) return;
    this.map.delete(key);
    this.map.set(key, e);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

export interface CacheStats {
  hits: number;
  misses: number;
  /** Requests that joined an identical in-flight request instead of calling Baidu. */
  joined: number;
  writes: number;
}

export interface BaiduCacheOptions {
  store?: KvStore;
  /** In-memory LRU size (entries). Default 5000. */
  maxMemoryEntries?: number;
  now?: () => number;
  ttlMs?: Partial<Record<BaiduService, number>>;
  /** false = never read or write entries (singleflight still applies). */
  enabled?: boolean;
}

export interface Loaded<T> {
  value: T;
  via: 'cache' | 'api';
}

export class BaiduCache {
  readonly store: KvStore;
  readonly enabled: boolean;
  private readonly lru: Lru;
  private readonly now: () => number;
  private readonly ttl: Record<BaiduService, number>;
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly counters: Record<BaiduService, CacheStats>;

  constructor(opts: BaiduCacheOptions = {}) {
    this.store = opts.store ?? new MemoryStore();
    this.enabled = opts.enabled ?? true;
    this.lru = new Lru(opts.maxMemoryEntries ?? 5000);
    this.now = opts.now ?? Date.now;
    this.ttl = { ...DEFAULT_TTL_MS, ...opts.ttlMs };
    this.counters = Object.fromEntries(
      BAIDU_SERVICES.map((s) => [s, { hits: 0, misses: 0, joined: 0, writes: 0 }]),
    ) as Record<BaiduService, CacheStats>;
  }

  ttlFor(service: BaiduService): number {
    return this.ttl[service];
  }

  /** A fresh copy of the cached value, or undefined (counts a hit or a miss). */
  get<T>(service: BaiduService, key: string): T | undefined {
    const stats = this.counters[service];
    if (!this.enabled) {
      stats.misses++;
      return undefined;
    }
    const now = this.now();
    let e: MemEntry | undefined = this.lru.get(key);
    if (!e) {
      const stored = this.store.get(CACHE_NS, key);
      if (stored) {
        e = { json: stored.value, expiresAt: stored.expiresAt };
        this.lru.set(key, e);
      }
    }
    if (e && e.expiresAt !== null && e.expiresAt <= now) {
      this.delete(key);
      e = undefined;
    }
    if (!e) {
      stats.misses++;
      return undefined;
    }
    stats.hits++;
    return JSON.parse(e.json) as T;
  }

  set(service: BaiduService, key: string, value: unknown, ttlMs: number = this.ttlFor(service)): void {
    if (!this.enabled || !(ttlMs > 0)) return;
    const e: MemEntry = { json: JSON.stringify(value), expiresAt: this.now() + ttlMs };
    this.lru.set(key, e);
    this.store.set(CACHE_NS, key, e.json, e.expiresAt);
    this.counters[service].writes++;
  }

  delete(key: string): void {
    this.lru.delete(key);
    this.store.delete(CACHE_NS, key);
  }

  /** The in-flight load of `key`, if another caller already started it. */
  pending<T>(key: string): Promise<T> | undefined {
    return this.inflight.get(key) as Promise<T> | undefined;
  }

  /** Registers an in-flight load so identical requests can join it; removed once settled. */
  track<T>(key: string, p: Promise<T>): Promise<T> {
    this.inflight.set(key, p);
    const clear = () => {
      if (this.inflight.get(key) === p) this.inflight.delete(key);
    };
    p.then(clear, clear);
    return p;
  }

  /** Counts a singleflight join for the stats. */
  noteJoined(service: BaiduService): void {
    this.counters[service].joined++;
  }

  /**
   * Cached value, or the result of an identical in-flight load, or `load()` (stored with `ttlOf(value)`,
   * default the service TTL). Errors are never cached.
   */
  async getOrLoad<T>(
    service: BaiduService,
    key: string,
    load: () => Promise<T>,
    ttlOf?: (value: T) => number,
  ): Promise<Loaded<T>> {
    const hit = this.get<T>(service, key);
    if (hit !== undefined) return { value: hit, via: 'cache' };
    const pending = this.pending<T>(key);
    if (pending) {
      this.noteJoined(service);
      return { value: structuredClone(await pending), via: 'api' };
    }
    const p = this.track(
      key,
      load().then((value) => {
        this.set(service, key, value, ttlOf ? ttlOf(value) : this.ttlFor(service));
        return value;
      }),
    );
    return { value: await p, via: 'api' };
  }

  stats(): Record<BaiduService, CacheStats> {
    return structuredClone(this.counters);
  }

  purgeExpired(): number {
    return this.store.purgeExpired(this.now());
  }

  /** Drops the in-memory layer (the store keeps its entries). */
  clearMemory(): void {
    this.lru.clear();
  }
}
