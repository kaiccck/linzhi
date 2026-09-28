/**
 * Service-gap check of the live mode (技术设计文档 §7.2–7.4) on core's coverage functions:
 *
 *   loop  planCoverageRound per category (the k nearest open candidates within the rule; covered points
 *         and points with nothing in range get nothing more) → planMatrixBatches (≤ 50 routes, no route
 *         nobody asked for) → routematrix, within the coverage budget
 *   then  mergeMatrixResults per category → four-state checks → 灰色区域
 */
import type { RouteMatrix } from '@zoudedao/baidu';
import {
  gapCount,
  grayAreaPolygons,
  HARD_CATEGORIES,
  mergeMatrixResults,
  planCoverageRound,
  planMatrixBatches,
  statusRaster,
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
  step: 'seed' | 'refine' | 'coverage' | 'siting',
  origins: readonly LngLat[],
  destinations: readonly LngLat[],
) => Promise<RouteMatrix>;

export interface LiveCommunity extends Community {
  /** Baidu uid of the compound. */
  uid?: string;
  /** Where `centroid` comes from: the navi entrance, a gate POI, or the POI point. */
  gate: GateSource;
}

export interface CoverageOutcome {
  communities: LiveCommunity[];
  gray_areas: GrayArea[];
  rounds: number;
  /** Routes a round wanted but the budget did not allow. */
  budget_limited: boolean;
  failed_cells: number;
  /** Non-covered checks left unverified because the facility list may be incomplete that far out. */
  unverified_by_inventory: number;
}

const RANK: Record<CheckStatus, number> = { 盲区: 0, 伪覆盖: 1, 临界: 2, 覆盖: 3 };

export async function runCoverage(args: {
  meter: Meter;
  frame: LocalFrame;
  matrix: MatrixFn;
  demand: readonly DemandSite[];
  facilities: Readonly<Record<HardCategory, readonly Poi[]>>;
  rule: Readonly<Record<HardCategory, number>>;
  /** Distance from the centre within which each category's facilities are all known. */
  knownRadius: Readonly<Record<HardCategory, number>>;
  onRound?: (round: number, routes: number) => void;
  warn?: (message: string) => void;
}): Promise<CoverageOutcome> {
  const { meter, frame, matrix, demand, facilities, rule } = args;
  const points: DemandPoint[] = demand.map((d) => ({ id: d.id, name: d.name, xy: d.xy }));
  const site = new Map(demand.map((d) => [d.id, d]));
  const routes: RoutedPair[] = [];
  let rounds = 0;
  let budgetLimited = false;
  let failed = 0;

  for (let round = 1; round <= COVERAGE_MAX_ROUNDS && points.length; round++) {
    const want = new Map<string, OdDestination[]>();
    for (const cat of HARD_CATEGORIES) {
      const w = planCoverageRound(points, { [cat]: facilities[cat] }, routes, {
        rule_m: rule[cat],
        k: COVERAGE_K,
      });
      for (const [id, dests] of w) {
        const list = want.get(id) ?? [];
        for (const d of dests) if (!list.some((x) => x.id === d.id)) list.push(d);
        want.set(id, list);
      }
    }
    if (!want.size) break;
    let room = meter.room('coverage');
    const chosen: OdBatch<DemandPoint, OdDestination>[] = [];
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
    for (const b of chosen) {
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
        args.warn?.(`盲区判定有一批路线失败，涉及的判定按未核实处理：${describeError(err)}`);
        continue;
      }
      b.origins.forEach((o, i) =>
        b.destinations.forEach((d, j) => {
          const cell = m.cells[i]?.[j];
          // a failed cell proves nothing; leaving it out lets the next round ask again
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
    }
  }

  let unverifiedByInventory = 0;
  const checks = {} as Record<HardCategory, Map<string, FacilityCheck>>;
  for (const cat of HARD_CATEGORIES) {
    const merged = mergeMatrixResults(points, facilities[cat], routes, {
      rule_m: rule[cat],
      speed: WALK_SPEED,
    });
    for (const d of demand) {
      const c = merged.get(d.id);
      // a gap is only proven if every facility that could serve the point was in the search results
      if (c && c.verified && c.status_main !== '覆盖' && d.straight_m + rule[cat] > args.knownRadius[cat]) {
        c.verified = false;
        unverifiedByInventory++;
      }
    }
    checks[cat] = merged;
  }

  const communities: LiveCommunity[] = demand.map((d) => {
    const c = Object.fromEntries(HARD_CATEGORIES.map((cat) => [cat, checks[cat].get(d.id)!])) as Record<
      HardCategory,
      FacilityCheck
    >;
    const out: LiveCommunity = { name: d.name, pts: [], centroid: d.xy, checks: c, gate: d.gate };
    const worst = worstStatus(Object.values(c));
    if (worst) out.worst_status = worst;
    if (d.uid) out.uid = d.uid;
    return out;
  });

  const status = communities.map((c) => ({ xy: c.centroid, ...gapCount(c.checks) }));
  const gray_areas = status.length
    ? grayAreaPolygons(statusRaster(status, { cell_m: GRAY_CELL_M, maxDist_m: GRAY_REACH_M }))
    : [];

  return {
    communities,
    gray_areas,
    rounds,
    budget_limited: budgetLimited,
    failed_cells: failed,
    unverified_by_inventory: unverifiedByInventory,
  };
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

/** Same shape as stats.community_status_counts of the samples. */
export function statusCounts(communities: readonly Community[]) {
  const zero = (): Record<CheckStatus, number> => ({ 覆盖: 0, 临界: 0, 伪覆盖: 0, 盲区: 0 });
  const all = zero();
  const main = { 覆盖: 0, 伪覆盖: 0, 盲区: 0 };
  const by_category = Object.fromEntries(HARD_CATEGORIES.map((c) => [c, zero()])) as Record<
    HardCategory,
    Record<CheckStatus, number>
  >;
  let unverified = 0;
  let upper = 0;
  let total = 0;
  for (const c of communities) {
    for (const cat of HARD_CATEGORIES) {
      const k = c.checks[cat];
      all[k.status]++;
      main[k.status_main]++;
      by_category[cat][k.status]++;
      if (!k.verified) unverified++;
      if (k.route_upper_bound) upper++;
      total++;
    }
  }
  return { ...all, main, by_category, unverified, route_upper_bound: upper, total };
}
