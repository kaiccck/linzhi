import { describe, expect, it } from 'vitest';
import { facilityStats, stationKey } from './facility-stats.js';
import type { AnalysisResult, Poi, XY } from './types.js';
import { zjA } from '../test/fixtures.js';

describe('facilityStats (圈内设施统计)', () => {
  const stats = facilityStats(zjA());
  const by = new Map(stats.map((s) => [s.category, s]));

  it('counts distinct facilities, folding market stalls into their market', () => {
    const markets = zjA().pois.filter((p) => p.cat === '菜市场' && !p.stall_of);
    expect(by.get('菜市场')!.found).toBe(markets.length);
  });

  it('never reaches more on foot than the straight circle claims for the same facilities', () => {
    for (const s of stats) {
      expect(s.walk).toBeLessThanOrEqual(s.found);
      expect(s.circle).toBeLessThanOrEqual(s.found);
    }
    // the walk reaches fewer facilities than the circle claims in total (the whole point of the product)
    const walk = stats.reduce((n, s) => n + s.walk, 0);
    const circle = stats.reduce((n, s) => n + s.circle, 0);
    expect(walk).toBeLessThan(circle);
  });

  it('names the nearest facility by walking time, and the elder profile reaches fewer', () => {
    const market = by.get('菜市场')!;
    expect(market.nearest).toBe('浦商生鲜(申城佳苑店)');
    expect(market.nearest_s).toBeGreaterThan(0);
    const elder = facilityStats(zjA(), { scale: 1.17 / 0.9 });
    const total = (xs: typeof stats) => xs.reduce((n, s) => n + s.walk, 0);
    expect(total(elder)).toBeLessThan(total(stats));
  });

  it('counts a station once, however many entrances the inventory lists', () => {
    // zj-a lists 张江路站 and three of its exits from OpenStreetMap
    const metro = zjA().pois.filter((p) => p.cat === '地铁');
    const zhangjiang = metro.filter((p) => p.name.startsWith('张江路站'));
    expect(zhangjiang.length).toBe(4);
    expect(new Set(zhangjiang.map((p) => stationKey(p.name)))).toEqual(new Set(['张江路']));
    expect(by.get('地铁')!.found).toBe(new Set(metro.map((p) => stationKey(p.name))).size);
    expect(by.get('地铁')!.found).toBeLessThan(metro.length);
  });
});

describe('station keys and transit folding', () => {
  it('strips exits, platforms and station words', () => {
    expect(stationKey('张江路站 出入口3')).toBe('张江路');
    expect(stationKey('张江路站')).toBe('张江路');
    expect(stationKey('张江路(地铁站)')).toBe('张江路');
    expect(stationKey('华夏中路地铁站-1口')).toBe('华夏中路');
    expect(stationKey('张江高科(地铁站)B口')).toBe('张江高科');
    expect(stationKey('罗山路华夏中路')).toBe('罗山路华夏中路');
    expect(stationKey('张江路口')).toBe('张江路口');
  });

  it('reaches a station through its nearest entrance and counts other categories per POI', () => {
    // a flat field: walking time = distance / 1.17 (2 km square, 20 m cells)
    const n = 201;
    const t_s: number[] = [];
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) t_s.push(Math.hypot(-2000 + 20 * i, -2000 + 20 * j) / 1.17);
    const poi = (uid: string, name: string, cat: Poi['cat'], xy: XY): Poi => ({
      uid,
      name,
      cat,
      xy,
      navi_xy: null,
      source: 'baidu',
    });
    const result = {
      meta: { walk_speed_mps: 1.17 } as AnalysisResult['meta'],
      field: { cell_m: 20, nx: n, ny: n, x0: -2000, y0: -2000, t_s },
      pois: [
        poi('m1', '远方路站', '地铁', [1500, 0]),
        poi('m2', '远方路站 出入口2', '地铁', [900, 0]),
        poi('b1', '东路西路', '公交', [300, 0]),
        poi('b2', '东路西路', '公交', [300, 120]),
        poi('s1', '联华超市', '超市', [200, 0]),
        poi('s2', '联华超市', '超市', [200, 60]),
      ],
    };
    const got = new Map(facilityStats(result).map((s) => [s.category, s]));
    expect(got.get('地铁')).toMatchObject({ found: 1, walk: 1, circle: 1, nearest: '远方路站 出入口2' });
    expect(got.get('地铁')!.nearest_s).toBe(Math.round(900 / 1.17));
    expect(got.get('公交')).toMatchObject({ found: 1, walk: 1, circle: 1 });
    // two supermarkets of one chain are two supermarkets
    expect(got.get('超市')).toMatchObject({ found: 2, walk: 2, circle: 2 });
    const elder = new Map(facilityStats(result, { scale: 1.3 }).map((s) => [s.category, s]));
    expect(elder.get('地铁')).toMatchObject({ found: 1, walk: 0, circle: 0 });
  });
});
