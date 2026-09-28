/**
 * Quota-aware adaptive sampling of walking times (design doc §5.4), as pure planning functions.
 * The caller sends the planned points to Baidu and feeds the answers back:
 *
 *   A  polarSeed          16 bearings × 3 rings in one 1×48 routematrix call      48 routes
 *   B  planPathProbes +   4–6 directionlite walks to 1.25 R; every vertex of the   4–6 directions
 *      pathPrefixSamples  answer becomes a time-labelled sample (prefixes of a
 *                         shortest path are shortest paths)
 *   C  planRefinement     rounds of 48 points near the uncertain boundary and      48–192 routes
 *                         near detected barriers, until `converged`
 */
import type { XY } from './coords.js';
import { bearingDeg } from './coords.js';
import type { Barriers, TimedPoint } from './barrier.js';
import { barrierDistance } from './barrier.js';
import type { Grid } from './field.js';
import { FIELD_DEFAULTS, angleDiff, sampleGrid } from './field.js';
import type { TimeSample } from './types.js';

// ------------------------------------------------------------------------------ A. polar seed

export interface PolarSeedOptions {
  /** Outer radius R, normally v·T (the largest distance a 15-minute walk can cover). */
  radius: number;
  bearings?: number;
  /** Ring radii as fractions of R. */
  rings?: readonly number[];
  /** Turns the whole pattern, e.g. half a sector for a second pass. */
  rotation_deg?: number;
}

export interface SeedPoint {
  xy: XY;
  bearing_deg: number;
  r_m: number;
  ring: number;
}

/** Stage A: bearings × rings, bearing-major (all rings of bearing 0 first), x east / y north. */
export function polarSeed(opts: PolarSeedOptions): SeedPoint[] {
  const { radius, bearings = 16, rings = [0.33, 0.67, 1.0], rotation_deg = 0 } = opts;
  const out: SeedPoint[] = [];
  for (let b = 0; b < bearings; b++) {
    const deg = (((rotation_deg + (360 * b) / bearings) % 360) + 360) % 360;
    const rad = (deg * Math.PI) / 180;
    rings.forEach((f, ring) => {
      const r = f * radius;
      out.push({ xy: [r * Math.sin(rad), r * Math.cos(rad)], bearing_deg: deg, r_m: r, ring });
    });
  }
  return out;
}

// --------------------------------------------------------------------------- B. path prefixes

export interface PathProbeOptions {
  /** Outer radius R of the seed. */
  radius: number;
  count?: number;
  /** Destinations sit at factor·R so the walked prefix covers the whole 15-minute boundary. */
  factor?: number;
  /** Sector width used to group samples by direction. */
  sector_deg?: number;
  /** Chosen directions keep at least this angle apart. */
  minSeparation_deg?: number;
}

export interface PathProbe {
  bearing_deg: number;
  xy: XY;
  /** Highest detour ratio seen in the sector. */
  rho_max: number;
  /** Largest change of the sector's highest ρ against its two neighbours. */
  jump: number;
  score: number;
}

/**
 * Stage B planning: the directions with the largest detour or the sharpest change of detour between
 * neighbouring sectors, i.e. where a walked route explains the most about the barriers.
 */
export function planPathProbes(
  samples: readonly Pick<TimeSample, 'xy' | 'rho'>[],
  opts: PathProbeOptions,
): PathProbe[] {
  const { radius, count = 4, factor = 1.25, sector_deg = 22.5, minSeparation_deg = 45 } = opts;
  const nSec = Math.max(1, Math.round(360 / sector_deg));
  const width = 360 / nSec;
  const best: Array<{ rho: number; bearing: number } | undefined> = new Array(nSec);
  for (const s of samples) {
    if (!Number.isFinite(s.rho)) continue;
    const b = bearingDeg(s.xy[0], s.xy[1]);
    const k = Math.round(b / width) % nSec;
    const cur = best[k];
    if (!cur || s.rho > cur.rho) best[k] = { rho: s.rho, bearing: b };
  }
  const cands: PathProbe[] = [];
  for (let k = 0; k < nSec; k++) {
    const cur = best[k];
    if (!cur) continue;
    let jump = 0;
    for (const nb of [best[(k + nSec - 1) % nSec], best[(k + 1) % nSec]]) {
      if (nb) jump = Math.max(jump, Math.abs(cur.rho - nb.rho));
    }
    const rad = (cur.bearing * Math.PI) / 180;
    const r = factor * radius;
    cands.push({
      bearing_deg: cur.bearing,
      xy: [r * Math.sin(rad), r * Math.cos(rad)],
      rho_max: cur.rho,
      jump,
      score: cur.rho + jump,
    });
  }
  cands.sort((p, q) => q.score - p.score);
  const picked: PathProbe[] = [];
  for (const c of cands) {
    if (picked.length >= count) break;
    const sep = (a: number, b: number) =>
      (angleDiff((a * Math.PI) / 180, (b * Math.PI) / 180) * 180) / Math.PI;
    if (picked.every((p) => sep(p.bearing_deg, c.bearing_deg) >= minSeparation_deg)) picked.push(c);
  }
  return picked;
}

/** One step of a Baidu directionlite walking route. */
export interface DirectionStep {
  /** Metres. */
  distance: number;
  /** Seconds. */
  duration: number;
  /** "lng,lat;lng,lat;…" as Baidu returns it, or vertices already projected to the local frame. */
  path: string | readonly XY[];
}

export interface PathPoint {
  xy: XY;
  /** Cumulative route metres, step distance spread along the step by length. */
  route_m: number;
  /** Cumulative directionlite seconds, step duration spread the same way. */
  t_s: number;
}

export interface PathPrefixOptions {
  /** Required when `path` is Baidu's raw string: BD-09 lng/lat → local metres. */
  project?: (lng: number, lat: number) => XY;
  /** Keep a vertex only when the route advanced this many metres since the last kept one (0 = all). */
  spacing_m?: number;
}

/**
 * Stage B: turns a walked route into time-labelled points. Each step's distance and duration are
 * spread over its vertices in proportion to length; repeated vertices (step joints) collapse.
 */
export function pathPrefixSamples(
  steps: readonly DirectionStep[],
  opts: PathPrefixOptions = {},
): PathPoint[] {
  const out: PathPoint[] = [];
  let T = 0;
  let D = 0;
  for (const st of steps) {
    let pts: readonly XY[];
    if (typeof st.path === 'string') {
      const project = opts.project;
      if (!project) throw new Error('pathPrefixSamples: raw "lng,lat;…" paths need a project callback');
      pts = st.path
        .split(';')
        .filter(Boolean)
        .map((tok) => {
          const [lng, lat] = tok.split(',').map(Number);
          return project(lng!, lat!);
        });
    } else {
      pts = st.path;
    }
    const cum = [0];
    for (let i = 1; i < pts.length; i++) {
      cum.push(cum[i - 1]! + Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]));
    }
    const L = cum[cum.length - 1] || 1;
    pts.forEach((xy, i) => {
      const last = out[out.length - 1];
      if (last && Math.hypot(last.xy[0] - xy[0], last.xy[1] - xy[1]) < 0.01) return;
      out.push({
        xy: [xy[0], xy[1]],
        t_s: T + (st.duration * cum[i]!) / L,
        route_m: D + (st.distance * cum[i]!) / L,
      });
    });
    T += st.duration;
    D += st.distance;
  }
  const spacing = opts.spacing_m ?? 0;
  if (!(spacing > 0) || out.length < 3) return out;
  const thin: PathPoint[] = [out[0]!];
  for (let i = 1; i < out.length - 1; i++) {
    if (out[i]!.route_m - thin[thin.length - 1]!.route_m >= spacing) thin.push(out[i]!);
  }
  thin.push(out[out.length - 1]!);
  return thin;
}

export interface PathSampleOptions {
  /** Routematrix speed: path samples get dur_s = route_m / speed so they agree with routematrix. */
  speed?: number;
  minStraight_m?: number;
  maxStraight_m?: number;
  set?: string;
  /** Index of the walked route, kept on each sample. */
  path?: number;
}

/** Path points as TimeSamples (src "directionlite_path"), measured from the frame origin. */
export function pathSamples(points: readonly PathPoint[], opts: PathSampleOptions = {}): TimeSample[] {
  const { speed = FIELD_DEFAULTS.speed, minStraight_m = 30, maxStraight_m = Infinity } = opts;
  const out: TimeSample[] = [];
  for (const p of points) {
    const straight = Math.hypot(p.xy[0], p.xy[1]);
    if (straight < minStraight_m || straight > maxStraight_m) continue;
    const s: TimeSample = {
      xy: p.xy,
      straight_m: straight,
      route_m: p.route_m,
      dur_s: p.route_m / speed,
      rho: p.route_m / straight,
      bearing_deg: bearingDeg(p.xy[0], p.xy[1]),
      src: 'directionlite_path',
      dur_dl_s: p.t_s,
    };
    if (opts.set !== undefined) s.set = opts.set;
    if (opts.path !== undefined) s.path = opts.path;
    out.push(s);
  }
  return out;
}

// ------------------------------------------------------------------------- C. boundary refinement

export interface RefinementOptions {
  /** Points per round (one 1×48 routematrix call). */
  batch?: number;
  /** Poisson-disk spacing between the points of one round, metres. */
  minSpacing?: number;
  /** Candidates closer than this to an existing sample are skipped (default minSpacing / 2). */
  minSampleGap?: number;
  /** Walking-time level(s) whose boundary is being refined, seconds. */
  target?: number | readonly number[];
  /** Candidate lattice spacing, metres. */
  candidateCell?: number;
  /** m/s of the times in `samples` and `grid`. */
  speed?: number;
  /** Candidates lie within this radius; default max(target)·speed, beyond which t ≥ r/v > T anyway. */
  radius?: number;
  minRadius?: number;
  barriers?: Barriers | null;
  /** Weight of barrier proximity: score × (1 + β·exp(−d/scale)). */
  beta?: number;
  barrierScale_m?: number;
  /** Neighbours for the local spread of ρ. */
  k?: number;
  sigmaFloor_s?: number;
}

export interface RefinementCandidate {
  xy: XY;
  score: number;
  /** Current estimate from the grid. */
  t_est_s: number;
  /** Estimated uncertainty of t_est_s. */
  sigma_s: number;
  nearest_sample_m: number;
  /** Distance to the nearest detected barrier (Infinity without barriers). */
  barrier_m: number;
}

/**
 * Stage C: scores lattice candidates by
 *
 *   boundary proximity  exp(−(t̂ − T)² / 2σ²)
 *   × novelty           1 − exp(−d_nearest / minSpacing)
 *   × barrier proximity 1 + β·exp(−d_barrier / scale)
 *
 * where σ combines the weighted spread of ρ among the k nearest samples (scaled by r/v) with the
 * distance to the nearest sample (the Lipschitz bound lets t drift by about d/v from it). The best
 * candidates are taken greedily with Poisson-disk spacing.
 */
export function planRefinement(
  samples: readonly TimedPoint[],
  grid: Grid,
  opts: RefinementOptions = {},
): RefinementCandidate[] {
  const batch = opts.batch ?? 48;
  const minSpacing = opts.minSpacing ?? 60;
  const minSampleGap = opts.minSampleGap ?? minSpacing / 2;
  const targets = typeof opts.target === 'number' ? [opts.target] : [...(opts.target ?? [900])];
  const cell = opts.candidateCell ?? 40;
  const v = opts.speed ?? FIELD_DEFAULTS.speed;
  const radius = opts.radius ?? Math.max(...targets) * v;
  const minRadius = opts.minRadius ?? 30;
  const beta = opts.beta ?? 1;
  const scale = opts.barrierScale_m ?? 60;
  const k = opts.k ?? FIELD_DEFAULTS.k;
  const sigmaFloor = opts.sigmaFloor_s ?? 15;
  const barriers = opts.barriers?.segments.length ? opts.barriers : null;

  const sx: number[] = [];
  const sy: number[] = [];
  const srho: number[] = [];
  const stheta: number[] = [];
  const allX: number[] = [];
  const allY: number[] = [];
  for (const s of samples) {
    allX.push(s.xy[0]);
    allY.push(s.xy[1]);
    const r = Math.hypot(s.xy[0], s.xy[1]);
    if (r < minRadius) continue;
    sx.push(s.xy[0]);
    sy.push(s.xy[1]);
    srho.push((s.dur_s * v) / r);
    stheta.push(Math.atan2(s.xy[0], s.xy[1]));
  }

  const cands: RefinementCandidate[] = [];
  const bestD2 = new Float64Array(k);
  const bestI = new Int32Array(k);
  const n0 = Math.ceil(radius / cell);
  for (let gj = -n0; gj <= n0; gj++) {
    for (let gi = -n0; gi <= n0; gi++) {
      const x = gi * cell;
      const y = gj * cell;
      const r = Math.hypot(x, y);
      if (r < minRadius || r > radius) continue;
      const t = sampleGrid(grid, x, y);
      if (!Number.isFinite(t)) continue;

      let dmin2 = Infinity;
      for (let i = 0; i < allX.length; i++)
        dmin2 = Math.min(dmin2, (allX[i]! - x) ** 2 + (allY[i]! - y) ** 2);
      const dmin = Math.sqrt(dmin2);
      if (dmin < minSampleGap) continue;

      bestD2.fill(Infinity);
      bestI.fill(-1);
      for (let i = 0; i < sx.length; i++) {
        const d2 = (sx[i]! - x) ** 2 + (sy[i]! - y) ** 2;
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
      let s1 = 0;
      let s2 = 0;
      for (let j = 0; j < k; j++) {
        const i = bestI[j]!;
        if (i < 0) break;
        const d = Math.max(Math.sqrt(bestD2[j]!), FIELD_DEFAULTS.dFloor);
        const w = 1 / (d * d * (1 + FIELD_DEFAULTS.anisotropy * angleDiff(theta, stheta[i]!)));
        sw += w;
        s1 += w * srho[i]!;
        s2 += w * srho[i]! * srho[i]!;
      }
      const mean = sw > 0 ? s1 / sw : 0;
      const sdRho = sw > 0 ? Math.sqrt(Math.max(0, s2 / sw - mean * mean)) : 0;
      const sigma = Math.max(sigmaFloor, Math.hypot((r / v) * sdRho, dmin / v));

      let boundary = 0;
      for (const T of targets) boundary = Math.max(boundary, Math.exp(-((t - T) ** 2) / (2 * sigma * sigma)));
      const novelty = 1 - Math.exp(-dmin / minSpacing);
      const barrier_m = barriers ? barrierDistance([x, y], barriers, 5 * scale) : Infinity;
      const near = Number.isFinite(barrier_m) ? Math.exp(-barrier_m / scale) : 0;
      const score = boundary * novelty * (1 + beta * near);
      if (score > 1e-9)
        cands.push({ xy: [x, y], score, t_est_s: t, sigma_s: sigma, nearest_sample_m: dmin, barrier_m });
    }
  }

  cands.sort((p, q) => q.score - p.score);
  const picked: RefinementCandidate[] = [];
  const min2 = minSpacing * minSpacing;
  for (const c of cands) {
    if (picked.length >= batch) break;
    if (picked.every((p) => (p.xy[0] - c.xy[0]) ** 2 + (p.xy[1] - c.xy[1]) ** 2 >= min2)) picked.push(c);
  }
  return picked;
}

/** Stops refining once the area changed by at most `tol` (relative) between two rounds. */
export function converged(prevArea: number, nextArea: number, tol = 0.03): boolean {
  if (!(prevArea > 0)) return prevArea === nextArea;
  return Math.abs(nextArea - prevArea) / prevArea <= tol;
}

/**
 * Symmetric difference of {t < level} between two fields on the same lattice, as a share of the
 * earlier region: the stricter form of the §5.4 stopping rule.
 */
export function symmetricDifferenceShare(prev: Grid, next: Grid, level: number): number {
  if (
    prev.nx !== next.nx ||
    prev.ny !== next.ny ||
    prev.x0 !== next.x0 ||
    prev.y0 !== next.y0 ||
    prev.cell !== next.cell
  ) {
    throw new Error('symmetricDifferenceShare: grids must share one lattice');
  }
  let inPrev = 0;
  let changed = 0;
  for (let i = 0; i < prev.values.length; i++) {
    const a = prev.values[i]! < level;
    const b = next.values[i]! < level;
    if (a) inPrev++;
    if (a !== b) changed++;
  }
  return inPrev ? changed / inPrev : changed ? Infinity : 0;
}

// ------------------------------------------------------------------------------- quota ledger

/** Pipeline stages of one health check (the SSE stages of docs/api.md that spend routes). */
export type QuotaStage = 'seed' | 'paths' | 'refine' | 'reach' | 'coverage' | 'siting';

export interface QuotaUse {
  /** Routematrix routes (origins × destinations: what Baidu bills). */
  routes: number;
  /** Directionlite walking requests (a separate quota pool). */
  directions: number;
  /** HTTP requests of either kind. */
  requests: number;
}

export interface QuotaLimits {
  routes: number;
  directions: number;
}

/** Personal-tier budget of one cold health check, per design doc §4.4. */
export const CHECK_BUDGET = {
  isochrone: { routes: 240, directions: 6 },
  reach: { routes: 100, directions: 0 },
  coverage: { routes: 400, directions: 0 },
} as const satisfies Record<string, QuotaLimits>;

export interface QuotaLedger {
  limits: QuotaLimits;
  used: Partial<Record<QuotaStage, QuotaUse>>;
}

export function createLedger(limits: QuotaLimits = CHECK_BUDGET.isochrone): QuotaLedger {
  return { limits: { ...limits }, used: {} };
}

/** Returns a new ledger with `use` added to `stage`. */
export function chargeLedger(ledger: QuotaLedger, stage: QuotaStage, use: Partial<QuotaUse>): QuotaLedger {
  const cur = ledger.used[stage] ?? { routes: 0, directions: 0, requests: 0 };
  return {
    limits: ledger.limits,
    used: {
      ...ledger.used,
      [stage]: {
        routes: cur.routes + (use.routes ?? 0),
        directions: cur.directions + (use.directions ?? 0),
        requests: cur.requests + (use.requests ?? 0),
      },
    },
  };
}

export function ledgerTotals(ledger: QuotaLedger): QuotaUse {
  const t: QuotaUse = { routes: 0, directions: 0, requests: 0 };
  for (const u of Object.values(ledger.used)) {
    t.routes += u.routes;
    t.directions += u.directions;
    t.requests += u.requests;
  }
  return t;
}

export function remainingQuota(ledger: QuotaLedger): QuotaLimits {
  const t = ledgerTotals(ledger);
  return {
    routes: Math.max(0, ledger.limits.routes - t.routes),
    directions: Math.max(0, ledger.limits.directions - t.directions),
  };
}

/** Cost of routing origins × destinations with routematrix batches of at most maxPairs routes. */
export function matrixUse(origins: number, destinations: number, maxPairs = 50): QuotaUse {
  const routes = origins * destinations;
  return { routes, directions: 0, requests: routes ? Math.ceil(routes / maxPairs) : 0 };
}
