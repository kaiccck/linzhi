import type { QuotaEvent } from './analyzer.js';

export interface QuotaUsage {
  used: number;
  limit: number;
}

/** Today's usage per Baidu service, keyed by service name (place, routematrix_walking, …). */
export type QuotaSnapshot = Record<string, QuotaUsage>;

/** Feeds the quota block of /api/health; live mode will adapt the packages/baidu ledger to this. */
export interface QuotaProvider {
  snapshot(): QuotaSnapshot | Promise<QuotaSnapshot>;
}

export const emptyQuota: QuotaProvider = { snapshot: () => ({}) };

/** Personal-tier daily limits (docs/技术设计文档.md §2.1). */
export const PERSONAL_TIER_LIMITS: Readonly<Record<string, number>> = {
  geocoding: 5000,
  reverse_geocoding: 300,
  geoconv: 5000,
  place: 100,
  routematrix_walking: 5000,
  directionlite_walking: 5000,
};

/** In-process counter, so the replay's quota events and /api/health tell the same story. Resets on restart. */
export class MemoryQuotaLedger implements QuotaProvider {
  readonly #limits: Readonly<Record<string, number>>;
  readonly #used = new Map<string, number>();

  constructor(limits: Readonly<Record<string, number>> = PERSONAL_TIER_LIMITS) {
    this.#limits = limits;
  }

  charge(service: string, count: number): QuotaEvent {
    const used = (this.#used.get(service) ?? 0) + count;
    this.#used.set(service, used);
    return { service, used, limit: this.#limits[service] ?? 0 };
  }

  snapshot(): QuotaSnapshot {
    const snapshot: QuotaSnapshot = {};
    for (const [service, limit] of Object.entries(this.#limits)) {
      snapshot[service] = { used: this.#used.get(service) ?? 0, limit };
    }
    return snapshot;
  }
}
