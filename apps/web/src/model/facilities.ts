/**
 * 圈内设施统计 for the panel's 圈内设施 view, its map and the printable report: per category, how
 * many facilities the straight 15′ circle claims and how many the 15′ walk really reaches. The counts
 * come from @zoudedao/core's facilityStats (the engine, the AI tools and the report agree); this
 * shapes them into rows and tallies, and names the facilities themselves for the map.
 */
import {
  facilityStats,
  gridFromField,
  sampleGrid,
  stationKey,
  type AnalysisResult,
  type FacilityCategory,
  type Poi,
} from '@zoudedao/core';
import { circleR, STAT_ICON, type IconId, type Model } from './derive.js';

/** One square of the tally: reached on foot within 15′, or only claimed by the straight circle. */
export type Mark = 'walk' | 'claim';

export type StatCategory = Exclude<FacilityCategory, '其他'>;

export interface FacilityRow {
  cat: StatCategory;
  icon: IconId;
  /** distinct facilities of the category in the inventory (search radius, market stalls folded) */
  found: number;
  /** reachable on foot within 15′ */
  walk: number;
  /** inside the straight 15′ circle */
  circle: number;
  /** walking minutes to the nearest one (null: none inside the time field) */
  nearestMin: number | null;
  nearest?: string;
  /** one mark per facility the circle claims (or the walk reaches), the reachable ones first */
  tally: Mark[];
}

export interface FacilitySummary {
  rows: FacilityRow[];
  /** totals over every category shown */
  walk: number;
  circle: number;
  /** radius of the straight 15′ circle the counts use, metres (it shrinks with the profile) */
  radiusM: number;
}

export function facilitySummary(model: Model, scale: number): FacilitySummary {
  // the categories checked per community lead, in the category buttons' order; the rest keep theirs
  const lead = (c: string) => {
    const i = (model.cats as readonly string[]).indexOf(c);
    return i < 0 ? model.cats.length : i;
  };
  const stats = [...facilityStats(model.data, { scale })].sort((a, b) => lead(a.category) - lead(b.category));
  const rows = stats.flatMap((s): FacilityRow[] => {
    if (s.category === '其他') return [];
    const n = Math.max(s.circle, s.walk);
    return [
      {
        cat: s.category,
        icon: STAT_ICON[s.category],
        found: s.found,
        walk: s.walk,
        circle: s.circle,
        nearestMin: s.nearest_s === null ? null : Math.round(s.nearest_s / 60),
        ...(s.nearest ? { nearest: s.nearest } : {}),
        tally: Array.from({ length: n }, (_, i): Mark => (i < s.walk ? 'walk' : 'claim')),
      },
    ];
  });
  return {
    rows,
    walk: rows.reduce((n, r) => n + r.walk, 0),
    circle: rows.reduce((n, r) => n + r.circle, 0),
    radiusM: circleR(model, scale),
  };
}

/** Spoken label of a row: every number with its meaning, never just the squares. */
export function rowLabel(r: FacilityRow, radiusM: number): string {
  const near =
    r.nearestMin === null
      ? '步行范围内没有'
      : `最近的${r.nearest ? ` ${r.nearest} ` : ''}步行约 ${r.nearestMin} 分钟`;
  return `${r.cat}：直线 ${Math.round(radiusM)} 米的圈里 ${r.circle} 个，15 分钟走得到 ${r.walk} 个，共找到 ${r.found} 个；${near}`;
}

/* ---------------------------------------------------------------- the facilities themselves */

/** One facility as the 圈内设施 map marks it (a station counts once, marked at the station itself). */
export interface FacilityMark {
  key: string;
  cat: StatCategory;
  /** the POI the mark stands on: the station rather than one of its entrances */
  face: Poi;
  inCircle: boolean;
  /** reachable on foot within 15′ at the profile's speed */
  reach: boolean;
  /** walking seconds to its nearest entrance at the profile's speed (Infinity outside the field) */
  t: number;
  /** straight metres from the centre to the mark */
  straight: number;
  /** a 买菜替代 shop beside the 菜市场 marks (model/fresh.ts), not a facility of the inventory */
  fresh?: boolean;
}

const grids = new WeakMap<AnalysisResult, ReturnType<typeof gridFromField>>();
const STATIONS = new Set<FacilityCategory>(['地铁', '公交']);

/**
 * The facilities behind facilityStats' counts, grouped exactly as it groups them (one per uid, one
 * per station for transit) and judged the same way: in the circle when any member is, reached when
 * the time field at any entrance is within 15′ at the profile's speed.
 */
export function facilityMarks(model: Model, scale: number): FacilityMark[] {
  const { data } = model;
  let grid = grids.get(data);
  if (!grid) {
    grid = gridFromField(data.field);
    grids.set(data, grid);
  }
  const radius = circleR(model, scale);
  const groups = new Map<string, { cat: StatCategory; pois: Poi[] }>();
  for (const p of data.pois) {
    if (p.stall_of || p.cat === '其他') continue;
    const key = STATIONS.has(p.cat) ? `${p.cat}:station:${stationKey(p.name)}` : `${p.cat}:uid:${p.uid}`;
    const g = groups.get(key);
    if (g) g.pois.push(p);
    else groups.set(key, { cat: p.cat, pois: [p] });
  }
  const out: FacilityMark[] = [];
  for (const [key, { cat, pois }] of groups) {
    let t = Infinity;
    for (const p of pois) {
      const [x, y] = p.navi_xy ?? p.xy;
      const s = sampleGrid(grid, x, y) * scale;
      if (Number.isFinite(s) && s < t) t = s;
    }
    const face = pois.find((p) => !/出入口|入口|出口/.test(p.name)) ?? pois[0]!;
    out.push({
      key,
      cat,
      face,
      inCircle: pois.some((p) => Math.hypot(p.xy[0], p.xy[1]) <= radius),
      reach: t <= 900,
      t,
      straight: Math.hypot(face.xy[0], face.xy[1]),
    });
  }
  return out;
}
