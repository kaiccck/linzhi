/**
 * Per-service request lanes (技术设计文档 §4.2): a token bucket at the tier QPS minus headroom, an extra
 * route bucket for routematrix, AIMD concurrency (start at 1, +1 after a run of successes, halve on
 * 401), and the status policy with exponential backoff.
 *
 * Measured 2026-09-26: 401 behaves like a time window — three concurrent 1×50 batches got two 401s, and
 * even requests 1 s apart sometimes did. Shrinking the batch did not help, waiting did, so a 401 retries
 * the same chunk after 1, 2, 4, 8, 16 s (+ jitter) and pauses the whole lane meanwhile.
 */
import { BaiduError, BaiduUpstreamError, statusError, statusRule } from './errors.js';
import { TIER_QPS } from './ledger.js';
import type { TransportResponse } from './transport.js';
import { BAIDU_SERVICES, SERVICE_LABEL, type BaiduJson, type BaiduService, type BaiduTier } from './types.js';

export interface LaneLimits {
  /** Requests per second. */
  ratePerSecond: number;
  /** Requests that may start back to back. */
  burst: number;
  /** AIMD ceiling; concurrency always starts at 1. */
  maxConcurrency: number;
  /** routematrix: Baidu counts QPS and quota per route, so routes get their own bucket. */
  routesPerSecond?: number;
  routeBurst?: number;
}

export function defaultLaneLimits(tier: BaiduTier, service: BaiduService): LaneLimits {
  // Headroom: 2/3 of the tier QPS (3 → 2/s, 30 → 20/s). Burst 1 keeps requests evenly spaced.
  const limits: LaneLimits = {
    ratePerSecond: Math.max(1, Math.floor((TIER_QPS[tier] * 2) / 3)),
    burst: 1,
    maxConcurrency: tier === 'personal' ? 3 : 10,
  };
  if (service === 'routematrix_walking') {
    // Empirical (research/zhangjiang): of 8 batches (≤ 50 routes) paced 1.15 s apart, 7 passed at once
    // and 1 drew a 401 that passed on retry. 45 routes/s spaces full batches about 1.1 s apart.
    limits.routesPerSecond = tier === 'personal' ? 45 : 450;
    limits.routeBurst = tier === 'personal' ? 50 : 500;
  }
  return limits;
}

/** 1, 2, 4, 8, 16 s … for retry 1, 2, 3 …, stretched by up to `jitter` × random(). */
export function backoffDelay(
  retry: number,
  baseMs = 1000,
  jitter = 0.25,
  random: () => number = Math.random,
): number {
  return Math.round(baseMs * 2 ** (retry - 1) * (1 + jitter * random()));
}

/** Token bucket that may go into debt: reserve() returns how long the caller must wait. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly ratePerSecond: number,
    private readonly capacity: number,
    private readonly now: () => number,
  ) {
    this.tokens = capacity;
    this.last = now();
  }

  reserve(n: number): number {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 1000) * this.ratePerSecond);
    this.last = t;
    this.tokens -= n;
    return this.tokens >= 0 ? 0 : Math.ceil((-this.tokens / this.ratePerSecond) * 1000);
  }
}

class Lane {
  limit = 1;
  active = 0;
  streak = 0;
  coolDownUntil = 0;
  attempts = 0;
  retries = 0;
  throttled = 0;
  readonly bucket: TokenBucket;
  readonly routes: TokenBucket | null;
  private readonly waiters: (() => void)[] = [];

  constructor(
    readonly limits: LaneLimits,
    now: () => number,
  ) {
    this.bucket = new TokenBucket(limits.ratePerSecond, Math.max(1, limits.burst), now);
    this.routes =
      limits.routesPerSecond && limits.routesPerSecond > 0
        ? new TokenBucket(limits.routesPerSecond, Math.max(50, limits.routeBurst ?? 50), now)
        : null;
  }

  get queued(): number {
    return this.waiters.length;
  }

  acquire(signal?: AbortSignal): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const grant = () => {
        signal?.removeEventListener('abort', onAbort);
        this.active++;
        resolve();
      };
      const onAbort = () => {
        const i = this.waiters.indexOf(grant);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(abortReason(signal));
      };
      this.waiters.push(grant);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
    this.pump();
  }

  /** Additive increase; returns true when the limit went up. */
  onSuccess(increaseAfter: number): boolean {
    this.streak++;
    if (this.streak < increaseAfter || this.limit >= this.limits.maxConcurrency) return false;
    this.limit++;
    this.streak = 0;
    this.pump();
    return true;
  }

  /** Multiplicative decrease on 401/402/429. */
  onThrottle(): void {
    this.throttled++;
    this.streak = 0;
    this.limit = Math.max(1, Math.floor(this.limit / 2));
  }

  private pump(): void {
    while (this.active < this.limit) {
      const next = this.waiters.shift();
      if (!next) break;
      next();
    }
  }
}

export type SchedulerEvent =
  | { type: 'attempt'; service: BaiduService; attempt: number; units: number }
  | {
      type: 'status';
      service: BaiduService;
      attempt: number;
      status: number;
      httpStatus: number;
      latencyMs: number;
    }
  | {
      type: 'retry';
      service: BaiduService;
      reason: 'server' | 'throttle' | 'network';
      retry: number;
      status?: number;
      delayMs: number;
    }
  | { type: 'concurrency'; service: BaiduService; limit: number };

export interface SchedulerOptions {
  tier?: BaiduTier;
  limits?: Partial<Record<BaiduService, Partial<LaneLimits>>>;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  /** First backoff step (default 1000 ms). */
  backoffBaseMs?: number;
  /** Extra random stretch of each backoff step (default 0.25 = up to +25 %). */
  jitter?: number;
  /** Consecutive successes before concurrency +1 (default 4). */
  increaseAfter?: number;
  /** Retries for requests that never reached Baidu (default 3). */
  networkRetries?: number;
  onEvent?: (event: SchedulerEvent) => void;
}

export interface ExecuteRequest {
  service: BaiduService;
  /** Routes for routematrix, 1 otherwise. */
  units?: number;
  /** One HTTP attempt; called again for every retry (so signatures and timestamps stay fresh). */
  send: (attempt: number) => Promise<TransportResponse>;
  signal?: AbortSignal | undefined;
  /** Env var of the AK in use, substituted into error hints. */
  akVar?: string | undefined;
}

export interface ExecuteResult {
  json: BaiduJson;
  /** Processed but nothing found (directionlite 7, geocoding "无相关结果"). */
  empty: boolean;
  attempts: number;
}

export interface LaneStats {
  concurrency: number;
  active: number;
  queued: number;
  attempts: number;
  retries: number;
  throttled: number;
}

export class Scheduler {
  readonly tier: BaiduTier;
  private readonly lanes = new Map<BaiduService, Lane>();
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly backoffBaseMs: number;
  private readonly jitter: number;
  private readonly increaseAfter: number;
  private readonly networkRetries: number;
  private readonly onEvent: ((event: SchedulerEvent) => void) | undefined;
  private readonly overrides: Partial<Record<BaiduService, Partial<LaneLimits>>>;

  constructor(opts: SchedulerOptions = {}) {
    this.tier = opts.tier ?? 'personal';
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
    this.random = opts.random ?? Math.random;
    this.backoffBaseMs = opts.backoffBaseMs ?? 1000;
    this.jitter = opts.jitter ?? 0.25;
    this.increaseAfter = opts.increaseAfter ?? 4;
    this.networkRetries = opts.networkRetries ?? 3;
    this.onEvent = opts.onEvent;
    this.overrides = opts.limits ?? {};
  }

  /** Runs one logical request through its lane, applying the status policy. */
  async execute(req: ExecuteRequest): Promise<ExecuteResult> {
    const { service, signal } = req;
    const lane = this.lane(service);
    const units = Math.max(1, req.units ?? 1);
    if (signal?.aborted) throw abortReason(signal);
    await lane.acquire(signal);
    const retries = { server: 0, throttle: 0, network: 0 };
    let attempt = 0;
    try {
      for (;;) {
        attempt++;
        await this.pace(lane, units, signal);
        if (signal?.aborted) throw abortReason(signal);
        lane.attempts++;
        this.emit({ type: 'attempt', service, attempt, units });
        const started = this.now();
        let res: TransportResponse;
        try {
          res = await req.send(attempt);
        } catch (err) {
          if (signal?.aborted) throw err;
          const retryable =
            !(err instanceof BaiduError) || (err instanceof BaiduUpstreamError && err.retryable);
          if (retryable && retries.network < this.networkRetries) {
            await this.backoff(req, lane, 'network', ++retries.network);
            continue;
          }
          throw asUpstreamError(err, service, attempt);
        }
        const latencyMs = this.now() - started;

        if (res.httpStatus === 429 || res.httpStatus >= 500) {
          const reason = res.httpStatus === 429 ? 'throttle' : 'network';
          if (reason === 'throttle') this.throttle(service, lane);
          if (retries[reason] < (reason === 'throttle' ? 5 : this.networkRetries)) {
            await this.backoff(req, lane, reason, ++retries[reason]);
            continue;
          }
        }
        if (res.httpStatus < 200 || res.httpStatus >= 300) {
          throw new BaiduUpstreamError(`${SERVICE_LABEL[service]}失败：HTTP ${res.httpStatus}`, {
            service,
            kind: 'http',
            attempts: attempt,
            hint: '百度接口暂时不可用，请稍后再试',
          });
        }
        const json = asBaiduJson(res.json);
        if (!json) {
          throw new BaiduUpstreamError(`${SERVICE_LABEL[service]}返回的不是有效的 JSON`, {
            service,
            kind: 'bad_response',
            attempts: attempt,
            hint: '百度返回了无法解析的内容，请稍后再试',
          });
        }
        const raw = json.message ?? json.msg;
        const message = typeof raw === 'string' ? raw : undefined;
        this.emit({
          type: 'status',
          service,
          attempt,
          status: json.status,
          httpStatus: res.httpStatus,
          latencyMs,
        });
        const action = statusRule(json.status, message).action;
        if (action.kind === 'ok' || action.kind === 'empty') {
          if (lane.onSuccess(this.increaseAfter)) {
            this.emit({ type: 'concurrency', service, limit: lane.limit });
          }
          return { json, empty: action.kind === 'empty', attempts: attempt };
        }
        if (action.kind === 'retry') {
          const reason = action.throttle ? 'throttle' : 'server';
          if (action.throttle) this.throttle(service, lane);
          if (retries[reason] < action.maxRetries) {
            await this.backoff(req, lane, reason, ++retries[reason], json.status);
            continue;
          }
        }
        throw statusError(json.status, message, { service, akVar: req.akVar, attempts: attempt });
      }
    } finally {
      lane.release();
    }
  }

  stats(): Record<BaiduService, LaneStats> {
    return Object.fromEntries(
      BAIDU_SERVICES.map((s) => {
        const l = this.lanes.get(s);
        const stats: LaneStats = l
          ? {
              concurrency: l.limit,
              active: l.active,
              queued: l.queued,
              attempts: l.attempts,
              retries: l.retries,
              throttled: l.throttled,
            }
          : { concurrency: 1, active: 0, queued: 0, attempts: 0, retries: 0, throttled: 0 };
        return [s, stats];
      }),
    ) as Record<BaiduService, LaneStats>;
  }

  /** Current AIMD concurrency limit of a lane. */
  concurrency(service: BaiduService): number {
    return this.lane(service).limit;
  }

  private lane(service: BaiduService): Lane {
    let lane = this.lanes.get(service);
    if (!lane) {
      lane = new Lane({ ...defaultLaneLimits(this.tier, service), ...this.overrides[service] }, this.now);
      this.lanes.set(service, lane);
    }
    return lane;
  }

  private throttle(service: BaiduService, lane: Lane): void {
    lane.onThrottle();
    this.emit({ type: 'concurrency', service, limit: lane.limit });
  }

  /** Waits out any lane-wide cool-down, then the request and route buckets. */
  private async pace(lane: Lane, units: number, signal?: AbortSignal): Promise<void> {
    for (let wait = lane.coolDownUntil - this.now(); wait > 0; wait = lane.coolDownUntil - this.now()) {
      await this.sleep(wait, signal);
    }
    const wait = Math.max(lane.bucket.reserve(1), lane.routes?.reserve(units) ?? 0);
    if (wait > 0) await this.sleep(wait, signal);
  }

  private async backoff(
    req: ExecuteRequest,
    lane: Lane,
    reason: 'server' | 'throttle' | 'network',
    retry: number,
    status?: number,
  ): Promise<void> {
    const delayMs = backoffDelay(retry, this.backoffBaseMs, this.jitter, this.random);
    // A 401 is about the whole key's time window: hold every request of this lane, not just this one.
    if (reason === 'throttle') lane.coolDownUntil = Math.max(lane.coolDownUntil, this.now() + delayMs);
    lane.retries++;
    this.emit({
      type: 'retry',
      service: req.service,
      reason,
      retry,
      delayMs,
      ...(status === undefined ? {} : { status }),
    });
    await this.sleep(delayMs, req.signal);
  }

  private emit(event: SchedulerEvent): void {
    this.onEvent?.(event);
  }
}

function asBaiduJson(v: unknown): BaiduJson | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const status = Number((v as { status?: unknown }).status);
  if (!Number.isFinite(status)) return null;
  const json = v as BaiduJson;
  json.status = status;
  return json;
}

function asUpstreamError(err: unknown, service: BaiduService, attempts: number): BaiduError {
  if (err instanceof BaiduError && !(err instanceof BaiduUpstreamError && err.kind === 'network')) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new BaiduUpstreamError(
    message.startsWith('网络错误') ? message : `${SERVICE_LABEL[service]}失败：${message}`,
    {
      service,
      kind: 'network',
      attempts,
      cause: err,
      hint: '请求没有到达百度（网络、代理或 TLS 问题），已自动重试；不计入配额',
    },
  );
}

function abortReason(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException('This operation was aborted', 'AbortError');
}

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
