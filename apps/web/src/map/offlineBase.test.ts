import { describe, expect, it } from 'vitest';
import type { AnalysisResult } from '@zoudedao/core';
import raw from '../../../../data/samples/zj-a.json?raw';
import { compositionFor, staticView } from '../geo/view.js';

const sample = JSON.parse(raw) as AnalysisResult;

describe('offline basemap coverage', () => {
  it.each([
    [1040, 840],
    [1460, 846], // the reported wide map with blank left and right edges
    [1520, 1020],
    [2160, 1380],
  ])('covers a %i × %i map, including Baidu whole-level zoom rounding', (width, height) => {
    const view = staticView(width, height, compositionFor(false), 0, 0, sample.meta.center_bd09[1]);
    const extent = sample.base!.extent_m!;
    expect(extent).toBeGreaterThan(sample.meta.extent_m);
    const corners = [
      [0, 0],
      [width, height],
    ].map(([x, y]) => [view.mx(x!), view.my(y!)]);
    for (const corner of corners) for (const v of corner) expect(Math.abs(v)).toBeLessThan(extent);
    // Actual street segments must exist in both margins, not merely a larger declared box.
    const roads = sample.base!.roads.flatMap((r) => r.pts);
    expect(
      roads.some(([x, y]) => view.x(x) >= 0 && view.x(x) < 100 && view.y(y) > 0 && view.y(y) < height),
    ).toBe(true);
    expect(
      roads.some(
        ([x, y]) => view.x(x) > width - 100 && view.x(x) <= width && view.y(y) > 0 && view.y(y) < height,
      ),
    ).toBe(true);
  });
});
