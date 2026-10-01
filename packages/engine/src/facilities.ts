/**
 * Facility inventory within the place budget (技术设计文档 §6.2–6.3).
 *
 * Measured (research/zhangjiang/raw/bv_place_A_fac_p0.json): a "$" union answers group by group in
 * keyword order, each group nearest first. So the scarce hard categories go first and the page limit
 * only cuts the far tail of the last, most abundant group (药店). A group crowded out by the ones before
 * it — the union was cut short or hit Baidu's 150 cap while the group has less than a page — gets its
 * own query: the `capped` handling (split keywords). How far out each group is known completely is
 * kept, so a gap far from the centre is never claimed from a truncated list.
 */
import type { PlacePoi, PlaceSearchResult } from '@zoudedao/baidu';
import {
  cleanPois,
  countFacilities,
  normalizeName,
  stationKey,
  type BaiduPlaceResult,
  type DroppedPoi,
  type FacilityCategory,
  type HardCategory,
  type LngLat,
  type LocalFrame,
  type Poi,
} from '@zoudedao/core';

import { LIVELIHOOD_DEDUPE_M, LIVELIHOOD_RADIUS_M, PLACE_PAGE_SIZE, STATION_DEDUPE_M } from './constants.js';
import { describeError, EngineError, isDegradable } from './errors.js';
import type { Meter } from './meter.js';
import type { EngineClient } from './types.js';

/** Categories of the 民生设施 union (the facilities counted, never checked per community). */
export type LivelihoodKey = '养老' | '地铁' | '公园' | '超市' | '公交';

/** Groups of the 买菜替代 search (engine fresh.ts): shops that name produce, then 超市. */
export type FreshGroupKey = '果蔬店' | '超市';

export type GroupKey = HardCategory | '生鲜超市' | LivelihoodKey | FreshGroupKey;

export interface FacilityGroup {
  key: GroupKey;
  keywords: readonly string[];
}

const GROUPS: Readonly<Record<Exclude<GroupKey, LivelihoodKey | FreshGroupKey>, FacilityGroup>> = {
  小学: { key: '小学', keywords: ['小学'] },
  社区卫生: { key: '社区卫生', keywords: ['社区卫生服务中心', '社区卫生服务站'] },
  幼儿园: { key: '幼儿园', keywords: ['幼儿园'] },
  菜市场: { key: '菜市场', keywords: ['菜市场', '菜场', '农贸市场', '生鲜市场'] },
  生鲜超市: { key: '生鲜超市', keywords: ['生鲜超市'] },
  药店: { key: '药店', keywords: ['药店', '药房'] },
};

/**
 * Keyword groups in query order: every checked category in one union of exactly 10 keywords (Baidu's
 * most for one query), the scarcest first and the abundant 药店 last, so the page limit only trims
 * the far tail of pharmacies; 生鲜超市 when pages are left.
 */
export function facilityGroups(): { required: FacilityGroup[]; optional: FacilityGroup[] } {
  const g = GROUPS;
  return { required: [g.小学, g.社区卫生, g.幼儿园, g.菜市场, g.药店], optional: [g.生鲜超市] };
}

export interface InventoryInfo {
  /** Every POI of the group within the search radius was fetched. */
  complete: boolean;
  /** Distance from the centre within which the group is known completely, metres. */
  radius_m: number;
  fetched: number;
}

export type Inventory = Partial<Record<GroupKey, InventoryInfo>>;

export interface PlaceQueryLog {
  keywords: string;
  max_pages: number;
  pages: number;
  /** Pages that cost a Baidu call. */
  billed: number;
  total: number;
  complete: boolean;
  capped: boolean;
}

export interface FacilitySearch {
  pois: Poi[];
  dropped: DroppedPoi[];
  /** Every row the searches returned, before cleaning (official lists match against these). */
  rows: PlacePoi[];
  inventory: Inventory;
  queries: PlaceQueryLog[];
  radius_m: number;
}

/** place/v3 POI as parsed by the client → the Baidu JSON shape core's cleanPois reads. */
export function toPlaceResult(p: PlacePoi): BaiduPlaceResult {
  const detail: NonNullable<BaiduPlaceResult['detail_info']> = {};
  if (p.classifiedTag) detail.classified_poi_tag = p.classifiedTag;
  if (p.tag) detail.tag = p.tag;
  if (p.naviLocation) detail.navi_location = { lng: p.naviLocation[0], lat: p.naviLocation[1] };
  if (p.parentId) detail.parent_id = p.parentId;
  if (p.label) detail.label = p.label;
  const out: BaiduPlaceResult = {
    name: p.name,
    location: { lng: p.location[0], lat: p.location[1] },
    detail_info: detail,
  };
  if (p.uid) out.uid = p.uid;
  if (p.address) out.address = p.address;
  return out;
}

/** Index of the first group whose keyword the POI's name or tag contains (how Baidu groups a union). */
export function groupIndex(
  p: Pick<PlacePoi, 'name' | 'tag' | 'classifiedTag'>,
  groups: readonly FacilityGroup[],
) {
  const text = `${p.name}|${p.classifiedTag ?? ''}|${p.tag ?? ''}`;
  return groups.findIndex((g) => g.keywords.some((k) => text.includes(k)));
}

/**
 * What one answer proves about each group. Complete answers prove everything; a cut-short union still
 * proves the groups before the last one it reached, provided its rows really came group by group;
 * a cut-short group is known out to its farthest row (rows come nearest first).
 */
export function inventoryOf(
  groups: readonly FacilityGroup[],
  r: Pick<PlaceSearchResult, 'pois' | 'complete'>,
  distOf: (p: PlacePoi) => number,
  radius: number,
): Map<GroupKey, InventoryInfo> {
  const idx = r.pois.map((p) => groupIndex(p, groups));
  const seq = idx.filter((i) => i >= 0);
  const ordered = seq.every((g, i) => i === 0 || g >= seq[i - 1]!);
  const last = seq.length ? seq[seq.length - 1]! : -1;
  const out = new Map<GroupKey, InventoryInfo>();
  groups.forEach((g, gi) => {
    const mine = r.pois.filter((_, k) => idx[k] === gi);
    const complete = r.complete || (ordered && gi < last);
    const far = mine.reduce((m, p) => Math.max(m, distOf(p)), 0);
    out.set(g.key, {
      complete,
      radius_m: complete ? radius : Math.round(far * 10) / 10,
      fetched: mine.length,
    });
  });
  return out;
}

function mergeInventory(inv: Inventory, key: GroupKey, info: InventoryInfo): void {
  const prev = inv[key];
  inv[key] = prev
    ? {
        complete: prev.complete || info.complete,
        radius_m: Math.max(prev.radius_m, info.radius_m),
        fetched: Math.max(prev.fetched, info.fetched),
      }
    : info;
}

/**
 * The facility inventory: a union of the required groups (one page is kept back), a split query for
 * any required group the union crowded out, then the optional groups with whatever pages are left.
 */
export async function searchFacilities(args: {
  meter: Meter;
  client: EngineClient;
  center: LngLat;
  frame: LocalFrame;
  radius_m: number;
  warn: (message: string) => void;
}): Promise<FacilitySearch> {
  const { meter, client, center, frame, radius_m, warn } = args;
  const { required, optional } = facilityGroups();
  const rows: PlacePoi[] = [];
  const inventory: Inventory = {};
  const queries: PlaceQueryLog[] = [];
  const distOf = (p: PlacePoi) => {
    const [x, y] = frame.toXY(p.location[0], p.location[1]);
    return Math.hypot(x, y);
  };
  const query = async (groups: FacilityGroup[], maxPages: number) => {
    const keywords = groups.flatMap((g) => g.keywords);
    const r = await meter.run(
      'facilities',
      maxPages,
      (o) =>
        client.placeAround(keywords, center, { ...o, radius: radius_m, maxPages, pageSize: PLACE_PAGE_SIZE }),
      (res) => res.apiCalls,
      (res) => res.pages,
    );
    rows.push(...r.pois);
    for (const [key, info] of inventoryOf(groups, r, distOf, radius_m)) mergeInventory(inventory, key, info);
    queries.push({
      keywords: keywords.join('$'),
      max_pages: maxPages,
      pages: r.pages,
      billed: r.apiCalls,
      total: r.total,
      complete: r.complete,
      capped: r.capped,
    });
    return r;
  };
  const room = () => meter.room('facilities');

  if (room() < 1) throw new EngineError('quota_exhausted', '本次分析没有地点检索预算，无法检索设施');
  const union = await query(required, Math.max(1, room() - 1));
  if (!union.complete) {
    for (const g of required) {
      const inv = inventory[g.key];
      if (room() < 1) break;
      if (!inv || inv.complete || inv.fetched >= PLACE_PAGE_SIZE) continue;
      await query([g], 1);
    }
  }
  if (optional.length && room() >= 1) {
    try {
      await query(optional, room());
    } catch (err) {
      if (!isDegradable(err)) throw err;
      warn(`生鲜超市检索失败，只统计逐小区检查的设施：${describeError(err)}`);
    }
  }
  const { pois, dropped } = cleanPois(rows.map(toPlaceResult), { project: frame.toXY });
  return { pois, dropped, rows, inventory, queries, radius_m };
}

/**
 * Distance from the centre within which a check category's facilities are all known (Infinity when its
 * group was fetched completely).
 */
export function knownRadius(inventory: Inventory, cat: HardCategory): number {
  const inv = inventory[cat];
  return inv?.complete ? Infinity : (inv?.radius_m ?? 0);
}

// ------------------------------------------------------------------------------- 民生设施

/**
 * The 民生设施 union for the 圈内设施统计: one query (at most Baidu's 10 keywords), grouped by category
 * and scarcest first, so the page limit only trims the far tail of bus stops. Every keyword maps to its
 * category through core's categorize(); station exits (出入口;其他) are dropped there. 社区卫生 is not
 * here: it is checked per community, with the facility union.
 */
export const LIVELIHOOD_GROUPS: readonly (FacilityGroup & { key: LivelihoodKey })[] = [
  { key: '养老', keywords: ['养老院', '日间照料中心', '长者照护之家', '长者食堂', '综合为老服务中心'] },
  { key: '地铁', keywords: ['地铁站'] },
  { key: '公园', keywords: ['公园'] },
  { key: '超市', keywords: ['超市'] },
  { key: '公交', keywords: ['公交车站'] },
];

export const LIVELIHOOD_KEYWORDS: readonly string[] = LIVELIHOOD_GROUPS.flatMap((g) => g.keywords);
export const LIVELIHOOD_CATEGORIES: readonly FacilityCategory[] = LIVELIHOOD_GROUPS.map((g) => g.key);

const TRANSIT: ReadonlySet<FacilityCategory> = new Set<FacilityCategory>(['地铁', '公交']);

/** Same facility by name: equal names, one containing the other, or the same station. */
function sameName(a: Poi, b: Poi): boolean {
  const na = normalizeName(a.name);
  const nb = normalizeName(b.name);
  if (na === nb) return true;
  if (Math.min(na.length, nb.length) >= 4 && (na.includes(nb) || nb.includes(na))) return true;
  return TRANSIT.has(a.cat) && stationKey(a.name) === stationKey(b.name);
}

/**
 * The rows of the 民生设施 union as POIs: cleaned like every other search, restricted to the union's
 * categories (a pharmacy or school it returns belongs to the checked inventory, which has its own
 * completeness bookkeeping), and without facilities `existing` already holds — same uid, or the same
 * category and name within LIVELIHOOD_DEDUPE_M (STATION_DEDUPE_M for stations).
 */
export function livelihoodPois(
  rows: readonly PlacePoi[],
  existing: readonly Poi[],
  frame: LocalFrame,
): { pois: Poi[]; dropped: DroppedPoi[] } {
  const cleaned = cleanPois(rows.map(toPlaceResult), { project: frame.toXY });
  const dropped = cleaned.dropped.slice();
  const known = new Set(existing.flatMap((p) => [p.uid, ...(p.merged_uids ?? [])]));
  const pois: Poi[] = [];
  for (const p of cleaned.pois) {
    if (!LIVELIHOOD_CATEGORIES.includes(p.cat)) {
      dropped.push({ uid: p.uid, name: p.name, reason: `category:${p.cat}` });
      continue;
    }
    if ([p.uid, ...(p.merged_uids ?? [])].some((u) => known.has(u))) {
      dropped.push({ uid: p.uid, name: p.name, reason: 'duplicate:known' });
      continue;
    }
    const reach = TRANSIT.has(p.cat) ? STATION_DEDUPE_M : LIVELIHOOD_DEDUPE_M;
    const twin = existing.find(
      (e) =>
        e.cat === p.cat &&
        !e.stall_of &&
        Math.hypot(e.xy[0] - p.xy[0], e.xy[1] - p.xy[1]) <= reach &&
        sameName(e, p),
    );
    if (twin) {
      dropped.push({ uid: p.uid, name: p.name, reason: `duplicate:name ${twin.uid}` });
      continue;
    }
    pois.push(p);
  }
  return { pois, dropped };
}

export interface LivelihoodSearch {
  pois: Poi[];
  dropped: DroppedPoi[];
  rows: PlacePoi[];
  inventory: Inventory;
  query: PlaceQueryLog;
}

/**
 * One "$" union of the 民生设施 within LIVELIHOOD_RADIUS_M, with whatever the `livelihood` budget line
 * allows (at most LIVELIHOOD_PAGES). Optional: null without budget, or with a warning when Baidu fails
 * transiently; key, permission and quota errors still end the run.
 */
export async function searchLivelihood(args: {
  meter: Meter;
  client: EngineClient;
  center: LngLat;
  frame: LocalFrame;
  /** The inventory so far (hard categories after the official lists): never counted twice. */
  existing: readonly Poi[];
  warn: (message: string) => void;
}): Promise<LivelihoodSearch | null> {
  const { meter, client, center, frame } = args;
  const pages = meter.room('livelihood');
  if (pages < 1) return null;
  let r: PlaceSearchResult;
  try {
    r = await meter.run(
      'livelihood',
      pages,
      (o) =>
        client.placeAround(LIVELIHOOD_KEYWORDS, center, {
          ...o,
          radius: LIVELIHOOD_RADIUS_M,
          maxPages: pages,
          pageSize: PLACE_PAGE_SIZE,
        }),
      (res) => res.apiCalls,
      (res) => res.pages,
    );
  } catch (err) {
    if (!isDegradable(err)) throw err;
    args.warn(
      `养老、地铁、公园、超市、公交检索失败，圈内设施统计只含逐小区检查的设施等已检索的类别：${describeError(err)}`,
    );
    return null;
  }
  const distOf = (p: PlacePoi) => Math.hypot(...frame.toXY(p.location[0], p.location[1]));
  const inventory: Inventory = Object.fromEntries(
    inventoryOf(LIVELIHOOD_GROUPS, r, distOf, LIVELIHOOD_RADIUS_M),
  );
  const { pois, dropped } = livelihoodPois(r.pois, args.existing, frame);
  return {
    pois,
    dropped,
    rows: r.pois,
    inventory,
    query: {
      keywords: LIVELIHOOD_KEYWORDS.join('$'),
      max_pages: pages,
      pages: r.pages,
      billed: r.apiCalls,
      total: r.total,
      complete: r.complete,
      capped: r.capped,
    },
  };
}

export const COUNTED_CATEGORIES: readonly FacilityCategory[] = [
  '幼儿园',
  '小学',
  '菜市场',
  '生鲜超市',
  '药店',
  '社区卫生',
  ...LIVELIHOOD_CATEGORIES,
];

/** Distinct facilities per category: stalls fold into their market, dropped POIs never count. */
export function facilityCounts(pois: readonly Poi[]): Record<string, number> {
  return Object.fromEntries(COUNTED_CATEGORIES.map((c) => [c, countFacilities(pois, c)]));
}
