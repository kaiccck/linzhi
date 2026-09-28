import { describe, expect, it } from 'vitest';

import { zjA } from '../test/fixtures.js';
import { sampleGrid } from './field.js';
import { pointInRing, ringSignedArea } from './geom.js';
import { ISO_LEVELS, buildIsochrone, fieldFromGrid, gridFromField, levelContours } from './isochrone.js';

describe('rebuilding the zj-a isochrone from its samples', () => {
  const zj = zjA();
  const res = buildIsochrone(zj.samples);
  const want = zj.stats;

  it('lands on the stored areas and ratios', () => {
    expect(res.stats.n_samples).toBe(693);
    expect(res.stats.n_samples_by_src).toEqual({ routematrix: 432, directionlite_path: 261 });
    expect(res.stats.area_iso15_km2).toBeCloseTo(1.857, 3);
    expect(res.stats.area_iso15_grid_km2).toBeCloseTo(want['area_iso15_grid_km2'] as number, 3);
    expect(res.stats.area_circle15_km2).toBe(want.area_circle15_km2);
    expect(res.stats.overstate_x).toBe(want.overstate_x);
    expect(res.stats.reach_share).toBe(want.reach_share);
    for (const l of ISO_LEVELS) {
      expect(Math.abs(res.stats.areas_km2[l].iso - want.areas_km2[l].iso)).toBeLessThanOrEqual(0.002);
      expect(res.stats.areas_km2[l].circle).toBe(want.areas_km2[l].circle);
    }
    expect(res.baseline.circle_r15_m).toBe(zj.baseline.circle_r15_m);
    expect(res.baseline.rule_radius_m).toBe(zj.baseline.rule_radius_m);
    expect(res.open_chains).toBe(0);
  });

  it('reproduces the leave-one-out validation and the gap summary', () => {
    expect(res.stats.loo_n).toBe(432);
    expect(res.stats.loo_mae_s).toBeCloseTo(want.loo_mae_s!, 0);
    expect(res.stats.loo_p90_abs_err_s).toBeCloseTo(want.loo_p90_abs_err_s!, 0);
    const g = res.stats.straight_vs_walk_gap_summary;
    const w = want.straight_vs_walk_gap_summary;
    expect(g.n).toBe(w.n);
    expect(g.n_inside_circle15).toBe(w.n_inside_circle15);
    expect(g.n_inside_circle15_over_900s).toBe(w.n_inside_circle15_over_900s);
    expect(g.share_inside_circle15_over_900s).toBe(w.share_inside_circle15_over_900s);
    expect(g.median_extra_s_inside_circle15).toBe(w.median_extra_s_inside_circle15);
    for (const k of ['rho_median', 'rho_p75', 'rho_p90', 'rho_max'] as const) {
      expect(Math.abs(g[k] - w[k])).toBeLessThanOrEqual(0.002); // stored straight_m is rounded to 0.1 m
    }
    expect(g.worst.map((x) => x.route_m)).toEqual(w.worst.map((x) => x.route_m));
  });

  it('reproduces reach per bearing every 5°', () => {
    const got = res.stats.reach_by_bearing;
    expect(got).toHaveLength(72);
    got.forEach((row, i) => {
      const ref = want.reach_by_bearing[i]!;
      expect(row.b).toBe(ref.b);
      for (const k of ['r300', 'r600', 'r900'] as const)
        expect(Math.abs(row[k] - ref[k])).toBeLessThanOrEqual(3);
    });
  });

  it('reproduces the stored field up to the rounding of the stored samples', () => {
    expect(res.field.nx).toBe(zj.field.nx);
    expect(res.field.x0).toBe(zj.field.x0);
    let same = 0;
    let worst = 0;
    res.field.t_s.forEach((t, i) => {
      const ref = zj.field.t_s[i]!;
      if (t === ref) same++;
      worst = Math.max(worst, Math.abs(t - ref));
    });
    expect(same / res.field.t_s.length).toBeGreaterThan(0.97);
    expect(worst).toBeLessThanOrEqual(30);
  });

  it('keeps holes and islands: 600 s has a detached island, 900 s a hole', () => {
    expect(res.contours_meta).toEqual({
      '300': [{ hole: false, parent: null, area_m2: expect.any(Number) }],
      '600': [
        { hole: false, parent: null, area_m2: expect.any(Number) },
        { hole: false, parent: null, area_m2: expect.any(Number) },
      ],
      '900': [
        { hole: false, parent: null, area_m2: expect.any(Number) },
        { hole: true, parent: 0, area_m2: expect.any(Number) },
      ],
    });
    for (const l of ISO_LEVELS) {
      res.contours[l].forEach((ring, i) => {
        const meta = res.contours_meta[l][i]!;
        expect(ring[0]).toEqual(ring[ring.length - 1]);
        expect(Math.sign(ringSignedArea(ring))).toBe(meta.hole ? -1 : 1);
        // area_m2 is measured before simplification; 5 m trims small rings relatively more
        const drift = Math.abs(Math.abs(ringSignedArea(ring)) / meta.area_m2 - 1);
        expect(drift).toBeLessThan(meta.area_m2 > 1e5 ? 0.01 : 0.1);
        expect(Math.abs(meta.area_m2 / zj.contours_meta![l][i]!.area_m2 - 1)).toBeLessThan(0.005);
      });
    }
    const [hx, hy] = res.contours['900'][1]![0]!;
    expect(pointInRing(hx, hy, res.contours['900'][0]!)).toBe(true);
  });

  it('simplifies the smoothed rings with Douglas–Peucker at 5 m', () => {
    const raw = levelContours(res.grid, 900, { simplify_m: 0 });
    const dp = levelContours(res.grid, 900);
    expect(dp.rings[0]!.length).toBeLessThan(raw.rings[0]!.length / 5);
    expect(dp.area_m2).toBe(raw.area_m2);
    // every smoothed vertex stays within 5 m of the simplified outline
    const ring = dp.rings[0]!;
    const near = (p: [number, number]) => {
      let best = Infinity;
      for (let i = 1; i < ring.length; i++) {
        const a = ring[i - 1]!;
        const b = ring[i]!;
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
        best = Math.min(best, Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]));
      }
      return best;
    };
    for (const p of raw.rings[0]!) expect(near(p)).toBeLessThanOrEqual(5 + 1e-6);
  });

  it('shrinks for a slower walker without new routes', () => {
    const elderly = buildIsochrone(zj.samples, { speed: 0.9, loo: false });
    expect(elderly.baseline.circle_r15_m).toBe(810);
    expect(elderly.stats.area_iso15_km2).toBeLessThan(0.75 * res.stats.area_iso15_km2);
    expect(elderly.stats.straight_vs_walk_gap_summary).toEqual(res.stats.straight_vs_walk_gap_summary);
  });
});

describe('field wire format', () => {
  it('round-trips through TimeField with whole seconds and -1 outside', () => {
    const zj = zjA();
    const g = gridFromField(zj.field);
    expect(Number.isNaN(g.values[0]!)).toBe(true);
    expect(fieldFromGrid(g, zj.field.note)).toEqual(zj.field);
    expect(sampleGrid(g, 0, 0)).toBeGreaterThanOrEqual(0);
  });
});
