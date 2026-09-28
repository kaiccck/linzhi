/**
 * Isochrone assembly (design doc §5.5): samples → detrended IDW field → 5/10/15-minute rings →
 * areas, straight-circle baseline, reach per bearing and the straight-vs-walk gap summary. Produces
 * the `field`, `contours`, `contours_meta`, `baseline` and isochrone `stats` of an AnalysisResult.
 * Rounding follows data/samples/*.json: 0.1 m for coordinates, whole seconds in the field.
 */
import type { XY } from './coords.js';
import { bearingDeg } from './coords.js';
import { chaikin, isoRings, nestRings } from './contour.js';
import type { FieldParams, Grid, LooReport, RhoSample } from './field.js';
import { FIELD_DEFAULTS, leaveOneOut, makeRhoSample, quantile, sampleGrid, timeGrid } from './field.js';
import { ringSignedArea } from './geom.js';
import { simplifyRing } from './simplify.js';
import { TASK_RULE_M } from './standards.js';
import type { ContourMeta, GapSummary, IsoLevel, ReachByBearing, TimeField, TimeSample } from './types.js';

/** Baidu routematrix walking speed: every measured answer has duration = distance / 1.17. */
export const WALK_SPEED_MPS = 1.17;
export const ISO_LEVELS: readonly IsoLevel[] = ['300', '600', '900'];

const r1 = (v: number) => Math.round(v * 10) / 10;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const rPts = (pts: XY[]): XY[] => pts.map((p) => [r1(p[0]), r1(p[1])]);

export interface IsochroneOptions {
  /** Walker speed for the output times; lower it for an elderly profile (routes stay the same). */
  speed?: number;
  /** Speed behind the samples' dur_s (Baidu routematrix). */
  sampleSpeed?: number;
  /** Half-size of the square lattice, metres. */
  extent_m?: number;
  cell_m?: number;
  /** Nodes farther than this from the centre are outside the domain (default extent_m). */
  radius_m?: number;
  /** Estimator overrides, e.g. { visible: visibilityFilter(barriers) }. */
  field?: Partial<FieldParams>;
  /** Samples closer to the centre than this carry no usable detour ratio. */
  minStraight_m?: number;
  chaikin?: number;
  /** Douglas–Peucker tolerance applied after smoothing, metres (0 = off). */
  simplify_m?: number;
  /** Smoothed rings smaller than this are dropped (grid speckle). */
  minRing_m2?: number;
  bearingStep_deg?: number;
  /** Leave-one-out validation over the routematrix samples. */
  loo?: boolean;
}

export interface IsochroneStats {
  n_samples: number;
  n_samples_by_src: Record<string, number>;
  loo_mae_s?: number;
  loo_p90_abs_err_s?: number;
  loo_rmse_s?: number;
  loo_bias_s?: number;
  loo_n?: number;
  area_iso15_km2: number;
  /** Lattice-node count estimate of the same area (cross-check of the ring area). */
  area_iso15_grid_km2: number;
  area_circle15_km2: number;
  overstate_x: number;
  reach_share: number;
  areas_km2: Record<IsoLevel, { iso: number; circle: number }>;
  straight_vs_walk_gap_summary: GapSummary;
  reach_by_bearing: ReachByBearing[];
  reach_note: string;
}

export interface IsochroneResult {
  field: TimeField;
  contours: Record<IsoLevel, XY[][]>;
  contours_meta: Record<IsoLevel, ContourMeta[]>;
  baseline: { circle_r15_m: number; rule_radius_m: number; note: string };
  stats: IsochroneStats;
  /** Full-precision lattice (NaN outside) for planning and further analysis; not part of the wire model. */
  grid: Grid;
  /** The estimator's samples; index[i] is the position of rho[i] in the input. */
  rho: RhoSample[];
  index: number[];
  /** Ring chains that hit the lattice border (0 unless the extent is smaller than level·speed). */
  open_chains: number;
}

/** Detour-ratio samples for the estimator: ρ = dur_s · sampleSpeed / straight, near-centre samples dropped. */
export function rhoSamplesOf(
  samples: readonly Pick<TimeSample, 'xy' | 'dur_s'>[],
  sampleSpeed = WALK_SPEED_MPS,
  minStraight_m = 30,
): { rho: RhoSample[]; index: number[] } {
  const rho: RhoSample[] = [];
  const index: number[] = [];
  samples.forEach((s, i) => {
    if (Math.hypot(s.xy[0], s.xy[1]) < minStraight_m || !(s.dur_s > 0)) return;
    rho.push(makeRhoSample(s.xy[0], s.xy[1], s.dur_s, sampleSpeed));
    index.push(i);
  });
  return { rho, index };
}

export interface ContourOptions {
  chaikin?: number;
  simplify_m?: number;
  minRing_m2?: number;
}

export interface LevelContours {
  /** Closed rings, outer rings each followed by their holes. */
  rings: XY[][];
  meta: ContourMeta[];
  /** Outer minus hole area, measured on the smoothed rings before simplification. */
  area_m2: number;
  openChains: number;
}

/** Marching squares at one level → Chaikin → speckle filter → nesting → Douglas–Peucker. */
export function levelContours(grid: Grid, level: number, opts: ContourOptions = {}): LevelContours {
  const { chaikin: passes = 2, simplify_m = 5, minRing_m2 = 1000 } = opts;
  const iso = isoRings(grid, level);
  const smoothed = iso.rings
    .map((r) => chaikin(r, passes))
    .filter((r) => Math.abs(ringSignedArea(r)) >= minRing_m2);
  const nested = nestRings(smoothed);
  const rings: XY[][] = [];
  const meta: ContourMeta[] = [];
  const newIndex = new Map<number, number>();
  let area = 0;
  nested.forEach((n, k) => {
    if (n.hole && !newIndex.has(n.parent)) return; // its outer ring collapsed
    const ring = simplify_m > 0 ? simplifyRing(n.ring, simplify_m) : n.ring;
    if (ring.length < 4) return;
    if (!n.hole) newIndex.set(k, rings.length);
    rings.push(ring);
    meta.push({
      hole: n.hole,
      parent: n.hole ? newIndex.get(n.parent)! : null,
      area_m2: Math.round(n.areaM2),
    });
    area += n.hole ? -n.areaM2 : n.areaM2;
  });
  return { rings, meta, area_m2: area, openChains: iso.openChains };
}

/**
 * Straight distance at which walking time first reaches each level along a bearing, walking outward
 * from the centre in 2 m steps over the bilinear field. NaN if the level is never reached.
 */
export function reachByBearing(grid: Grid, maxR: number, stepDeg = 5): ReachByBearing[] {
  const levels = ISO_LEVELS.map(Number);
  const out: ReachByBearing[] = [];
  for (let b = 0; b < 360; b += stepDeg) {
    const rad = (b * Math.PI) / 180;
    const found = levels.map((level) => {
      let prevT = 0;
      for (let r = 2; r <= maxR; r += 2) {
        const t = sampleGrid(grid, r * Math.sin(rad), r * Math.cos(rad));
        if (t >= level) return r - 2 + (2 * (level - prevT)) / (t - prevT);
        prevT = t;
      }
      return NaN;
    });
    out.push({ b, r300: Math.round(found[0]!), r600: Math.round(found[1]!), r900: Math.round(found[2]!) });
  }
  return out;
}

/** How much the straight line understates walking, over the routematrix samples from the centre. */
export function gapSummary(
  samples: readonly TimeSample[],
  speed = WALK_SPEED_MPS,
  limit_s = 900,
  minStraight_m = 30,
): GapSummary {
  const rm = samples.filter((s) => s.src === 'routematrix' && s.straight_m >= minStraight_m);
  const rhoOf = (s: TimeSample) => (s.dur_s * speed) / s.straight_m;
  const rho = rm.map(rhoOf);
  const r15 = Math.round(limit_s * speed);
  const inCircle = rm.filter((s) => s.straight_m <= r15);
  const late = inCircle.filter((s) => s.dur_s > limit_s);
  const worst = rm
    .slice()
    .sort((a, b) => rhoOf(b) - rhoOf(a))
    .slice(0, 5)
    .map((s) => {
      const w: GapSummary['worst'][number] = {
        bearing_deg: r1(bearingDeg(s.xy[0], s.xy[1])),
        straight_m: r1(s.straight_m),
        route_m: s.route_m,
        dur_s: s.dur_s,
        rho: r3(rhoOf(s)),
      };
      if (s.set !== undefined) w.set = s.set;
      return w;
    });
  return {
    basis: 'routematrix samples from the center',
    n: rm.length,
    rho_median: r3(quantile(rho, 0.5)),
    rho_p75: r3(quantile(rho, 0.75)),
    rho_p90: r3(quantile(rho, 0.9)),
    rho_max: r3(rho.length ? Math.max(...rho) : NaN),
    n_inside_circle15: inCircle.length,
    n_inside_circle15_over_900s: late.length,
    share_inside_circle15_over_900s: r3(inCircle.length ? late.length / inCircle.length : NaN),
    median_extra_s_inside_circle15: r1(
      quantile(
        inCircle.map((s) => s.dur_s - s.straight_m / speed),
        0.5,
      ),
    ),
    worst,
  };
}

/** Wire form of a lattice: whole seconds, -1 outside the domain. */
export function fieldFromGrid(grid: Grid, note?: string): TimeField {
  return {
    cell_m: grid.cell,
    nx: grid.nx,
    ny: grid.ny,
    x0: grid.x0,
    y0: grid.y0,
    t_s: Array.from(grid.values, (v) => (Number.isNaN(v) ? -1 : Math.round(v))),
    note:
      note ??
      'row-major from (x0,y0) going +x then +y; values sit on lattice nodes x0 + i*cell_m, y0 + j*cell_m; -1 = outside domain',
  };
}

/** Inverse of fieldFromGrid, e.g. to sample a stored field with sampleGrid. */
export function gridFromField(field: TimeField): Grid {
  return {
    nx: field.nx,
    ny: field.ny,
    x0: field.x0,
    y0: field.y0,
    cell: field.cell_m,
    values: Float64Array.from(field.t_s, (v) => (v < 0 ? NaN : v)),
  };
}

const looSummary = (r: LooReport) => ({
  loo_mae_s: r1(r.maeS),
  loo_p90_abs_err_s: r1(r.p90AbsS),
  loo_rmse_s: r1(r.rmseS),
  loo_bias_s: r1(r.biasS),
  loo_n: r.n,
});

/** Builds the isochrone part of an AnalysisResult from walking-time samples taken from the centre. */
export function buildIsochrone(samples: readonly TimeSample[], opts: IsochroneOptions = {}): IsochroneResult {
  const sampleSpeed = opts.sampleSpeed ?? WALK_SPEED_MPS;
  const speed = opts.speed ?? sampleSpeed;
  const extent = opts.extent_m ?? 1600;
  const cell = opts.cell_m ?? 20;
  const radius = opts.radius_m ?? extent;
  const minStraight = opts.minStraight_m ?? 30;
  const p: FieldParams = { ...FIELD_DEFAULTS, ...opts.field, speed };

  const { rho, index } = rhoSamplesOf(samples, sampleSpeed, minStraight);
  const grid = timeGrid(rho, p, extent, cell, radius);

  const contours = {} as Record<IsoLevel, XY[][]>;
  const contoursMeta = {} as Record<IsoLevel, ContourMeta[]>;
  const areaKm2 = {} as Record<IsoLevel, number>;
  let openChains = 0;
  for (const level of ISO_LEVELS) {
    const c = levelContours(grid, Number(level), {
      chaikin: opts.chaikin ?? 2,
      simplify_m: opts.simplify_m ?? 5,
      minRing_m2: opts.minRing_m2 ?? 1000,
    });
    contours[level] = c.rings.map(rPts);
    contoursMeta[level] = c.meta;
    areaKm2[level] = c.area_m2 / 1e6;
    openChains += c.openChains;
  }

  const limit = 900;
  let nodes15 = 0;
  for (const v of grid.values) if (v < limit) nodes15++;
  const circleKm2 = (level: number) => (Math.PI * (level * speed) ** 2) / 1e6;
  const area15 = areaKm2['900'];
  const circle15 = circleKm2(limit);

  const bySrc: Record<string, number> = {};
  for (const i of index) {
    const src = samples[i]!.src;
    bySrc[src] = (bySrc[src] ?? 0) + 1;
  }

  const stats: IsochroneStats = {
    n_samples: rho.length,
    n_samples_by_src: bySrc,
    area_iso15_km2: r3(area15),
    area_iso15_grid_km2: r3((nodes15 * cell * cell) / 1e6),
    area_circle15_km2: r3(circle15),
    overstate_x: Math.round((circle15 / area15) * 100) / 100,
    reach_share: r3(area15 / circle15),
    areas_km2: Object.fromEntries(
      ISO_LEVELS.map((l) => [l, { iso: r3(areaKm2[l]), circle: r3(circleKm2(Number(l))) }]),
    ) as Record<IsoLevel, { iso: number; circle: number }>,
    // describes the measured routes themselves, so it stays at the samples' speed for every profile
    straight_vs_walk_gap_summary: gapSummary(samples, sampleSpeed, limit, minStraight),
    reach_by_bearing: reachByBearing(grid, extent, opts.bearingStep_deg ?? 5),
    reach_note:
      'b = bearing (deg, this frame); r300/r600/r900 = straight distance (m) at which walking time first reaches the level along that bearing',
  };

  if (opts.loo ?? true) {
    const targets: number[] = [];
    const observed: number[] = [];
    index.forEach((si, fi) => {
      const s = samples[si]!;
      if (s.src !== 'routematrix') return;
      targets.push(fi);
      observed.push((s.dur_s * sampleSpeed) / speed);
    });
    if (targets.length) Object.assign(stats, looSummary(leaveOneOut(rho, targets, observed, p)));
  }

  return {
    field: fieldFromGrid(grid),
    contours,
    contours_meta: contoursMeta,
    baseline: {
      circle_r15_m: Math.round(limit * speed),
      rule_radius_m: TASK_RULE_M.小学,
      note: 'circle_r15_m = 900 s × walking speed: what a straight-line 15-minute circle claims; rule_radius_m = the 1 km facility rule of the task',
    },
    stats,
    grid,
    rho,
    index,
    open_chains: openChains,
  };
}
