/**
 * 规划 — where adding a facility would bring units within the rule on foot.
 *  - Suggestions come with the analysis (`site_suggestions`, the engine's greedy covering, task rule).
 *  - 假如在这里开一家…: a site the planner places is estimated right here, with @zoudedao/core's
 *    siteCoverage and the analysis' own detour field (fieldEstimator over its samples) — no API call,
 *    so it is always labelled 估算 until 实测核验 measures it (POST /api/whatif).
 */
import {
  fieldEstimator,
  isVisible,
  rhoSamplesOf,
  siteCandidatesFromPaths,
  siteCoverage,
  suggestSites,
  type AnalysisResult,
  type BarrierSegment,
  type HardCategory,
  type RouteEstimator,
  type SiteSuggestion,
  type XY,
} from '@zoudedao/core';
import { CATS, type Model, type Unit } from './derive.js';

export interface SitePin {
  key: string;
  cat: HardCategory;
  rank: number;
  xy: XY;
  label?: string;
  /** units the site brings within the rule (unknown names are kept as names) */
  covers: { name: string; unit: Unit | null }[];
  /** measured routes confirmed it; otherwise an estimate */
  verified: boolean;
  /** engine: the analysis' own; local: estimated here for a result that carries none */
  origin: 'engine' | 'local';
}

const DIRS8 = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
const localCache = new WeakMap<AnalysisResult, Partial<Record<HardCategory, SiteSuggestion[]>>>();

/**
 * Suggestions for a result made before the engine wrote any (sample A): the engine's own greedy
 * covering (core suggestSites) over candidate sites every 50 m along the walked routes, judged with
 * this analysis' detour field at the task rule — estimates, never measured.
 */
export function localSuggestions(model: Model): Partial<Record<HardCategory, SiteSuggestion[]>> {
  const cached = localCache.get(model.data);
  if (cached) return cached;
  const { paths, communities } = model.data;
  const candidates = siteCandidatesFromPaths(paths, 50).map((c) => {
    const m = /^path(\d+)@(\d+)m$/.exec(c.id);
    const path = m ? paths[Number(m[1])] : undefined;
    if (!path || !m) return c;
    const dir = DIRS8[Math.round((((path.bearing_deg % 360) + 360) % 360) / 45) % 8]!;
    return { ...c, label: `${dir}向步行路线约 ${m[2]} 米处` };
  });
  const out: Partial<Record<HardCategory, SiteSuggestion[]>> = {};
  if (candidates.length) {
    const estimator = estimatorFor(model);
    for (const cat of CATS) {
      // the task rule's verdicts, as the engine's suggestions use (communities hold them in `checks`)
      const demands = communities
        .filter((c) => c.checks[cat].verified !== false && c.checks[cat].status_main !== '覆盖')
        .map((c) => ({ id: c.name, xy: c.centroid, weight: 1 }));
      if (!demands.length) continue;
      const list = suggestSites(candidates, demands, {
        category: cat,
        rule_m: model.ruleM,
        maxSites: 3,
        estimator,
      });
      if (list.length) out[cat] = list;
    }
  }
  localCache.set(model.data, out);
  return out;
}

/**
 * The analysis' siting suggestions, per category in the task's order, best first — or, for a result
 * that carries none, the same search run here (`origin: 'local'`, always 估算).
 */
export function sitePins(model: Model): SitePin[] {
  const byName = new Map(model.units.map((u) => [u.name, u]));
  const own = model.data.site_suggestions;
  const source = own ?? localSuggestions(model);
  const origin = own ? 'engine' : 'local';
  return CATS.flatMap((cat) =>
    [...(source[cat] ?? [])]
      .sort((a, b) => a.rank - b.rank)
      .map((s): SitePin => ({
        key: `${cat}#${s.rank}`,
        cat,
        rank: s.rank,
        xy: s.xy,
        ...(s.label ? { label: s.label } : {}),
        covers: s.covers.map((name) => ({ name, unit: byName.get(name) ?? null })),
        verified: origin === 'engine' && s.verified,
        origin,
      })),
  );
}

const estimators = new WeakMap<AnalysisResult, RouteEstimator>();

/**
 * The analysis' detour field as a route estimator, built once per result the way the engine builds
 * its own for siting: the samples' ρ, and the detected barriers (when the result lists them) so a
 * sample across a river does not vote.
 */
export function estimatorFor(model: Model): RouteEstimator {
  let e = estimators.get(model.data);
  if (!e) {
    // wire pieces carry a, b and κ: all the visibility test reads of a barrier segment
    const pieces = (model.data.barriers ?? []) as unknown as BarrierSegment[];
    e = fieldEstimator(rhoSamplesOf(model.data.samples, model.vAdult).rho, {
      speed: model.vAdult,
      ...(pieces.length ? { visible: (x, y, s) => isVisible([x, y], [s.x, s.y], pieces) } : {}),
    });
    estimators.set(model.data, e);
  }
  return e;
}

/** A unit lacks the category on foot today: a measured 伪覆盖 or 盲区 (pending checks are unknown). */
export const lacks = (u: Unit, cat: HardCategory) =>
  u.checks[cat].verified !== false && u.checks[cat].status_main !== '覆盖';

export interface WhatIfEstimate {
  cat: HardCategory;
  xy: XY;
  rule: number;
  /** units that lack the category on foot today (the demand the site could serve) */
  demand: Unit[];
  /** of those, the ones the site would bring within the rule, with the estimated walk */
  flips: { unit: Unit; estM: number; straightM: number }[];
  /** demand units within the rule by straight line: what 实测核验 would route (one route each) */
  routable: number;
}

/**
 * A facility of `cat` placed at `xy`: which of today's gaps it would close, estimated from the detour
 * field (L̂ = max of the two ends' ρ̂ × straight line, and the field's time bound). Pending checks
 * are not counted as gaps — nobody knows yet whether they are.
 */
export function whatIf(model: Model, cat: HardCategory, xy: XY): WhatIfEstimate {
  const rule = model.ruleOf[cat];
  const demand = model.units.filter((u) => lacks(u, cat));
  const cov = siteCoverage(
    { id: 'whatif', xy },
    demand.map((u) => ({ id: u.code, xy: u.centroid })),
    { category: cat, rule_m: rule, estimator: estimatorFor(model) },
  );
  const byCode = new Map(demand.map((u) => [u.code, u]));
  const flips = cov.routes.map((r) => ({
    unit: byCode.get(r.demand_id)!,
    estM: r.est_m,
    straightM: r.straight_m,
  }));
  const routable = demand.filter(
    (u) => Math.hypot(u.centroid[0] - xy[0], u.centroid[1] - xy[1]) <= rule,
  ).length;
  return { cat, xy, rule, demand, flips, routable };
}
