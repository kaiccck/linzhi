/**
 * Small planar geometry toolkit (local metric frame): clipping, rings, nearest-segment lookup.
 * Rings are arrays of points; "closed" rings repeat the first point at the end (GeoJSON style).
 */
import type { LngLat, XY } from './coords.js';

export interface Box {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
}

export function squareBox(half: number): Box {
  return { xmin: -half, ymin: -half, xmax: half, ymax: half };
}

export function inBox(p: XY, b: Box): boolean {
  return p[0] >= b.xmin && p[0] <= b.xmax && p[1] >= b.ymin && p[1] <= b.ymax;
}

function lerp(p: XY, q: XY, t: number): XY {
  return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
}

/** Liang-Barsky: parameter interval [t0, t1] of segment p->q inside the box, or null. */
function clipSegment(p: XY, q: XY, b: Box): [number, number] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const P = [-dx, dx, -dy, dy];
  const Q = [p[0] - b.xmin, b.xmax - p[0], p[1] - b.ymin, b.ymax - p[1]];
  for (let k = 0; k < 4; k++) {
    const pk = P[k]!;
    const qk = Q[k]!;
    if (pk === 0) {
      if (qk < 0) return null;
      continue;
    }
    const r = qk / pk;
    if (pk < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  return [t0, t1];
}

/** Clips a polyline to the box; a line that leaves and re-enters becomes several pieces. */
export function clipPolyline(pts: XY[], b: Box): XY[][] {
  const out: XY[][] = [];
  let cur: XY[] | null = null;
  for (let i = 0; i + 1 < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[i + 1]!;
    const c = clipSegment(p, q, b);
    if (!c) {
      if (cur) out.push(cur);
      cur = null;
      continue;
    }
    if (cur && c[0] > 0) {
      out.push(cur);
      cur = null;
    }
    if (!cur) cur = [lerp(p, q, c[0])];
    cur.push(lerp(p, q, c[1]));
    if (c[1] < 1) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out.filter((l) => l.length >= 2);
}

/** Drops the closing duplicate point if present. */
export function openRing(ring: XY[]): XY[] {
  const n = ring.length;
  if (n > 1 && ring[0]![0] === ring[n - 1]![0] && ring[0]![1] === ring[n - 1]![1])
    return ring.slice(0, n - 1);
  return ring.slice();
}

/** Ensures first point == last point. */
export function closeRing(ring: XY[]): XY[] {
  const open = openRing(ring);
  return open.length ? [...open, [open[0]![0], open[0]![1]]] : [];
}

/**
 * Sutherland-Hodgman clip of a polygon ring against the box. Concave rings that leave and re-enter
 * the box get zero-area "bridges" along the box edge, which is harmless for filled rendering.
 * Returns a closed ring or [] if nothing remains.
 */
export function clipRing(ring: XY[], b: Box): XY[] {
  let pts = openRing(ring);
  const planes: Array<[(p: XY) => boolean, (p: XY, q: XY) => XY]> = [
    [(p) => p[0] >= b.xmin, (p, q) => lerp(p, q, (b.xmin - p[0]) / (q[0] - p[0]))],
    [(p) => p[0] <= b.xmax, (p, q) => lerp(p, q, (b.xmax - p[0]) / (q[0] - p[0]))],
    [(p) => p[1] >= b.ymin, (p, q) => lerp(p, q, (b.ymin - p[1]) / (q[1] - p[1]))],
    [(p) => p[1] <= b.ymax, (p, q) => lerp(p, q, (b.ymax - p[1]) / (q[1] - p[1]))],
  ];
  for (const [inside, cross] of planes) {
    if (!pts.length) return [];
    const out: XY[] = [];
    for (let i = 0; i < pts.length; i++) {
      const cur = pts[i]!;
      const prev = pts[(i + pts.length - 1) % pts.length]!;
      const ci = inside(cur);
      const pi = inside(prev);
      if (ci) {
        if (!pi) out.push(cross(prev, cur));
        out.push(cur);
      } else if (pi) {
        out.push(cross(prev, cur));
      }
    }
    pts = out;
  }
  return pts.length >= 3 ? closeRing(pts) : [];
}

/** Shoelace area; positive for counter-clockwise rings (x east, y north). Works on open or closed rings. */
export function ringSignedArea(ring: XY[]): number {
  const pts = openRing(ring);
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export function ringCentroid(ring: XY[]): XY {
  const pts = openRing(ring);
  const a = ringSignedArea(pts);
  if (Math.abs(a) < 1e-9) {
    const sx = pts.reduce((s, p) => s + p[0], 0);
    const sy = pts.reduce((s, p) => s + p[1], 0);
    return [sx / pts.length, sy / pts.length];
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    const f = p[0] * q[1] - q[0] * p[1];
    cx += (p[0] + q[0]) * f;
    cy += (p[1] + q[1]) * f;
  }
  return [cx / (6 * a), cy / (6 * a)];
}

/** Even-odd point-in-polygon test. */
export function pointInRing(x: number, y: number, ring: XY[]): boolean {
  const pts = openRing(ring);
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]!;
    const [xj, yj] = pts[j]!;
    if (yi > y !== yj > y && x < xi + ((y - yi) * (xj - xi)) / (yj - yi)) inside = !inside;
  }
  return inside;
}

export function polylineLength(pts: XY[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++)
    L += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
  return L;
}

/** Squared distance from p to segment a-b. */
export function segDist2(p: XY, a: XY, b: XY): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy;
  let t = L2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  const ex = a[0] + t * dx - p[0];
  const ey = a[1] + t * dy - p[1];
  return ex * ex + ey * ey;
}

/**
 * Joins open ways end-to-end into closed rings by exact coordinate equality (OSM multipolygon
 * members share their end nodes). Rings that cannot be closed are returned as-is (still open).
 */
export function assembleRings(ways: LngLat[][]): LngLat[][] {
  const same = (a: LngLat, b: LngLat) => a[0] === b[0] && a[1] === b[1];
  const segs = ways.filter((w) => w.length >= 2).map((w) => w.slice());
  const rings: LngLat[][] = [];
  while (segs.length) {
    let cur = segs.shift()!;
    let changed = true;
    while (!same(cur[0]!, cur[cur.length - 1]!) && changed) {
      changed = false;
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i]!;
        const head = cur[0]!;
        const tail = cur[cur.length - 1]!;
        if (same(s[0]!, tail)) cur = cur.concat(s.slice(1));
        else if (same(s[s.length - 1]!, tail)) cur = cur.concat(s.slice().reverse().slice(1));
        else if (same(s[s.length - 1]!, head)) cur = s.slice(0, -1).concat(cur);
        else if (same(s[0]!, head)) cur = s.slice().reverse().slice(0, -1).concat(cur);
        else continue;
        segs.splice(i, 1);
        changed = true;
        break;
      }
    }
    rings.push(cur);
  }
  return rings;
}

/** Uniform-grid spatial index over polyline segments for nearest-segment queries. */
export interface SegmentIndex {
  nSegments: number;
  /** Distance to the nearest segment within maxR (Infinity if none) and that segment's line id. */
  nearest(x: number, y: number, maxR: number): { d: number; line: number };
}

export function buildSegmentIndex(lines: XY[][], cell = 50): SegmentIndex {
  const ax: number[] = [];
  const ay: number[] = [];
  const bx: number[] = [];
  const by: number[] = [];
  const lineOf: number[] = [];
  const grid = new Map<string, number[]>();
  lines.forEach((pts, li) => {
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1]!;
      const q = pts[i]!;
      const id = ax.length;
      ax.push(p[0]);
      ay.push(p[1]);
      bx.push(q[0]);
      by.push(q[1]);
      lineOf.push(li);
      const gx0 = Math.floor(Math.min(p[0], q[0]) / cell);
      const gx1 = Math.floor(Math.max(p[0], q[0]) / cell);
      const gy0 = Math.floor(Math.min(p[1], q[1]) / cell);
      const gy1 = Math.floor(Math.max(p[1], q[1]) / cell);
      for (let gx = gx0; gx <= gx1; gx++) {
        for (let gy = gy0; gy <= gy1; gy++) {
          const k = gx + ',' + gy;
          const list = grid.get(k);
          if (list) list.push(id);
          else grid.set(k, [id]);
        }
      }
    }
  });
  return {
    nSegments: ax.length,
    nearest(x, y, maxR) {
      let best = Infinity;
      let line = -1;
      const gx0 = Math.floor((x - maxR) / cell);
      const gx1 = Math.floor((x + maxR) / cell);
      const gy0 = Math.floor((y - maxR) / cell);
      const gy1 = Math.floor((y + maxR) / cell);
      for (let gx = gx0; gx <= gx1; gx++) {
        for (let gy = gy0; gy <= gy1; gy++) {
          const list = grid.get(gx + ',' + gy);
          if (!list) continue;
          for (const id of list) {
            const d2 = segDist2([x, y], [ax[id]!, ay[id]!], [bx[id]!, by[id]!]);
            if (d2 < best) {
              best = d2;
              line = lineOf[id]!;
            }
          }
        }
      }
      const d = Math.sqrt(best);
      return d <= maxR ? { d, line } : { d: Infinity, line: -1 };
    },
  };
}

/** Twice the signed area of triangle a-b-c: > 0 when c lies left of a->b (counter-clockwise). */
export function orient(a: XY, b: XY, c: XY): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onSegment(a: XY, b: XY, p: XY): boolean {
  return (
    Math.min(a[0], b[0]) <= p[0] &&
    p[0] <= Math.max(a[0], b[0]) &&
    Math.min(a[1], b[1]) <= p[1] &&
    p[1] <= Math.max(a[1], b[1])
  );
}

/** True if the closed segments p1-p2 and q1-q2 share a point (touching counts). */
export function segmentsIntersect(p1: XY, p2: XY, q1: XY, q2: XY): boolean {
  const d1 = orient(q1, q2, p1);
  const d2 = orient(q1, q2, p2);
  const d3 = orient(p1, p2, q1);
  const d4 = orient(p1, p2, q2);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  return (
    (d1 === 0 && onSegment(q1, q2, p1)) ||
    (d2 === 0 && onSegment(q1, q2, p2)) ||
    (d3 === 0 && onSegment(p1, p2, q1)) ||
    (d4 === 0 && onSegment(p1, p2, q2))
  );
}

/** Points every `spacing` metres along a polyline, starting with its first vertex. */
export function resamplePolyline(pts: XY[], spacing: number): XY[] {
  if (!pts.length || !(spacing > 0)) return pts.slice();
  const out: XY[] = [[pts[0]![0], pts[0]![1]]];
  let carry = 0; // metres walked since the last emitted point
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let s = spacing - carry;
    while (s <= len) {
      const t = s / len;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      s += spacing;
    }
    carry = len - (s - spacing);
  }
  return out;
}
