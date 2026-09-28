/** Hand-made cases for the pure parts: lattice, masks, metrics, star16 geometry, budgets, formatting. */
import { ringSignedArea, type XY } from '@zoudedao/core';
import { describe, expect, it } from 'vitest';

import { stringify } from '../src/artefacts.js';
import {
  EVAL_GRID,
  insideRings,
  maskArea_m2,
  maskFromField,
  maskOf,
  referenceLattice,
  type EvalGrid,
} from '../src/lattice.js';
import {
  engineBudget,
  engineCalls,
  engineMethod,
  measuredMethods,
  methodOrder,
  R15_M,
  specOf,
} from '../src/methods.js';
import { pointMetrics, regionMetrics, type TruthPoint } from '../src/metrics.js';
import { chunks, displayWidth, methodCalls } from '../src/plan.js';
import { rayReach, starPoints, starPolygon, starRays } from '../src/star16.js';
import { niceCeil, overlayEngineId, textWidth } from '../src/svg.js';

describe('reference lattice', () => {
  it('covers the 1,600 m disc at 100 m: every lattice point once, no centre, inner points first', () => {
    const pts = referenceLattice(100, 1600);
    // Gauss circle count N(16) = 797 lattice points with i² + j² ≤ 256, minus the centre
    expect(pts).toHaveLength(796);
    const keys = new Set(pts.map((p) => p.ij.join(',')));
    expect(keys.size).toBe(796);
    expect(keys.has('0,0')).toBe(false);
    for (let j = -16; j <= 16; j++) {
      for (let i = -16; i <= 16; i++) {
        if (i === 0 && j === 0) continue;
        expect(keys.has(`${i},${j}`), `${i},${j}`).toBe(i * i + j * j <= 256);
      }
    }
    for (const p of pts) expect(p.xy).toEqual([p.ij[0] * 100, p.ij[1] * 100]);
    const r = pts.map((p) => Math.hypot(...p.xy));
    expect(r.every((v, k) => k === 0 || v >= r[k - 1]!)).toBe(true);
    expect(Math.max(...r)).toBe(1600);
    // other spacings: the boundary is inclusive
    expect(referenceLattice(50, 100).map((p) => p.ij.join(','))).toContain('0,2');
    expect(referenceLattice(200, 1000)).toHaveLength(80);
  });
});

describe('masks', () => {
  const g: EvalGrid = { x0: 0, y0: 0, cell: 10, nx: 5, ny: 5 };

  it('reads a field below a level (NaN outside), rings by the even-odd rule, and areas in m²', () => {
    const values = Float64Array.from({ length: 25 }, (_, k) => (k === 24 ? NaN : k * 10));
    const m = maskFromField({ ...g, values }, 60);
    expect([...m].slice(0, 8)).toEqual([1, 1, 1, 1, 1, 1, 0, 0]);
    expect(m[24]).toBe(0);
    expect(maskArea_m2(m, g)).toBe(600);
    // a 40 m square with a 20 m hole: 5 × 5 nodes, the hole's single interior node (20, 20) out
    const outer: XY[] = [
      [-1, -1],
      [41, -1],
      [41, 41],
      [-1, 41],
      [-1, -1],
    ];
    const hole: XY[] = [
      [15, 15],
      [15, 25],
      [25, 25],
      [25, 15],
      [15, 15],
    ];
    const inside = insideRings([outer, hole]);
    expect(inside(20, 20)).toBe(false);
    expect(inside(10, 10)).toBe(true);
    expect(inside(50, 50)).toBe(false);
    expect([...maskOf(g, inside)].reduce((a, b) => a + b, 0)).toBe(24);
  });

  it('the evaluation grid is the engine field lattice: 161 × 161 nodes at 20 m over ±1,600 m', () => {
    expect(EVAL_GRID).toEqual({ x0: -1600, y0: -1600, cell: 20, nx: 161, ny: 161 });
  });
});

describe('region metrics', () => {
  const g: EvalGrid = { x0: 0, y0: 0, cell: 10, nx: 10, ny: 10 };
  const block = (x0: number, y0: number, w: number, h: number) =>
    maskOf(g, (x, y) => x >= x0 && x < x0 + w && y >= y0 && y < y0 + h);

  it('IoU, symmetric difference, area ratio and the two error areas of shifted blocks', () => {
    // reference 4 × 4 nodes; the method is the same block shifted by 2 nodes in x: overlap 2 × 4
    const ref = block(0, 0, 40, 40);
    const m = block(20, 0, 40, 40);
    const r = regionMetrics(m, ref, g);
    expect(r.ref_area_km2).toBeCloseTo(16 * 100 * 1e-6, 12);
    expect(r.area_km2).toBeCloseTo(1600e-6, 12);
    expect(r.iou).toBeCloseTo(8 / 24, 12);
    expect(r.sym_diff_km2).toBeCloseTo(16 * 100 * 1e-6, 12);
    expect(r.sym_diff_share).toBeCloseTo(1, 12);
    expect(r.false_inside_km2).toBeCloseTo(800e-6, 12);
    expect(r.false_outside_km2).toBeCloseTo(800e-6, 12);
    expect(r.area_ratio).toBe(1);
    // a method claiming twice the area around the reference
    const big = regionMetrics(block(0, 0, 80, 40), ref, g);
    expect(big.area_ratio).toBe(2);
    expect(big.iou).toBe(0.5);
    expect(big.false_outside_km2).toBe(0);
    // identical, disjoint
    expect(regionMetrics(ref, ref, g)).toMatchObject({ iou: 1, sym_diff_km2: 0, area_ratio: 1 });
    expect(regionMetrics(block(60, 60, 20, 20), ref, g).iou).toBe(0);
    expect(() => regionMetrics(new Uint8Array(3), ref, g)).toThrow();
  });
});

describe('point metrics', () => {
  // t = 900 s boundary; points at 100 m steps east; one far point beyond 1,053 m, one without a route
  const pts: TruthPoint[] = [
    { xy: [100, 0], t_s: 200 }, // reachable, method inside: TP
    { xy: [200, 0], t_s: 850 }, // reachable, method outside: FN (band)
    { xy: [300, 0], t_s: 950 }, // not reachable, method inside: FP (band)
    { xy: [400, 0], t_s: 1400 }, // not reachable, method outside: TN
    { xy: [500, 0], t_s: null }, // no route: not reachable; method inside: FP; no time error
    { xy: [1100, 0], t_s: 2000 }, // beyond 1,053 m: not evaluated
    { xy: [0, 600], t_s: 700 }, // measured by the method itself: left out
  ];
  const said = new Map<string, { inside: boolean; t: number }>([
    ['100,0', { inside: true, t: 210 }],
    ['200,0', { inside: false, t: 910 }],
    ['300,0', { inside: true, t: 890 }],
    ['400,0', { inside: false, t: 1300 }],
    ['500,0', { inside: true, t: 880 }],
    ['1100,0', { inside: false, t: 0 }],
    ['0,600', { inside: true, t: 700 }],
  ]);
  const at = (xy: XY) => said.get(xy.join(','))!;

  it('confusion counts, rates, band accuracy and time errors over the evaluated points only', () => {
    const m = pointMetrics(pts, { inside: (xy) => at(xy).inside, time: (xy) => at(xy).t, used: [[0, 603]] });
    expect(m).toMatchObject({ n: 5, n_used: 1, tp: 1, fp: 2, fn: 1, tn: 1 });
    expect(m.accuracy).toBeCloseTo(2 / 5, 12);
    expect(m.false_inside_rate).toBeCloseTo(2 / 3, 12);
    expect(m.false_outside_rate).toBeCloseTo(1 / 2, 12);
    // band |t − 900| ≤ 180: the 850 s and 950 s points, both wrong
    expect(m.band).toEqual({ n: 2, accuracy: 0 });
    // errors t̂ − t over the 4 points with a route: +10, +60, −60, −100
    expect(m.time).not.toBeNull();
    expect(m.time!.n).toBe(4);
    expect(m.time!.mae_s).toBeCloseTo((10 + 60 + 60 + 100) / 4, 12);
    expect(m.time!.bias_s).toBeCloseTo((10 + 60 - 60 - 100) / 4, 12);
    expect(m.time!.rmse_s).toBeCloseTo(Math.sqrt((100 + 3600 + 3600 + 10000) / 4), 12);
    // numpy linear quantile of [10, 60, 60, 100] at 0.9: 60 + 0.7 × 40
    expect(m.time!.p90_s).toBeCloseTo(88, 12);
  });

  it('region-only methods get no time error; a used sample farther than 5 m does not exclude a point', () => {
    const m = pointMetrics(pts, { inside: (xy) => at(xy).inside, used: [[0, 606]] });
    expect(m.time).toBeNull();
    expect(m.n).toBe(6);
    expect(m.n_used).toBe(0);
    const none = pointMetrics([], { inside: () => true, used: [] });
    expect(none).toMatchObject({ n: 0, false_inside_rate: null, false_outside_rate: null, time: null });
    expect(Number.isNaN(none.accuracy)).toBe(true);
  });
});

describe('star16 geometry', () => {
  it('uses the engine seed pattern: 16 bearings × 347 / 705 / 1,053 m', () => {
    const pts = starPoints();
    expect(pts).toHaveLength(48);
    expect(new Set(pts.map((p) => p.bearing_deg)).size).toBe(16);
    expect([...new Set(pts.map((p) => Math.round(p.r_m)))]).toEqual([347, 706, 1053]);
    expect(R15_M).toBeCloseTo(1053, 6);
  });

  it('interpolates time along the ray to the first 900 s crossing', () => {
    const ok = (r_m: number, dur_s: number) => ({ r_m, status: 'ok' as const, dur_s });
    // straight streets: t = r / 1.17 reaches 900 s at 1,053 m
    expect(rayReach([ok(347.5, 297), ok(705.5, 603), ok(1053, 900)])).toBeCloseTo(1053, 6);
    // a river between 347 m and 705 m: 297 s → 1,115 s crosses 900 s at 347.5 + 603 / 818 × 358
    expect(rayReach([ok(347.5, 297), ok(705.5, 1115), ok(1053, 1400)])).toBeCloseTo(
      347.5 + (603 / 818) * 358,
      6,
    );
    // order of the points does not matter; the first crossing wins even if a later point is faster
    expect(rayReach([ok(705.5, 850), ok(347.5, 950), ok(1053, 1000)])).toBeCloseTo((347.5 * 900) / 950, 6);
    // no route: the reach stops at the last reachable point; a failed point is skipped
    expect(rayReach([ok(347.5, 297), { r_m: 705.5, status: 'no_route', dur_s: null }])).toBe(347.5);
    expect(
      rayReach([ok(347.5, 400), { r_m: 705.5, status: 'failed', dur_s: null }, ok(1053, 1100)]),
    ).toBeCloseTo(347.5 + (500 / 700) * 705.5, 6);
    // the outer point failed: extend the last segment, never beyond 1,053 m
    expect(rayReach([ok(347.5, 297), ok(705.5, 603)])).toBeCloseTo(1053, 0);
    expect(rayReach([ok(347.5, 297), ok(705.5, 700)])).toBeCloseTo(705.5 + (200 / 403) * 358, 6);
    expect(rayReach([{ r_m: 347.5, status: 'failed', dur_s: null }])).toBeNull();
  });

  it('closes a counter-clockwise polygon through the reach points and skips bearings without one', () => {
    const pts = starPoints();
    const cells = pts.map((p) => ({
      status: 'ok' as const,
      route_m: p.r_m * 1.3,
      dur_s: (p.r_m * 1.3) / 1.17,
    }));
    const rays = starRays(pts, cells);
    expect(rays).toHaveLength(16);
    for (const r of rays) expect(r.reach_m).toBeCloseTo(1053 / 1.3, 6);
    const ring = starPolygon(rays);
    expect(ring).toHaveLength(17);
    expect(ring[0]).toEqual(ring[16]);
    expect(ringSignedArea(ring)).toBeGreaterThan(0);
    // a regular 16-gon of circumradius R: area 8 R² sin(22.5°)
    const R = 1053 / 1.3;
    expect(ringSignedArea(ring)).toBeCloseTo(8 * R * R * Math.sin(Math.PI / 8), 3);
    const fewer = starPolygon(rays.map((r, k) => (k % 2 ? { ...r, reach_m: null } : r)));
    expect(fewer).toHaveLength(9);
  });
});

describe('methods and budgets', () => {
  it('engine@B spends B routes: the seed, then rounds of 48', () => {
    expect(engineCalls(48)).toEqual([48]);
    expect(engineCalls(100)).toEqual([48, 48, 4]);
    expect(engineCalls(200)).toEqual([48, 48, 48, 48, 8]);
    expect(engineCalls(700).reduce((a, b) => a + b, 0)).toBe(700);
    expect(engineBudget(400)).toMatchObject({ seed: 48, refine: 352, refineRounds: 8, reverse_geocoding: 0 });
    expect(() => engineBudget(47)).toThrow();
    for (const spec of measuredMethods()) {
      expect(
        methodCalls(spec).reduce((a, b) => a + b, 0),
        spec.id,
      ).toBe(spec.routes);
      expect(specOf(spec.id)?.id).toBe(spec.id);
    }
    expect(measuredMethods().map((m) => m.id)).toEqual([
      'star16',
      'seed48',
      'engine@48',
      'engine@100',
      'engine@200',
      'engine@400',
      'engine@700',
      'engine-default',
      'engine@700-nobarrier',
    ]);
    const order = [
      'engine@700-nobarrier',
      'engine@100',
      'circle',
      'engine-default',
      'star16',
      'engine@48',
      'seed48',
    ];
    expect(order.sort((a, b) => methodOrder(a) - methodOrder(b))).toEqual([
      'circle',
      'star16',
      'seed48',
      'engine@48',
      'engine@100',
      'engine-default',
      'engine@700-nobarrier',
    ]);
    expect(engineMethod(150).engine?.convergeShare).toBe(0);
  });

  it('chunks the reference into ≤ 50-route calls', () => {
    expect(chunks(796)).toEqual([...Array(15).fill(50), 46]);
    expect(chunks(0)).toEqual([]);
    expect(chunks(50)).toEqual([50]);
  });
});

describe('formatting', () => {
  it('keeps big JSON arrays on one line and small objects readable', () => {
    const text = stringify({ xy: [1.5, -2], t: [1, 2, 3], s: ['a', 'b,c]'], o: { k: null, v: [[1, 2]] } });
    expect(text).toContain('"xy": [1.5,-2]');
    expect(text).toContain('"t": [1,2,3]');
    expect(text).toContain('"s": ["a","b,c]"]');
    expect(JSON.parse(text)).toEqual({
      xy: [1.5, -2],
      t: [1, 2, 3],
      s: ['a', 'b,c]'],
      o: { k: null, v: [[1, 2]] },
    });
  });

  it('measures CJK as double width and picks the overlay engine', () => {
    expect(displayWidth('参考ab')).toBe(6);
    expect(textWidth('参考', 12)).toBe(24);
    expect(niceCeil(0.37)).toBe(0.5);
    expect(niceCeil(712)).toBe(1000);
    expect(niceCeil(250)).toBe(250);
    expect(overlayEngineId(['engine@100', 'engine@400', 'engine@700'])).toBe('engine@400');
    expect(overlayEngineId(['engine@100', 'engine@200'])).toBe('engine@200');
    expect(overlayEngineId(['engine-default', 'engine@700'])).toBe('engine-default');
    expect(overlayEngineId(['star16'])).toBeNull();
  });
});
