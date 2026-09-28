import { describe, expect, it } from 'vitest';
import {
  bd09ToGcj02,
  bd09ToWgs84,
  gcj02ToBd09,
  gcj02ToWgs84,
  haversine,
  wgs84ToBd09,
  wgs84ToGcj02,
} from './coords.js';

describe('coordinate transforms', () => {
  it('match the published coordtransform reference values', () => {
    const near = (got: readonly number[], want: readonly number[]) => {
      expect(got[0]).toBeCloseTo(want[0]!, 9);
      expect(got[1]).toBeCloseTo(want[1]!, 9);
    };
    near(wgs84ToGcj02(116.404, 39.915), [116.41024449916938, 39.91640428150164]);
    near(gcj02ToBd09(116.404, 39.915), [116.41036949371029, 39.92133699351021]);
    near(bd09ToGcj02(116.404, 39.915), [116.39762729119315, 39.90865673957631]);
  });

  it('round-trip within survey tolerances in Zhangjiang', () => {
    const [lng, lat] = [121.6334, 31.1865];
    const g = gcj02ToWgs84(...wgs84ToGcj02(lng, lat));
    expect(haversine(lng, lat, g[0], g[1])).toBeLessThan(0.001);
    const b = bd09ToWgs84(...wgs84ToBd09(lng, lat));
    expect(haversine(lng, lat, b[0], b[1])).toBeLessThan(0.2);
  });
});
