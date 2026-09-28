/**
 * Walking-time field from sparse routing samples (prototype of the product's core estimator).
 *
 * Idea: interpolate the DETOUR RATIO, not the time.
 *   rho = t * v / r      (t = walking time from the center, v = walking speed, r = straight-line distance)
 * Walking time grows roughly linearly with distance, so interpolating t directly mixes near and far
 * samples and drags every contour toward the sample average. rho is close to stationary along a
 * direction: a river, rail line or elevated road raises rho for everything behind it. So we
 * interpolate rho (IDW over the k nearest samples, with an extra penalty for samples on a different
 * bearing from the center) and convert back with t = rho * r / v. rho >= 1 is enforced, because
 * nothing can be reached faster than in a straight line.
 */

export interface RhoSample {
  x: number;
  y: number;
  r: number; // straight-line distance from the center (m)
  theta: number; // bearing from the center (rad, 0 = north, clockwise)
  rho: number; // detour ratio t * v / r
}

export interface FieldParams {
  k: number; // neighbours used by IDW
  anisotropy: number; // weight divisor 1 + anisotropy * (bearing difference in rad); 0 = isotropic
  dFloor: number; // metres; distances below this count as dFloor (avoids infinite weights)
  speed: number; // walking speed (m/s) that converts route metres <-> seconds
  nearRadius: number; // inside this radius (m) the field uses the fixed ratio nearRho
  nearRho: number;
  interpolate: 'rho' | 'time'; // 'time' exists only as the baseline the product idea is compared with
  /**
   * Optional line-of-sight test (§5.2): a sample only votes if it is "visible" from the estimated
   * point, i.e. the straight segment between them crosses no detected barrier (see barrier.ts).
   * Unset by default, which keeps every estimate identical to the plain IDW.
   */
  visible?: (x: number, y: number, s: RhoSample) => boolean;
}

/** With a visibility filter the k voters come from this many times k nearest samples. */
const VISIBILITY_POOL = 4;

export const FIELD_DEFAULTS: FieldParams = {
  k: 10,
  anisotropy: 1.0,
  dFloor: 15,
  speed: 1.17,
  nearRadius: 40,
  nearRho: 1.25,
  interpolate: 'rho',
};

export function makeRhoSample(x: number, y: number, timeS: number, speed: number): RhoSample {
  const r = Math.hypot(x, y);
  return { x, y, r, theta: Math.atan2(x, y), rho: (timeS * speed) / r };
}

/** Absolute difference of two angles in radians, in [0, pi]. */
export function angleDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % (2 * Math.PI);
  return d > Math.PI ? 2 * Math.PI - d : d;
}

/** Walking-time estimate (s) at (x, y). `skip` excludes one sample index (leave-one-out). */
export function estimateTime(samples: RhoSample[], x: number, y: number, p: FieldParams, skip = -1): number {
  const r = Math.hypot(x, y);
  const straightS = r / p.speed;
  if (r < p.nearRadius) return straightS * p.nearRho;

  // k nearest samples by plain Euclidean distance (insertion into a sorted fixed-size buffer);
  // hidden samples are skipped later, so a visibility filter widens the candidate pool
  const visible = p.visible;
  const k = visible ? p.k * VISIBILITY_POOL : p.k;
  const bestD2 = new Float64Array(k).fill(Infinity);
  const bestI = new Int32Array(k).fill(-1);
  for (let i = 0; i < samples.length; i++) {
    if (i === skip) continue;
    const s = samples[i]!;
    const d2 = (s.x - x) ** 2 + (s.y - y) ** 2;
    if (d2 >= bestD2[k - 1]!) continue;
    let j = k - 1;
    while (j > 0 && bestD2[j - 1]! > d2) {
      bestD2[j] = bestD2[j - 1]!;
      bestI[j] = bestI[j - 1]!;
      j--;
    }
    bestD2[j] = d2;
    bestI[j] = i;
  }

  const theta = Math.atan2(x, y);
  let sw = 0;
  let sv = 0;
  let voters = 0;
  for (let j = 0; j < k && voters < p.k; j++) {
    const i = bestI[j]!;
    if (i < 0) break;
    const s = samples[i]!;
    if (visible && !visible(x, y, s)) continue;
    voters++;
    const d = Math.max(Math.sqrt(bestD2[j]!), p.dFloor);
    const w = 1 / (d * d * (1 + p.anisotropy * angleDiff(theta, s.theta)));
    sw += w;
    sv += w * (p.interpolate === 'rho' ? s.rho : (s.rho * s.r) / p.speed);
  }
  // boxed in by barriers on every side: better the unfiltered estimate than a hole in the field
  if (sw === 0 && visible) return estimateTime(samples, x, y, { ...p, visible: undefined }, skip);
  if (sw === 0) return NaN;
  const est = sv / sw;
  return p.interpolate === 'rho' ? Math.max(1, est) * straightS : Math.max(est, straightS);
}

/** Regular lattice of node values; row-major from (x0, y0), +x first, then +y. NaN = outside domain. */
export interface Grid {
  nx: number;
  ny: number;
  x0: number;
  y0: number;
  cell: number;
  values: Float64Array;
}

/** Evaluates the time field on the lattice nodes of the square [-extent, extent]^2 inside `radius`. */
export function timeGrid(
  samples: RhoSample[],
  p: FieldParams,
  extent: number,
  cell: number,
  radius: number,
): Grid {
  const n = Math.round((2 * extent) / cell) + 1;
  const values = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    const y = -extent + j * cell;
    for (let i = 0; i < n; i++) {
      const x = -extent + i * cell;
      values[j * n + i] = Math.hypot(x, y) <= radius ? estimateTime(samples, x, y, p) : NaN;
    }
  }
  return { nx: n, ny: n, x0: -extent, y0: -extent, cell, values };
}

/** Bilinear interpolation of the grid at (x, y); NaN outside the grid or next to outside nodes. */
export function sampleGrid(g: Grid, x: number, y: number): number {
  const fx = (x - g.x0) / g.cell;
  const fy = (y - g.y0) / g.cell;
  const i = Math.floor(fx);
  const j = Math.floor(fy);
  if (i < 0 || j < 0 || i >= g.nx - 1 || j >= g.ny - 1) return NaN;
  const tx = fx - i;
  const ty = fy - j;
  const v = g.values;
  const a = v[j * g.nx + i]!;
  const b = v[j * g.nx + i + 1]!;
  const c = v[(j + 1) * g.nx + i]!;
  const d = v[(j + 1) * g.nx + i + 1]!;
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

/** numpy-style linear-interpolated quantile of an unsorted array. */
export function quantile(values: number[], q: number): number {
  if (!values.length) return NaN;
  const a = values.slice().sort((u, v) => u - v);
  const pos = (a.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return a[lo]! + (a[hi]! - a[lo]!) * (pos - lo);
}

export interface LooReport {
  n: number;
  maeS: number;
  p90AbsS: number;
  rmseS: number;
  biasS: number; // mean(predicted - observed); > 0 means the field is pessimistic
  errors: number[]; // predicted - observed, in target order
}

/**
 * Leave-one-out validation: each target sample is predicted from all other samples.
 * `targets` are indices into `samples`; `observedS` are their observed walking times.
 */
export function leaveOneOut(
  samples: RhoSample[],
  targets: number[],
  observedS: number[],
  p: FieldParams,
): LooReport {
  const errors = targets.map(
    (idx, t) => estimateTime(samples, samples[idx]!.x, samples[idx]!.y, p, idx) - observedS[t]!,
  );
  const abs = errors.map(Math.abs);
  const n = errors.length;
  return {
    n,
    maeS: abs.reduce((s, e) => s + e, 0) / n,
    p90AbsS: quantile(abs, 0.9),
    rmseS: Math.sqrt(errors.reduce((s, e) => s + e * e, 0) / n),
    biasS: errors.reduce((s, e) => s + e, 0) / n,
    errors,
  };
}
