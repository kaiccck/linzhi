/**
 * Quota budgets per tier and the dry-run estimate (技术设计文档 §4.4). One cold personal-tier analysis
 * may spend at most 12 place pages (6 for the five checked categories, 2 民生设施, 2 residential, 2
 * 买菜替代 — the last only when a 菜市场 check is a gap), 1,030 routematrix routes (seed, refinement,
 * the coverage check of five categories with its 买菜替代 routes, siting for five categories, 对口小学),
 * 6 directionlite walks and 1 reverse geocoding call; a typical one spends less because refinement
 * and the coverage check stop early.
 * With `browser_pois` it may also spend up to 5 place/v3/detail requests (50 uids) on the POIs the
 * browser found and the searches did not return.
 */
import type { BaiduTier } from '@zoudedao/baidu';
import { HARD_CATEGORIES } from '@zoudedao/core';

import { DEMAND_RADIUS_M, FACILITY_BUFFER_M, MAX_VERIFY_SITES } from './constants.js';
import { LIVELIHOOD_CATEGORIES } from './facilities.js';
import { validateInput } from './input.js';
import type { EngineBudget, EngineInput, EngineScope, EngineService, Stage } from './types.js';

const FACILITY_RADIUS_M = DEMAND_RADIUS_M + FACILITY_BUFFER_M;

export const TIER_BUDGETS: Readonly<Record<BaiduTier, Readonly<EngineBudget>>> = {
  // 100 place calls a day are the scarcest personal quota: about 8 cold runs (each reserves its 12-page
  // cap and spends ~10); 5,000 routes cover ~5 runs at the 1,030-route cap, more of the typical ~580
  personal: {
    place: 12,
    residentialPages: 2,
    livelihoodPages: 2,
    freshPages: 2,
    detailCalls: 5,
    reverse_geocoding: 1,
    directionlite_walking: 6,
    paths: 4,
    seed: 48,
    refine: 192,
    refineRounds: 4,
    coverage: 650,
    // up to MAX_VERIFY_SITES sites per category, each one route per gap compound within the rule
    siting: 100,
    catchment: 40,
    communities: 30,
  },
  enterprise: {
    place: 17,
    residentialPages: 3,
    livelihoodPages: 2,
    freshPages: 3,
    detailCalls: 10,
    reverse_geocoding: 1,
    directionlite_walking: 8,
    paths: 6,
    seed: 48,
    refine: 288,
    refineRounds: 6,
    coverage: 1500,
    siting: 200,
    catchment: 80,
    communities: 60,
  },
};

/** Place pages the hard-category search keeps before the 买菜替代 search gets any (the tier's own share). */
function facilityShare(tier: BaiduTier): number {
  const t = TIER_BUDGETS[tier];
  return t.place - t.residentialPages - t.livelihoodPages - t.freshPages;
}

/**
 * Tier defaults with overrides applied (non-negative integers). A smaller `place` shrinks the
 * 买菜替代 pages first, then the hard-category search (residential and 民生设施 keep theirs).
 */
export function resolveBudget(tier: BaiduTier, overrides: Partial<EngineBudget> = {}): EngineBudget {
  const out = { ...TIER_BUDGETS[tier] };
  for (const [k, v] of Object.entries(overrides) as [keyof EngineBudget, number | undefined][]) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.max(0, Math.floor(v));
  }
  out.residentialPages = Math.min(out.residentialPages, out.place);
  out.livelihoodPages = Math.min(out.livelihoodPages, out.place - out.residentialPages);
  out.freshPages = Math.min(
    out.freshPages,
    Math.max(0, out.place - out.residentialPages - out.livelihoodPages - facilityShare(tier)),
  );
  out.paths = Math.min(out.paths, out.directionlite_walking);
  return out;
}

/**
 * The budget a scope can spend: an isochrone-only run has no place pages and no coverage or siting
 * routes. `browserPois` false (the input has none): no detail requests either.
 */
export function scopedBudget(
  b: EngineBudget,
  scope: EngineScope = 'full',
  opts: { browserPois?: boolean } = {},
): EngineBudget {
  const out = opts.browserPois === false ? { ...b, detailCalls: 0 } : b;
  if (scope === 'full') return out;
  return {
    ...out,
    place: 0,
    residentialPages: 0,
    livelihoodPages: 0,
    freshPages: 0,
    detailCalls: 0,
    coverage: 0,
    siting: 0,
    catchment: 0,
    communities: 0,
  };
}

/** Budget lines of one run; each spends one service. */
export type Step =
  | 'locate'
  | 'facilities'
  | 'livelihood'
  | 'residential'
  | 'fresh'
  | 'detail'
  | 'paths'
  | 'seed'
  | 'refine'
  | 'coverage'
  | 'siting'
  | 'catchment';

export const STEP_SERVICE: Readonly<Record<Step, EngineService>> = {
  locate: 'reverse_geocoding',
  facilities: 'place',
  livelihood: 'place',
  residential: 'place',
  fresh: 'place',
  detail: 'place',
  paths: 'directionlite_walking',
  seed: 'routematrix_walking',
  refine: 'routematrix_walking',
  coverage: 'routematrix_walking',
  siting: 'routematrix_walking',
  catchment: 'routematrix_walking',
};

/**
 * SSE stage each step reports under (the 民生设施 search and the browser POIs' details belong to
 * 'facilities'; siting, the residential search and the 买菜替代 search to 'coverage').
 */
export const STEP_STAGE: Readonly<Record<Step, Stage>> = {
  locate: 'locate',
  facilities: 'facilities',
  livelihood: 'facilities',
  residential: 'coverage',
  fresh: 'coverage',
  detail: 'facilities',
  paths: 'paths',
  seed: 'seed',
  refine: 'refine',
  coverage: 'coverage',
  siting: 'coverage',
  catchment: 'coverage',
};

export function stepCaps(b: EngineBudget): Record<Step, number> {
  return {
    locate: b.reverse_geocoding,
    facilities: Math.max(0, b.place - b.residentialPages - b.livelihoodPages - b.freshPages),
    livelihood: b.livelihoodPages,
    residential: b.residentialPages,
    fresh: b.freshPages,
    detail: b.detailCalls,
    paths: b.directionlite_walking,
    seed: b.seed,
    refine: b.refine,
    coverage: b.coverage,
    siting: b.siting,
    catchment: b.catchment,
  };
}

export function serviceCaps(b: EngineBudget): Record<EngineService, number> {
  return {
    reverse_geocoding: b.reverse_geocoding,
    place: b.place + b.detailCalls,
    directionlite_walking: b.directionlite_walking,
    routematrix_walking: b.seed + b.refine + b.coverage + b.siting + b.catchment,
  };
}

// Typical cold run, calibrated on the synthetic city of test/city.ts and the cached place answers
// around 张江 (data/cache): the 10-keyword "$" union of the five checked categories holds 30–70 rows
// within 2.1 km (the old 7 keywords of 小学, markets and pharmacies 14–44, 生鲜超市$幼儿园 8–17, plus
// the 社区卫生 centres and stations), so it needs about 3 pages and the page after it goes to
// 生鲜超市; the 民生设施 union fills its 2 pages with bus stops within 1.1 km; refinement converges
// after about 3 rounds; the coverage check routes ~12 pairs per compound under the 1 km rule (the
// nearest two candidates of each of the five categories where it has any in range, a further round
// for a few; one or two for the nearest top-up, candidates nearer by straight line than the walk
// that proved a verdict; the 买菜替代 of the 菜市场 gaps); siting verifies a site or two for each
// category with gaps; where a catchment table covers the centre, about half the compounds match and
// need their assigned school routed once or twice. Some 菜市场 check is a gap almost everywhere, so
// the 买菜替代 search runs and fills its pages with the 超市 of a city district.
const EXPECTED_FACILITY_PAGES = 4;
const EXPECTED_LIVELIHOOD_PAGES = 2;
const EXPECTED_FRESH_PAGES = 2;
// the browser lists ~10–30 POIs within 2.1 km that place/v3/around left out (around 万科翡翠公园:
// 盒马鲜生, 火星荟森生鲜, 联华超市 among them), most of them 超市: two requests of 10 uids
const EXPECTED_DETAIL_CALLS = 2;
const EXPECTED_REFINE_ROUNDS = 3;
const REFINE_BATCH = 48;
const EXPECTED_ROUTES_PER_COMMUNITY = 12;
const EXPECTED_SITING_ROUTES = 30;
const EXPECTED_CATCHMENT_ROUTES = 15;

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
  opts: {
    budget?: Partial<EngineBudget>;
    tier?: BaiduTier;
    scope?: EngineScope;
    /** A catchment table is expected to cover the centre (only known after reverse geocoding). */
    catchment?: boolean;
  } = {},
): QuotaPlanEstimate {
  const job = validateInput(input);
  const tier = opts.tier ?? 'personal';
  const b = scopedBudget(resolveBudget(tier, opts.budget), opts.scope, {
    browserPois: job.browserPois.length > 0,
  });
  const caps = stepCaps(b);
  const expected: Record<Step, number> = {
    locate: caps.locate,
    facilities: Math.min(caps.facilities, EXPECTED_FACILITY_PAGES),
    livelihood: Math.min(caps.livelihood, EXPECTED_LIVELIHOOD_PAGES),
    residential: caps.residential,
    fresh: Math.min(caps.fresh, EXPECTED_FRESH_PAGES),
    detail: Math.min(caps.detail, EXPECTED_DETAIL_CALLS),
    paths: Math.min(b.paths, caps.paths),
    seed: caps.seed,
    refine: Math.min(caps.refine, EXPECTED_REFINE_ROUNDS * REFINE_BATCH, b.refineRounds * REFINE_BATCH),
    coverage: Math.min(caps.coverage, b.communities * EXPECTED_ROUTES_PER_COMMUNITY),
    siting: Math.min(caps.siting, EXPECTED_SITING_ROUTES),
    catchment: opts.catchment ? Math.min(caps.catchment, EXPECTED_CATCHMENT_ROUTES) : 0,
  };
  const checked = HARD_CATEGORIES.join('、');
  const notes: Record<Step, string> = {
    locate: '逆地理编码：中心点所在街道、小区',
    facilities: `地点检索：逐小区检查的${checked}（一次 $ 并集，半径 ${(FACILITY_RADIUS_M / 1000).toFixed(1)} 公里，分页，被挤掉的类别单独检索）；有余量时加查生鲜超市`,
    livelihood: `地点检索：${LIVELIHOOD_CATEGORIES.join('、')}（一次 $ 并集，半径 1.1 公里，最多 2 页），用于圈内设施统计`,
    residential: '地点检索：住宅区与小区出入口，作为盲区判定的需求点',
    fresh: `地点检索：蔬菜、果蔬、生鲜、超市（一次 $ 并集，半径 ${(FACILITY_RADIUS_M / 1000).toFixed(1)} 公里，最多 ${caps.fresh} 页），只在有菜市场缺口时检索，为缺口小区找判定距离内能买菜的店（买菜替代，只作参考）`,
    detail: `地点详情：地图前端（JSAPI）找到、服务端检索没有返回的设施，按 uid 查询标签后与检索结果一起清洗（每次 10 个，最多 ${caps.detail} 次，只在请求带 browser_pois 时查询）`,
    paths: '轻量步行路线：沿绕行最明显的方向采集路网骨架',
    seed: '批量算路：16 个方位 × 3 个半径的粗采样',
    refine: '批量算路：边界带加密，每轮 48 点，收敛即停',
    coverage: `批量算路：小区出入口 → ${HARD_CATEGORIES.length} 类候选设施（${checked}），直线剪枝，每类找到覆盖即停；最后补算直线比已测最短步行更近的设施，取实际最近的一处；菜市场有缺口的小区再算到判定距离内最近 2 家能买菜的店（买菜替代）`,
    siting: `批量算路：每类有缺口的设施核验排名前 ${MAX_VERIFY_SITES} 的选址建议`,
    catchment:
      '批量算路：小区出入口 → 对口小学校门（只在对口地段表覆盖的街镇；盲区判定已算过的路线直接复用）',
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
