/**
 * Accuracy of a method against the dense reference, two ways:
 *
 *  - region metrics on the evaluation grid: IoU, symmetric-difference area and area ratio of the
 *    method's 15-minute region against the reference region (the reference field's own {t < 900 s},
 *    built by the same buildIsochrone machinery from the dense samples);
 *  - point metrics directly at the measured reference points, so the reference's own interpolation
 *    cannot flatter anyone: time error |t̂ − t| and the inside/outside verdict at 900 s. Only points
 *    within the 1,053 m circle count (beyond it nothing is reachable and every method says so), and
 *    points the method measured itself (within 5 m of one of its samples) are left out.
 */
import { quantile, type XY } from '@zoudedao/core';

import type { EvalGrid, Mask } from './lattice.js';
import { LEVEL_S, R15_M } from './methods.js';

export interface RegionMetrics {
  /** Method region, km² (nodes × cell²). */
  area_km2: number;
  ref_area_km2: number;
  /** |M ∩ R| / |M ∪ R|. */
  iou: number;
  /** |M △ R|, km². */
  sym_diff_km2: number;
  /** |M △ R| / |R|. */
  sym_diff_share: number;
  /** |M| / |R|: > 1 claims more than is reachable. */
  area_ratio: number;
  /** |M \ R|, km²: claimed reachable, not reachable. */
  false_inside_km2: number;
  /** |R \ M|, km²: reachable, not claimed. */
  false_outside_km2: number;
}

export function regionMetrics(method: Mask, reference: Mask, grid: EvalGrid): RegionMetrics {
  if (method.length !== reference.length) throw new Error('regionMetrics: masks differ in size');
  let both = 0;
  let onlyM = 0;
  let onlyR = 0;
  for (let k = 0; k < method.length; k++) {
    const m = method[k] === 1;
    const r = reference[k] === 1;
    if (m && r) both++;
    else if (m) onlyM++;
    else if (r) onlyR++;
  }
  const km2 = (n: number) => (n * grid.cell * grid.cell) / 1e6;
  const refN = both + onlyR;
  const union = both + onlyM + onlyR;
  return {
    area_km2: km2(both + onlyM),
    ref_area_km2: km2(refN),
    iou: union ? both / union : 1,
    sym_diff_km2: km2(onlyM + onlyR),
    sym_diff_share: refN ? (onlyM + onlyR) / refN : NaN,
    area_ratio: refN ? (both + onlyM) / refN : NaN,
    false_inside_km2: km2(onlyM),
    false_outside_km2: km2(onlyR),
  };
}

/** A measured reference point: t_s for a route, reachable = false with t_s = null when Baidu has none. */
export interface TruthPoint {
  xy: XY;
  t_s: number | null;
}

/** What a method says at a point. */
export interface PointEstimator {
  inside(xy: XY): boolean;
  /** Walking time estimate (s); absent for methods that only draw a region. */
  time?: (xy: XY) => number;
  /** Positions the method measured itself. */
  used: readonly XY[];
}

export interface PointOptions {
  level_s?: number;
  /** Points farther than this from the centre are left out (default 1,053 m). */
  domain_m?: number;
  /** Half-width of the boundary band |t − level|, seconds. */
  band_s?: number;
  /** A reference point this close to one of the method's own samples counts as used. */
  usedRadius_m?: number;
}

export interface TimeError {
  n: number;
  mae_s: number;
  p90_s: number;
  rmse_s: number;
  /** mean(t̂ − t): < 0 means the method is optimistic (claims shorter walks). */
  bias_s: number;
}

export interface PointMetrics {
  /** Points evaluated (inside the domain, measured, not used by the method). */
  n: number;
  /** Domain points left out because the method measured them itself. */
  n_used: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  accuracy: number;
  /** fp / (tp + fp): share of the points the method calls reachable in 15 min that are not. */
  false_inside_rate: number | null;
  /** fn / (tp + fn): share of the truly reachable points the method calls unreachable. */
  false_outside_rate: number | null;
  /** Points with |t − level| ≤ band_s (routes only): where the verdict is hard. */
  band: { n: number; accuracy: number | null };
  /** Over points with a route and a finite estimate; null for region-only methods. */
  time: TimeError | null;
}

export const POINT_DEFAULTS: Required<PointOptions> = {
  level_s: LEVEL_S,
  domain_m: R15_M,
  band_s: 180,
  usedRadius_m: 5,
};

/** Indexes positions on a coarse grid for "is any sample within d metres" queries. */
function nearIndex(pts: readonly XY[], d: number): (xy: XY) => boolean {
  const cell = Math.max(d, 1);
  const cells = new Map<string, XY[]>();
  for (const p of pts) {
    const k = `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)}`;
    const list = cells.get(k);
    if (list) list.push(p);
    else cells.set(k, [p]);
  }
  return (xy) => {
    const cx = Math.floor(xy[0] / cell);
    const cy = Math.floor(xy[1] / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const p of cells.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (Math.hypot(p[0] - xy[0], p[1] - xy[1]) <= d) return true;
        }
      }
    }
    return false;
  };
}

export function pointMetrics(
  points: readonly TruthPoint[],
  est: PointEstimator,
  opts: PointOptions = {},
): PointMetrics {
  const o = { ...POINT_DEFAULTS, ...opts };
  const used = nearIndex(est.used, o.usedRadius_m);
  let n = 0;
  let nUsed = 0;
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  let bandN = 0;
  let bandOk = 0;
  const errors: number[] = [];
  for (const p of points) {
    if (Math.hypot(p.xy[0], p.xy[1]) > o.domain_m) continue;
    if (used(p.xy)) {
      nUsed++;
      continue;
    }
    n++;
    const truth = p.t_s !== null && p.t_s < o.level_s;
    const said = est.inside(p.xy);
    if (truth && said) tp++;
    else if (said) fp++;
    else if (truth) fn++;
    else tn++;
    if (p.t_s !== null && Math.abs(p.t_s - o.level_s) <= o.band_s) {
      bandN++;
      if (truth === said) bandOk++;
    }
    if (est.time && p.t_s !== null) {
      const t = est.time(p.xy);
      if (Number.isFinite(t)) errors.push(t - p.t_s);
    }
  }
  const abs = errors.map(Math.abs);
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  return {
    n,
    n_used: nUsed,
    tp,
    fp,
    fn,
    tn,
    accuracy: n ? (tp + tn) / n : NaN,
    false_inside_rate: tp + fp ? fp / (tp + fp) : null,
    false_outside_rate: tp + fn ? fn / (tp + fn) : null,
    band: { n: bandN, accuracy: bandN ? bandOk / bandN : null },
    time:
      est.time && errors.length
        ? {
            n: errors.length,
            mae_s: mean(abs),
            p90_s: quantile(abs, 0.9),
            rmse_s: Math.sqrt(mean(errors.map((e) => e * e))),
            bias_s: mean(errors),
          }
        : null,
  };
}
