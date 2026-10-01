/**
 * Pure derivations from one AnalysisResult: the headline numbers the product states, per-category
 * counts, the elderly-profile variant and the route estimator for what-if siting. Nothing here calls
 * a network or an LLM, so every tool answer can be reproduced from the result alone.
 */
import {
  HARD_CATEGORIES,
  ISO_LEVELS,
  STAT_ORDER,
  TASK_CATEGORIES,
  TASK_RULE_M,
  WALK_SPEED_MPS,
  bearingDeg,
  checkedCategories,
  facilityStats,
  fieldEstimator,
  fieldFromGrid,
  gapCount,
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
  type FacilityCategory,
  type FacilityCheck,
  type FacilityStat,
  type GrayArea,
  type HardCategory,
  type IsoLevel,
  type LocalFrame,
  type LngLat,
  type RouteEstimator,
  type XY,
} from '@zoudedao/core';
import { round } from './format.js';
import { ELDER_SPEED_MPS, type Profile, type ZddMeta } from './types.js';

/**
 * HARD_CATEGORIES: every category a community can be checked for (display order); TASK_CATEGORIES:
 * the three the task names; checkedCategories(result): those one analysis was checked for — all five
 * on new analyses, the task's three on older ones. Everything below reads the last.
 */
export { HARD_CATEGORIES, TASK_CATEGORIES, checkedCategories };

/**
 * Which checked categories the task names, for method notes: "其中小学、菜市场、药店是赛题要求，幼儿园、
 * 社区卫生按同一判定距离一并检查", or "均为赛题要求" when the analysis checked the task's own.
 */
export function taskScope(checked: readonly HardCategory[]): string {
  const asked = checked.filter((c) => TASK_CATEGORIES.includes(c));
  const added = checked.filter((c) => !TASK_CATEGORIES.includes(c));
  if (!added.length) return '均为赛题要求';
  if (!asked.length) return `${added.join('、')}按赛题的判定距离检查`;
  return `其中${asked.join('、')}是赛题要求，${added.join('、')}按同一判定距离一并检查`;
}

/**
 * What the per-community checks cover, for tool descriptions and the system prompt: "新的体检逐小区检查
 * 幼儿园、小学、菜市场、药店、社区卫生（其中…），较早的体检只检查小学、菜市场、药店".
 */
export const CHECKED_SCOPE = `新的体检逐小区检查${HARD_CATEGORIES.join('、')}（${taskScope(HARD_CATEGORIES)}），较早的体检只检查${TASK_CATEGORIES.join('、')}`;

/** 民生设施 the 圈内设施统计 counts beside the per-community categories (超市, 公交 …), in its order. */
export const COUNTED_ONLY: readonly FacilityCategory[] = STAT_ORDER.filter(
  (c) => !(HARD_CATEGORIES as readonly FacilityCategory[]).includes(c),
);

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

/** Every check of the analysis' checked categories, community by community (display order within). */
export function checkRows(result: AnalysisResult): CheckRow[] {
  const rows: CheckRow[] = [];
  const checked = checkedCategories(result);
  result.communities.forEach((community, index) => {
    for (const category of checked) {
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

/** Rule distance the result's checks used for a category (meta.rule_m of live results, else 1 km). */
export function ruleOf(result: AnalysisResult, category: HardCategory): number {
  const given = (result.meta as ZddMeta).rule_m?.[category];
  if (typeof given === 'number' && given > 0) return given;
  return TASK_RULE_M[category];
}

/** Rule distance per checked category of the analysis, metres. */
export function rulesOf(result: AnalysisResult): Record<HardCategory, number> {
  return Object.fromEntries(checkedCategories(result).map((c) => [c, ruleOf(result, c)])) as Record<
    HardCategory,
    number
  >;
}

/** How the rule reads in a sentence: "1 km" for the task rule, else the distances per checked category. */
export function ruleText(result: AnalysisResult): string {
  const checked = checkedCategories(result);
  const rules = checked.map((c) => ruleOf(result, c));
  if (rules.every((r) => r === 1000)) return '1 km';
  if (rules.every((r) => r === rules[0])) return `${rules[0]} m`;
  return checked.map((c) => `${c} ${ruleOf(result, c)} m`).join('、');
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

/**
 * Counts per checked category. Like core's Community.checks, the record carries the analysis' checked
 * categories only (checkedCategories): an older analysis has no 幼儿园 or 社区卫生 entry at all.
 */
export function categoryCounts(result: AnalysisResult): Record<HardCategory, CategoryCounts> {
  const out = Object.fromEntries(
    checkedCategories(result).map((c) => [c, { total: 0, 覆盖: 0, 伪覆盖: 0, 盲区: 0, 临界: 0, 待核实: 0 }]),
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
  /** Rule distance per checked category (only the analysis' checked categories are present). */
  rule_m: Record<HardCategory, number>;
  communities: number;
  /** Categories checked per community: 5 on new analyses, the task's 3 on older ones. */
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
    rule_m: rulesOf(result),
    communities: result.communities.length,
    categories: checkedCategories(result).length,
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
 * A check under a given distance rule, using only what was measured: walking is never shorter than the straight line, and an unrouted facility nearer than
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
  // 圈内设施统计 at the new speed, from the base's own (adult-second) field: the same numbers the web
  // derives with facilityStats(result, { scale: 1.17 / 0.9 })
  const facility_stats = facilityStats(base, { scale: k });
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
          {
            ...check,
            dur_s: scaleDur(check.route_m, check.dur_s),
            // the 买菜替代 walk is timed like the check's own
            ...(check.alt
              ? { alt: { ...check.alt, dur_s: scaleDur(check.alt.route_m, check.alt.dur_s) } }
              : {}),
          },
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
      facility_stats,
    },
  };
}

// ------------------------------------------------------------------ 圈内设施 and 灰色区域

/** How one inventory group was fetched (live results: stats.facility_inventory, keyed by category). */
export interface InventoryInfo {
  complete: boolean;
  radius_m: number;
  fetched?: number;
}

export function inventoryOf(result: AnalysisResult): Partial<Record<string, InventoryInfo>> {
  const inv = result.stats.facility_inventory;
  return inv && typeof inv === 'object' ? (inv as Partial<Record<string, InventoryInfo>>) : {};
}

/**
 * 圈内设施统计 at the result's own profile. Adult results and profiles derived here carry their own
 * stats.facility_stats; a live elder result stores adult numbers over an adult-second field, and older
 * results store none, so those are computed with core's facilityStats (scaled for the elder profile).
 */
export function facilityStatsOf(result: AnalysisResult): FacilityStat[] {
  const meta = result.meta as ZddMeta;
  const derived = meta.derived_from !== undefined;
  const elder = profileOf(result) === 'elder';
  const stored = result.stats.facility_stats;
  if (Array.isArray(stored) && (derived || !elder)) return stored;
  if (derived) {
    // the field is re-timed already: only the circle needs the profile speed
    return facilityStats({ ...result, meta: { ...result.meta, walk_speed_mps: speedOf(result) } });
  }
  return facilityStats(result, { scale: elder ? sampleSpeedOf(result) / speedOf(result) : 1 });
}

/**
 * Walking time from the centre to a facility's entrance at the result's profile (seconds), null
 * outside the field — the same numbers facilityStatsOf counts.
 */
export function facilityTimer(result: AnalysisResult): (xy: XY) => number | null {
  const meta = result.meta as ZddMeta;
  const grid = gridFromField(result.field);
  const scale =
    meta.derived_from === undefined && profileOf(result) === 'elder'
      ? sampleSpeedOf(result) / speedOf(result)
      : 1;
  return (xy) => {
    const t = sampleGrid(grid, xy[0], xy[1]) * scale;
    return Number.isFinite(t) ? t : null;
  };
}

/** Straight 15-minute radius at the result's profile, metres. */
export const circleRadius = (result: AnalysisResult): number => LIMIT_S * speedOf(result);

/** One layer of 灰色区域 in plain numbers, with the communities whose own checks put them in it. */
export interface GrayLayer {
  kind: GrayArea['kind'];
  min_missing: number;
  /** Separate polygons (outer rings). */
  polygons: number;
  area_m2: number;
  communities: string[];
}

/** The 灰色区域 layers (gap ≥ 1, ≥ 2 …, then 伪覆盖), as stored in result.gray_areas. */
export function grayLayers(result: AnalysisResult): GrayLayer[] {
  const status = result.communities.map((c) => ({ name: c.name, ...gapCount(c.checks) }));
  return (result.gray_areas ?? []).map((g) => ({
    kind: g.kind,
    min_missing: g.min_missing,
    polygons: g.meta.filter((m) => !m.hole).length,
    area_m2: g.area_m2,
    communities: status
      .filter((s) => (g.kind === 'pseudo' ? s.pseudo : s.missing >= g.min_missing))
      .map((s) => s.name),
  }));
}

/** Counting word of a category: 所 for schools, 个 for markets and stations, 家 for shops, 处 otherwise. */
export const FACILITY_UNIT: Readonly<Partial<Record<FacilityCategory, string>>> = {
  小学: '所',
  幼儿园: '所',
  菜市场: '个',
  生鲜超市: '家',
  超市: '家',
  药店: '家',
  社区卫生: '处',
  养老: '处',
  公交: '个',
  地铁: '个',
  公园: '个',
};

export const unitOfCategory = (c: FacilityCategory): string => FACILITY_UNIT[c] ?? '处';

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
