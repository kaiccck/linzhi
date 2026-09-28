/**
 * Pure derivations from one AnalysisResult: the headline numbers the product states, per-category
 * counts, the elderly-profile variant and the route estimator for what-if siting. Nothing here calls
 * a network or an LLM, so every tool answer can be reproduced from the result alone.
 */
import {
  GB50180_RADIUS_M,
  HARD_CATEGORIES,
  ISO_LEVELS,
  TASK_RULE_M,
  WALK_SPEED_MPS,
  bearingDeg,
  fieldEstimator,
  fieldFromGrid,
  gridFromField,
  levelContours,
  localFrame,
  quantile,
  reachByBearing,
  rhoSamplesOf,
  sampleGrid,
  segDist2,
  type AnalysisMeta,
  type AnalysisResult,
  type Community,
  type ContourMeta,
  type FacilityCheck,
  type HardCategory,
  type IsoLevel,
  type LocalFrame,
  type LngLat,
  type RouteEstimator,
  type XY,
} from '@zoudedao/core';
import { round } from './format.js';
import { ELDER_SPEED_MPS, type Profile, type ZddMeta } from './types.js';

export { HARD_CATEGORIES };

/** 15 minutes, the life-circle time budget. */
export const LIMIT_S = 900;

// ------------------------------------------------------------------------------------ frame

const FORMULA =
  /x\s*=\s*\(lng\s*-\s*(-?[\d.]+)\)\s*\*\s*([\d.]+)\s*\*\s*cos\((-?[\d.]+)\s*deg\)\s*,\s*y\s*=\s*\(lat\s*-\s*(-?[\d.]+)\)\s*\*\s*([\d.]+)/;

/**
 * The local metric frame the result's XY were computed in. meta.frame_formula is authoritative (it
 * says how XY were made); core's localFrame(center) is the documented default and the fallback.
 */
export function frameOf(meta: AnalysisMeta): LocalFrame {
  const m = FORMULA.exec(meta.frame_formula ?? '');
  if (m) {
    const lng0 = Number(m[1]);
    const cosDeg = Number(m[3]);
    const lat0 = Number(m[4]);
    const kx = Number(m[2]) * Math.cos((cosDeg * Math.PI) / 180);
    const ky = Number(m[5]);
    if ([lng0, lat0, kx, ky].every(Number.isFinite) && kx > 0 && ky > 0) {
      return {
        lng0,
        lat0,
        kx,
        ky,
        toXY: (lng, lat) => [(lng - lng0) * kx, (lat - lat0) * ky],
        toLngLat: (x, y) => [lng0 + x / kx, lat0 + y / ky],
      };
    }
  }
  return localFrame(meta.center_bd09[0], meta.center_bd09[1]);
}

// ---------------------------------------------------------------------------------- profile

export function profileOf(result: AnalysisResult): Profile {
  return (result.meta as ZddMeta).profile ?? 'adult';
}

/** Speed behind the result's times (the profile speed), m/s. */
export function speedOf(result: AnalysisResult): number {
  const meta = result.meta as ZddMeta;
  return meta.profile_speed_mps ?? meta.walk_speed_mps ?? WALK_SPEED_MPS;
}

/** Baidu routematrix speed behind the samples' dur_s, m/s. */
export function sampleSpeedOf(result: AnalysisResult): number {
  return result.meta.walk_speed_mps ?? WALK_SPEED_MPS;
}

export const PROFILE_ZH: Record<Profile, string> = { adult: '成人', elder: '老年人' };

// ----------------------------------------------------------------------------------- checks

export interface CheckRow {
  community: Community;
  index: number;
  category: HardCategory;
  check: FacilityCheck;
}

export function checkRows(result: AnalysisResult): CheckRow[] {
  const rows: CheckRow[] = [];
  result.communities.forEach((community, index) => {
    for (const category of HARD_CATEGORIES) {
      const check = community.checks?.[category];
      if (check) rows.push({ community, index, category, check });
    }
  });
  return rows;
}

/** Not routed for this community on its own yet: 待核实, never a gap (types.ts FacilityCheck.verified). */
export const isPending = (c: FacilityCheck): boolean => c.verified === false;

/** A verified check that is not walkable within the rule. */
export const isWalkGap = (c: FacilityCheck): boolean => !isPending(c) && c.status_main !== '覆盖';

/** The circle method's verdict: no facility within the rule by straight line (or none known at all). */
export const isStraightGap = (c: FacilityCheck, rule_m: number): boolean =>
  !(c.straight_m >= 0) || c.straight_m > rule_m;

/** 'gb50180' when the checks were made with GB 50180-2018 radii (live engine option), else 'task'. */
export function rulesOf(result: AnalysisResult): 'task' | 'gb50180' {
  return (result.meta as ZddMeta).rules === 'gb50180' ? 'gb50180' : 'task';
}

/** Rule distance the result's checks used for a category (meta.rule_m of live results, else 1 km). */
export function ruleOf(result: AnalysisResult, category: HardCategory): number {
  const given = (result.meta as ZddMeta).rule_m?.[category];
  if (typeof given === 'number' && given > 0) return given;
  return rulesOf(result) === 'gb50180' ? GB_RADIUS_M[category] : TASK_RULE_M[category];
}

/** How the rule reads in a sentence: "1 km" for the task rule, the GB radii otherwise. */
export function ruleText(result: AnalysisResult): string {
  const rules = HARD_CATEGORIES.map((c) => ruleOf(result, c));
  if (rules.every((r) => r === 1000)) return '1 km';
  if (rules.every((r) => r === rules[0])) return `${rules[0]} m`;
  return HARD_CATEGORIES.map((c) => `${c} ${ruleOf(result, c)} m`).join('、');
}

export interface CategoryCounts {
  total: number;
  覆盖: number;
  伪覆盖: number;
  盲区: number;
  /** Verified checks flagged 临界 (|route − rule| ≤ 50 m), on top of their main status. */
  临界: number;
  待核实: number;
}

export function categoryCounts(result: AnalysisResult): Record<HardCategory, CategoryCounts> {
  const out = Object.fromEntries(
    HARD_CATEGORIES.map((c) => [c, { total: 0, 覆盖: 0, 伪覆盖: 0, 盲区: 0, 临界: 0, 待核实: 0 }]),
  ) as Record<HardCategory, CategoryCounts>;
  for (const { category, check } of checkRows(result)) {
    const n = out[category];
    n.total++;
    if (isPending(check)) {
      n.待核实++;
      continue;
    }
    n[check.status_main]++;
    if (check.borderline) n.临界++;
  }
  return out;
}

/**
 * The comparison the product leads with (PRODUCT.md「Positioning」): gaps found by the straight-line
 * 1 km rule versus verified gaps found by walking distance. Unverified checks are only counted as
 * pending.
 */
export interface Headline {
  rules: 'task' | 'gb50180';
  rule_m: Record<HardCategory, number>;
  communities: number;
  categories: number;
  checks: number;
  straight_gaps: number;
  walking_gaps: number;
  pseudo: number;
  blind: number;
  /** Verified walking gaps the circle calls covered (= verified 伪覆盖). */
  missed_by_circle: number;
  /** missed_by_circle / walking_gaps in percent, one decimal; null without walking gaps. */
  missed_share_pct: number | null;
  pending: number;
  borderline: number;
}

export function headline(result: AnalysisResult): Headline {
  const rows = checkRows(result);
  let straight = 0;
  let pseudo = 0;
  let blind = 0;
  let pending = 0;
  let borderline = 0;
  for (const { category, check } of rows) {
    if (isStraightGap(check, ruleOf(result, category))) straight++;
    if (isPending(check)) {
      pending++;
      continue;
    }
    if (check.borderline) borderline++;
    if (check.status_main === '伪覆盖') pseudo++;
    else if (check.status_main === '盲区') blind++;
  }
  const walking = pseudo + blind;
  return {
    rules: rulesOf(result),
    rule_m: Object.fromEntries(HARD_CATEGORIES.map((c) => [c, ruleOf(result, c)])) as Record<
      HardCategory,
      number
    >,
    communities: result.communities.length,
    categories: HARD_CATEGORIES.length,
    checks: rows.length,
    straight_gaps: straight,
    walking_gaps: walking,
    pseudo,
    blind,
    missed_by_circle: pseudo,
    missed_share_pct: walking ? round((pseudo / walking) * 100, 1) : null,
    pending,
    borderline,
  };
}

/** Median, min and max of the straight distance reached in 15 minutes along each bearing. */
export function reach15(
  result: AnalysisResult,
): { median_m: number; min_m: number; max_m: number; bearings: number } | null {
  const values = (result.stats.reach_by_bearing ?? [])
    .map((r) => r.r900)
    .filter((v) => Number.isFinite(v) && v > 0);
  if (!values.length) return null;
  return {
    median_m: round(quantile(values, 0.5), 1),
    min_m: Math.min(...values),
    max_m: Math.max(...values),
    bearings: values.length,
  };
}

/** How many communities reach a facility of the category within 15 minutes at the profile speed. */
export function within15(
  result: AnalysisResult,
  category: HardCategory,
): { limit_m: number; within: number; undetermined: number; total: number } {
  const limit = Math.round(LIMIT_S * speedOf(result));
  let within = 0;
  let undetermined = 0;
  let total = 0;
  for (const row of checkRows(result)) {
    if (row.category !== category) continue;
    total++;
    const c = row.check;
    const routed = c.route_basis === undefined || c.route_basis === 'routed';
    if (!isPending(c) && routed && c.route_m >= 0 && c.route_m <= limit) {
      within++;
      continue;
    }
    const nearer = (c.unrouted_nearer ?? []).some((u) => u.straight_m <= limit);
    if (isPending(c) || (c.route_upper_bound && nearer)) undetermined++;
  }
  return { limit_m: limit, within, undetermined, total };
}

export type RuleStatus = '达标' | '未达标' | '待核实';

/**
 * A check under another distance rule (e.g. GB 50180-2018's 300/500 m), using only what was
 * measured: walking is never shorter than the straight line, and an unrouted facility nearer than
 * the shortest routed walk (unrouted_nearer) could still bring it within the rule.
 */
export function statusUnderRule(check: FacilityCheck, rule_m: number): RuleStatus {
  if (!(check.straight_m >= 0) || check.straight_m > rule_m) return '未达标';
  if (check.route_basis === 'estimated') return '待核实';
  const routed = check.route_basis === undefined || check.route_basis === 'routed';
  if (routed && check.route_m >= 0 && check.route_m <= rule_m) return '达标';
  const nearer = (check.unrouted_nearer ?? []).some((u) => u.straight_m <= rule_m);
  if (routed && !nearer && !isPending(check)) return '未达标';
  return '待核实';
}

export const GB_RADIUS_M: Record<HardCategory, number> = {
  小学: GB50180_RADIUS_M.小学 ?? 500,
  菜市场: GB50180_RADIUS_M.菜市场 ?? 500,
  药店: GB50180_RADIUS_M.药店 ?? 300,
};

// --------------------------------------------------------------------- elderly profile

const r3 = (v: number) => round(v, 3);

/**
 * The result re-timed for another walking speed (技术设计文档 §5.7): route distances stay, every time
 * scales by v_old / v_new. The field is scaled node by node, then contours, areas and reach per
 * bearing are rebuilt with core's own functions, so no API call and no re-interpolation is needed.
 */
export function deriveProfile(
  base: AnalysisResult,
  profile: Profile,
  opts: { speed?: number; baseId?: string } = {},
): AnalysisResult {
  const speed = opts.speed ?? (profile === 'elder' ? ELDER_SPEED_MPS : sampleSpeedOf(base));
  const k = speedOf(base) / speed;
  const scaled = gridFromField(base.field);
  scaled.values = scaled.values.map((v) => v * k);
  // round-trip through the wire form so the stored field reproduces the contours exactly
  const field = fieldFromGrid(scaled, base.field.note);
  const grid = gridFromField(field);

  const contours = {} as Record<IsoLevel, XY[][]>;
  const contoursMeta = {} as Record<IsoLevel, ContourMeta[]>;
  const areas = {} as Record<IsoLevel, { iso: number; circle: number }>;
  for (const level of ISO_LEVELS) {
    const c = levelContours(grid, Number(level), { chaikin: 2, simplify_m: 5, minRing_m2: 1000 });
    contours[level] = c.rings.map((ring) => ring.map(([x, y]) => [round(x, 1), round(y, 1)] as XY));
    contoursMeta[level] = c.meta;
    areas[level] = { iso: r3(c.area_m2 / 1e6), circle: r3((Math.PI * (Number(level) * speed) ** 2) / 1e6) };
  }
  const area15 = areas['900'].iso;
  const circle15 = areas['900'].circle;
  const extent = base.meta.extent_m ?? Math.abs(base.field.x0);

  const scaleDur = (route: number, dur: number) => (route >= 0 ? Math.round(route / speed) : dur);
  const meta: ZddMeta = {
    ...base.meta,
    profile,
    profile_speed_mps: speed,
    ...(opts.baseId !== undefined ? { derived_from: opts.baseId } : {}),
  };
  return {
    ...base,
    meta,
    field,
    contours,
    contours_meta: contoursMeta,
    baseline: { ...base.baseline, circle_r15_m: Math.round(LIMIT_S * speed) },
    communities: base.communities.map((c) => ({
      ...c,
      checks: Object.fromEntries(
        Object.entries(c.checks).map(([cat, check]) => [
          cat,
          { ...check, dur_s: scaleDur(check.route_m, check.dur_s) },
        ]),
      ) as Community['checks'],
    })),
    pois: base.pois.map((p) =>
      p.center_route_m !== undefined ? { ...p, center_dur_s: Math.round(p.center_route_m / speed) } : p,
    ),
    stats: {
      ...base.stats,
      area_iso15_km2: area15,
      area_circle15_km2: circle15,
      overstate_x: round(circle15 / area15, 2),
      reach_share: r3(area15 / circle15),
      areas_km2: areas,
      reach_by_bearing: reachByBearing(grid, extent, 5),
    },
  };
}

// ------------------------------------------------------------------------- route estimator

/** Memoises ρ̂ and t̂ per point: siting evaluates the same sites and communities many times. */
function memoEstimator(e: RouteEstimator): RouteEstimator {
  const rho = new Map<string, number>();
  const time = new Map<string, number>();
  const key = (xy: XY) => `${xy[0].toFixed(2)},${xy[1].toFixed(2)}`;
  const timeAt = e.timeAt;
  return {
    ...(e.speed !== undefined ? { speed: e.speed } : {}),
    rhoAt(xy) {
      const k = key(xy);
      let v = rho.get(k);
      if (v === undefined) rho.set(k, (v = e.rhoAt(xy)));
      return v;
    },
    ...(timeAt
      ? {
          timeAt(xy: XY) {
            const k = key(xy);
            let v = time.get(k);
            if (v === undefined) time.set(k, (v = timeAt(xy)));
            return v;
          },
        }
      : {}),
  };
}

/**
 * ρ̂ and t̂ for L̂ (core siting.ts): the same detrended IDW as the isochrone field, built from the
 * result's own samples; the stored field stands in when a result carries no samples.
 */
export function routeEstimator(result: AnalysisResult): RouteEstimator {
  const speed = sampleSpeedOf(result);
  const { rho } = rhoSamplesOf(result.samples ?? [], speed);
  if (rho.length >= 10) return memoEstimator(fieldEstimator(rho, { speed }));
  const grid = gridFromField(result.field);
  const v = speedOf(result);
  const timeAt = (xy: XY) => sampleGrid(grid, xy[0], xy[1]);
  return memoEstimator({
    speed: v,
    timeAt,
    rhoAt(xy) {
      const r = Math.hypot(xy[0], xy[1]);
      if (r < 40) return 1.25;
      const t = timeAt(xy);
      return Number.isFinite(t) ? Math.max(1, (t * v) / r) : NaN;
    },
  });
}

// ------------------------------------------------------------------------- places

const DIRS = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];

/** "分析中心东北方向，靠近申城佳苑二期A块，孙环路旁" — words only, so it asserts no number. */
export function describePlace(result: AnalysisResult, xy: XY): string {
  const r = Math.hypot(xy[0], xy[1]);
  const label = result.meta.center_label;
  const parts: string[] = [];
  if (r < 60) parts.push(`分析中心${label ? `（${label}）` : ''}附近`);
  else parts.push(`分析中心${DIRS[Math.round(bearingDeg(xy[0], xy[1]) / 45) % 8]}方向`);
  let near: { name: string; d: number } | null = null;
  for (const c of result.communities) {
    const d = Math.hypot(c.centroid[0] - xy[0], c.centroid[1] - xy[1]);
    if (d < 250 && (!near || d < near.d)) near = { name: c.name, d };
  }
  if (near) parts.push(`靠近${near.name}`);
  let road: { name: string; d2: number } | null = null;
  for (const way of result.base?.roads ?? []) {
    if (!way.name) continue;
    for (let i = 1; i < way.pts.length; i++) {
      const d2 = segDist2(xy, way.pts[i - 1]!, way.pts[i]!);
      if (d2 < 60 * 60 && (!road || d2 < road.d2)) road = { name: way.name, d2 };
    }
  }
  if (road) parts.push(`${road.name}旁`);
  return parts.join('，');
}

/** BD-09 [lng, lat] of a local point, rounded to 6 decimals (≈ 0.1 m). */
export function toBd09(result: AnalysisResult, xy: XY): LngLat {
  const [lng, lat] = frameOf(result.meta).toLngLat(xy[0], xy[1]);
  return [round(lng, 6), round(lat, 6)];
}

/** Finds a community by (partial) name: exact first, then containment either way. */
export function findCommunity(result: AnalysisResult, name: string): Community | undefined {
  const n = normName(name);
  if (!n) return undefined;
  return (
    result.communities.find((c) => normName(c.name) === n) ??
    result.communities.find((c) => normName(c.name).includes(n)) ??
    result.communities.find((c) => n.includes(normName(c.name)))
  );
}

export const normName = (s: string): string => s.replace(/[\s()（）·•]/g, '').toLowerCase();
