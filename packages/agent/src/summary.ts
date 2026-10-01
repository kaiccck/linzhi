/**
 * The overview of one health check and the Chinese sentences that state it. Tools, the report and the
 * template advisor all phrase the headline through these functions, so the product says the same
 * thing everywhere and every number passes through a FactBook.
 */
import type { AnalysisResult, FacilityCategory, HardCategory, LngLat } from '@zoudedao/core';
import {
  HARD_CATEGORIES,
  PROFILE_ZH,
  categoryCounts,
  circleRadius,
  facilityStatsOf,
  grayLayers,
  headline,
  inventoryOf,
  profileOf,
  reach15,
  ruleText,
  speedOf,
  unitOfCategory,
  within15,
  type CategoryCounts,
  type GrayLayer,
  type Headline,
} from './analysis.js';
import { FactBook, beijingDate, round } from './format.js';
import type { Profile, ZddMeta } from './types.js';

export type AnalysisSource = 'sample' | 'live' | 'derived';

/** One category of the 圈内设施统计, at the analysis' own profile. */
export interface FacilityRow {
  category: FacilityCategory;
  /** Counting word: 所, 个, 家 or 处. */
  unit: string;
  /** Distinct facilities in the inventory (stalls fold into markets, entrances into stations). */
  found: number;
  /** Inside the straight 15-minute circle. */
  circle: number;
  /** Reachable on foot within 15 minutes (walking time to the entrance). */
  walk: number;
  /** Nearest facility by walking time, and that time in minutes (one decimal); null outside the field. */
  nearest: string | null;
  nearest_min: number | null;
  /** false: the search was cut short by its page limit, counts are lower bounds; null: not recorded. */
  complete: boolean | null;
  /** complete = false: the inventory is known out to this distance from the centre, metres. */
  known_radius_m?: number;
}

export interface FacilityOverview {
  /** Straight 15-minute radius at the profile speed, metres. */
  circle_r_m: number;
  rows: FacilityRow[];
  /** Categories listed nearby of which not one is reachable within 15 minutes (complete lists only). */
  none_within_walk: FacilityCategory[];
}

export interface GrayOverview extends GrayLayer {
  area_km2: number;
}

export interface Overview {
  analysis_id: string;
  name: string;
  center_label: string | null;
  center_bd09: LngLat;
  source: AnalysisSource;
  profile: Profile;
  profile_zh: string;
  speed_mps: number;
  generated: string;
  /** Beijing date of `generated`. */
  date: string | null;
  /** Produced by the live engine (meta.mode = 'live'), also when saved as a sample. */
  live: boolean;
  isochrone: {
    area_iso15_km2: number;
    area_circle15_km2: number;
    overstate_x: number;
    reach_share_pct: number;
    circle_r15_m: number;
    reach15: { median_m: number; min_m: number; max_m: number; bearings: number } | null;
    levels: { minutes: 5 | 10 | 15; iso_km2: number; circle_km2: number }[];
  };
  /** Straight line vs walking over the routematrix samples from the centre (stats.straight_vs_walk_gap_summary). */
  detour: {
    routes: number;
    rho_median: number;
    rho_p90: number;
    late_inside_circle_share_pct: number;
  } | null;
  headline: Headline;
  /** How the rule reads in a sentence, e.g. "1 km". */
  rule_text: string;
  by_category: Record<HardCategory, CategoryCounts>;
  within_15min: Record<
    HardCategory,
    { limit_m: number; within: number; undetermined: number; total: number }
  >;
  sampling: {
    samples: number;
    by_src: Record<string, number>;
    loo_mae_s: number | null;
    loo_p90_abs_err_s: number | null;
  };
  /** 圈内设施统计 (null when the analysis lists no facilities). */
  facilities: FacilityOverview | null;
  /** 灰色区域 layers: where the nearest community misses facilities (empty when none). */
  gray_areas: GrayOverview[];
}

/** 圈内设施统计 of a result in the product's words (see facilityStatsOf). */
export function facilityOverview(result: AnalysisResult): FacilityOverview | null {
  const stats = facilityStatsOf(result);
  if (!stats.length) return null;
  const inv = inventoryOf(result);
  const rows = stats.map((s): FacilityRow => {
    const i = inv[s.category];
    const row: FacilityRow = {
      category: s.category,
      unit: unitOfCategory(s.category),
      found: s.found,
      circle: s.circle,
      walk: s.walk,
      nearest: s.nearest ?? null,
      nearest_min: s.nearest_s === null ? null : round(s.nearest_s / 60, 1),
      complete: i ? i.complete : null,
    };
    if (i && !i.complete) row.known_radius_m = Math.round(i.radius_m);
    return row;
  });
  return {
    circle_r_m: Math.round(circleRadius(result)),
    rows,
    none_within_walk: rows.filter((r) => r.walk === 0 && r.complete !== false).map((r) => r.category),
  };
}

export function sourceOf(result: AnalysisResult, id: string): AnalysisSource {
  if ((result.meta as ZddMeta).derived_from !== undefined || id.includes('~')) return 'derived';
  return id.startsWith('live-') ? 'live' : 'sample';
}

export function overview(result: AnalysisResult, id: string): Overview {
  const s = result.stats;
  const gap = s.straight_vs_walk_gap_summary;
  const levels = ([5, 10, 15] as const).map((minutes) => {
    const a = s.areas_km2?.[String(minutes * 60) as '300' | '600' | '900'];
    return { minutes, iso_km2: a?.iso ?? NaN, circle_km2: a?.circle ?? NaN };
  });
  const bySrc = (s.n_samples_by_src as Record<string, number> | undefined) ?? {};
  const profile = profileOf(result);
  return {
    analysis_id: id,
    name: result.meta.name,
    center_label: result.meta.center_label ?? null,
    center_bd09: result.meta.center_bd09,
    source: sourceOf(result, id),
    profile,
    profile_zh: PROFILE_ZH[profile],
    speed_mps: speedOf(result),
    generated: result.meta.generated,
    date: beijingDate(result.meta.generated),
    live: (result.meta as ZddMeta).mode === 'live',
    isochrone: {
      area_iso15_km2: s.area_iso15_km2,
      area_circle15_km2: s.area_circle15_km2,
      overstate_x: s.overstate_x,
      reach_share_pct: round(s.reach_share * 100, 1),
      circle_r15_m: result.baseline.circle_r15_m,
      reach15: reach15(result),
      levels,
    },
    detour: gap
      ? {
          routes: gap.n,
          rho_median: gap.rho_median,
          rho_p90: gap.rho_p90,
          late_inside_circle_share_pct: round(gap.share_inside_circle15_over_900s * 100, 1),
        }
      : null,
    headline: headline(result),
    rule_text: ruleText(result),
    by_category: categoryCounts(result),
    within_15min: Object.fromEntries(
      HARD_CATEGORIES.map((c) => [c, within15(result, c)]),
    ) as Overview['within_15min'],
    sampling: {
      samples: s.n_samples,
      by_src: bySrc,
      loo_mae_s: typeof s.loo_mae_s === 'number' ? s.loo_mae_s : null,
      loo_p90_abs_err_s: typeof s.loo_p90_abs_err_s === 'number' ? s.loo_p90_abs_err_s : null,
    },
    facilities: facilityOverview(result),
    gray_areas: grayLayers(result).map((g) => ({ ...g, area_km2: round(g.area_m2 / 1e6, 3) })),
  };
}

/** Where the numbers come from, e.g. "样例数据，2026-09-26 百度地图实测" (the date goes through `book`). */
export function provenance(o: Overview, book?: FactBook): string {
  const date = o.date ? (book ? book.date('数据日期', o.date) : o.date) : null;
  let text = o.live
    ? `实时分析，${date ? `${date} ` : ''}调用百度地图开放平台`
    : `样例数据，${date ? `${date} ` : ''}百度地图实测`;
  if (o.source === 'derived') text += '，按老年人步速换算';
  else if (o.live && o.source === 'sample') text += `，已保存为样例 ${o.analysis_id}`;
  return text;
}

/** Prefix for fact labels when several analyses share one answer (compare_sites). */
export interface PhraseOptions {
  labelPrefix?: string;
}

/**
 * The product's lead sentence: gaps the circle finds vs verified gaps on foot. Returns '' when there
 * is nothing to compare (no checks).
 */
export function gapSentence(o: Overview, book: FactBook, opts: PhraseOptions = {}): string {
  const p = opts.labelPrefix ?? '';
  const h = o.headline;
  if (!h.checks) return '';
  const straight = book.add(`${p}画圆法（直线 ${o.rule_text}）找到的缺口数`, h.straight_gaps, '个');
  const pending = h.pending
    ? `另有 ${book.add(`${p}待核实检查数`, h.pending, '项')}待核实，不计入缺口。`
    : '';
  if (!h.walking_gaps) {
    return `按实测步行距离没有已核实的服务缺口（画圆法找到 ${straight}）。${pending}`;
  }
  const walking = book.add(`${p}步行已核实缺口数`, h.walking_gaps, '个');
  if (!h.missed_by_circle) {
    return `画圆法找到 ${straight}缺口，按实测步行距离已核实 ${walking}，没有被画圆漏掉的。${pending}`;
  }
  const missed = book.add(`${p}画圆漏掉的缺口数`, h.missed_by_circle, '个');
  const share = book.add(`${p}画圆漏掉的比例`, h.missed_share_pct ?? 0, '%', { digits: 1, trim: true });
  return `画圆法（直线 ${o.rule_text}）只找到 ${straight}服务缺口，按实测步行距离已核实 ${walking}，画圆漏掉了其中 ${missed}（${share}）。${pending}`;
}

/** Reach area vs circle, overstatement and effective radius. */
export function reachSentence(o: Overview, book: FactBook, opts: PhraseOptions = {}): string {
  const p = opts.labelPrefix ?? '';
  const i = o.isochrone;
  if (!(i.area_iso15_km2 > 0)) return '';
  const area = book.add(`${p}15 分钟步行可达面积`, i.area_iso15_km2, 'km²', { digits: 3 });
  const circle = book.add(`${p}直线 15 分钟圆面积`, i.area_circle15_km2, 'km²', { digits: 3 });
  const share = book.add(`${p}可达面积占直线圆的比例`, i.reach_share_pct, '%', { digits: 1, trim: true });
  const x = book.add(`${p}画圆高估倍数`, i.overstate_x, '倍', { digits: 2 });
  let text = `15 分钟步行实际可达 ${area}，只有直线 15 分钟圆（${circle}）的 ${share}，画圆把可达面积高估了 ${x}。`;
  if (i.reach15) {
    const med = book.add(`${p}15 分钟有效半径中位数`, i.reach15.median_m, 'm', { digits: 1, trim: true });
    const r = book.add(`${p}直线 15 分钟圆半径`, i.circle_r15_m, 'm');
    text += `15 分钟有效步行半径中位数 ${med}，而直线圆半径是 ${r}。`;
  }
  return text;
}

/** "小学：覆盖 6、伪覆盖 5、盲区 1；…" over verified checks, pending counted separately. */
export function categorySentence(
  o: Overview,
  book: FactBook,
  categories: readonly HardCategory[] = HARD_CATEGORIES,
  opts: PhraseOptions = {},
): string {
  const p = opts.labelPrefix ?? '';
  const parts = categories.map((cat) => {
    const n = o.by_category[cat];
    const items = (['覆盖', '伪覆盖', '盲区'] as const).map(
      (k) => `${k} ${book.num(`${p}${cat}${k}数（已核实）`, n[k], '个')}`,
    );
    if (n.待核实) items.push(`待核实 ${book.num(`${p}${cat}待核实数`, n.待核实, '项')}`);
    return `${cat}：${items.join('、')}`;
  });
  return `各类设施（按小区计，已核实）——${parts.join('；')}。`;
}

/** Elderly profile note: speed and what 15 minutes reach at it. */
export function profileSentence(o: Overview, book: FactBook, opts: PhraseOptions = {}): string {
  if (o.profile !== 'elder') return '';
  const p = opts.labelPrefix ?? '';
  const speed = book.add(`${p}老年人步速`, o.speed_mps, 'm/s', { digits: 2, trim: true });
  const limit = book.add(`${p}老年人 15 分钟步行距离`, o.within_15min.小学.limit_m, 'm');
  return `按老年人步速 ${speed} 计算：路线距离不变、时间变长，15 分钟最多走 ${limit}。`;
}

/**
 * 圈内设施: per category, facilities reachable within 15 minutes on foot next to those inside the straight
 * 15-minute circle, the categories none of which is walkable, and the walk to the nearest one.
 */
export function facilitySentence(o: Overview, book: FactBook, opts: PhraseOptions = {}): string {
  const f = o.facilities;
  if (!f?.rows.length) return '';
  const p = opts.labelPrefix ?? '';
  const items = f.rows.map((r) => {
    const walk = book.num(`${p}15 分钟步行可达的${r.category}数`, r.walk, r.unit);
    const circle = book.num(`${p}直线 15 分钟圆内的${r.category}数`, r.circle, r.unit);
    return `${r.category} ${walk} / ${circle}${r.complete === false ? '（清单不全，至少）' : ''}`;
  });
  let text = `圈内设施（15 分钟步行可达 / 直线 15 分钟圆内）：${items.join('，')}。`;
  if (f.none_within_walk.length) text += `15 分钟内一处也走不到：${f.none_within_walk.join('、')}。`;
  const near = f.rows
    .filter((r) => r.walk > 0 && r.nearest_min !== null)
    .map(
      (r) =>
        `${r.category} ${book.add(`${p}最近的${r.category}步行时间`, r.nearest_min!, '分钟', { digits: 1 })}`,
    );
  if (near.length) text += `最近一处的步行时间：${near.join('、')}。`;
  return text;
}

/** 灰色区域: area and pieces per layer (at least n categories missing, then 伪覆盖). */
export function graySentence(o: Overview, book: FactBook, opts: PhraseOptions = {}): string {
  if (!o.gray_areas.length) return '';
  const p = opts.labelPrefix ?? '';
  const layer = (g: GrayOverview) => {
    const what =
      g.kind === 'pseudo'
        ? '有伪覆盖'
        : `缺至少 ${book.num(`${p}灰色区域的缺类门槛`, g.min_missing, '类')} 类必需设施`;
    const tag = g.kind === 'pseudo' ? '伪覆盖' : `缺至少${g.min_missing}类`;
    const area = book.add(`${p}灰色区域（${tag}）面积`, g.area_km2, 'km²', { digits: 3 });
    const n = book.num(`${p}灰色区域（${tag}）块数`, g.polygons, '处');
    return `${what} ${area}（${n} 处）`;
  };
  return `灰色区域（按最近小区的已核实判定标出的设施匮乏范围）：${o.gray_areas.map(layer).join('，')}。`;
}
