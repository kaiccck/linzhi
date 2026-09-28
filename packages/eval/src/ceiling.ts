/**
 * The evaluation's hard quota ceiling. Quota is scarce (personal tier: 5,000 routematrix routes and 100
 * place requests a day), so a run gets a cap per service and the ledger refuses the request that would
 * pass it, before it is sent. What this process billed is counted from the ledger's own tickets, so
 * cache hits cost nothing and other processes sharing the SQLite ledger do not eat the cap. The day's
 * 90 % soft limit of the tier still applies on top (the parent QuotaLedger).
 */
import {
  BaiduClient,
  BaiduQuotaError,
  QuotaLedger,
  SERVICE_LABEL,
  type BaiduService,
  type LedgerTicket,
  type QuotaBudget,
  type QuotaLedgerOptions,
} from '@zoudedao/baidu';
import type { EngineClient } from '@zoudedao/engine';

/** Refused by the evaluation's own cap (not Baidu's quota). */
export class EvalCeilingError extends BaiduQuotaError {}

export type Ceilings = Partial<Record<BaiduService, number>>;

export class CeilingLedger extends QuotaLedger {
  private readonly caps: Ceilings;
  private readonly billedHere = new Map<BaiduService, number>();
  private readonly pendingHere = new Map<BaiduService, number>();

  /** `caps`: units this process may bill per service; services without a cap are only under the tier limits. */
  constructor(opts: QuotaLedgerOptions & { caps: Ceilings }) {
    super(opts);
    this.caps = { ...opts.caps };
  }

  cap(service: BaiduService): number | undefined {
    return this.caps[service];
  }

  /** Units this process billed since the ledger was created. */
  billed(service: BaiduService): number {
    return this.billedHere.get(service) ?? 0;
  }

  /** Units still allowed under the cap (Infinity without one). */
  headroom(service: BaiduService): number {
    const cap = this.caps[service];
    if (cap === undefined) return Infinity;
    return Math.max(0, cap - this.billed(service) - (this.pendingHere.get(service) ?? 0));
  }

  override acquire(service: BaiduService, units: number, budget?: QuotaBudget): LedgerTicket {
    const cap = this.caps[service];
    if (cap !== undefined && units > this.headroom(service)) {
      throw new EvalCeilingError(
        `${SERVICE_LABEL[service]}：本次评测上限 ${cap}，已计费 ${this.billed(service)}，下一次请求需要 ${units}，已停止`,
        {
          service,
          scope: 'hard',
          hint: '提高 --max-routes / --max-walks 后重新运行；已完成的步骤会跳过，已测过的路线命中缓存不再计费',
        },
      );
    }
    const ticket = super.acquire(service, units, budget);
    const add = (m: Map<BaiduService, number>, v: number) => m.set(service, (m.get(service) ?? 0) + v);
    add(this.pendingHere, units);
    let open = true;
    const close = () => {
      if (!open) return false;
      open = false;
      add(this.pendingHere, -units);
      return true;
    };
    return {
      service,
      units,
      commit: (billedUnits = units) => {
        if (close()) add(this.billedHere, billedUnits);
        ticket.commit(billedUnits);
      },
      fail: () => {
        close();
        ticket.fail();
      },
      release: () => {
        close();
        ticket.release();
      },
    };
  }
}

/** Calls of one method: routes asked (cached or not) and what they cost. */
export interface Tally {
  /** Routematrix calls and the routes they asked for. */
  matrix_calls: number;
  routes: number;
  /** HTTP routematrix requests (cache hits need none). */
  requests: number;
  routes_billed: number;
  /** directionlite walks asked for. */
  walks: number;
  place: number;
  reverse_geocoding: number;
}

export const emptyTally = (): Tally => ({
  matrix_calls: 0,
  routes: 0,
  requests: 0,
  routes_billed: 0,
  walks: 0,
  place: 0,
  reverse_geocoding: 0,
});

/**
 * The client as the engine sees it, counting every call into `tally`. It has no `ledger`: the engine
 * then reserves nothing up front (a reservation would claim the whole cap even for cached routes) and
 * every uncached request meets the ceiling one by one.
 */
export function tallyClient(client: BaiduClient, tally: Tally): EngineClient {
  return {
    reverseGeocode: (location, opts) => {
      tally.reverse_geocoding++;
      return client.reverseGeocode(location, opts);
    },
    placeAround: (keywords, center, opts) => {
      tally.place++;
      return client.placeAround(keywords, center, opts);
    },
    routeMatrixWalking: async (origins, destinations, opts) => {
      tally.matrix_calls++;
      tally.routes += origins.length * destinations.length;
      const m = await client.routeMatrixWalking(origins, destinations, opts);
      tally.requests += m.stats.requests;
      tally.routes_billed += m.stats.routesRequested;
      return m;
    },
    walkingRoute: (origin, destination, opts) => {
      tally.walks++;
      return client.walkingRoute(origin, destination, opts);
    },
  };
}
