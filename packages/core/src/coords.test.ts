import { describe, expect, it } from 'vitest';
import {
  bd09ToGcj02,
  bd09ToWgs84,
  gcj02ToBd09,
  gcj02ToWgs84,
  haversine,
  parseCoordinateText,
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

describe('parseCoordinateText', () => {
  const point = { lng: 121.644195, lat: 31.19007, swapped: false, inChina: true };

  it('reads longitude, latitude with commas, spaces, full-width punctuation and brackets', () => {
    for (const text of [
      '121.644195,31.19007',
      '121.644195 31.19007',
      ' 121.644195 ,  31.19007 ',
      '121.644195，31.19007',
      '１２１.６４４１９５，３１.１９００７',
      '121.644195、31.19007',
      '121.644195;31.19007',
      '[121.644195, 31.19007]',
      '（121.644195，31.19007）',
    ]) {
      expect(parseCoordinateText(text), text).toEqual(point);
    }
  });

  it('reads latitude first when only that order lies in China', () => {
    expect(parseCoordinateText('31.19007,121.644195')).toEqual({ ...point, swapped: true });
    expect(parseCoordinateText('31.19007 121.644195')).toEqual({ ...point, swapped: true });
  });

  it('flags two numbers outside China, and leaves addresses and single numbers alone', () => {
    expect(parseCoordinateText('2.35, 48.85')).toEqual({
      lng: 2.35,
      lat: 48.85,
      swapped: false,
      inChina: false,
    });
    expect(parseCoordinateText('-121.6,31.2')).toMatchObject({ inChina: false });
    for (const text of [
      '海科路1650号',
      '1650',
      '1650 20',
      '孙环路 高木桥路',
      '121.6,31.2,5',
      '121.6.1,31.2',
      '121.,31.2',
      '',
      '12a 31',
    ])
      expect(parseCoordinateText(text), text).toBeNull();
  });
});
