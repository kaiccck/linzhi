/**
 * The methods the evaluation compares (技术设计文档 §5.9), each producing a 15-minute region and, where
 * it has one, a walking-time field:
 *
 *   circle             the straight-line claim: radius 900 s × 1.17 m/s = 1,053 m, no route
 *   star16             the common competitor method: 16 bearings × 3 radii measured from the centre, the
 *                      15-minute reach per bearing by linear interpolation of time along the ray, and a
 *                      polygon through the 16 reach points (48 routes)
 *   seed48             our estimator on exactly star16's 48 points (the engine's seed pattern) with no
 *                      walked route and no refinement: same data, different estimator
 *   engine@B           the live engine, isochrone only, capped at B routematrix routes (cached or not) and
 *                      forced to spend them (no early stop): one point of the accuracy–quota curve
 *   engine-default     the engine as it ships (personal-tier caps, stops when the region settles)
 *   engine@700-nobarrier  the largest budget without Lipschitz barrier detection (ablation)
 */
import { LIMIT_S, R15_M as ENGINE_R15_M, WALK_SPEED, type EngineBudget } from '@zoudedao/engine';

/** 15 minutes. */
export const LEVEL_S = LIMIT_S;
/** Baidu routematrix walking speed (duration = distance / 1.17 for every answer). */
export const SPEED_MPS = WALK_SPEED;
/**
 * Nothing farther than 900 s × 1.17 m/s = 1,053 m can be reached in 15 minutes (t ≥ r / v). The engine's
 * own constant, so star16's points are bit-identical to the engine's seed and share its cache entries.
 */
export const R15_M = ENGINE_R15_M;
/** The engine's seed pattern: 16 bearings × rings at 0.33, 0.67 and 1.0 R (347, 705 and 1,053 m). */
export const STAR_BEARINGS = 16;
export const STAR_RINGS: readonly number[] = [0.33, 0.67, 1.0];
/** Refinement rounds of the engine route 48 points each. */
export const ROUND_ROUTES = 48;
/** Walked routes the engine takes (personal tier) and the spares it may use when a probe has no route. */
export const ENGINE_PATHS = 4;
export const ENGINE_WALKS_MAX = 6;
/** The curve's budgets. */
export const ENGINE_BUDGETS: readonly number[] = [48, 100, 200, 400, 700];

export type MethodKind = 'circle' | 'star16' | 'engine';

export interface EngineVariant {
  budget: Partial<EngineBudget>;
  /** Refinement stop share; 0 = spend the whole budget (default: the engine's own 3 %). */
  convergeShare?: number;
  /** Lipschitz barrier detection; default true. */
  barriers?: boolean;
}

export interface MethodSpec {
  id: string;
  kind: MethodKind;
  /** Short Chinese name for tables and charts. */
  label: string;
  /** What the method is, in Chinese (results.md). */
  description: string;
  /** Routematrix routes the method asks for, cached or not (engine: its cap; it may stop earlier). */
  routes: number;
  /** Walked routes (directionlite) it wants; engine runs may use up to ENGINE_WALKS_MAX. */
  walks: number;
  /** True when the method may stop before `routes` (the engine's convergence rule). */
  mayStopEarly: boolean;
  engine?: EngineVariant;
}

/** No reverse geocoding (names are not evaluated) and the personal tier's walk budget, stated explicitly. */
const ENGINE_BASE: Partial<EngineBudget> = {
  reverse_geocoding: 0,
  paths: ENGINE_PATHS,
  directionlite_walking: ENGINE_WALKS_MAX,
  seed: 48,
};

/** Budget of engine@B: the 48-route seed plus rounds of 48 until B routes are spent. */
export function engineBudget(routes: number): Partial<EngineBudget> {
  if (!Number.isInteger(routes) || routes < 48)
    throw new Error(`engine@B 需要 B ≥ 48 的整数，收到 ${routes}`);
  const refine = routes - 48;
  return { ...ENGINE_BASE, refine, refineRounds: Math.ceil(refine / ROUND_ROUTES) };
}

/** Routes per routematrix call of engine@B, in order: the seed, then refinement rounds of ≤ 48. */
export function engineCalls(routes: number): number[] {
  const calls = [48];
  for (let left = routes - 48; left > 0; left -= ROUND_ROUTES) calls.push(Math.min(ROUND_ROUTES, left));
  return calls;
}

export const CIRCLE: MethodSpec = {
  id: 'circle',
  kind: 'circle',
  label: '直线圆',
  description:
    '以中心为圆心、900 秒 × 1.17 米/秒 = 1,053 米为半径的圆，不调用任何接口；耗时按直线距离 ÷ 1.17 米/秒估计。',
  routes: 0,
  walks: 0,
  mayStopEarly: false,
};

export const STAR16: MethodSpec = {
  id: 'star16',
  kind: 'star16',
  label: '16 方位射线法',
  description:
    '常见做法：从中心沿 16 个方位、在 347 / 705 / 1,053 米三个半径各测 1 条步行路线（48 条），每个方位沿射线对耗时线性插值得到 15 分钟可达半径，16 个可达点连成多边形。只给出区域，不给出耗时场。',
  routes: 48,
  walks: 0,
  mayStopEarly: false,
};

export function engineMethod(routes: number): MethodSpec {
  return {
    id: `engine@${routes}`,
    kind: 'engine',
    label: `本方法 ${routes} 条`,
    description:
      routes === 48
        ? '实时引擎只做粗采样（与 16 方位射线法同样的 48 个点）加 4 条轻量步行路线，不做边界加密；去趋势插值 + 断裂检测。'
        : `实时引擎（只生成等时圈）：粗采样 48 条 + 4 条轻量步行路线 + 边界加密，批量算路共 ${routes} 条（含缓存命中也计数），用满预算不提前停止。`,
    routes,
    walks: ENGINE_PATHS,
    mayStopEarly: false,
    engine: { budget: engineBudget(routes), convergeShare: 0 },
  };
}

export const SEED48: MethodSpec = {
  id: 'seed48',
  kind: 'engine',
  label: '本方法·仅 48 点',
  description:
    '与 16 方位射线法完全相同的 48 条路线，不用步行路线、不加密，只换估计方法（绕行系数 ρ 的去趋势插值）：同样的数据，不同的算法。',
  routes: 48,
  walks: 0,
  mayStopEarly: false,
  engine: {
    budget: { ...ENGINE_BASE, paths: 0, directionlite_walking: 0, refine: 0, refineRounds: 0 },
    convergeShare: 0,
  },
};

/** The engine as it ships: personal-tier caps (48 + 4 × 48 routes), stops once the region settles. */
export const ENGINE_DEFAULT: MethodSpec = {
  id: 'engine-default',
  kind: 'engine',
  label: '本方法·默认',
  description:
    '实时引擎的默认配置（个人档：粗采样 48 条 + 4 条步行路线 + 最多 4 轮 × 48 条加密），15 分钟区域前后两轮变化 < 3% 即停。',
  routes: 48 + 4 * ROUND_ROUTES,
  walks: ENGINE_PATHS,
  mayStopEarly: true,
  engine: { budget: { ...ENGINE_BASE, refine: 4 * ROUND_ROUTES, refineRounds: 4 } },
};

export function noBarrierMethod(routes: number): MethodSpec {
  return {
    id: `engine@${routes}-nobarrier`,
    kind: 'engine',
    label: `本方法 ${routes} 条·无断裂检测`,
    description: `消融实验：与 engine@${routes} 相同的预算，但关闭 Lipschitz 断裂检测（加密不向阻隔靠拢，插值不做可见性过滤）。`,
    routes,
    walks: ENGINE_PATHS,
    mayStopEarly: false,
    engine: { budget: engineBudget(routes), convergeShare: 0, barriers: false },
  };
}

/**
 * The measured methods in run order. The order matters for quota: star16 first, then seed48 and the
 * engine budgets in increasing order, so every run repeats the previous one's requests (the cache
 * answers them) and only pays for its extra rounds; the default engine's rounds are a prefix of
 * engine@400's; the ablation comes last.
 */
export function measuredMethods(budgets: readonly number[] = ENGINE_BUDGETS): MethodSpec[] {
  const sorted = [...new Set(budgets)].sort((a, b) => a - b);
  const largest = sorted[sorted.length - 1];
  return [
    STAR16,
    SEED48,
    ...sorted.map(engineMethod),
    ENGINE_DEFAULT,
    ...(largest !== undefined ? [noBarrierMethod(largest)] : []),
  ];
}

/** The spec behind a method id (artefacts may come from other budgets than the default list). */
export function specOf(id: string): MethodSpec | null {
  const fixed = [CIRCLE, STAR16, SEED48, ENGINE_DEFAULT].find((m) => m.id === id);
  if (fixed) return fixed;
  const b = /^engine@(\d+)$/.exec(id);
  if (b) return engineMethod(Number(b[1]));
  const nb = /^engine@(\d+)-nobarrier$/.exec(id);
  if (nb) return noBarrierMethod(Number(nb[1]));
  return null;
}

/** Table order: circle, star16, seed48, engine@B by B, the default engine, then the ablations. */
export function methodOrder(id: string): number {
  if (id === 'circle') return 0;
  if (id === 'star16') return 1;
  if (id === 'seed48') return 2;
  const b = /^engine@(\d+)$/.exec(id);
  if (b) return 3 + Number(b[1]) / 1e6;
  if (id === 'engine-default') return 4;
  const nb = /^engine@(\d+)-nobarrier$/.exec(id);
  if (nb) return 5 + Number(nb[1]) / 1e6;
  return 9;
}

export type StepId = 'reference' | 'star16' | 'engine';

/** Which CLI step runs a method. */
export function stepOf(m: MethodSpec): Exclude<StepId, 'reference'> | null {
  return m.kind === 'circle' ? null : m.kind;
}
