/**
 * Row views of the facility checks: verified gaps sorted by how far residents actually walk, and the
 * pending (待核实) checks with the reason they are not verdicts yet.
 */
import type {
  AnalysisResult,
  FacilityCheck,
  FreshAlternative,
  FreshKind,
  HardCategory,
  MainStatus,
} from '@zoudedao/core';
import { viaName } from '@zoudedao/core';
import { HARD_CATEGORIES, checkRows, isPending, isWalkGap, ruleOf, speedOf } from './analysis.js';
import { round } from './format.js';

/** 买菜替代 of a 菜市场 gap: a shop within the rule on foot that sells vegetables. Not coverage. */
export interface FreshAltRow {
  /** The shop. */
  name: string;
  /** Why it counts: 生鲜超市, 果蔬店 (its tag or name says produce) or 超市 (a chain that sells produce). */
  kind: FreshKind;
  straight_m: number;
  /** Measured walk from the community. */
  route_m: number;
  /** Minutes at the analysis' walking speed. */
  walk_min: number;
}

export interface GapRow {
  community: string;
  category: HardCategory;
  status: Exclude<MainStatus, '覆盖'>;
  /** |route − rule| ≤ 50 m: the verdict depends on the exact entrance, check on site. */
  borderline: boolean;
  rule_m: number;
  straight_m: number;
  /** Nearest facility by straight line. */
  nearest_straight: string | null;
  route_m: number;
  /** routed = measured; lower_bound = nothing within the rule, route_m is the straight lower bound. */
  route_basis: string;
  /** Facility reached by the shortest measured walk. */
  via: string | null;
  excess_m: number;
  /** route / straight. */
  detour_x: number | null;
  /** Minutes at the analysis' walking speed; null when nothing was routed (lower_bound). */
  walk_min: number | null;
  /**
   * 菜市场 gaps only, when the result looked: 买菜替代, the nearest shop within the rule on foot where
   * vegetables can be bought — the gap stays a gap and every count stays; null = none within the rule
   * on foot.
   */
  alt?: FreshAltRow | null;
}

/** The 买菜替代 of a check as a row, minutes at the result's speed. */
export function freshAltRow(alt: FreshAlternative, speed: number): FreshAltRow {
  return {
    name: alt.name,
    kind: alt.kind,
    straight_m: alt.straight_m,
    route_m: alt.route_m,
    walk_min: round(alt.route_m / speed / 60, 1),
  };
}

/** A verified check that is walkable within the rule. */
export interface CoveredRow {
  community: string;
  category: HardCategory;
  borderline: boolean;
  rule_m: number;
  straight_m: number;
  route_m: number;
  via: string | null;
  walk_min: number;
}

export interface PendingRow {
  community: string;
  category: HardCategory;
  /** What the check would say if it were verified; not a verdict. */
  tentative_status: MainStatus;
  straight_m: number;
  route_m: number;
  route_basis: string;
  reason: string;
  unrouted_nearer: { name: string; straight_m: number }[];
}

export interface RowFilter {
  category?: HardCategory;
  status?: '伪覆盖' | '盲区' | '临界';
  /** Exact community name. */
  community?: string;
}

const keep = (filter: RowFilter, community: string, category: HardCategory) =>
  (!filter.category || category === filter.category) && (!filter.community || community === filter.community);

function basis(c: FacilityCheck): string {
  return c.route_basis ?? 'routed';
}

/** Verified gaps, longest walk first. */
export function gapRows(result: AnalysisResult, filter: RowFilter = {}): GapRow[] {
  const speed = speedOf(result);
  return checkRows(result)
    .filter((r) => keep(filter, r.community.name, r.category) && isWalkGap(r.check))
    .filter((r) => {
      if (!filter.status) return true;
      if (filter.status === '临界') return r.check.borderline;
      return r.check.status_main === filter.status;
    })
    .map(({ community, category, check }) => {
      const rule = ruleOf(result, category);
      return {
        community: community.name,
        category,
        status: check.status_main as GapRow['status'],
        borderline: check.borderline,
        rule_m: rule,
        straight_m: check.straight_m,
        nearest_straight: check.nearest_straight ?? null,
        route_m: check.route_m,
        route_basis: basis(check),
        via: viaName(check) ?? null,
        excess_m: round(check.route_m - rule, 1),
        detour_x:
          basis(check) !== 'lower_bound' && check.straight_m > 0 && check.route_m > 0
            ? round(check.route_m / check.straight_m, 2)
            : null,
        walk_min: basis(check) === 'lower_bound' ? null : round(check.route_m / speed / 60, 1),
        ...(category === '菜市场' && check.alt !== undefined
          ? { alt: check.alt && freshAltRow(check.alt, speed) }
          : {}),
      };
    })
    .sort((a, b) => b.route_m - a.route_m || b.straight_m - a.straight_m);
}

export function pendingReason(c: FacilityCheck): string {
  if (c.route_basis === 'estimated') return '候选设施还没有从该小区算路，步行距离只是按绕行系数估算';
  if (c.unrouted_nearer?.length) return '有更近的同类设施还没有从该小区算路，实际最短步行可能更短';
  return '该小区的这一项还没有单独算路核实';
}

export function pendingRows(result: AnalysisResult, filter: RowFilter = {}): PendingRow[] {
  return checkRows(result)
    .filter((r) => keep(filter, r.community.name, r.category) && isPending(r.check))
    .map(({ community, category, check }) => ({
      community: community.name,
      category,
      tentative_status: check.status_main,
      straight_m: check.straight_m,
      route_m: check.route_m,
      route_basis: basis(check),
      reason: pendingReason(check),
      unrouted_nearer: (check.unrouted_nearer ?? []).map((u) => ({ name: u.name, straight_m: u.straight_m })),
    }));
}

/** Verified checks within the rule (for questions about one community). */
export function coveredRows(result: AnalysisResult, filter: RowFilter = {}): CoveredRow[] {
  const speed = speedOf(result);
  return checkRows(result)
    .filter(
      (r) =>
        keep(filter, r.community.name, r.category) && !isPending(r.check) && r.check.status_main === '覆盖',
    )
    .map(({ community, category, check }) => ({
      community: community.name,
      category,
      borderline: check.borderline,
      rule_m: ruleOf(result, category),
      straight_m: check.straight_m,
      route_m: check.route_m,
      via: viaName(check) ?? null,
      walk_min: round(check.route_m / speed / 60, 1),
    }));
}

/** One line per community: what "哪些小区都方便" needs, without one call per community. */
export interface CommunityStatusRow {
  community: string;
  /** Verdict per category: 覆盖 / 伪覆盖 / 盲区, or 待核实 (not a verdict yet). */
  status: Partial<Record<HardCategory, MainStatus | '待核实'>>;
  /**
   * Minutes to the facility reached on foot, at the analysis' walking speed; null when the walk was
   * not measured (待核实, or nothing within the rule).
   */
  walk_min: Partial<Record<HardCategory, number | null>>;
}

export function communityStatusRows(result: AnalysisResult, filter: RowFilter = {}): CommunityStatusRow[] {
  const speed = speedOf(result);
  const by = new Map<string, CommunityStatusRow>();
  for (const { community, category, check } of checkRows(result)) {
    if (!keep(filter, community.name, category)) continue;
    const row = by.get(community.name) ?? { community: community.name, status: {}, walk_min: {} };
    const pending = isPending(check);
    row.status[category] = pending ? '待核实' : check.status_main;
    row.walk_min[category] =
      pending || basis(check) !== 'routed' || check.route_m < 0 ? null : round(check.route_m / speed / 60, 1);
    by.set(community.name, row);
  }
  return [...by.values()];
}

/** Communities with at least one verified gap, and which categories they miss. */
export function communitiesWithGaps(
  rows: readonly GapRow[],
): { community: string; missing: HardCategory[] }[] {
  const by = new Map<string, HardCategory[]>();
  for (const r of rows) {
    const list = by.get(r.community) ?? [];
    if (!list.includes(r.category)) list.push(r.category);
    by.set(r.community, list);
  }
  return [...by.entries()].map(([community, missing]) => ({
    community,
    missing: HARD_CATEGORIES.filter((c) => missing.includes(c)),
  }));
}
