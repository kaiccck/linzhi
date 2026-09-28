/**
 * Geometry of the evaluation: the reference lattice (measured points) and the evaluation grid on which
 * regions are compared. All coordinates are local metres around the area centre (x east, y north), the
 * frame of @zoudedao/core's localFrame, so XY here equals XY in the engine's results.
 */
import { pointInRing, type Grid, type XY } from '@zoudedao/core';

export interface LatticePoint {
  /** Lattice indices: xy = ij × spacing. */
  ij: [number, number];
  xy: XY;
}

/**
 * Every lattice point at `spacing` inside the disc of `radius` (boundary included), without the centre
 * itself (origin = destination needs no route). Ordered from the centre outward (then by bearing), so a
 * measurement stopped halfway has the inner points, where the 15-minute boundary lies, done first.
 */
export function referenceLattice(spacing = 100, radius = 1600): LatticePoint[] {
  if (!(spacing > 0) || !(radius > 0)) throw new Error('referenceLattice: spacing and radius must be > 0');
  const n = Math.floor(radius / spacing);
  const out: (LatticePoint & { r: number; b: number })[] = [];
  for (let j = -n; j <= n; j++) {
    for (let i = -n; i <= n; i++) {
      if (i === 0 && j === 0) continue;
      const x = i * spacing;
      const y = j * spacing;
      const r = Math.hypot(x, y);
      // a hair of tolerance so points exactly on the circle count at any spacing
      if (r > radius + 1e-9) continue;
      const b = (Math.atan2(x, y) + 2 * Math.PI) % (2 * Math.PI);
      out.push({ ij: [i, j], xy: [x, y], r, b });
    }
  }
  out.sort((p, q) => p.r - q.r || p.b - q.b);
  return out.map(({ ij, xy }) => ({ ij, xy }));
}

/** The lattice the engine's final field lives on (EXTENT_M 1,600 m, FINAL_CELL_M 20 m): 161 × 161 nodes. */
export interface EvalGrid {
  x0: number;
  y0: number;
  cell: number;
  nx: number;
  ny: number;
}

export const EVAL_GRID: EvalGrid = { x0: -1600, y0: -1600, cell: 20, nx: 161, ny: 161 };

export function sameGrid(a: EvalGrid, b: EvalGrid): boolean {
  return a.x0 === b.x0 && a.y0 === b.y0 && a.cell === b.cell && a.nx === b.nx && a.ny === b.ny;
}

/** A region as the set of evaluation-grid nodes inside it (1 = inside); each node stands for cell² m². */
export type Mask = Uint8Array;

export function maskOf(grid: EvalGrid, inside: (x: number, y: number) => boolean): Mask {
  const m = new Uint8Array(grid.nx * grid.ny);
  for (let j = 0; j < grid.ny; j++) {
    const y = grid.y0 + j * grid.cell;
    for (let i = 0; i < grid.nx; i++) if (inside(grid.x0 + i * grid.cell, y)) m[j * grid.nx + i] = 1;
  }
  return m;
}

/** Nodes of a time field faster than `level` seconds (NaN nodes are outside the domain). */
export function maskFromField(field: Grid, level: number): Mask {
  const m = new Uint8Array(field.nx * field.ny);
  field.values.forEach((v, k) => {
    if (v < level) m[k] = 1;
  });
  return m;
}

/** Inside a set of closed rings by the even-odd rule (outer rings with their holes, islands in holes). */
export function insideRings(rings: readonly XY[][]): (x: number, y: number) => boolean {
  const boxes = rings.map((ring) => {
    let xmin = Infinity;
    let ymin = Infinity;
    let xmax = -Infinity;
    let ymax = -Infinity;
    for (const [x, y] of ring) {
      xmin = Math.min(xmin, x);
      ymin = Math.min(ymin, y);
      xmax = Math.max(xmax, x);
      ymax = Math.max(ymax, y);
    }
    return { ring, xmin, ymin, xmax, ymax };
  });
  return (x, y) => {
    let inside = false;
    for (const b of boxes) {
      if (x < b.xmin || x > b.xmax || y < b.ymin || y > b.ymax) continue;
      if (pointInRing(x, y, b.ring)) inside = !inside;
    }
    return inside;
  };
}

export function maskArea_m2(mask: Mask, grid: EvalGrid): number {
  let n = 0;
  for (const v of mask) n += v;
  return n * grid.cell * grid.cell;
}
