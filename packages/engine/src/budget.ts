/**
 * Quota budgets per tier and the dry-run estimate (技术设计文档 §4.4). One cold personal-tier analysis
 * may spend at most 6 place pages, 700 routematrix routes, 6 directionlite walks and 1 reverse
 * geocoding call; a typical one spends less because refinement and the coverage check stop early.
 */
import type { BaiduTier } from '@zoudedao/baidu';

import { validateInput } from './input.js';
import type { EngineBudget, EngineInput, EngineScope, EngineService, Stage } from './types.js';

export const TIER_BUDGETS: Readonly<Record<BaiduTier, Readonly<EngineBudget>>> = {
  // 100 place calls a day are the scarcest personal quota; 5,000 routes allow ~7 cold runs a day
  personal: {
    place: 6,
    residentialPages: 2,
    reverse_geocoding: 1,
    directionlite_walking: 6,
    paths: 4,
    seed: 48,
    refine: 192,
    refineRounds: 4,
    coverage: 400,
    siting: 60,
    communities: 30,
  },
  enterprise: {
    place: 10,
    residentialPages: 3,
    reverse_geocoding: 1,
    directionlite_walking: 8,
    paths: 6,
    seed: 48,
    refine: 288,
    refineRounds: 6,
    coverage: 900,
    siting: 120,
    communities: 60,
  },
};

/** Tier defaults with overrides applied (non-negative integers). */
export function resolveBudget(tier: BaiduTier, overrides: Partial<EngineBudget> = {}): EngineBudget {
  const out = { ...TIER_BUDGETS[tier] };
  for (const [k, v] of Object.entries(overrides) as [keyof EngineBudget, number | undefined][]) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.max(0, Math.floor(v));
  }
  out.residentialPages = Math.min(out.residentialPages, out.place);
  out.paths = Math.min(out.paths, out.directionlite_walking);
  return out;
}

/** The budget a scope can spend: an isochrone-only run has no place pages and no coverage or siting routes. */
export function scopedBudget(b: EngineBudget, scope: EngineScope = 'full'): EngineBudget {
  if (scope === 'full') return b;
  return { ...b, place: 0, residentialPages: 0, coverage: 0, siting: 0, communities: 0 };
}

/** Budget lines of one run; each spends one service. */
export type Step =
  'locate' | 'facilities' | 'residential' | 'paths' | 'seed' | 'refine' | 'coverage' | 'siting';

export const STEP_SERVICE: Readonly<Record<Step, EngineService>> = {
  locate: 'reverse_geocoding',
  facilities: 'place',
  residential: 'place',
  paths: 'directionlite_walking',
  seed: 'routematrix_walking',
  refine: 'routematrix_walking',
  coverage: 'routematrix_walking',
  siting: 'routematrix_walking',
};

/** SSE stage each step reports under (siting and the residential search belong to 'coverage'). */
export const STEP_STAGE: Readonly<Record<Step, Stage>> = {
  locate: 'locate',
  facilities: 'facilities',
  residential: 'coverage',
  paths: 'paths',
  seed: 'seed',
  refine: 'refine',
  coverage: 'coverage',
  siting: 'coverage',
};

export function stepCaps(b: EngineBudget): Record<Step, number> {
  return {
    locate: b.reverse_geocoding,
    facilities: Math.max(0, b.place - b.residentialPages),
    residential: b.residentialPages,
    paths: b.directionlite_walking,
    seed: b.seed,
    refine: b.refine,
    coverage: b.coverage,
    siting: b.siting,
  };
}

export function serviceCaps(b: EngineBudget): Record<EngineService, number> {
  return {
    reverse_geocoding: b.reverse_geocoding,
    place: b.place,
    directionlite_walking: b.directionlite_walking,
    routematrix_walking: b.seed + b.refine + b.coverage + b.siting,
  };
}

// Typical cold run, calibrated on the synthetic city of test/city.ts and the zj-a research calls:
// the "$" union needs 1–2 pages and the leftover page goes to 生鲜超市/幼儿园; refinement converges
// after about 3 rounds; the coverage check routes ~7 pairs per compound under the 1 km rule (the
// nearest two candidates per category, a third round for a few) and fewer under GB 50180's 300–500 m.
const EXPECTED_FACILITY_PAGES = 3;
const EXPECTED_REFINE_ROUNDS = 3;
const REFINE_BATCH = 48;
const EXPECTED_ROUTES_PER_COMMUNITY = { task: 7, gb50180: 4 } as const;
const EXPECTED_SITING_ROUTES = 20;

export interface QuotaPlanItem {
  step: Step;
  stage: Stage;
  service: EngineService;
  expected: number;
  max: number;
  /** What the units buy, in Chinese. */
  note: string;
}

export interface QuotaPlanEstimate {
  tier: BaiduTier;
  /** Units a typical cold run spends per service (cache hits spend nothing). */
  expected: Record<EngineService, number>;
  /** The run's caps per service: never exceeded, and what analyze() reserves from the ledger. */
  max: Record<EngineService, number>;
  steps: QuotaPlanItem[];
}

/**
 * Dry-run estimate for one analysis, before any call: what the server can show (and check with
 * ledger.blockedBy(plan.max)) before starting. Depends only on the input and the budget.
 */
export function planQuota(
  input: EngineInput,
  opts: { budget?: Partial<EngineBudget>; tier?: BaiduTier; scope?: EngineScope } = {},
): QuotaPlanEstimate {
  const job = validateInput(input);
  const tier = opts.tier ?? 'personal';
  const b = scopedBudget(resolveBudget(tier, opts.budget), opts.scope);
  const caps = stepCaps(b);
  const expected: Record<Step, number> = {
    locate: caps.locate,
    facilities: Math.min(caps.facilities, EXPECTED_FACILITY_PAGES),
    residential: caps.residential,
    paths: Math.min(b.paths, caps.paths),
    seed: caps.seed,
    refine: Math.min(caps.refine, EXPECTED_REFINE_ROUNDS * REFINE_BATCH, b.refineRounds * REFINE_BATCH),
    coverage: Math.min(caps.coverage, b.communities * EXPECTED_ROUTES_PER_COMMUNITY[job.rules]),
    siting: Math.min(caps.siting, EXPECTED_SITING_ROUTES),
  };
  const notes: Record<Step, string> = {
    locate: '逆地理编码：中心点所在街道、小区',
    facilities:
      '地点检索：小学、菜市场、药店（$ 并集分页，被挤掉的类别单独检索）；有余量时加查生鲜超市、幼儿园',
    residential: '地点检索：住宅区与小区出入口，作为盲区判定的需求点',
    paths: '轻量步行路线：沿绕行最明显的方向采集路网骨架',
    seed: '批量算路：16 个方位 × 3 个半径的粗采样',
    refine: '批量算路：边界带加密，每轮 48 点，收敛即停',
    coverage: '批量算路：小区出入口 → 候选设施，直线剪枝，找到覆盖即停',
    siting: '批量算路：核验排名前 2 的选址建议',
  };
  const steps: QuotaPlanItem[] = (Object.keys(expected) as Step[]).map((step) => ({
    step,
    stage: STEP_STAGE[step],
    service: STEP_SERVICE[step],
    expected: expected[step],
    max: caps[step],
    note: notes[step],
  }));
  const sum = (key: 'expected' | 'max'): Record<EngineService, number> => {
    const out: Record<EngineService, number> = {
      reverse_geocoding: 0,
      place: 0,
      directionlite_walking: 0,
      routematrix_walking: 0,
    };
    for (const s of steps) out[s.service] += s[key];
    return out;
  };
  return { tier, expected: sum('expected'), max: sum('max'), steps };
}
