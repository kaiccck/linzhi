import { describe, expect, it } from 'vitest';

import { jitteredSamples, riverWorld, zjA } from '../test/fixtures.js';
import { barrierDistance, barrierPieces, detectBarriers, isVisible, visibilityFilter } from './barrier.js';
import { FIELD_DEFAULTS, estimateTime, makeRhoSample, quantile } from './field.js';

const world = riverWorld(); // river x = 300, only bridge at (300, -700)
const samples = jitteredSamples(world.time, { xmin: -500, xmax: 1100, ymin: -1000, ymax: 800 }, 60);
const barriers = detectBarriers(samples);
const side = (i: number) => Math.sign(samples[i]!.xy[0] - world.riverX);

describe('Lipschitz barrier detection on a synthetic river', () => {
  it('flags only edges that cross the river (no false positives)', () => {
    const strong = barriers.edges.filter((e) => e.kappa > barriers.kappaThreshold);
    expect(strong.length).toBeGreaterThan(20);
    expect(barriers.segments).toHaveLength(strong.length);
    for (const e of strong) expect(side(e.i)).not.toBe(side(e.j));
  });

  it('finds the river wherever it cuts the walking-time field', () => {
    // north of the bridge every crossing costs a long detour; within ~100 m of it the field is continuous
    const crossing = barriers.edges.filter(
      (e) => side(e.i) !== side(e.j) && Math.min(samples[e.i]!.xy[1], samples[e.j]!.xy[1]) > -600,
    );
    expect(crossing.length).toBeGreaterThan(20);
    const found = crossing.filter((e) => e.kappa > barriers.kappaThreshold).length;
    expect(found / crossing.length).toBeGreaterThanOrEqual(0.95);
  });

  it('places barrier segments on the river and leaves the bridge open', () => {
    for (const s of barriers.segments) {
      const da = s.a[0] - world.riverX;
      const db = s.b[0] - world.riverX;
      const toRiver = da * db <= 0 ? 0 : Math.min(Math.abs(da), Math.abs(db));
      // an edge localises its barrier to within half its length (long hull edges are coarse)
      const len = Math.hypot(
        samples[s.i]!.xy[0] - samples[s.j]!.xy[0],
        samples[s.i]!.xy[1] - samples[s.j]!.xy[1],
      );
      expect(toRiver).toBeLessThanOrEqual(len / 2 + 1e-6);
      if (len < 100) expect(toRiver).toBeLessThan(50);
      // each segment cuts its own edge
      const p = samples[s.i]!.xy;
      const q = samples[s.j]!.xy;
      expect(isVisible(p, q, [s])).toBe(false);
    }
    expect(isVisible([270, 0], [330, 0], barriers)).toBe(false);
    expect(isVisible([250, 400], [350, 420], barriers)).toBe(false);
    expect(isVisible([270, -700], [330, -700], barriers)).toBe(true); // over the bridge
    expect(isVisible([-200, 0], [200, 300], barriers)).toBe(true); // same bank
    // the indexed query agrees with a plain scan
    for (const [a, b] of [
      [
        [100, 100],
        [500, 150],
      ],
      [
        [200, -650],
        [400, -750],
      ],
    ] as [number, number][][]) {
      expect(isVisible(a!, b!, barriers)).toBe(isVisible(a!, b!, barriers.segments));
    }
  });

  it('improves the IDW next to the river when hidden samples are skipped', () => {
    const rho = samples.map((s) => makeRhoSample(s.xy[0], s.xy[1], s.dur_s, world.speed));
    const withVis = { ...FIELD_DEFAULTS, visible: visibilityFilter(barriers) };
    const plain: number[] = [];
    const vis: number[] = [];
    for (let x = 180; x <= 420; x += 20) {
      for (let y = -500; y <= 800; y += 20) {
        if (Math.abs(x - world.riverX) < 5) continue;
        const t = world.time(x, y);
        plain.push(Math.abs(estimateTime(rho, x, y, FIELD_DEFAULTS) - t));
        vis.push(Math.abs(estimateTime(rho, x, y, withVis) - t));
      }
    }
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    expect(mean(vis)).toBeLessThan(0.6 * mean(plain));
    expect(quantile(vis, 0.9)).toBeLessThan(quantile(plain, 0.9));
  });

  it('measures distance to the nearest barrier and exports wire pieces', () => {
    expect(barrierDistance([world.riverX, 300], barriers)).toBeLessThan(40);
    expect(barrierDistance([-300, 0], barriers)).toBe(Infinity);
    const pieces = barrierPieces(barriers);
    expect(pieces).toHaveLength(barriers.segments.length);
    expect(pieces[0]!.kappa).toBeGreaterThanOrEqual(pieces[pieces.length - 1]!.kappa);
    expect(Number.isInteger(pieces[0]!.a[0] * 10)).toBe(true);
  });

  it('ignores time gaps within road-snapping noise', () => {
    // two answers 0.45 m apart that differ by 2 s (a real routematrix pair, see zj-a duplicate_conflicts)
    const pts = [
      { xy: [1156.1, -475.8] as [number, number], dur_s: 1799 },
      { xy: [1155.9, -476.2] as [number, number], dur_s: 1801 },
      { xy: [1100, -400] as [number, number], dur_s: 1700 },
    ];
    const noisy = detectBarriers(pts);
    expect(Math.max(...noisy.edges.map((e) => e.kappa))).toBeGreaterThan(5);
    expect(noisy.segments).toEqual([]);
    expect(detectBarriers(pts, { minDetour_m: 0 }).segments).toHaveLength(1);
  });

  it('handles degenerate input', () => {
    expect(detectBarriers([]).segments).toEqual([]);
    const line = [0, 1, 2, 3].map((i) => ({ xy: [i * 100, 0] as [number, number], dur_s: i * 1000 }));
    expect(detectBarriers(line).segments).toEqual([]); // collinear: no triangles
    expect(isVisible([0, 0], [1, 1], detectBarriers([]))).toBe(true);
  });
});

describe('barrier detection on the zj-a Baidu samples', () => {
  const zj = zjA().samples.filter((s) => s.straight_m >= 30);
  const b = detectBarriers(zj);

  it('finds the places where a walked route doubles back across a waterway', () => {
    // two vertices of the b090 route 13 m apart but 176 s apart in time: the route walks past, crosses
    // further on and comes back on the other bank
    const strongPair = b.edges.find((e) => {
      const p = zj[e.i]!;
      const q = zj[e.j]!;
      return p.set === 'dl_b090' && q.set === 'dl_b090' && e.length_m < 20 && e.kappa > 10;
    });
    expect(strongPair).toBeDefined();
    expect(b.segments.length).toBeGreaterThan(100);
  });

  it('lowers the leave-one-out error when barriers are re-detected without the target (fair LOO)', () => {
    const rho = zj.map((s) => makeRhoSample(s.xy[0], s.xy[1], s.dur_s, FIELD_DEFAULTS.speed));
    const errs: number[] = [];
    const plain: number[] = [];
    zj.forEach((s, ti) => {
      if (s.src !== 'routematrix') return;
      const others = detectBarriers(zj.filter((_, i) => i !== ti));
      const p = { ...FIELD_DEFAULTS, visible: visibilityFilter(others) };
      errs.push(Math.abs(estimateTime(rho, rho[ti]!.x, rho[ti]!.y, p, ti) - s.dur_s));
      plain.push(Math.abs(estimateTime(rho, rho[ti]!.x, rho[ti]!.y, FIELD_DEFAULTS, ti) - s.dur_s));
    });
    const mae = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    expect(errs).toHaveLength(432);
    expect(mae(plain)).toBeCloseTo(54.4, 0);
    // measured: 50.0 s MAE, 121.3 s p90 (plain 54.4 / 125.3)
    expect(mae(errs)).toBeLessThan(mae(plain) - 2);
    expect(quantile(errs, 0.9)).toBeLessThan(quantile(plain, 0.9));
  });
});
