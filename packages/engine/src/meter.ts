/**
 * Every Baidu call of a run goes through the meter: it stops at abort, keeps each step inside its
 * budget line, passes { budget, signal } to the client, counts what Baidu billed (cache hits cost
 * nothing) and what the run asked for (cached or not), and reports the service's quota after the call.
 * The budget basis decides which of the two counts the budget lines hold.
 */
import type { CallOptions, QuotaBudget } from '@zoudedao/baidu';

import { STEP_SERVICE, type Step } from './budget.js';
import type { BudgetBasis, EngineLedger, EngineService, QuotaEvent } from './types.js';

/** Settles like `work`, but rejects with the abort reason as soon as `signal` fires. */
export function abortable<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

const zeroServices = (): Record<EngineService, number> => ({
  reverse_geocoding: 0,
  place: 0,
  directionlite_walking: 0,
  routematrix_walking: 0,
});

const zeroSteps = (): Record<Step, number> => ({
  locate: 0,
  facilities: 0,
  residential: 0,
  paths: 0,
  seed: 0,
  refine: 0,
  coverage: 0,
  siting: 0,
});

export class Meter {
  /** Billed units: what the ledger was charged. */
  readonly used = zeroServices();
  readonly byStep = zeroSteps();
  /** Requested units, cache hits included. */
  readonly requested = zeroServices();
  readonly requestedByStep = zeroSteps();
  private readonly lastQuota = new Map<string, string>();

  constructor(
    private readonly caps: Readonly<Record<Step, number>>,
    private readonly serviceCaps: Readonly<Record<EngineService, number>>,
    private readonly opts: {
      ledger?: EngineLedger | undefined;
      budget?: QuotaBudget | undefined;
      signal?: AbortSignal | undefined;
      onQuota: (event: QuotaEvent) => void;
      /** Default 'billed'. */
      basis?: BudgetBasis | undefined;
    },
  ) {}

  /** Units `step` may still spend: the smaller of its own line and its service's cap. */
  room(step: Step): number {
    const service = STEP_SERVICE[step];
    const requested = this.opts.basis === 'requested';
    const spentStep = requested ? this.requestedByStep : this.byStep;
    const spentService = requested ? this.requested : this.used;
    return Math.max(
      0,
      Math.min(this.caps[step] - spentStep[step], this.serviceCaps[service] - spentService[service]),
    );
  }

  /**
   * One client call worth at most `planned` units. `billed` reads what the call actually cost from its
   * result (pages or routes from the API, not from the cache); `asked` what it asked for, cache hits
   * included (default `planned`, e.g. pages actually fetched for a place search that may stop early).
   */
  async run<T>(
    step: Step,
    planned: number,
    call: (opts: CallOptions) => Promise<T>,
    billed: (result: T) => number,
    asked?: (result: T) => number,
  ): Promise<T> {
    const { signal, budget } = this.opts;
    signal?.throwIfAborted();
    if (!(planned > 0) || planned > this.room(step)) {
      throw new Error(`engine budget: ${step} wants ${planned}, ${this.room(step)} left`);
    }
    const service = STEP_SERVICE[step];
    const callOpts: CallOptions = { ...(budget ? { budget } : {}), ...(signal ? { signal } : {}) };
    try {
      const result = await abortable(call(callOpts), signal);
      const units = Math.max(0, Math.min(planned, billed(result)));
      this.used[service] += units;
      this.byStep[step] += units;
      const wanted = Math.max(0, Math.min(planned, asked ? asked(result) : planned));
      this.requested[service] += wanted;
      this.requestedByStep[step] += wanted;
      return result;
    } finally {
      if (!signal?.aborted) this.reportQuota(service);
    }
  }

  /** Emits today's usage of a service (the ledger's numbers, or this run's against its cap). */
  reportQuota(service: EngineService): void {
    const ledger = this.opts.ledger;
    let used = this.used[service];
    let limit = this.serviceCaps[service];
    if (ledger) {
      const u = ledger.usage(service);
      used = u.used;
      limit = u.limit;
    }
    const key = `${used}/${limit}`;
    if (this.lastQuota.get(service) === key) return;
    this.lastQuota.set(service, key);
    this.opts.onQuota({ service, used, limit });
  }
}
