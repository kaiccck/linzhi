/**
 * Browser-found POIs (POST /api/analyze `browser_pois`). place/v3/around omits POIs Baidu has: around
 * 万科翡翠公园 it never returned 盒马鲜生(陆悦天地店) 546 m away, 火星荟森生鲜 627 m or 联华超市(川和路店)
 * 38 m, not even for single keywords, while the browser JSAPI's LocalSearch.searchNearby lists them and
 * place/v3/detail returns their full records (measured 2026-09-29). The browser's rows have no tags,
 * so they decide nothing themselves:
 *
 *   pick     uids the searches did not return (uid or merged uids), not curated out, within the facility
 *            radius; the scarce keywords first (小学, markets, pharmacies, produce, then 超市), nearest
 *            first, as many as the `detail` budget line allows (10 uids a request, asked in uid order)
 *   detail   place/v3/detail (scope 2): classified tag, entrance, parent_id, address
 *   clean    the detail rows join the search rows and everything is cleaned again (core cleanPois:
 *            categories, blacklists, stalls, duplicates), so tags decide: a restaurant, a fruit shop or
 *            a tea shop the browser listed under 生鲜 has no category and goes; official lists, the
 *            curated exclusions (前置仓 of online grocers) and the 买菜替代 pool see them like any row
 */
import { PLACE_DETAIL_MAX_UIDS, type PlacePoi } from '@zoudedao/baidu';
import {
  cleanPois,
  excludedByPattern,
  type FacilityCategory,
  type FacilityExclusion,
  type LocalFrame,
} from '@zoudedao/core';

import { LIVELIHOOD_RADIUS_M } from './constants.js';
import { describeError, isDegradable } from './errors.js';
import { LIVELIHOOD_CATEGORIES, toPlaceResult, type FacilitySearch } from './facilities.js';
import type { Meter } from './meter.js';
import type { BrowserPoi, EngineClient } from './types.js';

/** Keywords of the browser search, scarcest first: a short budget details these first. */
export const BROWSER_KEYWORDS: readonly string[] = [
  '小学',
  '菜市场',
  '菜场',
  '农贸市场',
  '生鲜市场',
  '生鲜超市',
  '药店',
  '药房',
  '蔬菜',
  '果蔬',
  '生鲜',
  '超市',
];

/** stats.browser_pois. */
export interface BrowserPoiStats {
  /** Valid items of the request. */
  offered: number;
  /** Not returned by the searches, not curated out, within the facility radius. */
  new: number;
  /** Rows place/v3/detail returned. */
  detailed: number;
  /** Of those, POIs in the result (`found_by: 'jsapi'`), after cleaning, fusion and exclusions. */
  kept: number;
  /** Some new ones were not detailed: the `detail` line (or the day's place quota) ran out. */
  budget_limited: boolean;
}

export interface BrowserDetail {
  /** The detail rows within the facility radius. */
  rows: PlacePoi[];
  stats: BrowserPoiStats;
}

const rank = (p: BrowserPoi) => {
  const i = BROWSER_KEYWORDS.indexOf(p.keyword);
  return i < 0 ? BROWSER_KEYWORDS.length : i;
};

/**
 * Details the new browser POIs within the `detail` budget line. Optional: without new ones, budget or
 * a client that can detail nothing is asked; a transient Baidu failure is a warning, a key, permission
 * or quota error still ends the run.
 */
export async function detailBrowserPois(args: {
  meter: Meter;
  client: EngineClient;
  frame: LocalFrame;
  radius_m: number;
  offered: readonly BrowserPoi[];
  /** uids the searches returned, merged duplicates included. */
  known: ReadonlySet<string>;
  exclusions: readonly FacilityExclusion[];
  /** Before the detail requests: new POIs, and how many of them the budget lets the run detail. */
  onDetail?: (fresh: number, asked: number) => void;
  warn: (message: string) => void;
}): Promise<BrowserDetail> {
  const { meter, frame, radius_m } = args;
  const excludedUids = new Set(args.exclusions.flatMap((x) => (x.uid ? [x.uid] : [])));
  const distOf = (p: readonly [number, number]) => Math.hypot(...frame.toXY(p[0], p[1]));
  const fresh = args.offered
    .filter(
      (p) =>
        !args.known.has(p.uid) &&
        !excludedUids.has(p.uid) &&
        !excludedByPattern(p.name, args.exclusions) &&
        distOf(p.bd09) <= radius_m,
    )
    .sort((a, b) => rank(a) - rank(b) || distOf(a.bd09) - distOf(b.bd09));
  const stats: BrowserPoiStats = {
    offered: args.offered.length,
    new: fresh.length,
    detailed: 0,
    kept: 0,
    budget_limited: false,
  };
  const out: BrowserDetail = { rows: [], stats };
  const detail = args.client.placeDetail?.bind(args.client);
  if (!fresh.length || !detail) return out;
  const calls = Math.min(meter.room('detail'), Math.ceil(fresh.length / PLACE_DETAIL_MAX_UIDS));
  // which ones by priority; asked in uid order, so the same set is the same cached requests whatever
  // order the browser listed them in
  const uids = fresh
    .slice(0, calls * PLACE_DETAIL_MAX_UIDS)
    .map((p) => p.uid)
    .sort();
  if (uids.length < fresh.length) {
    stats.budget_limited = true;
    args.warn(
      calls
        ? `地图前端找到 ${fresh.length} 处服务端检索没有返回的设施，详情查询预算只够其中 ${uids.length} 处（小学、菜市场、药店优先，同类按距离）`
        : `地图前端找到 ${fresh.length} 处服务端检索没有返回的设施，本次没有详情查询预算，设施清单只用服务端检索结果`,
    );
  }
  if (!uids.length) return out;
  args.onDetail?.(fresh.length, uids.length);
  try {
    const r = await meter.run(
      'detail',
      calls,
      (o) => detail(uids, o),
      (res) => res.apiCalls,
      (res) => res.requests,
    );
    out.rows = r.pois.filter((p) => distOf(p.location) <= radius_m);
    stats.detailed = r.pois.length;
  } catch (err) {
    if (!isDegradable(err)) throw err;
    args.warn(`地图前端找到的设施查询详情失败，设施清单只用服务端检索结果：${describeError(err)}`);
  }
  return out;
}

/**
 * The facility search with the detail rows cleaned in: every row cleaned again together (a browser
 * row may be a duplicate or a stall of a search row, and the other way round). A POI only a browser
 * row made carries `found_by: 'jsapi'`. A 超市 or another 民生设施 the browser found counts within the
 * 民生设施 radius only, like the union that searches for them; farther out its row still reaches the
 * 买菜替代 pool.
 */
export function withBrowserRows(
  fac: FacilitySearch,
  rows: readonly PlacePoi[],
  frame: LocalFrame,
): FacilitySearch {
  if (!rows.length) return fac;
  const searched = new Set(fac.rows.flatMap((r) => (r.uid ? [r.uid] : [])));
  const added = rows.filter((r) => r.uid && !searched.has(r.uid));
  if (!added.length) return fac;
  const browser = new Set(added.map((r) => r.uid!));
  const all = [...fac.rows, ...added];
  const cleaned = cleanPois(all.map(toPlaceResult), { project: frame.toXY });
  const dropped = cleaned.dropped.slice();
  const counted: readonly FacilityCategory[] = LIVELIHOOD_CATEGORIES;
  const pois = cleaned.pois.filter((p) => {
    const mine = browser.has(p.uid) && !(p.merged_uids ?? []).some((u) => searched.has(u));
    if (!mine) return true;
    if (counted.includes(p.cat) && (p.straight_m ?? 0) > LIVELIHOOD_RADIUS_M) {
      dropped.push({ uid: p.uid, name: p.name, reason: `browser:beyond ${LIVELIHOOD_RADIUS_M} m` });
      return false;
    }
    p.found_by = 'jsapi';
    return true;
  });
  return { ...fac, pois, dropped, rows: all };
}
