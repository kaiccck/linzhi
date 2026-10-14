/**
 * Service-gap check of the live mode (技术设计文档 §7.2–7.4) on core's coverage functions:
 *
 *   loop  planCoverageRound per category (the k nearest open candidates within the rule; covered
 *         points and points with nothing in range get nothing more) → planMatrixBatches (≤ 50 routes,
 *         no route nobody asked for) → routematrix, within the coverage budget
 *   once  planNearestTopUp: the early stop proves a verdict with any walk within the rule, which may
 *         pass a nearer facility never routed; those are routed too, so via / route_m are the nearest
 *         walk (what the budget cannot cover keeps route_upper_bound and unrouted_nearer)
 *   then  mergeMatrixResults per category → four-state checks → 灰色区域
 *
 * Every category the check set lists is checked alike; a set may list fewer than all five (the task's
 * three in older analyses and their tests), and the communities then carry checks of those only.
 */
import type { RouteMatrix } from '@zoudedao/baidu';
import {
  checkedCategories,
  gapCount,
  grayAreaPolygons,
  HARD_CATEGORIES,
  mergeMatrixResults,
  planCoverageRound,
  planMatrixBatches,
  planNearestTopUp,
  statusRaster,
  TASK_RULE_M,
  type CheckStatus,
  type Community,
  type DemandPoint,
  type FacilityCheck,
  type GrayArea,
  type HardCategory,
  type LngLat,
  type LocalFrame,
  type OdBatch,
  type OdDestination,
  type Poi,
  type RoutedPair,
} from '@zoudedao/core';

import { COVERAGE_K, COVERAGE_MAX_ROUNDS, GRAY_CELL_M, GRAY_REACH_M, WALK_SPEED } from './constants.js';
import { describeError, isDegradable } from './errors.js';
import type { Meter } from './meter.js';
import type { DemandSite, GateSource } from './residential.js';

/** Routematrix call of one step: origins × destinations, fatal errors already thrown. */
export type MatrixFn = (
  step: 'seed' | 'refine' | 'coverage' | 'siting' | 'catchment',
  origins: readonly LngLat[],
  destinations: readonly LngLat[],
) => Promise<RouteMatrix>;

export interface LiveCommunity extends Community {
  /** Baidu uid of the compound. */
  uid?: string;
  /** Where `centroid` comes from: the navi entrance, a gate POI, or the POI point. */
  gate: GateSource;
}

/**
 * What the check needs, per checked category: the facilities that answer it (the categories listed
 * here are the ones checked), its distance and how far out its facility list is complete.
 */
export interface CheckSet {
  /** Absent: the task rule (TASK_RULE_M, 1 km). */
  rule: Readonly<Partial<Record<HardCategory, number>>>;
  facilities: Readonly<Partial<Record<HardCategory, readonly Poi[]>>>;
  /**
   * Distance from the centre within which each category's facilities are all known. Absent: nothing is
   * known to be complete, so no gap of that category is ever claimed (it stays unverified).
   */
  knownRadius: Readonly<Partial<Record<HardCategory, number>>>;
}

/** The categories a set checks, in display order: those it lists facilities for. */
export function setCategories(set: Pick<CheckSet, 'facilities'>): HardCategory[] {
  return HARD_CATEGORIES.filter((c) => set.facilities[c] !== undefined);
}

const ruleOf = (set: CheckSet, cat: HardCategory) => set.rule[cat] ?? TASK_RULE_M[cat];

export interface CoverageOutcome {
  communities: LiveCommunity[];
  gray_areas: GrayArea[];
  rounds: number;
  /** Routes a round or the nearest top-up wanted but the budget did not allow. */
  budget_limited: boolean;
  /** Routes the nearest top-up measured, cached or not. */
  nearest_routes: number;
  failed_cells: number;
  /** Non-covered checks left unverified because the facility list may be incomplete that far out. */
  unverified_by_inventory: number;
  /** Every route measured (community gate → facility uid), for reuse by later steps. */
  routes: RoutedPair[];
}

const RANK: Record<CheckStatus, number> = { 盲区: 0, 伪覆盖: 1, 临界: 2, 覆盖: 3 };

function planSet(
  points: readonly DemandPoint[],
  set: CheckSet,
  routes: readonly RoutedPair[],
): Map<string, OdDestination[]> {
  const want = new Map<string, OdDestination[]>();
  for (const cat of setCategories(set)) {
    const w = planCoverageRound(points, { [cat]: set.facilities[cat]! }, routes, {
      rule_m: ruleOf(set, cat),
      k: COVERAGE_K,
    });
    for (const [id, dests] of w) {
      const list = want.get(id) ?? [];
      for (const d of dests) if (!list.some((x) => x.id === d.id)) list.push(d);
      want.set(id, list);
    }
  }
  return want;
}

function mergeSet(
  points: readonly DemandPoint[],
  demand: readonly DemandSite[],
  set: CheckSet,
  routes: readonly RoutedPair[],
): { checks: Partial<Record<HardCategory, Map<string, FacilityCheck>>>; unverified: number } {
  let unverified = 0;
  const checks: Partial<Record<HardCategory, Map<string, FacilityCheck>>> = {};
  for (const cat of setCategories(set)) {
    const rule = ruleOf(set, cat);
    const known = set.knownRadius[cat] ?? 0;
    const merged = mergeMatrixResults(points, set.facilities[cat]!, routes, {
      rule_m: rule,
      speed: WALK_SPEED,
    });
    for (const d of demand) {
      const c = merged.get(d.id);
      // a gap is only proven if every facility that could serve the point was in the search results
      if (c && c.verified && c.status_main !== '覆盖' && d.straight_m + rule > known) {
        c.verified = false;
        unverified++;
      }
    }
    checks[cat] = merged;
  }
  return { checks, unverified };
}

export async function runCoverage(args: {
  meter: Meter;
  frame: LocalFrame;
  matrix: MatrixFn;
  demand: readonly DemandSite[];
  /** communities[].checks, gray areas and siting. */
  set: CheckSet;
  onRound?: (round: number, routes: number) => void;
  /** Before the nearest top-up spends anything. */
  onNearest?: (routes: number) => void;
  warn?: (message: string) => void;
}): Promise<CoverageOutcome> {
  const { meter, frame, matrix, demand, set } = args;
  const categories = setCategories(set);
  const points: DemandPoint[] = demand.map((d) => ({ id: d.id, name: d.name, xy: d.xy }));
  const site = new Map(demand.map((d) => [d.id, d]));
  const routes: RoutedPair[] = [];
  let rounds = 0;
  let budgetLimited = false;
  let failed = 0;
  let nearest = 0;

  /** Routes one batch into `routes`; false when it failed in a way the result can do without. */
  async function measure(b: OdBatch<DemandPoint, OdDestination>, failure: string): Promise<boolean> {
    let m: RouteMatrix;
    try {
      m = await matrix(
        'coverage',
        b.origins.map((o) => site.get(o.id)!.bd09),
        b.destinations.map((d) => frame.toLngLat(d.xy[0], d.xy[1])),
      );
    } catch (err) {
      if (!isDegradable(err)) throw err;
      failed += b.routes;
      args.warn?.(`${failure}：${describeError(err)}`);
      return false;
    }
    b.origins.forEach((o, i) =>
      b.destinations.forEach((d, j) => {
        const cell = m.cells[i]?.[j];
        // a failed cell proves nothing; leaving it out lets a later round ask again
        if (!cell || cell.status === 'failed') {
          failed++;
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
  }

  for (let round = 1; round <= COVERAGE_MAX_ROUNDS && points.length; round++) {
    let room = meter.room('coverage');
    const chosen: OdBatch<DemandPoint, OdDestination>[] = [];
    const want = planSet(points, set, routes);
    if (!want.size) break;
    for (const b of planMatrixBatches(points, want)) {
      if (b.routes <= room) {
        chosen.push(b);
        room -= b.routes;
        continue;
      }
      budgetLimited = true;
      const keep = Math.floor(room / b.origins.length);
      if (keep >= 1) {
        const destinations = b.destinations.slice(0, keep);
        const n = b.origins.length * keep;
        chosen.push({ ...b, destinations, routes: n, wanted: n });
        room -= n;
      }
    }
    if (!chosen.length) break;
    rounds = round;
    args.onRound?.(
      round,
      chosen.reduce((n, b) => n + b.routes, 0),
    );
    for (const b of chosen) await measure(b, '盲区判定有一批路线失败，涉及的判定按未核实处理');
  }

  // nearest top-up: whole batches while the budget lasts; a skipped one only leaves its checks'
  // upper-bound flags standing
  const byCategory = Object.fromEntries(categories.map((cat) => [cat, set.facilities[cat]!]));
  const topUp = planNearestTopUp(points, byCategory, routes);
  if (topUp.size) {
    let room = meter.room('coverage');
    const chosen: OdBatch<DemandPoint, OdDestination>[] = [];
    for (const b of planMatrixBatches(points, topUp)) {
      if (b.routes > room) {
        budgetLimited = true;
        continue;
      }
      chosen.push(b);
      room -= b.routes;
    }
    if (chosen.length) {
      args.onNearest?.(chosen.reduce((n, b) => n + b.routes, 0));
      for (const b of chosen) {
        if (await measure(b, '最近设施补算有一批路线失败，涉及的判定仍按已测路线给出（上界）'))
          nearest += b.routes;
      }
    }
  }

  const main = mergeSet(points, demand, set, routes);

  const communities: LiveCommunity[] = demand.map((d) => {
    // the set's categories only (Community.checks holds what was checked; core checkedCategories)
    const c = Object.fromEntries(categories.map((cat) => [cat, main.checks[cat]!.get(d.id)!])) as Record<
      HardCategory,
      FacilityCheck
    >;
    // centroid is the gate (every walk starts there); label_xy where the compound sits on the map
    const out: LiveCommunity = {
      name: d.name,
      pts: [],
      centroid: d.xy,
      ...(d.label_xy ? { label_xy: d.label_xy } : {}),
      checks: c,
      gate: d.gate,
    };
    const worst = worstStatus(Object.values(c));
    if (worst) out.worst_status = worst;
    if (d.uid) out.uid = d.uid;
    return out;
  });

  const gray_areas = communityGrayAreas(communities);

  return {
    communities,
    gray_areas,
    rounds,
    budget_limited: budgetLimited,
    nearest_routes: nearest,
    failed_cells: failed,
    unverified_by_inventory: main.unverified,
    routes,
  };
}

/** Recompute after policy-school checks replace proximity checks. */
export function communityGrayAreas(communities: readonly Community[]): GrayArea[] {
  const status = communities.map((c) => ({ xy: c.centroid, ...gapCount(c.checks) }));
  return status.length
    ? grayAreaPolygons(statusRaster(status, { cell_m: GRAY_CELL_M, maxDist_m: GRAY_REACH_M }))
    : [];
}

/** Worst verdict among the verified checks (unverified ones are never painted as a verdict). */
export function worstStatus(checks: readonly FacilityCheck[]): CheckStatus | undefined {
  let worst: CheckStatus | undefined;
  for (const c of checks) {
    if (!c.verified) continue;
    if (!worst || RANK[c.status] < RANK[worst]) worst = c.status;
  }
  return worst;
}

/**
 * Same shape as stats.community_status_counts of the samples, over `categories` (default: those the
 * communities were checked for, core checkedCategories); a check a community lacks counts nowhere.
 */
export function statusCounts(
  communities: readonly Community[],
  categories: readonly HardCategory[] = checkedCategories({ communities: [...communities] }),
) {
  const zero = (): Record<CheckStatus, number> => ({ 覆盖: 0, 临界: 0, 伪覆盖: 0, 盲区: 0 });
  const all = zero();
  const main = { 覆盖: 0, 伪覆盖: 0, 盲区: 0 };
  const by_category = Object.fromEntries(categories.map((c) => [c, zero()])) as Partial<
    Record<HardCategory, Record<CheckStatus, number>>
  >;
  let unverified = 0;
  let upper = 0;
  let total = 0;
  for (const c of communities) {
    const checks = c.checks as Partial<Record<HardCategory, FacilityCheck>>;
    for (const cat of categories) {
      const k = checks[cat];
      if (!k) continue;
      if (k.school_assignment && k.school_assignment !== 'confirmed') {
        unverified++;
        total++;
        continue;
      }
      all[k.status]++;
      main[k.status_main]++;
      by_category[cat]![k.status]++;
      if (!k.verified) unverified++;
      if (k.route_upper_bound) upper++;
      total++;
    }
  }
  return { ...all, main, by_category, unverified, route_upper_bound: upper, total };
}
