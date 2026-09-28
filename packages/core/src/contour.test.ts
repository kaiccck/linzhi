import { describe, expect, it } from 'vitest';

import { chaikin, isoRings, nestRings } from './contour.js';
import type { XY } from './coords.js';
import type { Grid } from './field.js';
import { pointInRing, ringSignedArea } from './geom.js';

const V = 1.17;

/** Lattice over [-extent, extent]² with values f(x, y); NaN outside the disc of `radius`. */
function lattice(extent: number, cell: number, f: (x: number, y: number) => number, radius = Infinity): Grid {
  const n = Math.round((2 * extent) / cell) + 1;
  const values = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = -extent + i * cell;
      const y = -extent + j * cell;
      values[j * n + i] = Math.hypot(x, y) <= radius ? f(x, y) : NaN;
    }
  }
  return { nx: n, ny: n, x0: -extent, y0: -extent, cell, values };
}

const cone = lattice(1600, 20, (x, y) => Math.hypot(x, y) / V, 1600);

describe('isoRings on a cone field t = r / v', () => {
  it.each([300, 600, 900])('gives one closed, counter-clockwise, near-circular ring at %i s', (level) => {
    const { rings, openChains } = isoRings(cone, level);
    expect(openChains).toBe(0);
    expect(rings).toHaveLength(1);
    const ring = rings[0]!;
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    const R = level * V;
    const area = ringSignedArea(chaikin(ring, 2));
    expect(area).toBeGreaterThan(0);
    expect(Math.abs(area / (Math.PI * R * R) - 1)).toBeLessThan(0.02);
    for (const [x, y] of ring) expect(Math.abs(Math.hypot(x, y) - R)).toBeLessThan(3);
  });

  it('nests the levels: each ring lies inside the next one', () => {
    const r = [300, 600, 900].map((l) => chaikin(isoRings(cone, l).rings[0]!, 2));
    for (let k = 0; k + 1 < r.length; k++) {
      for (const [x, y] of r[k]!) expect(pointInRing(x, y, r[k + 1]!)).toBe(true);
      expect(ringSignedArea(r[k]!)).toBeLessThan(ringSignedArea(r[k + 1]!));
    }
  });

  it('never lets a region leak into nodes outside the domain', () => {
    // the whole disc is below this level, so the ring must follow the NaN border
    const disc = lattice(1600, 20, (x, y) => Math.hypot(x, y) / V, 1500);
    const { rings, openChains } = isoRings(disc, 5000);
    expect(openChains).toBe(0);
    expect(rings).toHaveLength(1);
    for (const [x, y] of rings[0]!) expect(Math.hypot(x, y)).toBeLessThanOrEqual(1500 + 20);
    // a region that reaches the lattice edge cannot close and is reported
    expect(isoRings(cone, 5000).openChains).toBeGreaterThan(0);
  });
});

describe('holes and islands', () => {
  // cone with a blocked pocket around (400, 0): unreachable within 10 minutes although it lies inside
  const pocket = lattice(1600, 20, (x, y) => {
    const t = Math.hypot(x, y) / V;
    return Math.hypot(x - 400, y) < 120 ? t + 400 : t;
  });

  it('returns the pocket as a clockwise hole attached to the outer ring', () => {
    const { rings } = isoRings(pocket, 600);
    expect(rings).toHaveLength(2);
    const nested = nestRings(rings.map((r) => chaikin(r, 2)));
    expect(nested.map((n) => n.hole)).toEqual([false, true]);
    expect(nested[1]!.parent).toBe(0);
    expect(ringSignedArea(nested[1]!.ring)).toBeLessThan(0);
    const holeArea = nested[1]!.areaM2;
    expect(Math.abs(holeArea / (Math.PI * 120 * 120) - 1)).toBeLessThan(0.08);
    const [hx, hy] = nested[1]!.ring[0]!;
    expect(pointInRing(hx, hy, nested[0]!.ring)).toBe(true);
  });

  it('keeps a detached island as a second outer ring', () => {
    // reachable pad at (1000, 0) beyond the 600 s circle (702 m), e.g. across a fast link
    const island = lattice(1600, 20, (x, y) => (Math.hypot(x - 1000, y) < 100 ? 300 : Math.hypot(x, y) / V));
    const nested = nestRings(isoRings(island, 600).rings);
    expect(nested.filter((n) => !n.hole)).toHaveLength(2);
    expect(nested.every((n) => !n.hole)).toBe(true);
    expect(nested[0]!.areaM2).toBeGreaterThan(nested[1]!.areaM2);
  });

  it('resolves a saddle cell by the cell-centre average', () => {
    // two diagonal inside nodes (value 0) meeting in the centre cell, whose other corners hold `a`
    const saddle = (a: number): Grid => ({
      nx: 4,
      ny: 4,
      x0: 0,
      y0: 0,
      cell: 10,
      values: Float64Array.from([9, 9, 9, 9, 9, 0, a, 9, 9, a, 0, 9, 9, 9, 9, 9]),
    });
    const joined = isoRings(saddle(1.5), 1); // centre average 0.75 < 1: connected
    const split = isoRings(saddle(4), 1); // centre average 2 ≥ 1: two separate regions
    expect(joined.openChains + split.openChains).toBe(0);
    expect(joined.rings).toHaveLength(1);
    expect(split.rings).toHaveLength(2);
    for (const r of [...joined.rings, ...split.rings]) expect(ringSignedArea(r)).toBeGreaterThan(0);
  });
});

describe('chaikin', () => {
  it('doubles the vertex count per pass and keeps the ring closed', () => {
    const sq: XY[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ];
    const one = chaikin(sq, 1);
    expect(one).toHaveLength(9);
    expect(one[0]).toEqual(one[8]);
    expect(chaikin(sq, 2)).toHaveLength(17);
    // corner cutting only removes area
    expect(ringSignedArea(one)).toBeLessThan(100);
    expect(ringSignedArea(one)).toBeCloseTo(100 - 4 * (0.5 * 2.5 * 2.5), 9);
  });
});
