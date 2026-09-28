import { describe, expect, it } from 'vitest';

import type { XY } from './coords.js';
import {
  assembleRings,
  buildSegmentIndex,
  clipPolyline,
  clipRing,
  closeRing,
  inBox,
  openRing,
  pointInRing,
  polylineLength,
  resamplePolyline,
  ringCentroid,
  ringSignedArea,
  segDist2,
  segmentsIntersect,
  squareBox,
} from './geom.js';

const square: XY[] = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];

describe('ring geometry', () => {
  it('signs the shoelace area by orientation, for open and closed rings alike', () => {
    expect(ringSignedArea(square)).toBe(100);
    expect(ringSignedArea(closeRing(square))).toBe(100);
    expect(ringSignedArea(square.slice().reverse())).toBe(-100);
  });

  it('opens and closes rings without duplicating the seam', () => {
    const closed = closeRing(square);
    expect(closed).toHaveLength(5);
    expect(closed[4]).toEqual(closed[0]);
    expect(closeRing(closed)).toEqual(closed);
    expect(openRing(closed)).toEqual(square);
    expect(closeRing([])).toEqual([]);
  });

  it('finds area centroids, including for concave rings', () => {
    expect(ringCentroid(square)).toEqual([5, 5]);
    // L-shape: 10×10 square minus its upper-right 5×5 quarter
    const L: XY[] = [
      [0, 0],
      [10, 0],
      [10, 5],
      [5, 5],
      [5, 10],
      [0, 10],
    ];
    expect(ringSignedArea(L)).toBe(75);
    const [cx, cy] = ringCentroid(L);
    expect(cx).toBeCloseTo((50 * 5 + 25 * 2.5) / 75, 10);
    expect(cy).toBeCloseTo((50 * 2.5 + 25 * 7.5) / 75, 10);
  });

  it('tests points against concave rings with the even-odd rule', () => {
    const L: XY[] = [
      [0, 0],
      [10, 0],
      [10, 5],
      [5, 5],
      [5, 10],
      [0, 10],
    ];
    expect(pointInRing(2, 8, L)).toBe(true);
    expect(pointInRing(8, 2, L)).toBe(true);
    expect(pointInRing(8, 8, L)).toBe(false);
    expect(pointInRing(-1, 5, L)).toBe(false);
  });

  it('clips rings and polylines to a box', () => {
    const b = squareBox(5);
    expect(inBox([5, -5], b)).toBe(true);
    expect(inBox([5.1, 0], b)).toBe(false);
    const clipped = clipRing(
      [
        [0, 0],
        [20, 0],
        [20, 20],
        [0, 20],
      ],
      b,
    );
    expect(Math.abs(ringSignedArea(clipped))).toBeCloseTo(25, 10);
    expect(
      clipRing(
        [
          [100, 100],
          [110, 100],
          [110, 110],
        ],
        b,
      ),
    ).toEqual([]);
    // leaves through the top and comes back: two pieces
    const pieces = clipPolyline(
      [
        [-10, 0],
        [0, 0],
        [0, 20],
        [2, 20],
        [2, 0],
        [10, 0],
      ],
      b,
    );
    expect(pieces).toHaveLength(2);
    expect(polylineLength(pieces[0]!) + polylineLength(pieces[1]!)).toBeCloseTo(5 + 5 + 5 + 3, 10);
  });

  it('measures point-segment distances and polyline lengths', () => {
    expect(segDist2([5, 3], [0, 0], [10, 0])).toBe(9);
    expect(segDist2([-3, 4], [0, 0], [10, 0])).toBe(25);
    expect(segDist2([1, 1], [0, 0], [0, 0])).toBe(2);
    expect(polylineLength(square)).toBe(30);
  });

  it('joins OSM way fragments into closed rings', () => {
    const rings = assembleRings([
      [
        [0, 0],
        [1, 0],
      ],
      [
        [1, 1],
        [0, 0],
      ],
      [
        [1, 0],
        [1, 1],
      ],
    ]);
    expect(rings).toHaveLength(1);
    const r = rings[0]!;
    expect(r[0]).toEqual(r[r.length - 1]);
    expect(r).toHaveLength(4);
  });

  it('answers nearest-segment queries through the grid index', () => {
    const idx = buildSegmentIndex(
      [
        [
          [0, 0],
          [100, 0],
        ],
        [
          [0, 50],
          [100, 50],
        ],
      ],
      20,
    );
    expect(idx.nSegments).toBe(2);
    expect(idx.nearest(30, 10, 25)).toEqual({ d: 10, line: 0 });
    expect(idx.nearest(30, 45, 25)).toEqual({ d: 5, line: 1 });
    expect(idx.nearest(30, 200, 25).d).toBe(Infinity);
  });
});

describe('segment intersection', () => {
  it('detects crossings, touches and collinear overlaps', () => {
    expect(segmentsIntersect([0, 0], [10, 10], [0, 10], [10, 0])).toBe(true);
    expect(segmentsIntersect([0, 0], [10, 0], [5, 0], [5, 5])).toBe(true); // T-junction
    expect(segmentsIntersect([0, 0], [10, 0], [5, 0], [15, 0])).toBe(true); // overlap
    expect(segmentsIntersect([0, 0], [10, 0], [11, 0], [15, 0])).toBe(false); // collinear, apart
    expect(segmentsIntersect([0, 0], [10, 0], [0, 1], [10, 1])).toBe(false); // parallel
    expect(segmentsIntersect([0, 0], [4, 4], [5, 0], [9, -4])).toBe(false);
  });
});

describe('resamplePolyline', () => {
  it('emits points every `spacing` metres along the line', () => {
    const pts = resamplePolyline(
      [
        [0, 0],
        [30, 0],
        [30, 45],
      ],
      25,
    );
    expect(pts).toEqual([
      [0, 0],
      [25, 0],
      [30, 20],
      [30, 45],
    ]);
    expect(resamplePolyline([[1, 2]], 10)).toEqual([[1, 2]]);
  });
});
