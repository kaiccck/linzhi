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
  acceptedCategories,
  cleanPois,
  countFacilities,
  type BaiduPlaceResult,
  type DroppedPoi,
  type FacilityCategory,
  type HardCategory,
  type LngLat,
  type LocalFrame,
  type Poi,
  type RuleSet,
} from '@zoudedao/core';

import { PLACE_PAGE_SIZE } from './constants.js';
import { describeError, EngineError, isDegradable } from './errors.js';
import type { Meter } from './meter.js';
import type { EngineClient } from './types.js';

export type GroupKey = '小学' | '菜市场' | '生鲜超市' | '药店' | '幼儿园';

export interface FacilityGroup {
  key: GroupKey;
  keywords: readonly string[];
}

const GROUPS: Readonly<Record<GroupKey, FacilityGroup>> = {
  小学: { key: '小学', keywords: ['小学'] },
  菜市场: { key: '菜市场', keywords: ['菜市场', '菜场', '农贸市场', '生鲜市场'] },
  生鲜超市: { key: '生鲜超市', keywords: ['生鲜超市'] },
  药店: { key: '药店', keywords: ['药店', '药房'] },
  幼儿园: { key: '幼儿园', keywords: ['幼儿园'] },
};

/** Keyword groups in query order: scarce hard categories first, optional ones when pages are left. */
export function facilityGroups(rules: RuleSet): { required: FacilityGroup[]; optional: FacilityGroup[] } {
  const g = GROUPS;
  // GB 50180 accepts 生鲜超市 for 菜市场 ("菜市场或生鲜超市"), so there it is required
  return rules === 'gb50180'
    ? { required: [g.小学, g.菜市场, g.生鲜超市, g.药店], optional: [g.幼儿园] }
    : { required: [g.小学, g.菜市场, g.药店], optional: [g.生鲜超市, g.幼儿园] };
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
    out.set(g.key, { complete, radius_m: complete ? radius : far, fetched: mine.length });
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
  rules: RuleSet;
  radius_m: number;
  warn: (message: string) => void;
}): Promise<FacilitySearch> {
  const { meter, client, center, frame, rules, radius_m, warn } = args;
  const { required, optional } = facilityGroups(rules);
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
      warn(`生鲜超市、幼儿园检索失败，只统计硬指标设施：${describeError(err)}`);
    }
  }
  const { pois, dropped } = cleanPois(rows.map(toPlaceResult), { project: frame.toXY });
  return { pois, dropped, rows, inventory, queries, radius_m };
}

/**
 * Distance from the centre within which a check category's facilities are all known (Infinity when
 * every accepted group was fetched completely).
 */
export function knownRadius(inventory: Inventory, cat: HardCategory, rules: RuleSet): number {
  let r = Infinity;
  for (const c of acceptedCategories(cat, rules)) {
    const inv = inventory[c as GroupKey];
    r = Math.min(r, inv?.complete ? Infinity : (inv?.radius_m ?? 0));
  }
  return r;
}

export const COUNTED_CATEGORIES: readonly FacilityCategory[] = [
  '小学',
  '菜市场',
  '生鲜超市',
  '药店',
  '幼儿园',
];

/** Distinct facilities per category: stalls fold into their market, dropped POIs never count. */
export function facilityCounts(pois: readonly Poi[]): Record<string, number> {
  return Object.fromEntries(COUNTED_CATEGORIES.map((c) => [c, countFacilities(pois, c)]));
}
