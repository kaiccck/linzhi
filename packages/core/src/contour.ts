/**
 * Iso-lines of a lattice field as closed, consistently oriented rings.
 *
 *  - marching squares on the lattice nodes; region = {value < level}
 *  - every cell emits oriented segments with the region on the LEFT, so assembled outer boundaries
 *    are counter-clockwise (positive area, x east / y north) and holes are clockwise
 *  - saddle cells are resolved with the cell-centre average (connected if the centre is inside)
 *  - segment end points live on lattice edges, so rings are assembled by edge id, not by float equality
 *  - Chaikin corner cutting smooths the 20 m staircase before output
 */
import type { XY } from './coords.js';
import type { Grid } from './field.js';
import { closeRing, openRing, pointInRing, ringSignedArea } from './geom.js';

/** Value used for nodes outside the domain (NaN): always outside any region. */
const OUTSIDE = 1e12;

export interface IsoResult {
  rings: XY[][]; // closed rings (first point repeated at the end)
  openChains: number; // chains that hit the lattice border (0 when the region stays inside the domain)
}

export function isoRings(g: Grid, level: number): IsoResult {
  const { nx, ny, x0, y0, cell, values } = g;
  const val = (i: number, j: number): number => {
    const v = values[j * nx + i]!;
    return Number.isNaN(v) ? OUTSIDE : v;
  };
  // Edge ids: horizontal edge (i,j)-(i+1,j) = 2*(j*nx+i); vertical edge (i,j)-(i,j+1) = 2*(j*nx+i)+1.
  const hEdge = (i: number, j: number) => 2 * (j * nx + i);
  const vEdge = (i: number, j: number) => 2 * (j * nx + i) + 1;
  const edgePoint = (id: number): XY => {
    const node = id >> 1;
    const i = node % nx;
    const j = (node - i) / nx;
    const vertical = (id & 1) === 1;
    const va = val(i, j);
    const vb = vertical ? val(i, j + 1) : val(i + 1, j);
    const t = (level - va) / (vb - va);
    const x = x0 + (i + (vertical ? 0 : t)) * cell;
    const y = y0 + (j + (vertical ? t : 0)) * cell;
    return [x, y];
  };

  const next = new Map<number, number>(); // exit edge -> entry edge within the same cell
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      // corners counter-clockwise: p0 (i,j), p1 (i+1,j), p2 (i+1,j+1), p3 (i,j+1)
      const v: [number, number, number, number] = [
        val(i, j),
        val(i + 1, j),
        val(i + 1, j + 1),
        val(i, j + 1),
      ];
      const inside = v.map((x) => x < level);
      const mask = (inside[0] ? 1 : 0) | (inside[1] ? 2 : 0) | (inside[2] ? 4 : 0) | (inside[3] ? 8 : 0);
      if (mask === 0 || mask === 15) continue;
      // edge k joins corner k and corner k+1 (counter-clockwise traversal of the cell boundary)
      const edges = [hEdge(i, j), vEdge(i + 1, j), hEdge(i, j + 1), vEdge(i, j)];
      const exits: number[] = [];
      const entries: number[] = [];
      const order: Array<'x' | 'n'> = [];
      for (let k = 0; k < 4; k++) {
        const a = inside[k];
        const b = inside[(k + 1) % 4];
        if (a && !b) {
          exits.push(k);
          order.push('x');
        } else if (!a && b) {
          entries.push(k);
          order.push('n');
        }
      }
      if (exits.length === 1) {
        // walking from the exit crossing to the entry crossing keeps the region on the left
        next.set(edges[exits[0]!]!, edges[entries[0]!]!);
        continue;
      }
      // saddle: crossings alternate exit/entry around the cell; pair each exit with the next entry
      // (region connected through the centre) or with the previous one (region split)
      const connected = (v[0] + v[1] + v[2] + v[3]) / 4 < level;
      for (const e of exits) {
        const later = entries.filter((n) => n > e);
        const earlier = entries.filter((n) => n < e);
        const nextEntry = later.length ? later[0]! : entries[0]!;
        const prevEntry = earlier.length ? earlier[earlier.length - 1]! : entries[entries.length - 1]!;
        next.set(edges[e]!, edges[connected ? nextEntry : prevEntry]!);
      }
    }
  }

  const rings: XY[][] = [];
  const used = new Set<number>();
  let openChains = 0;
  for (const start of next.keys()) {
    if (used.has(start)) continue;
    const ring: XY[] = [];
    let e: number | undefined = start;
    while (e !== undefined && !used.has(e)) {
      used.add(e);
      ring.push(edgePoint(e));
      e = next.get(e);
    }
    if (e !== start) openChains++;
    if (ring.length >= 3) rings.push(closeRing(dedupe(ring)));
  }
  return { rings, openChains };
}

/** Removes consecutive duplicate points (a contour can pass exactly through a lattice node). */
function dedupe(pts: XY[]): XY[] {
  return pts.filter((p, i) => {
    const q = pts[(i + pts.length - 1) % pts.length]!;
    return i === 0 || p[0] !== q[0] || p[1] !== q[1];
  });
}

/** Chaikin corner cutting on a closed ring (each pass doubles the vertex count). */
export function chaikin(ring: XY[], iterations: number): XY[] {
  let pts = openRing(ring);
  for (let it = 0; it < iterations; it++) {
    const out: XY[] = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]!;
      const q = pts[(i + 1) % pts.length]!;
      out.push([0.75 * p[0] + 0.25 * q[0], 0.75 * p[1] + 0.25 * q[1]]);
      out.push([0.25 * p[0] + 0.75 * q[0], 0.25 * p[1] + 0.75 * q[1]]);
    }
    pts = out;
  }
  return closeRing(pts);
}

export interface NestedRing {
  ring: XY[];
  hole: boolean;
  parent: number; // index of the enclosing outer ring in the same list, -1 for outer rings
  areaM2: number; // absolute area
}

/**
 * Orders rings as: outer rings by decreasing area, each followed by its holes. Hole/outer is decided
 * by orientation (holes are clockwise); each hole is attached to the smallest outer ring containing it.
 */
export function nestRings(rings: XY[][]): NestedRing[] {
  const info = rings.map((ring) => ({ ring, a: ringSignedArea(ring) }));
  const outers = info.filter((r) => r.a > 0).sort((p, q) => q.a - p.a);
  const holes = info.filter((r) => r.a < 0);
  const holesOf = outers.map(() => [] as typeof holes);
  for (const h of holes) {
    const [hx, hy] = h.ring[0]!;
    let best = -1;
    for (let k = 0; k < outers.length; k++) {
      const o = outers[k]!;
      if (pointInRing(hx, hy, o.ring) && (best < 0 || o.a < outers[best]!.a)) best = k;
    }
    if (best >= 0) holesOf[best]!.push(h);
  }
  const out: NestedRing[] = [];
  outers.forEach((o, k) => {
    const parent = out.length;
    out.push({ ring: o.ring, hole: false, parent: -1, areaM2: o.a });
    for (const h of holesOf[k]!.sort((p, q) => p.a - q.a))
      out.push({ ring: h.ring, hole: true, parent, areaM2: -h.a });
  });
  return out;
}
