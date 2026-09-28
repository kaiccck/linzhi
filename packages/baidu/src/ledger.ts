/**
 * Daily quota ledger (技术设计文档 §4.4). Counts what Baidu bills per service and day (routes for
 * routematrix), refuses cold calls at 90 % of the tier limit, opens a breaker after a 302, and
 * persists through the same KvStore as the cache so restarts keep the count.
 *
 * Billing assumption (not confirmed by Baidu): only calls Baidu processed (status 0 or "no result") are
 * counted; config errors, 401/402 and network failures are not, as in the research scripts' tally.
 * If Baidu bills more, its 302 still trips the breaker.
 */
import { BaiduQuotaError } from './errors.js';
import { MemoryStore, type KvStore } from './store.js';
import { BAIDU_SERVICES, SERVICE_LABEL, type BaiduService, type BaiduTier } from './types.js';

/** Calls per day (routematrix: routes = origins × destinations). 开发者权益表, 2025-10. */
export const DAILY_QUOTA: Readonly<Record<BaiduTier, Readonly<Record<BaiduService, number>>>> = {
  personal: {
    place: 100,
    routematrix_walking: 5000,
    directionlite_walking: 5000,
    geocoding: 5000,
    reverse_geocoding: 300,
    geoconv: 5000,
  },
  enterprise: {
    place: 2000,
    routematrix_walking: 100_000,
    directionlite_walking: 100_000,
    geocoding: 100_000,
    reverse_geocoding: 100_000,
    geoconv: 100_000,
  },
};

/** Per-service QPS of the tier (all six services share the same figure). */
export const TIER_QPS: Readonly<Record<BaiduTier, number>> = { personal: 3, enterprise: 30 };

export const SOFT_LIMIT_RATIO = 0.9;

const LEDGER_NS = 'ledger:v1';
const KEEP_DAYS_MS = 7 * 86_400_000;
const CHINA_OFFSET_MS = 8 * 3_600_000;

/** Baidu resets quotas at midnight Beijing time, whatever the server's time zone. */
export function quotaDay(nowMs: number): string {
  return new Date(nowMs + CHINA_OFFSET_MS).toISOString().slice(0, 10);
}

/** Units per service, e.g. the expected cost of one analysis. */
export type QuotaPlan = Partial<Record<BaiduService, number>>;

/** Wire shape for /api/health and the SSE `quota` event (snake_case, docs/api.md). */
export interface ServiceQuota {
  used: number;
  limit: number;
  remaining: number;
  /** Cold calls are refused beyond this (90 % of limit) unless they belong to a reserved budget. */
  soft_limit: number;
  /** Held by open analysis budgets. */
  reserved: number;
  in_flight: number;
  /** Billed requests (for routematrix `used` counts routes, `calls` counts requests). */
  calls: number;
  failed: number;
  exhausted: boolean;
  exhausted_reason?: string;
}

export type QuotaSnapshot = Record<BaiduService, ServiceQuota>;

interface DayCounters {
  used: number;
  calls: number;
  failed: number;
  exhausted_at?: number;
  exhausted_reason?: string;
}

export interface LedgerTicket {
  readonly service: BaiduService;
  readonly units: number;
  /** Baidu processed the call: bill it (default: the acquired units). */
  commit(billedUnits?: number): void;
  /** The call failed: release the units without billing and count a failure. */
  fail(): void;
  /** The call never went out (aborted while queued): release the units, count nothing. */
  release(): void;
}

export interface QuotaLedgerOptions {
  tier?: BaiduTier;
  store?: KvStore;
  now?: () => number;
  softRatio?: number;
  /** Override daily limits (tests, or an account with custom quota). */
  limits?: Partial<Record<BaiduService, number>>;
}

type Listener = (service: BaiduService, quota: ServiceQuota) => void;

export class QuotaLedger {
  readonly tier: BaiduTier;
  readonly softRatio: number;
  private readonly store: KvStore;
  private readonly now: () => number;
  private readonly limits: Record<BaiduService, number>;
  private readonly inFlight = new Map<BaiduService, number>();
  private readonly reserved = new Map<BaiduService, number>();
  private readonly listeners = new Set<Listener>();
  private counters: Partial<Record<BaiduService, DayCounters>> = {};

  constructor(opts: QuotaLedgerOptions = {}) {
    this.tier = opts.tier ?? 'personal';
    this.softRatio = opts.softRatio ?? SOFT_LIMIT_RATIO;
    this.store = opts.store ?? new MemoryStore();
    this.now = opts.now ?? Date.now;
    this.limits = { ...DAILY_QUOTA[this.tier], ...opts.limits };
    this.refresh();
  }

  day(): string {
    return quotaDay(this.now());
  }

  limit(service: BaiduService): number {
    return this.limits[service];
  }

  softLimit(service: BaiduService): number {
    return Math.floor(this.limits[service] * this.softRatio);
  }

  usage(service: BaiduService): ServiceQuota {
    this.refresh();
    const c = this.counters[service] ?? { used: 0, calls: 0, failed: 0 };
    const limit = this.limits[service];
    return {
      used: c.used,
      limit,
      remaining: Math.max(0, limit - c.used),
      soft_limit: this.softLimit(service),
      reserved: this.reserved.get(service) ?? 0,
      in_flight: this.inFlight.get(service) ?? 0,
      calls: c.calls,
      failed: c.failed,
      exhausted: c.exhausted_at !== undefined,
      ...(c.exhausted_reason ? { exhausted_reason: c.exhausted_reason } : {}),
    };
  }

  snapshot(): QuotaSnapshot {
    return Object.fromEntries(BAIDU_SERVICES.map((s) => [s, this.usage(s)])) as QuotaSnapshot;
  }

  /** Services that cannot take `plan` under the soft limit (empty = a cold analysis may start). */
  blockedBy(plan: QuotaPlan): BaiduService[] {
    return BAIDU_SERVICES.filter((s) => {
      const units = plan[s] ?? 0;
      if (units <= 0) return false;
      const u = this.usage(s);
      return u.exhausted || u.used + u.in_flight + u.reserved + units > u.soft_limit;
    });
  }

  /**
   * Reserves quota for one cold analysis. Throws BaiduQuotaError (scope 'soft') when any service would
   * pass 90 %. Calls made with the budget may then run up to 100 %; release() returns what is left.
   */
  reserve(plan: QuotaPlan): QuotaBudget {
    const blocked = this.blockedBy(plan);
    const first = blocked[0];
    if (first) {
      throw new BaiduQuotaError(`${SERVICE_LABEL[first]}今日配额已用到 90%，不再开始新的实时分析`, {
        service: first,
        scope: 'soft',
        hint: '配额接近上限：请查看已缓存的分析结果或样例社区，北京时间次日 0 点恢复',
      });
    }
    for (const [s, units] of Object.entries(plan) as [BaiduService, number][]) {
      if (units > 0) this.reserved.set(s, (this.reserved.get(s) ?? 0) + units);
    }
    return new QuotaBudget(this, plan);
  }

  /**
   * Claims units for one request. Without a budget (or beyond it) the call must fit under the soft
   * limit together with every open reservation; with a budget it may use up to the hard limit.
   */
  acquire(service: BaiduService, units: number, budget?: QuotaBudget): LedgerTicket {
    const u = this.usage(service);
    const label = SERVICE_LABEL[service];
    if (u.exhausted) {
      throw new BaiduQuotaError(`${label}今日配额已用尽（百度返回配额超限），今天不再调用`, {
        service,
        scope: 'daily',
        hint: '今日配额已用尽：改用缓存或样例数据，北京时间次日 0 点恢复',
      });
    }
    const fromBudget = budget !== undefined && budget.take(service, units);
    if (fromBudget) {
      if (u.used + u.in_flight + units > u.limit) {
        budget.refund(service, units);
        throw new BaiduQuotaError(`${label}今日配额即将超出上限（${u.used}/${u.limit}）`, {
          service,
          scope: 'hard',
          hint: '今日配额已用尽：改用缓存或样例数据，北京时间次日 0 点恢复',
        });
      }
    } else if (u.used + u.in_flight + u.reserved + units > u.soft_limit) {
      throw new BaiduQuotaError(`${label}今日配额已用到 90%（${u.used}/${u.limit}），拒绝新的实时调用`, {
        service,
        scope: 'soft',
        hint: '配额接近上限：请使用已缓存的结果或样例社区，北京时间次日 0 点恢复',
      });
    }
    this.inFlight.set(service, (this.inFlight.get(service) ?? 0) + units);
    let open = true;
    const close = () => {
      if (!open) return false;
      open = false;
      this.inFlight.set(service, Math.max(0, (this.inFlight.get(service) ?? 0) - units));
      return true;
    };
    return {
      service,
      units,
      commit: (billedUnits = units) => {
        if (close()) this.bump(service, { used: billedUnits, calls: 1 });
      },
      fail: () => {
        if (!close()) return;
        if (fromBudget) budget.refund(service, units);
        this.bump(service, { failed: 1 });
      },
      release: () => {
        if (close() && fromBudget) budget.refund(service, units);
      },
    };
  }

  /** Opens the breaker for the rest of the (Beijing) day after Baidu answered 302. */
  markExhausted(service: BaiduService, reason: string): void {
    this.bump(service, {}, { exhausted_at: this.now(), exhausted_reason: reason });
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** @internal budget bookkeeping */
  unreserve(service: BaiduService, units: number): void {
    this.reserved.set(service, Math.max(0, (this.reserved.get(service) ?? 0) - units));
  }

  /** @internal */
  rereserve(service: BaiduService, units: number): void {
    this.reserved.set(service, (this.reserved.get(service) ?? 0) + units);
  }

  /** Re-reads today's counters (another process may share the store) and rolls over at midnight. */
  private refresh(): void {
    this.counters = this.load(this.day());
  }

  private load(day: string): Partial<Record<BaiduService, DayCounters>> {
    const raw = this.store.get(LEDGER_NS, day)?.value;
    if (!raw) return {};
    try {
      return JSON.parse(raw) as Partial<Record<BaiduService, DayCounters>>;
    } catch {
      return {};
    }
  }

  // Read-merge-write of a delta, so two processes sharing the SQLite file do not overwrite each other.
  private bump(
    service: BaiduService,
    delta: Partial<Pick<DayCounters, 'used' | 'calls' | 'failed'>>,
    set?: Partial<DayCounters>,
  ): void {
    const day = this.day();
    const all = this.load(day);
    const c = all[service] ?? { used: 0, calls: 0, failed: 0 };
    c.used += delta.used ?? 0;
    c.calls += delta.calls ?? 0;
    c.failed += delta.failed ?? 0;
    Object.assign(c, set);
    all[service] = c;
    this.store.set(LEDGER_NS, day, JSON.stringify(all), this.now() + KEEP_DAYS_MS);
    this.counters = all;
    const snapshot = this.usage(service);
    for (const l of this.listeners) l(service, snapshot);
  }
}

/** Quota held for one analysis; pass it as `{ budget }` to client calls and release() when done. */
export class QuotaBudget {
  private readonly left = new Map<BaiduService, number>();
  private released = false;

  constructor(
    private readonly ledger: QuotaLedger,
    plan: QuotaPlan,
  ) {
    for (const [s, units] of Object.entries(plan) as [BaiduService, number][]) {
      if (units > 0) this.left.set(s, units);
    }
  }

  remaining(service: BaiduService): number {
    return this.left.get(service) ?? 0;
  }

  /** @internal Draws units from the reservation; false if not enough is left. */
  take(service: BaiduService, units: number): boolean {
    const left = this.left.get(service) ?? 0;
    if (this.released || left < units) return false;
    this.left.set(service, left - units);
    this.ledger.unreserve(service, units);
    return true;
  }

  /** @internal Puts units back after a failed call. */
  refund(service: BaiduService, units: number): void {
    if (this.released) return;
    this.left.set(service, (this.left.get(service) ?? 0) + units);
    this.ledger.rereserve(service, units);
  }

  /** Returns every unused unit to the ledger. Idempotent. */
  release(): void {
    if (this.released) return;
    this.released = true;
    for (const [s, units] of this.left) this.ledger.unreserve(s, units);
    this.left.clear();
  }
}
