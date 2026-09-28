import { describe, expect, it } from 'vitest';

import { readRaw, riverWorld, zjA, zjFrame } from '../test/fixtures.js';
import { barrierDistance, detectBarriers, visibilityFilter } from './barrier.js';
import type { XY } from './coords.js';
import type { Grid } from './field.js';
import { quantile } from './field.js';
import { buildIsochrone } from './isochrone.js';
import type { DirectionStep } from './sampling.js';
import {
  chargeLedger,
  converged,
  createLedger,
  ledgerTotals,
  matrixUse,
  pathPrefixSamples,
  pathSamples,
  planPathProbes,
  planRefinement,
  polarSeed,
  remainingQuota,
  symmetricDifferenceShare,
} from './sampling.js';
import type { TimeSample } from './types.js';

const R15 = 900 * 1.17;

describe('stage A: polar seed', () => {
  it('lays 16 bearings × 3 rings, bearing-major, x east / y north', () => {
    const seed = polarSeed({ radius: R15 });
    expect(seed).toHaveLength(48);
    expect(seed.slice(0, 3).map((p) => p.r_m)).toEqual([0.33 * R15, 0.67 * R15, R15]);
    expect(seed[2]!.xy[0]).toBeCloseTo(0, 9);
    expect(seed[2]!.xy[1]).toBeCloseTo(R15, 9);
    const east = seed.find((p) => p.bearing_deg === 90 && p.ring === 2)!;
    expect(east.xy[0]).toBeCloseTo(R15, 9);
    expect(east.xy[1]).toBeCloseTo(0, 9);
    const turned = polarSeed({ radius: 100, bearings: 4, rings: [1], rotation_deg: 45 });
    expect(turned.map((p) => p.bearing_deg)).toEqual([45, 135, 225, 315]);
  });
});

describe('stage B: path prefixes', () => {
  interface Walk {
    status: number;
    result: { routes: { distance: number; duration: number; steps: DirectionStep[] }[] };
  }
  const raw = readRaw<Walk>('research/zhangjiang/raw/bv_directionlite_A_b090.json');
  const route = raw.response.result.routes[0]!;
  const frame = zjFrame();

  it('picks the directions with the largest detour or detour jump from the real seed', () => {
    const rays = zjA().samples.filter((s) => s.set === 'rays_A');
    const probes = planPathProbes(rays, { radius: R15, count: 4 });
    expect(probes).toHaveLength(4);
    // the research walked b090 and b330 for exactly this reason
    expect(probes[0]!.bearing_deg).toBeCloseTo(88.8, 0);
    expect(Math.abs(probes[1]!.bearing_deg - 330)).toBeLessThan(3);
    for (const p of probes) expect(Math.hypot(p.xy[0], p.xy[1])).toBeCloseTo(1.25 * R15, 6);
    for (let i = 0; i < probes.length; i++) {
      for (let j = i + 1; j < probes.length; j++) {
        const d = Math.abs(probes[i]!.bearing_deg - probes[j]!.bearing_deg) % 360;
        expect(Math.min(d, 360 - d)).toBeGreaterThanOrEqual(45);
      }
    }
  });

  it('spreads step times and distances over the vertices by length (matches the stored paths)', () => {
    const pts = pathPrefixSamples(route.steps, { project: frame.toXY });
    const stored = zjA().paths[0]!;
    expect(stored.pts).toHaveLength(pts.length);
    pts.forEach((p, i) => {
      const [x, y, t, d] = stored.pts[i]!;
      expect(Math.abs(p.xy[0] - x)).toBeLessThanOrEqual(0.051);
      expect(Math.abs(p.xy[1] - y)).toBeLessThanOrEqual(0.051);
      expect(Math.abs(p.t_s - t)).toBeLessThanOrEqual(0.051);
      expect(Math.abs(p.route_m - d)).toBeLessThanOrEqual(0.051);
    });
    const last = pts[pts.length - 1]!;
    expect(last.route_m).toBeCloseTo(route.distance, 6);
    expect(last.t_s).toBeCloseTo(route.duration, 6);
  });

  it('accepts pre-projected steps and thins by route distance', () => {
    const projected = route.steps.map((st) => ({
      ...st,
      path: String(st.path)
        .split(';')
        .filter(Boolean)
        .map((tok) => {
          const [lng, lat] = tok.split(',').map(Number);
          return frame.toXY(lng!, lat!);
        }),
    }));
    expect(pathPrefixSamples(projected)).toEqual(pathPrefixSamples(route.steps, { project: frame.toXY }));
    expect(() => pathPrefixSamples(route.steps)).toThrow(/project/);
    const thin = pathPrefixSamples(projected, { spacing_m: 50 });
    expect(thin.length).toBeLessThan(route.distance / 50 + 2);
    for (let i = 1; i < thin.length - 1; i++)
      expect(thin[i]!.route_m - thin[i - 1]!.route_m).toBeGreaterThanOrEqual(50);
  });

  it('turns path points into routematrix-consistent TimeSamples', () => {
    const pts = pathPrefixSamples(route.steps, { project: frame.toXY });
    const samples = pathSamples(pts, { set: 'dl_b090', path: 0, maxStraight_m: 1600 });
    expect(samples.every((s) => s.straight_m >= 30 && s.straight_m <= 1600)).toBe(true);
    for (const s of samples) {
      expect(s.src).toBe('directionlite_path');
      expect(s.dur_s).toBeCloseTo(s.route_m / 1.17, 9);
      expect(s.rho).toBeCloseTo(s.route_m / s.straight_m, 9);
    }
    // every stored b090 sample (the others were de-duplicated against routematrix points) is reproduced
    const stored = zjA().samples.filter((s) => s.set === 'dl_b090');
    expect(stored.length).toBeGreaterThan(50);
    for (const s of stored) {
      const twin = samples.find((q) => Math.hypot(q.xy[0] - s.xy[0], q.xy[1] - s.xy[1]) < 0.1);
      expect(twin).toBeDefined();
      expect(Math.abs(twin!.dur_s - s.dur_s)).toBeLessThanOrEqual(0.051);
    }
  });
});

describe('stage C: boundary refinement', () => {
  const zj = zjA();
  const iso = buildIsochrone(zj.samples, { loo: false });
  const picks = planRefinement(zj.samples, iso.grid);

  it('plans one 48-point round near the 15-minute boundary with Poisson-disk spacing', () => {
    expect(picks).toHaveLength(48);
    for (let i = 0; i < picks.length; i++) {
      const p = picks[i]!;
      expect(Math.hypot(p.xy[0], p.xy[1])).toBeLessThanOrEqual(R15 + 1e-9);
      expect(p.nearest_sample_m).toBeGreaterThanOrEqual(30);
      for (let j = i + 1; j < picks.length; j++) {
        expect(Math.hypot(p.xy[0] - picks[j]!.xy[0], p.xy[1] - picks[j]!.xy[1])).toBeGreaterThanOrEqual(60);
      }
    }
    expect(
      quantile(
        picks.map((p) => Math.abs(p.t_est_s - 900)),
        0.5,
      ),
    ).toBeLessThan(100);
    expect(picks[0]!.score).toBeGreaterThanOrEqual(picks[47]!.score);
  });

  it('pulls points towards detected barriers', () => {
    const b = detectBarriers(zj.samples.filter((s) => s.straight_m >= 30));
    const near = planRefinement(zj.samples, iso.grid, { barriers: b });
    const med = (xs: XY[]) =>
      quantile(
        xs.map((xy) => barrierDistance(xy, b, 5000)),
        0.5,
      );
    expect(med(near.map((p) => p.xy))).toBeLessThan(0.6 * med(picks.map((p) => p.xy)));
  });

  it('respects smaller batches and several target levels', () => {
    const few = planRefinement(zj.samples, iso.grid, { batch: 5, target: [300, 600, 900] });
    expect(few).toHaveLength(5);
  });
});

describe('closed loop on a synthetic river (seed → refine → converge)', () => {
  const world = riverWorld();
  const measure = (xy: XY): TimeSample => {
    const t = world.time(xy[0], xy[1]);
    const r = Math.hypot(xy[0], xy[1]);
    return {
      xy,
      straight_m: r,
      route_m: t * 1.17,
      dur_s: t,
      rho: (t * 1.17) / r,
      bearing_deg: 0,
      src: 'routematrix',
    };
  };
  /** Share of the true 15-minute region that the estimate gets wrong, on the estimate's lattice. */
  const error = (g: Grid) => {
    let wrong = 0;
    let inside = 0;
    for (let j = 0; j < g.ny; j++) {
      for (let i = 0; i < g.nx; i++) {
        const truth = world.time(g.x0 + i * g.cell, g.y0 + j * g.cell) < 900;
        if (truth) inside++;
        if (g.values[j * g.nx + i]! < 900 !== truth) wrong++;
      }
    }
    return wrong / inside;
  };
  const opts = { loo: false, extent_m: 1200, cell_m: 25 };

  it('shrinks the boundary error within the 240-route isochrone budget and keeps the books', () => {
    let samples = polarSeed({ radius: R15 }).map((p) => measure(p.xy));
    let ledger = chargeLedger(createLedger(), 'seed', matrixUse(1, samples.length));
    let res = buildIsochrone(samples, opts);
    const seedError = error(res.grid);
    let prevArea = res.stats.area_iso15_km2;
    let prevGrid = res.grid;
    let lastChange = Infinity;
    while (remainingQuota(ledger).routes > 0) {
      const barriers = detectBarriers(samples);
      const round = planRefinement(samples, res.grid, {
        barriers,
        batch: Math.min(48, remainingQuota(ledger).routes),
      });
      samples = samples.concat(round.map((c) => measure(c.xy)));
      ledger = chargeLedger(ledger, 'refine', matrixUse(1, round.length));
      res = buildIsochrone(samples, {
        ...opts,
        field: { visible: visibilityFilter(detectBarriers(samples)) },
      });
      lastChange = symmetricDifferenceShare(prevGrid, res.grid, 900);
      expect(converged(prevArea, res.stats.area_iso15_km2, 0.05)).toBe(true);
      prevArea = res.stats.area_iso15_km2;
      prevGrid = res.grid;
    }
    const finalError = error(res.grid);
    expect(seedError).toBeGreaterThan(0.04);
    expect(finalError).toBeLessThan(0.4 * seedError);
    expect(lastChange).toBeLessThan(0.03);
    expect(ledgerTotals(ledger)).toEqual({ routes: 240, directions: 0, requests: 5 });
    expect(ledger.used.seed).toEqual({ routes: 48, directions: 0, requests: 1 });
    expect(ledger.used.refine!.routes).toBe(192);
  });
});

describe('stopping rule and quota ledger', () => {
  it('compares areas relatively and regions by symmetric difference', () => {
    expect(converged(1.8, 1.85)).toBe(true);
    expect(converged(1.8, 1.9)).toBe(false);
    expect(converged(0, 0)).toBe(true);
    const g = (vals: number[]): Grid => ({
      nx: 2,
      ny: 2,
      x0: 0,
      y0: 0,
      cell: 1,
      values: Float64Array.from(vals),
    });
    expect(symmetricDifferenceShare(g([1, 1, 5, 5]), g([1, 5, 5, 5]), 2)).toBe(0.5);
    expect(symmetricDifferenceShare(g([1, 1, 5, 5]), g([1, 1, 5, 5]), 2)).toBe(0);
    expect(() => symmetricDifferenceShare(g([1, 1, 5, 5]), { ...g([1, 1, 5, 5]), cell: 2 }, 2)).toThrow();
  });

  it('charges stages immutably and never reports negative remaining quota', () => {
    const a = createLedger({ routes: 100, directions: 2 });
    const b = chargeLedger(a, 'seed', matrixUse(1, 48));
    const c = chargeLedger(
      chargeLedger(b, 'paths', { directions: 2, requests: 2 }),
      'refine',
      matrixUse(2, 40),
    );
    expect(a.used).toEqual({});
    expect(ledgerTotals(c)).toEqual({ routes: 128, directions: 2, requests: 5 });
    expect(remainingQuota(c)).toEqual({ routes: 0, directions: 0 });
    expect(matrixUse(3, 50)).toEqual({ routes: 150, directions: 0, requests: 3 });
    expect(matrixUse(0, 5).requests).toBe(0);
  });
});
