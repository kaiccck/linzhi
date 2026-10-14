/**
 * 圈内设施统计: how many facilities of each category the 15-minute walk actually reaches, next to
 * how many the straight-line circle claims. Computed from an AnalysisResult alone (POIs + time
 * field), so the engine, the web board, the printable report and the AI tools agree.
 */
import { gridFromField, WALK_SPEED_MPS } from './isochrone.js';
import { sampleGrid } from './field.js';
import { normalizeName } from './poi.js';
import type { AnalysisResult, FacilityCategory, Poi } from './types.js';

export interface FacilityStat {
  category: FacilityCategory;
  /**
   * Distinct facilities of the category in the inventory: market stalls fold into their market, the
   * entrances and platforms of one station (地铁, 公交) into the station.
   */
  found: number;
  /** Reachable on foot within the limit: time field at the facility's entrance ≤ limit. */
  walk: number;
  /** Inside the straight-line circle of radius limit × speed. */
  circle: number;
  /** Walking time from the centre to the nearest reachable facility (seconds), null if none is in the field. */
  nearest_s: number | null;
  nearest?: string;
}

export interface FacilityStatsOptions {
  /** Walking-time limit in the field's (adult) seconds; default 900 (15 minutes). */
  limit_s?: number;
  /**
   * Walking-time multiplier of a profile relative to the field's speed (elder: 1.17 / 0.9). The limit
   * is compared against field time × scale, and the straight circle shrinks by the same factor.
   */
  scale?: number;
  /** Categories in display order; default: every category present, in STAT_ORDER. */
  categories?: readonly FacilityCategory[];
}

/** Display order of the 民生设施 categories. */
export const STAT_ORDER: readonly FacilityCategory[] = [
  '小学',
  '幼儿园',
  '中学',
  '菜市场',
  '生鲜超市',
  '超市',
  '便利店',
  '餐饮',
  '药店',
  '社区卫生',
  '养老',
  '快递',
  '银行',
  '健身',
  '文化',
  '公交',
  '地铁',
  '公园',
];

/** Categories whose POIs are entrances or platforms of one station, told apart by name. */
const STATIONS: ReadonlySet<FacilityCategory> = new Set<FacilityCategory>(['地铁', '公交']);

const EXIT_SUFFIX =
  /[-－_]*(?:(?:出入口|入口|出口)[0-9a-z]*|[0-9a-z一二三四五六七八九十]+号?(?:出入口|入口|出口|口))$/;
const STATION_SUFFIX = /\(?(?:地铁站|公交站|车站|站)\)?$/;

/**
 * The station a transit POI belongs to: "张江路站 出入口3", "张江路站", "张江路(地铁站)" and Baidu's
 * "张江路" (交通设施;地铁站) are all 张江路; "华夏中路地铁站-1口" is 华夏中路.
 */
export function stationKey(name: string): string {
  const n = normalizeName(name);
  const key = n.replace(EXIT_SUFFIX, '').replace(STATION_SUFFIX, '');
  return key || n;
}

export function facilityStats(
  result: Pick<AnalysisResult, 'pois' | 'field' | 'meta'>,
  opts: FacilityStatsOptions = {},
): FacilityStat[] {
  const limit = opts.limit_s ?? 900;
  const scale = opts.scale ?? 1;
  const speed = result.meta.walk_speed_mps || WALK_SPEED_MPS;
  const radius = (limit * speed) / scale;
  const grid = gridFromField(result.field);
  const distinct = result.pois.filter((p) => !p.stall_of && p.cat !== '其他');
  const present = new Set(distinct.map((p) => p.cat));
  const cats = opts.categories ?? STAT_ORDER.filter((c) => present.has(c));
  return cats.map((category) => {
    // one facility per uid, or per station for transit (its entrances all lead to the same trains)
    const facilities = new Map<string, Poi[]>();
    for (const p of distinct) {
      if (p.cat !== category) continue;
      const key = STATIONS.has(category) ? `station:${stationKey(p.name)}` : `uid:${p.uid}`;
      const members = facilities.get(key);
      if (members) members.push(p);
      else facilities.set(key, [p]);
    }
    let walk = 0;
    let circle = 0;
    let nearest: { t: number; poi: Poi } | null = null;
    for (const members of facilities.values()) {
      if (members.some((p) => Math.hypot(p.xy[0], p.xy[1]) <= radius)) circle++;
      let best = Infinity;
      for (const p of members) {
        const [x, y] = p.navi_xy ?? p.xy;
        const t = sampleGrid(grid, x, y) * scale;
        if (!Number.isFinite(t)) continue;
        if (t < best) best = t;
        if (!nearest || t < nearest.t) nearest = { t, poi: p };
      }
      if (best <= limit) walk++;
    }
    const stat: FacilityStat = {
      category,
      found: facilities.size,
      walk,
      circle,
      nearest_s: nearest ? Math.round(nearest.t) : null,
    };
    if (nearest) stat.nearest = nearest.poi.name;
    return stat;
  });
}
