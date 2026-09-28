import { describe, expect, it } from 'vitest';

import { rng, zjA } from '../test/fixtures.js';
import type { RhoSample } from './field.js';
import {
  FIELD_DEFAULTS,
  angleDiff,
  estimateTime,
  leaveOneOut,
  makeRhoSample,
  quantile,
  sampleGrid,
  timeGrid,
} from './field.js';

const V = FIELD_DEFAULTS.speed;

/** zj-a samples as the estimator sees them (the builder skipped the few within 30 m of the centre). */
function zjSamples() {
  const all = zjA().samples.filter((s) => s.straight_m >= 30);
  const rho = all.map((s) => makeRhoSample(s.xy[0], s.xy[1], s.dur_s, V));
  const targets = all.flatMap((s, i) => (s.src === 'routematrix' ? [i] : []));
  return { all, rho, targets, observed: targets.map((i) => all[i]!.dur_s) };
}

describe('detrended IDW of the detour ratio', () => {
  it('builds rho samples and compares bearings on the circle', () => {
    const s = makeRhoSample(300, 400, 600, V);
    expect(s.r).toBe(500);
    expect(s.rho).toBeCloseTo((600 * V) / 500, 12);
    expect(s.theta).toBeCloseTo(Math.atan2(300, 400), 12);
    expect(angleDiff(0.1, 2 * Math.PI - 0.1)).toBeCloseTo(0.2, 12);
    expect(angleDiff(-Math.PI, Math.PI)).toBeCloseTo(0, 12);
  });

  it('never estimates a walk faster than the straight line (t̂ ≥ r / v)', () => {
    const { rho } = zjSamples();
    const rand = rng(1);
    for (let n = 0; n < 2000; n++) {
      const x = (rand() - 0.5) * 3200;
      const y = (rand() - 0.5) * 3200;
      const t = estimateTime(rho, x, y, FIELD_DEFAULTS);
      expect(t).toBeGreaterThanOrEqual(Math.hypot(x, y) / V - 1e-9);
      const tTime = estimateTime(rho, x, y, { ...FIELD_DEFAULTS, interpolate: 'time' });
      expect(tTime).toBeGreaterThanOrEqual(Math.hypot(x, y) / V - 1e-9);
    }
    // even when every sample claims to be faster than a straight walk
    const fast: RhoSample[] = [makeRhoSample(100, 0, 50, V), makeRhoSample(0, 100, 50, V)];
    expect(estimateTime(fast, 80, 80, FIELD_DEFAULTS)).toBeCloseTo(Math.hypot(80, 80) / V, 9);
  });

  it('uses the fixed near-centre ratio inside nearRadius', () => {
    const { rho } = zjSamples();
    expect(estimateTime(rho, 10, 20, FIELD_DEFAULTS)).toBeCloseTo((Math.hypot(10, 20) / V) * 1.25, 12);
  });

  it('reproduces the leave-one-out validation of the zj-a sample (MAE ≈ 54 s, p90 ≈ 125 s)', () => {
    const { rho, targets, observed } = zjSamples();
    const loo = leaveOneOut(rho, targets, observed, FIELD_DEFAULTS);
    expect(loo.n).toBe(432);
    expect(loo.maeS).toBeCloseTo(54.4, 0);
    expect(loo.p90AbsS).toBeCloseTo(125.3, 0);
    expect(Math.abs(loo.biasS)).toBeLessThan(10);
    // the point of detrending: interpolating t directly is worse, above all in the tail
    const time = leaveOneOut(rho, targets, observed, {
      ...FIELD_DEFAULTS,
      anisotropy: 0,
      interpolate: 'time',
    });
    expect(time.maeS).toBeGreaterThan(loo.maeS);
    expect(time.p90AbsS).toBeGreaterThan(loo.p90AbsS + 10);
  });

  it('leaves every estimate unchanged when the visibility filter is off or sees everything', () => {
    const { rho } = zjSamples();
    const all = { ...FIELD_DEFAULTS, visible: () => true };
    const rand = rng(2);
    for (let n = 0; n < 500; n++) {
      const x = (rand() - 0.5) * 3000;
      const y = (rand() - 0.5) * 3000;
      expect(estimateTime(rho, x, y, all)).toBe(estimateTime(rho, x, y, FIELD_DEFAULTS));
    }
  });

  it('skips hidden samples and falls back to all samples when every one is hidden', () => {
    const samples = [makeRhoSample(-100, 500, 500, V), makeRhoSample(100, 500, 1000, V)];
    const p = { ...FIELD_DEFAULTS, k: 1 };
    const onlyEast = { ...p, visible: (_x: number, _y: number, s: RhoSample) => s.x > 0 };
    expect(estimateTime(samples, -90, 500, onlyEast)).toBeCloseTo(
      (samples[1]!.rho * Math.hypot(-90, 500)) / V,
      9,
    );
    const none = { ...p, visible: () => false };
    expect(estimateTime(samples, -90, 500, none)).toBe(estimateTime(samples, -90, 500, p));
  });
});

describe('lattice helpers', () => {
  it('interpolates bilinearly and returns NaN off the lattice', () => {
    const g = {
      nx: 3,
      ny: 3,
      x0: 0,
      y0: 0,
      cell: 10,
      values: Float64Array.from([0, 1, 2, 10, 11, 12, 20, 21, 22]),
    };
    expect(sampleGrid(g, 5, 5)).toBeCloseTo(5.5, 12);
    expect(sampleGrid(g, 15, 12)).toBeCloseTo(13.5, 12);
    expect(sampleGrid(g, -1, 5)).toBeNaN();
    expect(sampleGrid(g, 20, 5)).toBeNaN();
  });

  it('evaluates the field on lattice nodes inside the disc only', () => {
    const g = timeGrid([makeRhoSample(200, 0, 300, V)], FIELD_DEFAULTS, 400, 100, 300);
    expect(g.nx).toBe(9);
    expect(g.values[0]).toBeNaN(); // corner (-400, -400)
    expect(g.values[4 * 9 + 7]).toBeCloseTo((300 * 300) / 200, 9); // (300, 0): same rho, t scales with r
  });

  it('computes numpy-style quantiles', () => {
    expect(quantile([4, 1, 3, 2], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4, 5], 0.9)).toBeCloseTo(4.6, 12);
    expect(quantile([], 0.5)).toBeNaN();
  });
});
