/**
 * 买菜替代 of the live mode (core fresh.ts): for every 菜市场 check that is a verified gap (伪覆盖 or
 * 盲区), the nearest shop within the rule on foot where vegetables can be bought. Informational only:
 * the checks' verdicts, the 灰色区域, the siting and every count stay as they are.
 *
 *   search  only when some 菜市场 check is a gap: one place query at the facility radius for the shops
 *           the rule counts (FRESH_KEYWORDS, the scarce produce keywords first, so the page limit only
 *           trims the far tail of 超市), within the `fresh` budget line. Its rows are cleaned together
 *           with the earlier searches' (a produce shop those dropped for want of a category counts too)
 *           and join the POIs already found, never twice (uid, merged uids, same name within 30 m).
 *   route   the k nearest candidates within the rule of every gap (core planFreshAlternatives; markets
 *           and their stalls left out, the exclusions applied), routes already measured reused, whole
 *           batches while the coverage budget lasts
 *   pick    core mergeFreshAlternatives → checks.菜市场.alt: the shortest walk within the rule; null when the nearest were routed and none qualifies; absent when a batch
 *           did not fit the budget or failed, or when the candidate list may miss a nearer shop that far
 *           out (the search's page limit cut the 超市 short of the gap's rule disk)
 */
import type { PlacePoi, PlaceSearchResult, RouteMatrix } from '@zoudedao/baidu';
import {
  cleanPois,
  FRESH_ALT_K,
  freshCandidates,
  mergeFreshAlternatives,
  normalizeName,
  planFreshAlternatives,
  planMatrixBatches,
  TASK_RULE_M,
  type Community,
  type DemandPoint,
  type FacilityExclusion,
  type FreshAlternative,
  type FreshCandidate,
  type LngLat,
  type LocalFrame,
  type OdBatch,
  type OdDestination,
  type Poi,
  type RoutedPair,
} from '@zoudedao/core';

import { PLACE_PAGE_SIZE, WALK_SPEED } from './constants.js';
import type { CheckSet, MatrixFn } from './coverage.js';
import { describeError, isDegradable } from './errors.js';
import { inventoryOf, toPlaceResult, type FacilityGroup, type PlaceQueryLog } from './facilities.js';
import type { Meter } from './meter.js';
import type { DemandSite } from './residential.js';
import type { EngineClient } from './types.js';

/**
 * Keyword groups of the 买菜替代 search, scarcest first: a "$" union answers group by group, so the
 * page limit only trims the far tail of the abundant 超市 (Baidu files 生鲜超市 under 超市 too). 生鲜
 * reaches produce stores named so (清美生鲜, 谊品生鲜) whatever Baidu tags them; the restaurants and
 * butchers it brings too are no 买菜替代 (core freshKind).
 */
export const FRESH_GROUPS: readonly FacilityGroup[] = [
  { key: '果蔬店', keywords: ['蔬菜', '果蔬', '生鲜'] },
  { key: '超市', keywords: ['超市'] },
];

export const FRESH_KEYWORDS: readonly string[] = FRESH_GROUPS.flatMap((g) => g.keywords);

/** A new row with the name of a POI already found is that POI when this close (cleanPois' rule). */
const TWIN_M = 30;

/** 菜市场 checks and their 买菜替代 (stats.fresh_alternatives). */
export interface FreshCounts {
  /** 菜市场 checks that are a verified gap (伪覆盖 or 盲区). */
  gaps: number;
  /** Of those, with a 买菜替代 (`alt` set). */
  with_alt: number;
  /** Looked, no shop within the rule on foot (`alt: null`). */
  none: number;
  /** Not looked (no `alt`): budget, a failed request, or a candidate list that may be incomplete that far out. */
  not_looked: number;
}

export interface FreshOutcome {
  counts: FreshCounts;
  /** The place search, when it ran. */
  query: PlaceQueryLog | null;
  /**
   * Distance from the centre within which the candidate list is complete: the facility radius when the
   * search came back complete, less when its pages ran out, 0 without the search.
   */
  known_m: number;
  /** Distinct candidate shops. */
  candidates: number;
  /** Routes this step asked for, cached or not (the rest came from the coverage check). */
  routes: number;
  /** Batches the coverage budget could not fit: those gaps got no `alt`. */
  budget_limited: boolean;
  failed_cells: number;
}

const zero = (): FreshCounts => ({ gaps: 0, with_alt: 0, none: 0, not_looked: 0 });

/** A market of the POIs as a place row tagged 菜市场, whatever source or list made it one. */
function marketRow(p: Poi, frame: LocalFrame): PlacePoi {
  return {
    uid: p.uid,
    name: p.name,
    location: frame.toLngLat(p.xy[0], p.xy[1]),
    naviLocation: p.navi_xy ? frame.toLngLat(p.navi_xy[0], p.navi_xy[1]) : null,
    address: null,
    province: null,
    city: null,
    area: null,
    town: null,
    townCode: null,
    telephone: null,
    tag: '购物;农贸市场;菜市场',
    classifiedTag: '购物;农贸市场;菜市场',
    type: null,
    label: null,
    brand: null,
    distanceM: null,
    parentId: null,
    children: [],
    extra: {},
  };
}

/**
 * The POIs plus the shops only the rows know: `rows` cleaned with keepOther (a 水果店 named 生鲜蔬果 has
 * no facility category of its own), without what `pois` holds already. The POIs' markets are cleaned
 * with them, so a produce stall within 60 m of one is its stall (cleanPois) even where only an official
 * list made it a market.
 */
export function freshPool(pois: readonly Poi[], rows: readonly PlacePoi[], frame: LocalFrame): Poi[] {
  if (!rows.length) return pois.slice();
  const markets = pois.filter((p) => p.cat === '菜市场' && !p.stall_of).map((p) => marketRow(p, frame));
  const cleaned = cleanPois([...markets, ...rows].map(toPlaceResult), {
    project: frame.toXY,
    keepOther: true,
  }).pois;
  const known = new Set(pois.flatMap((p) => [p.uid, ...(p.merged_uids ?? [])]));
  const names = pois.map((p) => ({ key: normalizeName(p.name), xy: p.xy }));
  const extra = cleaned.filter((p) => {
    if ([p.uid, ...(p.merged_uids ?? [])].some((u) => known.has(u))) return false;
    const key = normalizeName(p.name);
    return !names.some((n) => n.key === key && Math.hypot(n.xy[0] - p.xy[0], n.xy[1] - p.xy[1]) <= TWIN_M);
  });
  return [...pois, ...extra];
}

/** Gap points: communities whose 菜市场 check is a verified 伪覆盖 or 盲区. */
function gapPoints(demand: readonly DemandSite[], byName: ReadonlyMap<string, Community>): DemandPoint[] {
  return demand
    .filter((d) => {
      const k = byName.get(d.name)?.checks['菜市场'];
      return !!k && k.verified !== false && k.status_main !== '覆盖';
    })
    .map((d) => ({ id: d.id, name: d.name, xy: d.xy }));
}

export async function runFreshAlternatives(args: {
  meter: Meter;
  client: EngineClient;
  center: LngLat;
  frame: LocalFrame;
  matrix: MatrixFn;
  /** The facility radius: the search reaches every shop within the rule of any gap. */
  radius_m: number;
  demand: readonly DemandSite[];
  /** Communities of the coverage check: `alt` is set on their 菜市场 checks in place. */
  communities: readonly Community[];
  pois: readonly Poi[];
  /** Rows of the earlier searches, cleaned again with the new ones. */
  rows: readonly PlacePoi[];
  set: CheckSet;
  /** Routes the coverage check measured (gate → facility uid), reused. */
  routes: readonly RoutedPair[];
  exclusions: readonly FacilityExclusion[];
  /** Before the search spends anything: the gap communities. */
  onSearch?: (gaps: number) => void;
  /** Before the routes are asked for. */
  onRoutes?: (routes: number) => void;
  warn?: (message: string) => void;
}): Promise<FreshOutcome> {
  const { meter, frame, set } = args;
  const byName = new Map(args.communities.map((c) => [c.name, c]));
  const gaps = gapPoints(args.demand, byName);
  const out: FreshOutcome = {
    counts: zero(),
    query: null,
    known_m: 0,
    candidates: 0,
    routes: 0,
    budget_limited: false,
    failed_cells: 0,
  };
  if (!gaps.length) return out;

  // search: the shops the earlier searches may have missed, within the facility radius. Without it the
  // list is complete nowhere (known 0): a gap may still get a shop, never a null
  args.onSearch?.(gaps.length);
  let rows: PlacePoi[] = [];
  let known = 0;
  const pages = meter.room('fresh');
  if (pages >= 1) {
    try {
      const r: PlaceSearchResult = await meter.run(
        'fresh',
        pages,
        (o) =>
          args.client.placeAround(FRESH_KEYWORDS, args.center, {
            ...o,
            radius: args.radius_m,
            maxPages: pages,
            pageSize: PLACE_PAGE_SIZE,
          }),
        (res) => res.apiCalls,
        (res) => res.pages,
      );
      rows = r.pois;
      // complete groups prove the list everywhere; a group the page limit cut, out to its last row
      const distOf = (p: PlacePoi) => Math.hypot(...frame.toXY(p.location[0], p.location[1]));
      known = Infinity;
      for (const info of inventoryOf(FRESH_GROUPS, r, distOf, args.radius_m).values()) {
        known = Math.min(known, info.complete ? Infinity : info.radius_m);
      }
      out.known_m = Number.isFinite(known) ? known : args.radius_m;
      out.query = {
        keywords: FRESH_KEYWORDS.join('$'),
        max_pages: pages,
        pages: r.pages,
        billed: r.apiCalls,
        total: r.total,
        complete: r.complete,
        capped: r.capped,
      };
    } catch (err) {
      if (!isDegradable(err)) throw err;
      args.warn?.(
        `买菜替代检索失败，只用已找到的超市和生鲜超市，没找到替代的菜市场缺口不下“没有替代”的结论：${describeError(err)}`,
      );
    }
  }
  const pool = freshPool(args.pois, [...args.rows, ...rows], frame);
  const candidates: FreshCandidate[] = freshCandidates(pool, { exclusions: args.exclusions });
  out.candidates = new Set(candidates.map((c) => c.poi.uid)).size;

  // route: the k nearest within the rule of every gap, whole batches while the coverage budget lasts
  const routes: RoutedPair[] = args.routes.slice();
  const site = new Map(args.demand.map((d) => [d.id, d]));
  const measure = async (b: OdBatch<DemandPoint, OdDestination>): Promise<boolean> => {
    let m: RouteMatrix;
    try {
      m = await args.matrix(
        'coverage',
        b.origins.map((o) => site.get(o.id)!.bd09),
        b.destinations.map((d) => frame.toLngLat(d.xy[0], d.xy[1])),
      );
    } catch (err) {
      if (!isDegradable(err)) throw err;
      out.failed_cells += b.routes;
      args.warn?.(`买菜替代有一批路线失败，涉及的小区不给出替代：${describeError(err)}`);
      return false;
    }
    b.origins.forEach((o, i) =>
      b.destinations.forEach((d, j) => {
        const cell = m.cells[i]?.[j];
        // a failed cell proves nothing: the pair stays unrouted, the gap without `alt`
        if (!cell || cell.status === 'failed') {
          out.failed_cells++;
          return;
        }
        const ok = cell.status === 'ok';
        routes.push({
          origin_id: o.id,
          dest_id: d.id,
          route_m: ok ? cell.distanceM : null,
          dur_s: ok ? cell.durationS : null,
        });
      }),
    );
    return true;
  };
  const rule_m = set.rule['菜市场'] ?? TASK_RULE_M['菜市场'];
  const want = planFreshAlternatives(gaps, candidates, routes, { rule_m, k: FRESH_ALT_K });
  if (want.size) {
    let room = meter.room('coverage');
    const chosen: OdBatch<DemandPoint, OdDestination>[] = [];
    for (const b of planMatrixBatches(gaps, want)) {
      if (b.routes > room) {
        out.budget_limited = true;
        continue;
      }
      chosen.push(b);
      room -= b.routes;
    }
    if (chosen.length) {
      args.onRoutes?.(chosen.reduce((n, b) => n + b.routes, 0));
      for (const b of chosen) if (await measure(b)) out.routes += b.routes;
    }
  }

  // pick: the shortest walk within the rule, or null, per gap
  const alts = mergeFreshAlternatives(gaps, candidates, routes, {
    rule_m,
    k: FRESH_ALT_K,
    known_m: known,
    speed: WALK_SPEED,
  });
  for (const p of gaps) {
    out.counts.gaps++;
    const check = byName.get(p.name ?? p.id)?.checks['菜市场'];
    if (!check || !alts.has(p.id)) {
      out.counts.not_looked++;
      continue;
    }
    const alt: FreshAlternative | null = alts.get(p.id)!;
    check.alt = alt;
    if (alt) out.counts.with_alt++;
    else out.counts.none++;
  }
  return out;
}
