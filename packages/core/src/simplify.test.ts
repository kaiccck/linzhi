import { describe, expect, it } from 'vitest';

import type { XY } from './coords.js';
import { ringSignedArea, segDist2 } from './geom.js';
import { simplifyLine, simplifyRing } from './simplify.js';

/** Largest distance from any original vertex to the simplified polyline. */
function maxDeviation(original: XY[], simplified: XY[]): number {
  let worst = 0;
  for (const p of original) {
    let best = Infinity;
    for (let i = 1; i < simplified.length; i++)
      best = Math.min(best, segDist2(p, simplified[i - 1]!, simplified[i]!));
    worst = Math.max(worst, Math.sqrt(best));
  }
  return worst;
}

const circle = (r: number, n: number): XY[] =>
  Array.from({ length: n }, (_, i) => [
    r * Math.cos((2 * Math.PI * i) / n),
    r * Math.sin((2 * Math.PI * i) / n),
  ]);

describe('simplifyLine (Douglas–Peucker)', () => {
  it('drops collinear vertices and keeps the end points', () => {
    const line: XY[] = [
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
    ];
    expect(simplifyLine(line, 0.01)).toEqual([
      [0, 0],
      [3, 0],
    ]);
    expect(simplifyLine(line.slice(0, 2), 5)).toEqual(line.slice(0, 2));
  });

  it('keeps every vertex needed to stay within the tolerance', () => {
    const wave: XY[] = Array.from({ length: 400 }, (_, i) => [i, 20 * Math.sin(i / 15)]);
    for (const tol of [0.5, 2, 5]) {
      const s = simplifyLine(wave, tol);
      expect(s.length).toBeLessThan(wave.length);
      expect(s[0]).toEqual(wave[0]);
      expect(s[s.length - 1]).toEqual(wave[wave.length - 1]);
      expect(maxDeviation(wave, s)).toBeLessThanOrEqual(tol + 1e-9);
    }
    // a looser tolerance never needs more vertices
    expect(simplifyLine(wave, 5).length).toBeLessThanOrEqual(simplifyLine(wave, 0.5).length);
  });
});

describe('simplifyRing', () => {
  it('simplifies a closed ring within tolerance, keeping it closed and oriented', () => {
    const ring = circle(500, 720);
    const s = simplifyRing(ring, 1);
    expect(s.length).toBeLessThan(ring.length / 4);
    expect(s[0]).toEqual(s[s.length - 1]);
    expect(Math.sign(ringSignedArea(s))).toBe(Math.sign(ringSignedArea(ring)));
    expect(maxDeviation(ring, s)).toBeLessThanOrEqual(1 + 1e-9);
    expect(Math.abs(ringSignedArea(s) / ringSignedArea(ring) - 1)).toBeLessThan(0.005);
    const cw = simplifyRing(ring.slice().reverse(), 1);
    expect(ringSignedArea(cw)).toBeLessThan(0);
  });

  it('keeps a long thin ring whose width exceeds the tolerance, and drops one narrower than it', () => {
    const strip = (w: number): XY[] => [
      [0, 0],
      [100, 0],
      [100, w],
      [0, w],
    ];
    const s = simplifyRing(strip(12), 5);
    expect(s).toHaveLength(5);
    expect(ringSignedArea(s)).toBeCloseTo(1200, 9);
    expect(simplifyRing(strip(3), 5)).toEqual([]);
  });

  it('returns [] for degenerate input', () => {
    expect(
      simplifyRing(
        [
          [0, 0],
          [1, 1],
        ],
        1,
      ),
    ).toEqual([]);
  });
});
