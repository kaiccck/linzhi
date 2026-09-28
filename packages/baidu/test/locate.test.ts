import { describe, expect, it } from 'vitest';
import { locate, parseAddress } from '../src/index.js';
import { baiduJson, fixture, spyReplay, spyTransport, testClient } from './helpers.js';

const VENUE = '上海市浦东新区海科路1650号';
const VENUE_TRUE: [number, number] = [121.62426890957015, 31.193070480100403];

describe('parseAddress', () => {
  it('peels province / city / district / town off the front', () => {
    expect(parseAddress(VENUE)).toEqual({
      province: null,
      city: '上海市',
      district: '浦东新区',
      town: null,
      core: '海科路1650号',
    });
    expect(parseAddress('浙江省杭州市西湖区文三路 90 号')).toMatchObject({
      province: '浙江省',
      city: '杭州市',
      district: '西湖区',
      core: '文三路90号',
    });
    expect(parseAddress('张江镇申城佳苑')).toMatchObject({ town: '张江镇', core: '申城佳苑' });
    // "小区" is not a district, and a lone admin name stays the core.
    expect(parseAddress('申城佳苑小区')).toMatchObject({ district: null, core: '申城佳苑小区' });
    expect(parseAddress('浦东新区')).toMatchObject({ district: null, core: '浦东新区' });
  });
});

describe('locate', () => {
  it('prefers place/v3/region when geocoding is imprecise (recorded 3.5 km mislocation)', async () => {
    const { transport, replay } = spyReplay([
      fixture('api-probe/raw/01_geocoding_venue.json'),
      fixture('api-probe/raw/03_reverse_geocoding_center_town_poi.json'),
      fixture('api-probe/raw/08f_v3_region_haike1650.json'),
    ]);
    const r = await locate(testClient(transport), VENUE);
    expect(replay.served).toEqual([
      'api-probe/raw/01_geocoding_venue.json',
      'api-probe/raw/03_reverse_geocoding_center_town_poi.json',
      'api-probe/raw/08f_v3_region_haike1650.json',
    ]);
    expect(r.calls).toEqual({ geocoding: 1, reverse_geocoding: 1, place: 1 });
    expect(r.best).toMatchObject({ source: 'place_region', location: VENUE_TRUE });
    expect(r.best?.confidence).toBeGreaterThanOrEqual(0.8);
    expect(r.best?.reason).toContain('address_type');
    expect(r.needsConfirmation).toBe(false);

    const geo = r.candidates.find((c) => c.source === 'geocoding');
    expect(geo).toMatchObject({ town: '北蔡镇', district: '浦东新区' });
    expect(geo?.confidence).toBeLessThanOrEqual(0.2);
    // The district check passes (浦东新区), which is exactly why precise=0 is never trusted on it.
    expect(geo?.reason).toContain('precise=0');
    expect(geo?.reason).toContain('与输入的“上海市、浦东新区”一致');
    expect(geo?.reason).toContain('相距 3.5 公里');
    expect(r.geocode?.precise).toBe(false);
  });

  it('accepts a precise geocode with one call (recorded 申城佳苑)', async () => {
    const { transport } = spyReplay([fixture('zhangjiang/raw/bv_geocode_A.json')]);
    const r = await locate(testClient(transport), '上海市浦东新区申城佳苑');
    expect(transport.urls).toHaveLength(1);
    expect(r.calls).toEqual({ geocoding: 1, reverse_geocoding: 0, place: 0 });
    expect(r.best).toMatchObject({
      source: 'geocoding',
      confidence: 0.9,
      location: [121.64364131704559, 31.189501690449696],
    });
    expect(r.needsConfirmation).toBe(false);
  });

  it('accepts precise but poorly understood geocodes when the district checks out', async () => {
    const t = spyTransport((u) => {
      if (u.pathname.startsWith('/geocoding')) {
        return baiduJson({
          status: 0,
          result: {
            location: { lng: 121.64, lat: 31.19 },
            precise: 1,
            confidence: 50,
            comprehension: 60,
            level: '道路',
          },
        });
      }
      return baiduJson({
        status: 0,
        result: {
          location: { lng: 121.64, lat: 31.19 },
          addressComponent: { city: '上海市', district: '浦东新区', town: '张江镇' },
        },
      });
    });
    const r = await locate(testClient(t), '上海市浦东新区张江镇孙环路');
    expect(r.calls).toEqual({ geocoding: 1, reverse_geocoding: 1, place: 0 });
    expect(r.best).toMatchObject({ source: 'geocoding', confidence: 0.75, town: '张江镇' });
  });

  it('rejects a geocode in the wrong town and falls back to a same-name place', async () => {
    const t = spyTransport((u) => {
      if (u.pathname.startsWith('/geocoding')) {
        return baiduJson({
          status: 0,
          result: {
            location: { lng: 121.59, lat: 31.18 },
            precise: 1,
            confidence: 50,
            comprehension: 70,
            level: 'UNKNOWN',
          },
        });
      }
      if (u.pathname.startsWith('/reverse')) {
        return baiduJson({
          status: 0,
          result: {
            location: { lng: 121.59, lat: 31.18 },
            addressComponent: { district: '浦东新区', town: '北蔡镇' },
          },
        });
      }
      expect(u.searchParams.get('query')).toBe('申城佳苑');
      expect(u.searchParams.get('region')).toBe('上海');
      return baiduJson({
        status: 0,
        total: 1,
        result_type: 'poi_type',
        results: [
          {
            name: '申城佳苑',
            uid: 'u1',
            location: { lng: 121.6436, lat: 31.1895 },
            area: '浦东新区',
            town: '张江镇',
          },
        ],
      });
    });
    const r = await locate(testClient(t), '上海市浦东新区张江镇申城佳苑');
    expect(r.best).toMatchObject({ source: 'place_region', uid: 'u1', town: '张江镇' });
    const geo = r.candidates.find((c) => c.source === 'geocoding');
    expect(geo?.confidence).toBeLessThanOrEqual(0.2);
    expect(geo?.reason).toContain('不一致');
  });

  it('keeps going when place search is unavailable, and asks the user to confirm', async () => {
    const t = spyTransport((u) => {
      if (u.pathname.startsWith('/geocoding')) {
        return baiduJson({
          status: 0,
          result: {
            location: { lng: 121.59, lat: 31.18 },
            precise: 0,
            confidence: 80,
            comprehension: 99,
            level: '门址',
          },
        });
      }
      if (u.pathname.startsWith('/reverse'))
        return baiduJson({ status: 302, message: '天配额超限，限制访问' });
      return baiduJson({ status: 240, message: 'APP 服务被禁用' });
    });
    const r = await locate(testClient(t), VENUE);
    expect(r.best).toMatchObject({ source: 'geocoding', confidence: 0.45 });
    expect(r.needsConfirmation).toBe(true);
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings[1]).toContain('status 240');
  });

  it('returns no candidate when nothing is found', async () => {
    const t = spyTransport((u) =>
      u.pathname.startsWith('/geocoding')
        ? baiduJson({ status: 1, msg: 'Internal Service Error:无相关结果', results: [] })
        : baiduJson({ status: 0, total: 0, results: [] }),
    );
    const r = await locate(testClient(t), '火星基地1号');
    expect(r.best).toBeNull();
    expect(r.needsConfirmation).toBe(true);
    expect(r.calls).toEqual({ geocoding: 1, reverse_geocoding: 0, place: 1 });
  });
});
