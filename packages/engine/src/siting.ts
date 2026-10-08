/**
 * Siting suggestions of the live mode (技术设计文档 §7.5): greedy maximal covering over candidate
 * points along the walked routes, coverage estimated with L̂ from the analysis field.
 *
 * core's suggestSites takes a synchronous verification hook, while measuring needs an async Baidu
 * call. So the greedy runs as a pure function over the routes measured so far: whenever one of the top
 * suggestions rests on estimates only, that site is measured (one 1 × |D| routematrix call) and the
 * greedy re-runs — at most MAX_VERIFY_SITES sites per category and within the siting budget. Whatever
 * stays unmeasured keeps verified: false, i.e. an estimate. Every checked category competes for the
 * budget alike (the one with the most gaps first); a category the communities were not checked for
 * gets no suggestion.
 */
import type { RouteMatrix } from '@zoudedao/baidu';
import {
  HARD_CATEGORIES,
  siteCandidatesFromPaths,
  suggestSites,
  type HardCategory,
  type LngLat,
  type LocalFrame,
  type MeasuredRoutes,
  type RouteEstimator,
  type SiteCandidate,
  type SiteSuggestion,
  type SitingDemand,
  type WalkPath,
} from '@zoudedao/core';

import { MAX_SITES, MAX_VERIFY_SITES, SITE_SPACING_M } from './constants.js';
import type { LiveCommunity, MatrixFn } from './coverage.js';
import { describeError, isDegradable } from './errors.js';
import type { Meter } from './meter.js';

const DIRECTIONS = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'] as const;

export function direction8(bearing: number): string {
  return DIRECTIONS[Math.round((((bearing % 360) + 360) % 360) / 45) % 8]!;
}

/** Points every 50 m along the walked routes (they are on walkable streets), with readable labels. */
export function pathCandidates(paths: readonly WalkPath[]): SiteCandidate[] {
  return siteCandidatesFromPaths(paths, SITE_SPACING_M).map((c) => {
    const m = /^path(\d+)@(\d+)m$/.exec(c.id);
    const path = m ? paths[Number(m[1])] : undefined;
    return path && m ? { ...c, label: `${direction8(path.bearing_deg)}向步行路线约 ${m[2]} m 处` } : c;
  });
}

export interface SitingOutcome {
  suggestions: Partial<Record<HardCategory, SiteSuggestion[]>>;
  /** Sites whose coverage was measured. */
  verified_sites: number;
}

export async function runSiting(args: {
  meter: Meter;
  frame: LocalFrame;
  matrix: MatrixFn;
  communities: readonly LiveCommunity[];
  /** Gate of each community by name, BD-09. */
  gates: ReadonlyMap<string, LngLat>;
  paths: readonly WalkPath[];
  rule: Readonly<Record<HardCategory, number>>;
  estimator: RouteEstimator;
  warn?: (message: string) => void;
}): Promise<SitingOutcome> {
  const { meter, frame, matrix, rule, estimator } = args;
  const candidates = pathCandidates(args.paths);
  const suggestions: Partial<Record<HardCategory, SiteSuggestion[]>> = {};
  let verifiedSites = 0;
  if (!candidates.length) return { suggestions, verified_sites: 0 };

  // only proven gaps ask for a new facility; the category with the most gaps gets the budget first
  const gaps = HARD_CATEGORIES.map((cat) => ({
    cat,
    demands: args.communities
      .filter((c) => {
        const k = (c.checks as Partial<LiveCommunity['checks']>)[cat];
        return !!k && k.verified && k.status_main !== '覆盖';
      })
      .map((c): SitingDemand => ({ id: c.name, xy: c.centroid, weight: 1 })),
  }))
    .filter((g) => g.demands.length)
    .sort((a, b) => b.demands.length - a.demands.length);

  for (const { cat, demands } of gaps) {
    const measured = new Map<string, MeasuredRoutes>();
    let list: SiteSuggestion[];
    for (;;) {
      list = suggestSites(candidates, demands, {
        category: cat,
        rule_m: rule[cat],
        maxSites: MAX_SITES,
        estimator,
        verify: (site) => measured.get(site.id),
      });
      if (measured.size >= MAX_VERIFY_SITES) break;
      const next = list.slice(0, MAX_VERIFY_SITES).find((s) => !s.verified && !measured.has(s.site_id));
      if (!next) break;
      const near = demands.filter(
        (d) => Math.hypot(d.xy[0] - next.xy[0], d.xy[1] - next.xy[1]) <= rule[cat] && args.gates.has(d.id),
      );
      if (!near.length || near.length > meter.room('siting')) break;
      const site = candidates.find((c) => c.id === next.site_id)!;
      let m: RouteMatrix;
      try {
        m = await matrix(
          'siting',
          [frame.toLngLat(site.xy[0], site.xy[1])],
          near.map((d) => args.gates.get(d.id)!),
        );
      } catch (err) {
        if (!isDegradable(err)) throw err;
        args.warn?.(`${cat}选址建议核验失败，保留估算结果：${describeError(err)}`);
        break;
      }
      const routes: Record<string, number | null> = {};
      near.forEach((d, j) => {
        const cell = m.cells[0]?.[j];
        if (!cell || cell.status === 'failed') return; // unknown: that demand keeps its estimate
        routes[d.id] = cell.status === 'ok' ? cell.distanceM : null;
      });
      measured.set(site.id, routes);
      verifiedSites++;
    }
    suggestions[cat] = list;
  }
  return { suggestions, verified_sites: verifiedSites };
}
