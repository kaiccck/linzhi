/**
 * One engine variant as an evaluated method: the real live pipeline (`analyze`), isochrone only, with
 * the budget counting requested routes (cache hits included), so engine@B never uses more than B routes
 * of samples however warm the cache is — and repeating a run repeats its requests, which the cache
 * answers for free.
 */
import type { BaiduClient } from '@zoudedao/baidu';
import { analyze, EngineError } from '@zoudedao/engine';

import type { EvalArea } from './areas.js';
import { ARTEFACT_VERSION, areaInfo, type EngineSummary, type MethodArtefact } from './artefacts.js';
import { emptyTally, tallyClient, type CeilingLedger } from './ceiling.js';
import type { MethodSpec } from './methods.js';

export interface EngineRun {
  artefact: MethodArtefact | null;
  /** Why the method did not finish (quota, ceiling, key, upstream): an EngineError. */
  stopped: EngineError | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export async function runEngineMethod(args: {
  spec: MethodSpec;
  client: BaiduClient;
  ledger: CeilingLedger;
  area: EvalArea;
  now: () => Date;
  signal?: AbortSignal;
}): Promise<EngineRun> {
  const { spec, area } = args;
  const variant = spec.engine;
  if (spec.kind !== 'engine' || !variant) throw new Error(`${spec.id} 不是引擎方法`);
  const tally = emptyTally();
  const walksBefore = args.ledger.billed('directionlite_walking');
  const t0 = performance.now();
  let result;
  try {
    result = await analyze(
      { center_bd09: area.center_bd09, label: area.label, profile: 'adult' },
      { client: tallyClient(args.client, tally), now: args.now },
      () => {},
      {
        scope: 'isochrone',
        budgetBasis: 'requested',
        tier: 'personal',
        budget: variant.budget,
        ...(variant.convergeShare !== undefined ? { convergeShare: variant.convergeShare } : {}),
        ...(variant.barriers !== undefined ? { barriers: variant.barriers } : {}),
        ...(args.signal ? { signal: args.signal } : {}),
      },
    );
  } catch (err) {
    if (err instanceof EngineError && err.code !== 'invalid_input') return { artefact: null, stopped: err };
    throw err;
  }
  const wall = Math.round(performance.now() - t0);
  const s = result.stats;
  const warnings = (result.meta as { warnings?: string[] }).warnings ?? [];
  const engine: EngineSummary = {
    refine_rounds: num(s.refine_rounds) ?? 0,
    refine_converged: s.refine_converged === true,
    refine_last_change: num(s.refine_last_change),
    barrier_segments: num(s.barrier_segments) ?? 0,
    n_samples: s.n_samples,
    n_samples_by_src: (s.n_samples_by_src as Record<string, number> | undefined) ?? {},
    loo_mae_s: num(s.loo_mae_s),
    loo_p90_abs_err_s: num(s.loo_p90_abs_err_s),
    area_iso15_km2: s.area_iso15_km2,
    quota_requested_by_step: (s.quota_requested_by_step as Record<string, number> | undefined) ?? null,
    warnings: [...warnings],
  };
  const artefact: MethodArtefact = {
    version: ARTEFACT_VERSION,
    kind: 'method',
    id: spec.id,
    method: 'engine',
    label: spec.label,
    area: areaInfo(area),
    created: args.now().toISOString(),
    params: {
      budget: variant.budget,
      scope: 'isochrone',
      budgetBasis: 'requested',
      convergeShare: variant.convergeShare ?? 'default (0.03)',
      barriers: variant.barriers ?? true,
      generator: (result.meta as { generator?: string }).generator ?? '@zoudedao/engine',
    },
    cost: {
      routes: tally.routes,
      routes_billed: tally.routes_billed,
      requests: tally.requests,
      calls: tally.matrix_calls,
      walks: tally.walks,
      walks_billed: args.ledger.billed('directionlite_walking') - walksBefore,
      wall_ms: wall,
    },
    region: { rings: result.contours['900'] },
    field: result.field,
    samples: result.samples.map((x): [number, number, number] => [x.xy[0], x.xy[1], x.dur_s]),
    engine,
  };
  if (tally.place || tally.reverse_geocoding) {
    // scope 'isochrone' with no reverse-geocoding budget must never touch the scarcer quotas
    throw new Error(
      `${spec.id}：评测中的引擎调用了地点检索或逆地理编码（${tally.place} / ${tally.reverse_geocoding}）`,
    );
  }
  return { artefact, stopped: null };
}
