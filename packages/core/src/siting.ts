/**
 * Facility siting suggestions (design doc §7.5): greedy maximal covering location (MCLP).
 *
 * Coverage is first estimated without any API call from the detour-ratio field ρ̂ of the analysis:
 *
 *   L̂(s, d) = max( max(ρ̂(s), ρ̂(d)) · |s − d|,  |t̂(s) − t̂(d)| · v )
 *
 * The doc's L̂ = ρ̂_local(s) · |s − d| uses the field at the site only. Checked against the 132
 * measured community → facility routes of the zj-a sample, that form calls 85.6 % of the 1 km
 * verdicts right with 15 false "covered" and runs 112 m short on average, because ρ̂ is referenced to
 * the analysis centre and a site near it sits on a nearly straight way out. Taking the larger ρ̂ of
 * both ends, and the Lipschitz lower bound from the field times (it sees rivers between s and d),
 * gets 92.4 % right with 5 false "covered" and a bias of −9 m.
 *
 * The chosen site is then checked with measured routes through an optional verification hook (one
 * 1×|D| routematrix call); when the measured coverage is smaller, the greedy step re-runs with the
 * corrected numbers (lazy greedy), so a suggestion marked verified rests on measured walks only.
 */
import type { XY } from './coords.js';
import type { FieldParams, RhoSample } from './field.js';
import { FIELD_DEFAULTS, estimateTime } from './field.js';
import { resamplePolyline } from './geom.js';
import type { FacilityCategory, SiteSuggestion, WalkPath } from './types.js';

export interface SiteCandidate {
  id: string;
  xy: XY;
  label?: string;
}

export interface SitingDemand {
  id: string;
  xy: XY;
  /** Households or residents; defaults to 1. */
  weight?: number;
}

/** Local walking knowledge from the isochrone analysis (see fieldEstimator). */
export interface RouteEstimator {
  /** ρ̂ near a point, ≥ 1. */
  rhoAt(xy: XY): number;
  /** t̂ from the analysis centre in seconds; enables the Lipschitz bound. */
  timeAt?(xy: XY): number;
  /** m/s behind timeAt. */
  speed?: number;
}

/** Measured walks from a site: demand id → metres, null when Baidu found no route. */
export type MeasuredRoutes = Readonly<Record<string, number | null>>;

export interface EstimateOptions {
  estimator?: RouteEstimator;
  /** ρ used without an estimator (design doc §4.5 rough factor). */
  defaultRho?: number;
}

export interface SitingOptions extends EstimateOptions {
  category: FacilityCategory;
  rule_m?: number;
  maxSites?: number;
  /**
   * Verification hook: measured routes from the site to the given demand points (those within the
   * rule by straight line). Return undefined when routes are not available; the suggestion then keeps
   * its estimate and verified: false.
   */
  verify?: (site: SiteCandidate, demands: readonly SitingDemand[]) => MeasuredRoutes | undefined;
}

export interface SiteCoverage {
  covers: string[];
  gain: number;
  /** ρ̂ at the site itself. */
  rho: number;
  verified: boolean;
  routes: SiteSuggestion['routes'];
}

const r1 = (v: number) => Math.round(v * 10) / 10;

function rhoOf(xy: XY, opts: EstimateOptions): number {
  const fallback = opts.defaultRho ?? 1.35;
  const rho = opts.estimator ? opts.estimator.rhoAt(xy) : fallback;
  return Number.isFinite(rho) ? Math.max(1, rho) : fallback;
}

/** L̂ between two points (see the module comment); never below the straight line. */
export function estimateRoute(a: XY, b: XY, opts: EstimateOptions = {}): number {
  const straight = Math.hypot(a[0] - b[0], a[1] - b[1]);
  let est = Math.max(rhoOf(a, opts), rhoOf(b, opts)) * straight;
  const e = opts.estimator;
  if (e?.timeAt) {
    const dt = Math.abs(e.timeAt(a) - e.timeAt(b)) * (e.speed ?? FIELD_DEFAULTS.speed);
    if (Number.isFinite(dt)) est = Math.max(est, dt);
  }
  return est;
}

/**
 * Which demand points a (real or hypothetical) facility at `site` would serve: measured routes where
 * given, L̂ otherwise. Also the what-if answer for a facility placed by the user.
 */
export function siteCoverage(
  site: SiteCandidate,
  demands: readonly SitingDemand[],
  opts: SitingOptions,
  measured?: MeasuredRoutes,
): SiteCoverage {
  const rule = opts.rule_m ?? 1000;
  const covers: string[] = [];
  const routes: SiteSuggestion['routes'] = [];
  let gain = 0;
  for (const d of demands) {
    const straight = Math.hypot(d.xy[0] - site.xy[0], d.xy[1] - site.xy[1]);
    if (straight > rule) continue; // walking is never shorter than the straight line
    const est = estimateRoute(site.xy, d.xy, opts);
    const has = measured !== undefined && Object.hasOwn(measured, d.id);
    const route = has ? measured[d.id] : undefined;
    const ok = has ? route !== null && route !== undefined && route <= rule : est <= rule;
    if (!ok) continue;
    covers.push(d.id);
    gain += d.weight ?? 1;
    const row: SiteSuggestion['routes'][number] = {
      demand_id: d.id,
      straight_m: r1(straight),
      est_m: Math.round(est),
    };
    if (typeof route === 'number') row.route_m = route;
    routes.push(row);
  }
  return { covers, gain, rho: rhoOf(site.xy, opts), verified: measured !== undefined, routes };
}

/**
 * Ranked suggestions for one category. `demands` are the points that currently lack the facility;
 * each suggestion lists the ids it newly covers (points covered by an earlier pick are not counted
 * again).
 */
export function suggestSites(
  candidates: readonly SiteCandidate[],
  demands: readonly SitingDemand[],
  opts: SitingOptions,
): SiteSuggestion[] {
  const rule = opts.rule_m ?? 1000;
  const maxSites = opts.maxSites ?? 3;
  const measured = new Map<string, MeasuredRoutes | undefined>();
  const chosen = new Set<string>();
  let remaining = demands.slice();
  const out: SiteSuggestion[] = [];

  while (out.length < maxSites && remaining.length) {
    let best: { site: SiteCandidate; cov: SiteCoverage; spread: number } | null = null;
    for (const site of candidates) {
      if (chosen.has(site.id)) continue;
      const cov = siteCoverage(site, remaining, opts, measured.get(site.id));
      if (cov.gain <= 0) continue;
      // tie-break: the site closer to the points it serves
      const spread = cov.routes.reduce((s, r) => s + (r.route_m ?? r.est_m), 0);
      if (!best || cov.gain > best.cov.gain || (cov.gain === best.cov.gain && spread < best.spread)) {
        best = { site, cov, spread };
      }
    }
    if (!best) break;
    const site = best.site;
    if (opts.verify && !measured.has(site.id)) {
      const near = demands.filter((d) => Math.hypot(d.xy[0] - site.xy[0], d.xy[1] - site.xy[1]) <= rule);
      measured.set(site.id, opts.verify(site, near));
      if (measured.get(site.id) !== undefined) continue; // re-rank with the measured coverage
    }
    chosen.add(site.id);
    const covered = new Set(best.cov.covers);
    remaining = remaining.filter((d) => !covered.has(d.id));
    const s: SiteSuggestion = {
      rank: out.length + 1,
      category: opts.category,
      site_id: site.id,
      xy: [r1(site.xy[0]), r1(site.xy[1])],
      covers: best.cov.covers,
      gain: best.cov.gain,
      rho_local: Math.round(best.cov.rho * 1000) / 1000,
      verified: best.cov.verified,
      routes: best.cov.routes,
    };
    if (site.label !== undefined) s.label = site.label;
    out.push(s);
  }
  return out;
}

/** ρ̂ and t̂ from the analysis samples, with the same estimator as the isochrone field. */
export function fieldEstimator(
  samples: readonly RhoSample[],
  params: Partial<FieldParams> = {},
): RouteEstimator {
  const p: FieldParams = { ...FIELD_DEFAULTS, ...params };
  const list = samples as RhoSample[];
  const timeAt = (xy: XY) => estimateTime(list, xy[0], xy[1], p);
  return {
    speed: p.speed,
    timeAt,
    rhoAt(xy) {
      const r = Math.hypot(xy[0], xy[1]);
      if (r < p.nearRadius) return p.nearRho;
      const t = timeAt(xy);
      return Number.isFinite(t) ? Math.max(1, (t * p.speed) / r) : NaN;
    },
  };
}

/** Candidate sites every `spacing` metres along walked routes: points that are on a walkable street. */
export function siteCandidatesFromPaths(paths: readonly WalkPath[], spacing = 50): SiteCandidate[] {
  const out: SiteCandidate[] = [];
  paths.forEach((path, pi) => {
    const pts = resamplePolyline(
      path.pts.map((p) => [p[0], p[1]] as XY),
      spacing,
    );
    pts.forEach((xy, k) => out.push({ id: `path${pi}@${k * spacing}m`, xy }));
  });
  return out;
}
