/**
 * Lipschitz discontinuity detection from walking times alone (design doc §5.3).
 *
 * For any two points the triangle inequality gives |t1 − t2| ≤ L(x1, x2) / v, where L is the walking
 * distance between them. So the edge strength
 *
 *   κ = |t1 − t2| · v / |x1 − x2|
 *
 * is a lower bound of the network detour between the two points. κ > κ* (default 2.5) proves that
 * something blocks the direct walk: a river, a railway, an elevated road without crossings, a gated
 * compound. No road data is needed, only the times the routing API already returned.
 *
 * Samples are connected by a Delaunay triangulation; every strong edge contributes one barrier
 * segment on its perpendicular bisector. The segment spans the Voronoi edge dual to the Delaunay edge
 * (circumcentre to circumcentre), so the segments of neighbouring strong edges join into continuous
 * barrier lines, while bridges show up as gaps where the edges are weak.
 */
import Delaunator from 'delaunator';

import type { XY } from './coords.js';
import type { RhoSample } from './field.js';
import { segDist2, segmentsIntersect } from './geom.js';

/** Anything with a position and a walking time from the analysis centre (TimeSample fits). */
export interface TimedPoint {
  xy: XY;
  dur_s: number;
}

export interface BarrierOptions {
  /** m/s that converts time differences back to metres; Baidu routematrix walks at 1.17. */
  speed?: number;
  /** κ*: edges stronger than this become barriers. */
  kappa?: number;
  /** Longer Delaunay edges are ignored: they prove a barrier but cannot say where it is. */
  maxEdge_m?: number;
  /** A barrier segment reaches at most clip × edge length from the midpoint of its edge. */
  clip?: number;
  /**
   * Minimum implied extra walk |Δt|·v − |Δx|, metres. Baidu snaps each endpoint to a nearby road
   * link, so two answers for almost the same point can differ by a few seconds; over a 0.5 m edge
   * that alone gives κ ≈ 5. Real barriers in zj-a imply at least 30 m.
   */
  minDetour_m?: number;
}

export const BARRIER_DEFAULTS: Required<BarrierOptions> = {
  speed: 1.17,
  kappa: 2.5,
  maxEdge_m: 400,
  clip: 1,
  minDetour_m: 20,
};

export interface BarrierEdge {
  /** Indices of the two samples. */
  i: number;
  j: number;
  length_m: number;
  kappa: number;
}

export interface BarrierSegment {
  a: XY;
  b: XY;
  kappa: number;
  /** The strong Delaunay edge this segment cuts. */
  i: number;
  j: number;
}

export interface Barriers {
  kappaThreshold: number;
  speed: number;
  /** Every Delaunay edge within maxEdge_m, strong or not. */
  edges: BarrierEdge[];
  segments: BarrierSegment[];
  index: BarrierIndex;
}

/** Uniform grid over barrier segments for visibility and distance queries. */
export interface BarrierIndex {
  cell: number;
  cells: Map<number, number[]>;
  /** Per-segment stamp so a query tests each segment once. */
  stamp: Int32Array;
  query: number;
}

const INDEX_CELL_M = 100;
// Cell key packing: grid coordinates are offset into [0, 2^16) (±3,276 km at 100 m cells).
const KEY_OFFSET = 32768;
const KEY_STRIDE = 65536;
const cellKey = (gx: number, gy: number) => (gx + KEY_OFFSET) * KEY_STRIDE + (gy + KEY_OFFSET);

function buildIndex(segments: readonly BarrierSegment[], cell = INDEX_CELL_M): BarrierIndex {
  const cells = new Map<number, number[]>();
  segments.forEach((s, id) => {
    const gx0 = Math.floor(Math.min(s.a[0], s.b[0]) / cell);
    const gx1 = Math.floor(Math.max(s.a[0], s.b[0]) / cell);
    const gy0 = Math.floor(Math.min(s.a[1], s.b[1]) / cell);
    const gy1 = Math.floor(Math.max(s.a[1], s.b[1]) / cell);
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gy = gy0; gy <= gy1; gy++) {
        const k = cellKey(gx, gy);
        const list = cells.get(k);
        if (list) list.push(id);
        else cells.set(k, [id]);
      }
    }
  });
  return { cell, cells, stamp: new Int32Array(segments.length), query: 0 };
}

/** Calls `visit` once for every segment whose cells overlap the box; stops early when it returns true. */
function forEachNear(
  b: Barriers,
  xmin: number,
  ymin: number,
  xmax: number,
  ymax: number,
  visit: (s: BarrierSegment) => boolean | void,
): boolean {
  const ix = b.index;
  const q = ++ix.query;
  const gx0 = Math.floor(xmin / ix.cell);
  const gx1 = Math.floor(xmax / ix.cell);
  const gy0 = Math.floor(ymin / ix.cell);
  const gy1 = Math.floor(ymax / ix.cell);
  for (let gx = gx0; gx <= gx1; gx++) {
    for (let gy = gy0; gy <= gy1; gy++) {
      const list = ix.cells.get(cellKey(gx, gy));
      if (!list) continue;
      for (const id of list) {
        if (ix.stamp[id] === q) continue;
        ix.stamp[id] = q;
        if (visit(b.segments[id]!)) return true;
      }
    }
  }
  return false;
}

const nextHalfedge = (e: number) => (e % 3 === 2 ? e - 2 : e + 1);

function circumcenter(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): XY {
  const dx = bx - ax;
  const dy = by - ay;
  const ex = cx - ax;
  const ey = cy - ay;
  const bl = dx * dx + dy * dy;
  const cl = ex * ex + ey * ey;
  const d = 0.5 / (dx * ey - dy * ex);
  return [ax + (ey * bl - dy * cl) * d, ay + (dx * cl - ex * bl) * d];
}

/** Finds barriers between samples (exact duplicate positions are skipped by the triangulation). */
export function detectBarriers(points: readonly TimedPoint[], opts: BarrierOptions = {}): Barriers {
  const o = { ...BARRIER_DEFAULTS, ...opts };
  const edges: BarrierEdge[] = [];
  const segments: BarrierSegment[] = [];
  const n = points.length;
  if (n >= 3) {
    const coords = new Float64Array(2 * n);
    points.forEach((p, i) => {
      coords[2 * i] = p.xy[0];
      coords[2 * i + 1] = p.xy[1];
    });
    const { triangles, halfedges } = new Delaunator(coords);
    const nt = triangles.length / 3;
    const cc = new Float64Array(2 * nt);
    for (let t = 0; t < nt; t++) {
      const a = points[triangles[3 * t]!]!.xy;
      const b = points[triangles[3 * t + 1]!]!.xy;
      const c = points[triangles[3 * t + 2]!]!.xy;
      const [x, y] = circumcenter(a[0], a[1], b[0], b[1], c[0], c[1]);
      cc[2 * t] = x;
      cc[2 * t + 1] = y;
    }
    for (let e = 0; e < triangles.length; e++) {
      const opp = halfedges[e]!;
      if (e < opp) continue; // interior edges are visited once, from their larger half-edge
      const i = triangles[e]!;
      const j = triangles[nextHalfedge(e)]!;
      const pi = points[i]!;
      const pj = points[j]!;
      const dx = pj.xy[0] - pi.xy[0];
      const dy = pj.xy[1] - pi.xy[1];
      const len = Math.hypot(dx, dy);
      if (!(len > 1e-6) || len > o.maxEdge_m) continue;
      const kappa = (Math.abs(pj.dur_s - pi.dur_s) * o.speed) / len;
      edges.push({ i, j, length_m: len, kappa });
      if (!(kappa > o.kappa) || kappa * len - len < o.minDetour_m) continue;

      // Parametrise the bisector as m + s·u; the dual Voronoi edge runs between the circumcentres.
      const mx = (pi.xy[0] + pj.xy[0]) / 2;
      const my = (pi.xy[1] + pj.xy[1]) / 2;
      const ux = -dy / len;
      const uy = dx / len;
      const along = (x: number, y: number) => (x - mx) * ux + (y - my) * uy;
      const t1 = Math.floor(e / 3);
      let s1 = along(cc[2 * t1]!, cc[2 * t1 + 1]!);
      let s2: number;
      if (opp >= 0) {
        const t2 = Math.floor(opp / 3);
        s2 = along(cc[2 * t2]!, cc[2 * t2 + 1]!);
      } else {
        // hull edge: the Voronoi edge is a ray pointing away from the triangle's third vertex
        const k = points[triangles[nextHalfedge(nextHalfedge(e))]!]!.xy;
        s2 = along(k[0], k[1]) > 0 ? -Infinity : Infinity;
      }
      if (Number.isNaN(s1)) s1 = 0;
      if (Number.isNaN(s2)) s2 = 0;
      // Always straddle the edge itself: with an obtuse neighbour the Voronoi edge misses it.
      const margin = 0.05 * len;
      const reach = o.clip * len;
      const lo = Math.max(Math.min(s1, s2, -margin), -reach);
      const hi = Math.min(Math.max(s1, s2, margin), reach);
      segments.push({ a: [mx + ux * lo, my + uy * lo], b: [mx + ux * hi, my + uy * hi], kappa, i, j });
    }
  }
  return { kappaThreshold: o.kappa, speed: o.speed, edges, segments, index: buildIndex(segments) };
}

/** True if the straight segment from→to crosses no barrier segment. */
export function isVisible(from: XY, to: XY, barriers: Barriers | readonly BarrierSegment[]): boolean {
  if (Array.isArray(barriers)) {
    return !(barriers as readonly BarrierSegment[]).some((s) => segmentsIntersect(from, to, s.a, s.b));
  }
  const b = barriers as Barriers;
  if (!b.segments.length) return true;
  const blocked = forEachNear(
    b,
    Math.min(from[0], to[0]),
    Math.min(from[1], to[1]),
    Math.max(from[0], to[0]),
    Math.max(from[1], to[1]),
    (s) => segmentsIntersect(from, to, s.a, s.b),
  );
  return !blocked;
}

/** Distance (m) from p to the nearest barrier segment, or Infinity if none lies within maxR. */
export function barrierDistance(p: XY, barriers: Barriers, maxR = 500): number {
  if (!barriers.segments.length) return Infinity;
  let best = maxR * maxR;
  let hit = false;
  forEachNear(barriers, p[0] - maxR, p[1] - maxR, p[0] + maxR, p[1] + maxR, (s) => {
    const d2 = segDist2(p, s.a, s.b);
    if (d2 <= best) {
      best = d2;
      hit = true;
    }
  });
  return hit ? Math.sqrt(best) : Infinity;
}

/**
 * Visibility test for FieldParams.visible: a sample votes in the IDW only if no detected barrier lies
 * between it and the estimated point.
 */
export function visibilityFilter(barriers: Barriers): (x: number, y: number, s: RhoSample) => boolean {
  return (x, y, s) => isVisible([x, y], [s.x, s.y], barriers);
}

/** Barrier segments in wire form (rounded to 0.1 m), strongest first. */
export function barrierPieces(barriers: Barriers): { a: XY; b: XY; kappa: number }[] {
  const r1 = (v: number) => Math.round(v * 10) / 10;
  return barriers.segments
    .slice()
    .sort((p, q) => q.kappa - p.kappa)
    .map((s) => ({
      a: [r1(s.a[0]), r1(s.a[1])],
      b: [r1(s.b[0]), r1(s.b[1])],
      kappa: Math.round(s.kappa * 100) / 100,
    }));
}
