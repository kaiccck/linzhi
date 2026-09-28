/**
 * Travel-time field helpers for the map, ported from design/mockups/shared/geo.js.
 * Kept local on purpose: packages/core is being refactored in parallel and these are render-side
 * helpers (rasterising for canvas, marching-squares segments for the moving front).
 * Frame: local metres around the analysis centre, x east, y north.
 */
import type { TimeField, XY } from '@zoudedao/core';

/** Bilinear sampler over the travel-time lattice; returns -1 outside the domain. */
export function fieldSampler(field: TimeField): (x: number, y: number) => number {
  const { nx, ny, x0, y0, cell_m: c, t_s: t } = field;
  const at = (k: number) => t[k] ?? -1;
  return (x, y) => {
    const fx = (x - x0) / c;
    const fy = (y - y0) / c;
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    if (i < 0 || j < 0 || i >= nx - 1 || j >= ny - 1) return -1;
    const a = at(j * nx + i);
    const b = at(j * nx + i + 1);
    const d = at((j + 1) * nx + i);
    const e = at((j + 1) * nx + i + 1);
    if (a < 0 || b < 0 || d < 0 || e < 0) return -1;
    const tx = fx - i;
    const ty = fy - j;
    return (a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty;
  };
}

export interface Raster {
  w: number;
  h: number;
  /** metres per texel */
  res: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** seconds from the centre per texel, row 0 = north edge; -1 outside */
  t: Float32Array;
}

/** Pre-sample the field on a regular metre grid (res metres per texel) for fast per-frame recolouring. */
export function rasterize(field: TimeField, res: number): Raster {
  const sample = fieldSampler(field);
  const { x0, y0 } = field;
  const w = Math.round(((field.nx - 1) * field.cell_m) / res);
  const h = Math.round(((field.ny - 1) * field.cell_m) / res);
  const t = new Float32Array(w * h);
  for (let r = 0; r < h; r++) {
    const my = y0 + (h - 1 - r + 0.5) * res;
    for (let q = 0; q < w; q++) t[r * w + q] = sample(x0 + (q + 0.5) * res, my);
  }
  return { w, h, res, x0, y0, x1: x0 + w * res, y1: y0 + h * res, t };
}

/** Marching squares at level T (seconds); scale multiplies stored times (slower walkers). */
export function isoSegments(field: TimeField, T: number, scale = 1): [number, number, number, number][] {
  const { nx, ny, x0, y0, cell_m: c, t_s } = field;
  const v = (i: number, j: number) => {
    const k = t_s[j * nx + i] ?? -1;
    return k < 0 ? -1 : k * scale;
  };
  const out: [number, number, number, number][] = [];
  const lerp = (p: number, q: number) => (T - p) / (q - p);
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = v(i, j);
      const b = v(i + 1, j);
      const e = v(i + 1, j + 1);
      const d = v(i, j + 1);
      if (a < 0 || b < 0 || e < 0 || d < 0) continue;
      const k = (a > T ? 1 : 0) | (b > T ? 2 : 0) | (e > T ? 4 : 0) | (d > T ? 8 : 0);
      if (k === 0 || k === 15) continue;
      const x = x0 + i * c;
      const y = y0 + j * c;
      const E0 = (): XY => [x + lerp(a, b) * c, y];
      const E1 = (): XY => [x + c, y + lerp(b, e) * c];
      const E2 = (): XY => [x + lerp(d, e) * c, y + c];
      const E3 = (): XY => [x, y + lerp(a, d) * c];
      const seg = (p: XY, q: XY) => out.push([p[0], p[1], q[0], q[1]]);
      switch (k) {
        case 1:
        case 14:
          seg(E3(), E0());
          break;
        case 2:
        case 13:
          seg(E0(), E1());
          break;
        case 3:
        case 12:
          seg(E3(), E1());
          break;
        case 4:
        case 11:
          seg(E1(), E2());
          break;
        case 6:
        case 9:
          seg(E0(), E2());
          break;
        case 7:
        case 8:
          seg(E3(), E2());
          break;
        case 5:
          seg(E3(), E2());
          seg(E0(), E1());
          break;
        case 10:
          seg(E3(), E0());
          seg(E1(), E2());
          break;
      }
    }
  }
  return out;
}

/** Compass bearing from a to b in degrees (0 = north, clockwise). */
export const bearingTo = (a: XY, b: XY): number =>
  ((Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI + 360) % 360;

/** Longest visible run of a named line: midpoint + angle for an along-road label. */
export function roadLabelAnchor(
  lines: { name: string | null; pts: XY[] }[],
  name: string,
  bounds?: [number, number, number, number],
): { x: number; y: number; ang: number } | null {
  let best: { len: number; x: number; y: number; ang: number } | null = null;
  for (const r of lines) {
    if (r.name !== name) continue;
    for (let i = 0; i < r.pts.length - 1; i++) {
      const p = r.pts[i];
      const q = r.pts[i + 1];
      if (!p || !q) continue;
      const mx = (p[0] + q[0]) / 2;
      const my = (p[1] + q[1]) / 2;
      if (bounds && (mx < bounds[0] || mx > bounds[2] || my < bounds[1] || my > bounds[3])) continue;
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (!best || len > best.len) best = { len, x: mx, y: my, ang: Math.atan2(q[1] - p[1], q[0] - p[0]) };
    }
  }
  return best;
}

/** The point of a ring set that sits closest to a bearing from the centre (farthest on ties). */
export function ringPointAt(rings: XY[][], bearing: number): XY | null {
  let best: { d: number; p: XY } | null = null;
  for (const p of rings[0] ?? []) {
    const b = bearingTo([0, 0], p);
    const d = Math.abs(((b - bearing + 540) % 360) - 180);
    if (
      !best ||
      d < best.d - 0.5 ||
      (Math.abs(d - best.d) <= 0.5 && Math.hypot(...p) > Math.hypot(...best.p))
    ) {
      best = { d, p };
    }
  }
  return best ? best.p : null;
}
