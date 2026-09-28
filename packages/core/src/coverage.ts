/**
 * Service-gap checks (design doc §7): the four-state rule, quota-saving candidate selection, OD
 * batching for Baidu routematrix, merging of the answers into FacilityChecks, and 灰色区域 polygons.
 *
 * Flow for one health check:
 *
 *   routes = []
 *   loop:  want = planCoverageRound(demand, facilitiesByCategory, routes)   // early stop inside
 *          if want is empty: break
 *          for batch of planMatrixBatches(demand, want): routes.push(...matrixPairs(batch, answer))
 *   checks = mergeMatrixResults(demand, facilities, routes)                 // per category
 */
import type { XY } from './coords.js';
import { chaikin, isoRings, nestRings } from './contour.js';
import type { Grid } from './field.js';
import { routingPoint } from './poi.js';
import { BORDERLINE_M } from './standards.js';
import type { CheckStatus, ContourMeta, FacilityCheck, GrayArea, MainStatus, Poi } from './types.js';

const r1 = (v: number) => Math.round(v * 10) / 10;
const dist = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// ------------------------------------------------------------------------------ four-state rule

export interface CheckInput {
  /** Straight line to the nearest facility of the category. */
  straight_m: number;
  /** Shortest walk found (measured, estimated, or a lower bound; see lowerBound). */
  route_m: number;
  rule_m?: number;
  /** |route − rule| ≤ edge_m flags 临界. */
  edge_m?: number;
  verified?: boolean;
  /** A nearer facility was not routed, so the true walk may be shorter than route_m. */
  upperBound?: boolean;
  /** route_m is only a proven minimum (nothing was routed); it can rule coverage out, never in. */
  lowerBound?: boolean;
}

export interface CheckVerdict {
  status: CheckStatus;
  status_main: MainStatus;
  borderline: boolean;
  verified: boolean;
  route_upper_bound: boolean;
}

/**
 *   覆盖    route ≤ rule                  walkable
 *   伪覆盖  straight ≤ rule < route        the circle says yes, the street says no
 *   盲区    straight > rule                nothing nearby at all
 *   临界    |route − rule| ≤ edge          flag on top of the main status (status keeps 临界,
 *                                          status_main keeps the three-way verdict)
 */
export function classifyCheck(c: CheckInput): CheckVerdict {
  const rule = c.rule_m ?? 1000;
  const edge = c.edge_m ?? BORDERLINE_M;
  const covered = !c.lowerBound && c.route_m <= rule;
  const status_main: MainStatus = covered ? '覆盖' : c.straight_m <= rule ? '伪覆盖' : '盲区';
  const borderline = !c.lowerBound && Math.abs(c.route_m - rule) <= edge;
  return {
    status: borderline ? '临界' : status_main,
    status_main,
    borderline,
    // a lower bound inside the rule proves nothing either way
    verified: (c.verified ?? true) && !(c.lowerBound && c.route_m <= rule),
    route_upper_bound: c.upperBound ?? false,
  };
}

// ---------------------------------------------------------------------------------- candidates

export interface DemandPoint {
  id: string;
  name?: string;
  /** Where residents start walking: a community entrance, or its centroid as a fallback. */
  xy: XY;
  /** Households or residents, for siting; defaults to 1. */
  weight?: number;
}

export interface CoverageCandidate {
  poi: Poi;
  /** Straight line from the demand point to the POI: what the four-state rule reports. */
  straight_m: number;
  /** Straight line to the routing point (entrance): every route to this POI is at least this long. */
  bound_m: number;
}

/** All facilities by straight distance from the demand point (nearest first). */
export function rankCandidates(origin: XY, facilities: readonly Poi[]): CoverageCandidate[] {
  return facilities
    .map((poi) => ({ poi, straight_m: dist(origin, poi.xy), bound_m: dist(origin, routingPoint(poi)) }))
    .sort((a, b) => a.straight_m - b.straight_m || a.bound_m - b.bound_m || (a.poi.uid < b.poi.uid ? -1 : 1));
}

/** Pruning (§7.3): walking is never shorter than the straight line, so candidates beyond the rule can't cover. */
export function pruneCandidates(ranked: readonly CoverageCandidate[], rule_m = 1000): CoverageCandidate[] {
  return ranked.filter((c) => c.bound_m <= rule_m);
}

/** A walking route measured by routematrix; null distance/duration = Baidu had no route (it answers 0). */
export interface RoutedPair {
  origin_id: string;
  /** Facility uid. */
  dest_id: string;
  route_m: number | null;
  dur_s: number | null;
}

interface Assessment {
  ranked: CoverageCandidate[];
  best: { cand: CoverageCandidate; route_m: number; dur_s: number } | null;
  succeeded: Set<string>;
  attempted: Set<string>;
  /** Candidates within the rule without a measured route: they could still cover the point. */
  open: CoverageCandidate[];
  /** Proven covered, or nothing left that could cover it. */
  resolved: boolean;
}

function routesByOrigin(routes: readonly RoutedPair[]): Map<string, Map<string, RoutedPair>> {
  const out = new Map<string, Map<string, RoutedPair>>();
  for (const r of routes) {
    let m = out.get(r.origin_id);
    if (!m) out.set(r.origin_id, (m = new Map()));
    const prev = m.get(r.dest_id);
    // a failed attempt never hides a successful one
    if (!prev || (prev.route_m === null && r.route_m !== null)) m.set(r.dest_id, r);
  }
  return out;
}

function assess(
  o: DemandPoint,
  facilities: readonly Poi[],
  mine: Map<string, RoutedPair> | undefined,
  rule: number,
): Assessment {
  const ranked = rankCandidates(o.xy, facilities);
  const succeeded = new Set<string>();
  const attempted = new Set<string>();
  let best: Assessment['best'] = null;
  for (const c of ranked) {
    const r = mine?.get(c.poi.uid);
    if (!r) continue;
    attempted.add(c.poi.uid);
    if (r.route_m === null || !(r.route_m > 0)) continue;
    succeeded.add(c.poi.uid);
    const dur = r.dur_s ?? NaN;
    if (!best || r.route_m < best.route_m || (r.route_m === best.route_m && dur < best.dur_s)) {
      best = { cand: c, route_m: r.route_m, dur_s: dur };
    }
  }
  const open = pruneCandidates(ranked, rule).filter((c) => !succeeded.has(c.poi.uid));
  const resolved = (best !== null && best.route_m <= rule) || open.length === 0;
  return { ranked, best, succeeded, attempted, open, resolved };
}

/** A routematrix endpoint: an id plus whatever the caller needs to send it (local XY here). */
export interface OdPoint {
  id: string;
  xy: XY;
}

export interface OdDestination extends OdPoint {
  poi: Poi;
}

export interface CoverageRoundOptions {
  rule_m?: number;
  /** New candidates per demand point and category in this round. */
  k?: number;
}

/**
 * Destinations to route next, per demand point: for every category not yet decided, the k nearest
 * candidates whose entrance lies within the rule and that were never tried. A point proven covered
 * gets nothing more (early stop), and neither does one whose remaining candidates are all out of range.
 */
export function planCoverageRound(
  demand: readonly DemandPoint[],
  facilitiesByCategory: Readonly<Record<string, readonly Poi[]>>,
  routes: readonly RoutedPair[],
  opts: CoverageRoundOptions = {},
): Map<string, OdDestination[]> {
  const rule = opts.rule_m ?? 1000;
  const k = opts.k ?? 3;
  const byOrigin = routesByOrigin(routes);
  const out = new Map<string, OdDestination[]>();
  for (const o of demand) {
    const want = new Map<string, OdDestination>();
    for (const facilities of Object.values(facilitiesByCategory)) {
      const a = assess(o, facilities, byOrigin.get(o.id), rule);
      if (a.resolved) continue;
      for (const c of a.open.filter((c) => !a.attempted.has(c.poi.uid)).slice(0, k)) {
        want.set(c.poi.uid, { id: c.poi.uid, xy: routingPoint(c.poi), poi: c.poi });
      }
    }
    if (want.size) out.set(o.id, [...want.values()]);
  }
  return out;
}

// ---------------------------------------------------------------------------------- OD batches

export interface OdBatch<O extends { id: string }, D extends { id: string }> {
  origins: O[];
  destinations: D[];
  /** Routes Baidu bills for the request: origins × destinations. */
  routes: number;
  /** Pairs that were asked for; the rest ride along because they share the batch. */
  wanted: number;
}

export interface BatchOptions {
  /** Unrequested routes a batch may carry to save a request (0 = never pay for a route nobody asked for). */
  maxWaste?: number;
}

/**
 * Packs per-origin destination lists into routematrix requests of at most maxPairs routes. Baidu
 * routes every origin to every destination of a request and answers origin-major
 * (result[oi · |D| + di]), billing |O|·|D| routes, so origins only share a request when that costs no
 * more than maxWaste unrequested routes; with the default 0 that means identical destination sets.
 */
export function planMatrixBatches<O extends { id: string }, D extends { id: string }>(
  origins: readonly O[],
  candidatesPerOrigin: ReadonlyMap<string, readonly D[]> | Readonly<Record<string, readonly D[]>>,
  maxPairs = 50,
  opts: BatchOptions = {},
): OdBatch<O, D>[] {
  const maxWaste = opts.maxWaste ?? 0;
  const get = (id: string): readonly D[] =>
    (candidatesPerOrigin instanceof Map
      ? (candidatesPerOrigin as ReadonlyMap<string, readonly D[]>).get(id)
      : (candidatesPerOrigin as Readonly<Record<string, readonly D[]>>)[id]) ?? [];
  const batches: Array<OdBatch<O, D> & { ids: Set<string> }> = [];
  for (const o of origins) {
    const uniq = new Map<string, D>();
    for (const d of get(o.id)) if (!uniq.has(d.id)) uniq.set(d.id, d);
    const dests = [...uniq.values()];
    if (!dests.length) continue;
    if (dests.length > maxPairs) {
      for (let i = 0; i < dests.length; i += maxPairs) {
        const chunk = dests.slice(i, i + maxPairs);
        batches.push({
          origins: [o],
          destinations: chunk,
          routes: chunk.length,
          wanted: chunk.length,
          ids: new Set(),
        });
      }
      continue;
    }
    let pick: (typeof batches)[number] | null = null;
    let pickWaste = Infinity;
    let pickUnion: D[] = [];
    for (const b of batches) {
      if (!b.ids.size) continue; // split chunks stay single-origin
      const extra = dests.filter((d) => !b.ids.has(d.id));
      const size = (b.origins.length + 1) * (b.destinations.length + extra.length);
      if (size > maxPairs) continue;
      const waste = size - (b.wanted + dests.length);
      if (waste <= maxWaste && waste < pickWaste) {
        pick = b;
        pickWaste = waste;
        pickUnion = extra;
      }
    }
    if (pick) {
      pick.origins.push(o);
      for (const d of pickUnion) {
        pick.destinations.push(d);
        pick.ids.add(d.id);
      }
      pick.wanted += dests.length;
      pick.routes = pick.origins.length * pick.destinations.length;
    } else {
      batches.push({
        origins: [o],
        destinations: dests,
        routes: dests.length,
        wanted: dests.length,
        ids: new Set(dests.map((d) => d.id)),
      });
    }
  }
  return batches.map(({ origins: os, destinations, routes, wanted }) => ({
    origins: os,
    destinations,
    routes,
    wanted,
  }));
}

/** One element of Baidu's routematrix `result` array. */
export interface MatrixElement {
  distance?: { value?: number } | null;
  duration?: { value?: number } | null;
}

/** Unpacks an origin-major routematrix answer; Baidu's 0 distance/duration becomes null (no route). */
export function matrixPairs<O extends { id: string }, D extends { id: string }>(
  batch: OdBatch<O, D>,
  result: readonly (MatrixElement | null | undefined)[],
): RoutedPair[] {
  const nd = batch.destinations.length;
  if (result.length !== batch.origins.length * nd) {
    throw new Error(`routematrix answered ${result.length} pairs for ${batch.origins.length} × ${nd}`);
  }
  const out: RoutedPair[] = [];
  batch.origins.forEach((o, oi) => {
    batch.destinations.forEach((d, di) => {
      const el = result[oi * nd + di];
      const m = el?.distance?.value ?? 0;
      const s = el?.duration?.value ?? 0;
      const ok = m > 0 && s > 0;
      out.push({ origin_id: o.id, dest_id: d.id, route_m: ok ? m : null, dur_s: ok ? s : null });
    });
  });
  return out;
}

// ------------------------------------------------------------------------------------- merging

export interface MergeOptions {
  rule_m?: number;
  edge_m?: number;
  /** m/s for durations of estimated or bounded routes. */
  speed?: number;
  /** ρ for rough estimates when nothing could be routed (design doc §4.5: straight × 1.35). */
  fallbackRho?: number;
}

/**
 * Builds one FacilityCheck per demand point from every route measured so far. A check is verified
 * when its verdict is proven: a measured route within the rule, or every candidate that could beat
 * the rule was routed (or is out of range by straight line). A point whose nearest candidates were
 * not all routed therefore stays verified: false unless a route already covers it.
 */
export function mergeMatrixResults(
  demand: readonly DemandPoint[],
  facilities: readonly Poi[],
  routes: readonly RoutedPair[],
  opts: MergeOptions = {},
): Map<string, FacilityCheck> {
  const rule = opts.rule_m ?? 1000;
  const edge = opts.edge_m ?? BORDERLINE_M;
  const speed = opts.speed ?? 1.17;
  const fallbackRho = opts.fallbackRho ?? 1.35;
  const byOrigin = routesByOrigin(routes);
  const out = new Map<string, FacilityCheck>();
  for (const o of demand) {
    const a = assess(o, facilities, byOrigin.get(o.id), rule);
    const nearest = a.ranked[0];
    if (!nearest) {
      out.set(o.id, {
        straight_m: -1,
        route_m: -1,
        dur_s: -1,
        status: '盲区',
        status_main: '盲区',
        borderline: false,
        route_upper_bound: false,
        verified: true,
        route_basis: 'none',
      });
      continue;
    }
    const base = { straight_m: r1(nearest.straight_m), nearest_straight: nearest.poi.name };
    if (a.best) {
      const { cand, route_m, dur_s } = a.best;
      // facilities never routed from here whose entrance is closer than the best walk might beat it
      const nearer = a.ranked.filter((c) => !a.succeeded.has(c.poi.uid) && c.bound_m < route_m);
      const v = classifyCheck({
        straight_m: nearest.straight_m,
        route_m,
        rule_m: rule,
        edge_m: edge,
        verified: a.resolved,
        upperBound: nearer.length > 0,
      });
      const check: FacilityCheck = {
        ...base,
        route_m,
        dur_s: Number.isFinite(dur_s) ? dur_s : Math.round(route_m / speed),
        via: cand.poi.name,
        via_uid: cand.poi.uid,
        via_straight_m: r1(cand.straight_m),
        ...v,
        route_basis: 'routed',
      };
      if (cand.poi.stall_of) check.via_stall_of = cand.poi.stall_of;
      if (nearer.length) {
        check.unrouted_nearer = nearer
          .slice(0, 3)
          .map((c) => ({ name: c.poi.name, uid: c.poi.uid, straight_m: r1(c.straight_m) }));
      }
      out.set(o.id, check);
      continue;
    }
    if (!a.open.length) {
      // every entrance is beyond the rule: the walk is at least that long, no API call needed
      const bound = Math.min(...a.ranked.map((c) => c.bound_m));
      const v = classifyCheck({
        straight_m: nearest.straight_m,
        route_m: bound,
        rule_m: rule,
        edge_m: edge,
        lowerBound: true,
      });
      out.set(o.id, {
        ...base,
        route_m: r1(bound),
        dur_s: Math.round(bound / speed),
        ...v,
        route_basis: 'lower_bound',
      });
      continue;
    }
    // candidates could cover the point but none has been routed: a rough estimate, never a verdict
    const est = Math.round(fallbackRho * Math.min(...a.open.map((c) => c.bound_m)));
    const v = classifyCheck({
      straight_m: nearest.straight_m,
      route_m: est,
      rule_m: rule,
      edge_m: edge,
      verified: false,
    });
    out.set(o.id, { ...base, route_m: est, dur_s: Math.round(est / speed), ...v, route_basis: 'estimated' });
  }
  return out;
}

// ------------------------------------------------------------------------------------ 灰色区域

/** Hard categories not walkable within the rule; unverified checks are left out rather than guessed. */
export function gapCount(checks: Readonly<Record<string, FacilityCheck | undefined>>): {
  missing: number;
  pseudo: boolean;
} {
  let missing = 0;
  let pseudo = false;
  for (const c of Object.values(checks)) {
    if (!c || !c.verified || c.status_main === '覆盖') continue;
    missing++;
    if (c.status_main === '伪覆盖') pseudo = true;
  }
  return { missing, pseudo };
}

export interface StatusPoint {
  xy: XY;
  missing: number;
  pseudo: boolean;
}

export interface StatusRasterOptions {
  cell_m?: number;
  /** Nodes farther than this from every demand point stay outside (NaN). */
  maxDist_m?: number;
  /** Restricts the raster, e.g. to residential land. */
  inside?: (x: number, y: number) => boolean;
}

export interface StatusRaster {
  /** Missing-category count of the nearest demand point; NaN outside. */
  missing: Grid;
  /** 1 where the nearest demand point has a 伪覆盖 check, else 0; NaN outside. */
  pseudo: Grid;
}

/** Nearest-demand-point raster of gap counts (§7.4). */
export function statusRaster(points: readonly StatusPoint[], opts: StatusRasterOptions = {}): StatusRaster {
  const cell = opts.cell_m ?? 50;
  const maxDist = opts.maxDist_m ?? 250;
  const xs = points.map((p) => p.xy[0]);
  const ys = points.map((p) => p.xy[1]);
  // one extra node of margin keeps every region closed inside the lattice
  const x0 = (Math.floor((Math.min(...xs) - maxDist) / cell) - 1) * cell;
  const y0 = (Math.floor((Math.min(...ys) - maxDist) / cell) - 1) * cell;
  const nx = points.length
    ? Math.round(((Math.ceil((Math.max(...xs) + maxDist) / cell) + 1) * cell - x0) / cell) + 1
    : 0;
  const ny = points.length
    ? Math.round(((Math.ceil((Math.max(...ys) + maxDist) / cell) + 1) * cell - y0) / cell) + 1
    : 0;
  const missing = new Float64Array(nx * ny).fill(NaN);
  const pseudo = new Float64Array(nx * ny).fill(NaN);
  const max2 = maxDist * maxDist;
  for (let j = 0; j < ny; j++) {
    const y = y0 + j * cell;
    for (let i = 0; i < nx; i++) {
      const x = x0 + i * cell;
      if (opts.inside && !opts.inside(x, y)) continue;
      let best = -1;
      let bestD2 = max2;
      points.forEach((p, k) => {
        const d2 = (p.xy[0] - x) ** 2 + (p.xy[1] - y) ** 2;
        if (d2 <= bestD2) {
          bestD2 = d2;
          best = k;
        }
      });
      if (best < 0) continue;
      const p = points[best]!;
      missing[j * nx + i] = p.missing;
      pseudo[j * nx + i] = p.pseudo ? 1 : 0;
    }
  }
  return {
    missing: { nx, ny, x0, y0, cell, values: missing },
    pseudo: { nx, ny, x0, y0, cell, values: pseudo },
  };
}

function regionRings(
  grid: Grid,
  atLeast: number,
  passes: number,
  minRing_m2: number,
): { rings: XY[][]; meta: ContourMeta[]; area: number } {
  // marching squares extracts {value < level}; negate so that "missing ≥ n" becomes "−missing < 0.5 − n"
  const neg: Grid = { ...grid, values: grid.values.map((v) => -v) };
  const iso = isoRings(neg, 0.5 - atLeast);
  const nested = nestRings(iso.rings.map((r) => chaikin(r, passes)));
  const rings: XY[][] = [];
  const meta: ContourMeta[] = [];
  const newIndex = new Map<number, number>();
  let area = 0;
  nested.forEach((n, k) => {
    if (n.areaM2 < minRing_m2 || (n.hole && !newIndex.has(n.parent))) return;
    if (!n.hole) newIndex.set(k, rings.length);
    rings.push(n.ring.map((p) => [r1(p[0]), r1(p[1])]));
    meta.push({
      hole: n.hole,
      parent: n.hole ? newIndex.get(n.parent)! : null,
      area_m2: Math.round(n.areaM2),
    });
    area += n.hole ? -n.areaM2 : n.areaM2;
  });
  return { rings, meta, area };
}

export interface GrayAreaOptions {
  chaikin?: number;
  minRing_m2?: number;
}

/** 灰色区域 polygons: one layer per "at least n categories missing", plus the 伪覆盖 layer. */
export function grayAreaPolygons(raster: StatusRaster, opts: GrayAreaOptions = {}): GrayArea[] {
  const passes = opts.chaikin ?? 2;
  const minRing = opts.minRing_m2 ?? 0;
  let top = 0;
  for (const v of raster.missing.values) if (v > top) top = v;
  const out: GrayArea[] = [];
  for (let n = 1; n <= top; n++) {
    const g = regionRings(raster.missing, n, passes, minRing);
    if (g.rings.length)
      out.push({ kind: 'gap', min_missing: n, rings: g.rings, meta: g.meta, area_m2: Math.round(g.area) });
  }
  const p = regionRings(raster.pseudo, 1, passes, minRing);
  if (p.rings.length)
    out.push({ kind: 'pseudo', min_missing: 1, rings: p.rings, meta: p.meta, area_m2: Math.round(p.area) });
  return out;
}
