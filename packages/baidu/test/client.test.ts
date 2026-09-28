import { describe, expect, it } from 'vitest';
import type { LngLat } from '@zoudedao/core';
import {
  BaiduConfigError,
  BaiduInputError,
  BaiduUpstreamError,
  createReplayClient,
  GEOCONV_MODEL,
  planRequests,
  planTiles,
  snSign,
  type MatrixPair,
} from '../src/index.js';
import {
  baiduJson,
  FAKE_ENV,
  fakeConfig,
  fakeMatrix,
  fixture,
  latLngList,
  PROBE_RAW,
  requestParam,
  responseOf,
  spyReplay,
  spyTransport,
  testClient,
  ZJ_RAW,
} from './helpers.js';

type Cell = { distance: { value: number }; duration: { value: number } };
const resultOf = (rel: string) => responseOf(rel).result as Cell[];

const BLIND_PHARMACY = 'zhangjiang/raw/bv_blind_A_药店_000.json';
const BLIND_MARKET = 'zhangjiang/raw/bv_blind_A_菜市场_000.json';
const BLIND_SCHOOL = 'zhangjiang/raw/bv_blind_A_小学_000.json';
const pharmacy = fixture(BLIND_PHARMACY);
const ORIGINS = latLngList(requestParam(pharmacy, 'origins'));
const PHARMACIES = latLngList(requestParam(pharmacy, 'destinations'));
const MARKETS = latLngList(requestParam(fixture(BLIND_MARKET), 'destinations'));
const SCHOOLS = latLngList(requestParam(fixture(BLIND_SCHOOL), 'destinations'));
const CENTER_A: LngLat = [121.644195, 31.19007];

describe('routeMatrixWalking — recorded Zhangjiang blind-spot batches', () => {
  it('maps a 12 × 4 batch back origin-major', async () => {
    const { transport } = spyReplay([pharmacy]);
    const client = testClient(transport);
    const m = await client.routeMatrixWalking(ORIGINS, PHARMACIES);
    expect(transport.urls).toHaveLength(1);
    const rows = resultOf(BLIND_PHARMACY);
    expect(m.cells).toHaveLength(12);
    m.cells.forEach((row, i) =>
      row.forEach((cell, j) => {
        expect(cell.distanceM).toBe(rows[i * 4 + j]?.distance.value);
        expect(cell.durationS).toBe(rows[i * 4 + j]?.duration.value);
      }),
    );
    expect(m.cells[0]?.map((c) => c.distanceM)).toEqual([923, 932, 972, 1179]);
    expect(m.cells[0]?.[0]).toMatchObject({ status: 'ok', via: 'api' });
    expect(m.stats).toMatchObject({ pairs: 48, unique: 48, fromApi: 48, requests: 1, routesRequested: 48 });
  });

  it('packs 12 × 11 into three ≤ 50-route requests that match the recorded tiles', async () => {
    const { transport } = spyReplay([pharmacy, fixture(BLIND_MARKET), fixture(BLIND_SCHOOL)]);
    const client = testClient(transport);
    const dests = [...PHARMACIES, ...MARKETS, ...SCHOOLS];
    const m = await client.routeMatrixWalking(ORIGINS, dests);
    expect(transport.urls).toHaveLength(3);
    expect(m.stats).toMatchObject({ requests: 3, routesRequested: 132, failed: 0 });
    const [p, k, s] = [resultOf(BLIND_PHARMACY), resultOf(BLIND_MARKET), resultOf(BLIND_SCHOOL)];
    for (let i = 0; i < 12; i++) {
      const got = m.cells[i]?.map((c) => c.distanceM);
      const want = [
        ...[0, 1, 2, 3].map((j) => p[i * 4 + j]?.distance.value),
        ...[0, 1, 2, 3].map((j) => k[i * 4 + j]?.distance.value),
        ...[0, 1, 2].map((j) => s[i * 3 + j]?.distance.value),
      ];
      expect(got).toEqual(want);
    }
    // Quota counts routes, not requests.
    expect(client.ledger.usage('routematrix_walking')).toMatchObject({ used: 132, calls: 3 });
  });

  it('answers the recorded 1 × 50 batch; duration = distance / 1.17', async () => {
    const fx = fixture('api-probe/raw/04c_1x50_routematrix_walking.json');
    const client = testClient(spyReplay([fx]).transport);
    const dests = latLngList(requestParam(fx, 'destinations'));
    const m = await client.routeMatrixWalking([CENTER_A], dests);
    const row = m.cells[0] ?? [];
    expect(row).toHaveLength(50);
    for (const c of row) expect(Math.abs((c.distanceM ?? 0) / (c.durationS ?? 1) - 1.17)).toBeLessThan(0.01);
    expect(row[0]).toMatchObject({
      distanceM: 1044,
      durationS: 892,
      restrictionsStatus: 0,
      retrogradeDist: 0,
    });
  });

  it('serves repeated calls from the cache without touching quota', async () => {
    const { transport } = spyReplay([pharmacy]);
    const client = testClient(transport);
    await client.routeMatrixWalking(ORIGINS, PHARMACIES);
    const again = await client.routeMatrixWalking(ORIGINS, PHARMACIES);
    expect(transport.urls).toHaveLength(1);
    expect(again.stats).toMatchObject({ fromCache: 48, requests: 0 });
    expect(again.cells[3]?.[1]).toMatchObject({ via: 'cache', distanceM: 594 });
    expect(client.ledger.usage('routematrix_walking').used).toBe(48);
  });

  it('works offline through createReplayClient on the research recordings', async () => {
    const client = await createReplayClient({ dirs: [PROBE_RAW, ZJ_RAW] });
    const m = await client.routeMatrixWalking(ORIGINS, SCHOOLS);
    expect(m.cells[0]?.map((c) => c.distanceM)).toEqual([691, 1724, 2431]);
    expect(client.health().mode).toBe('replay');
    await expect(client.routeMatrixWalking([[121.5, 31.1]], [[121.51, 31.11]])).rejects.toMatchObject({
      kind: 'replay_miss',
    });
  });
});

describe('routeMatrixWalking — batching, dedupe and encoding', () => {
  const A: LngLat = [121.644195, 31.19007];
  const B: LngLat = [121.646054, 31.190555];
  const C: LngLat = [121.641878, 31.189311];

  it('splits 1 × 51 into 50 + 1 routes', async () => {
    const t = fakeMatrix();
    const dests = Array.from({ length: 51 }, (_, i): LngLat => [121.63 + i * 0.0005, 31.2]);
    const m = await testClient(t).routeMatrixWalking([A], dests);
    const sizes = t.urls.map((u) => (new URL(u).searchParams.get('destinations') ?? '').split('|').length);
    expect(sizes).toEqual([50, 1]);
    expect(m.cells[0]?.every((c) => c.status === 'ok')).toBe(true);
  });

  it('deduplicates identical OD pairs (1e-5°) and skips origin = destination', async () => {
    const t = fakeMatrix();
    const A2: LngLat = [A[0], A[1] + 2e-7];
    const m = await testClient(t).routeMatrixWalking([A, A2], [B, C, B, A]);
    expect(t.urls).toHaveLength(1);
    const u = new URL(t.urls[0] ?? '');
    expect(u.searchParams.get('origins')).toBe('31.190070,121.644195');
    expect(u.searchParams.get('destinations')).toBe('31.190555,121.646054|31.189311,121.641878');
    expect(m.stats).toMatchObject({ pairs: 8, unique: 3, identity: 1, fromApi: 2, routesRequested: 2 });
    expect(m.cells[1]?.[2]?.distanceM).toBe(m.cells[0]?.[0]?.distanceM);
    expect(m.cells[0]?.[3]).toEqual({ status: 'ok', distanceM: 0, durationS: 0, via: 'identity' });
  });

  it('turns a 0 distance into a missing value, not zero metres', async () => {
    const t = fakeMatrix((_o, d) => d[0] === C[0]);
    const m = await testClient(t).routeMatrixWalking([A], [B, C]);
    expect(m.cells[0]?.[1]).toMatchObject({ status: 'no_route', distanceM: null, durationS: null });
    expect(m.cells[0]?.[0]?.status).toBe('ok');
  });

  it('groups sparse pairs into exact blocks so no unrequested route is computed', async () => {
    const t = fakeMatrix();
    const D: LngLat = [121.65, 31.2];
    const pairs = [
      { origin: A, destination: B },
      { origin: A, destination: C },
      { origin: D, destination: B },
      { origin: D, destination: C },
      { origin: B, destination: D },
    ];
    const r = await testClient(t).routePairsWalking(pairs);
    const shapes = t.urls.map((s) => {
      const u = new URL(s);
      return [
        u.searchParams.get('origins')?.split('|').length,
        u.searchParams.get('destinations')?.split('|').length,
      ];
    });
    expect(shapes).toEqual([
      [2, 2],
      [1, 1],
    ]);
    expect(r.stats.routesRequested).toBe(5);
    expect(r.cells.every((c) => c.status === 'ok')).toBe(true);
  });

  it('plans the fewest requests with ≤ 50 routes each', () => {
    expect(planTiles(1, 50)).toEqual({ originChunk: 1, destChunk: 50, requests: 1 });
    expect(planTiles(12, 4)).toEqual({ originChunk: 12, destChunk: 4, requests: 1 });
    expect(planTiles(12, 11)).toEqual({ originChunk: 12, destChunk: 4, requests: 3 });
    expect(planTiles(100, 1)).toEqual({ originChunk: 50, destChunk: 1, requests: 2 });
    expect(planTiles(7, 7).requests).toBe(1);
    expect(planTiles(8, 7).requests).toBe(2);
    const ep = (k: string) => ({ key: k, point: [0, 0] as LngLat, uid: null });
    const pairs: MatrixPair[] = ['a', 'b', 'c'].map((d) => ({ origin: ep('o'), dest: ep(d) }));
    expect(planRequests(pairs).map((b) => [b.origins.length, b.dests.length])).toEqual([[1, 3]]);
  });

  it('binds POI uids as "lat,lng;uid" with ";" sent as %3B, on the unsigned matrix key', async () => {
    const t = fakeMatrix();
    await testClient(t).routeMatrixWalking([A], [B, C], { destUids: ['7740d3d9e9035493744ff1d7', null] });
    const url = t.urls[0] ?? '';
    expect(url).toContain(
      'destinations=31.190555,121.646054%3B7740d3d9e9035493744ff1d7%7C31.189311,121.641878&',
    );
    expect(url).toContain(`ak=${FAKE_ENV.BAIDU_MATRIX_AK}`);
    expect(url).not.toContain('sn=');
  });

  it('signs routematrix with the server key when no matrix key is configured', async () => {
    const t = fakeMatrix();
    const client = testClient(t, { config: fakeConfig({ BAIDU_MATRIX_AK: '' }) });
    await client.routeMatrixWalking([A], [B], { roadPrefer: 3 });
    const url = t.urls[0] ?? '';
    expect(url).toContain('road_prefer=3');
    const [unsigned, sn] = url.replace('https://api.map.baidu.com', '').split('&sn=');
    expect(sn).toBe(snSign(unsigned ?? '', FAKE_ENV.BAIDU_SERVER_SK));
  });

  it('211 (recorded): throws BaiduConfigError, or returns failed cells with partial', async () => {
    const fx = fixture('api-probe/raw/04x_routematrix_walking_1x1_server_ak_sn_blocked.json');
    const origin: LngLat = [121.593, 31.2035];
    const dest: LngLat = [121.598, 31.208];
    const client = testClient(spyReplay([fx]).transport);
    await expect(client.routeMatrixWalking([origin], [dest])).rejects.toBeInstanceOf(BaiduConfigError);
    const r = await client.routeMatrixWalking([origin], [dest], { partial: true });
    expect(r.cells[0]?.[0]).toMatchObject({ status: 'failed', distanceM: null });
    expect(r.errors[0]).toBeInstanceOf(BaiduConfigError);
    expect(r.errors[0]?.hint).toContain('BAIDU_MATRIX_AK');
    expect(client.ledger.usage('routematrix_walking')).toMatchObject({ used: 0, failed: 2 });
  });

  it('stops sending the remaining batches after a config error', async () => {
    const t = spyTransport(() => baiduJson({ status: 211, message: 'APP SN校验失败' }));
    const dests = Array.from({ length: 120 }, (_, i): LngLat => [121.6 + i * 0.001, 31.2]);
    const r = await testClient(t).routeMatrixWalking([A], dests, { partial: true });
    expect(t.urls).toHaveLength(1);
    expect(r.errors).toHaveLength(1);
    expect(r.cells[0]?.every((c) => c.status === 'failed')).toBe(true);
  });

  it('rejects swapped [lat, lng] input', async () => {
    await expect(testClient(fakeMatrix()).routeMatrixWalking([[31.19, 121.64]], [B])).rejects.toBeInstanceOf(
      BaiduInputError,
    );
  });
});

describe('place search', () => {
  const FAC = ['菜市场', '菜场', '农贸市场', '药店', '药房', '小学'];

  it('parses the recorded 1.5 km facility search (keywords joined with "$")', async () => {
    const { transport } = spyReplay([fixture('zhangjiang/raw/bv_place_A_fac_p0.json')]);
    const r = await testClient(transport).placeAround(FAC, CENTER_A, { radius: 1500 });
    expect(transport.urls[0]).toContain('query=%E8%8F%9C%E5%B8%82%E5%9C%BA$%E8%8F%9C%E5%9C%BA$');
    expect(r).toMatchObject({ total: 18, capped: false, complete: true, pages: 1, apiCalls: 1, via: 'api' });
    expect(r.pois).toHaveLength(18);
    const [stall, market] = [r.pois[2], r.pois[1]];
    expect(market).toMatchObject({
      name: '浦商邻里荟(孙桥店)',
      classifiedTag: '购物;农贸市场;菜市场',
      town: '张江镇',
    });
    expect(stall?.parentId).toBe(market?.uid);
    expect(r.pois[4]).toMatchObject({
      uid: '7740d3d9e9035493744ff1d7',
      distanceM: 185,
      naviLocation: [121.64605392448628, 31.190554943672492],
    });
    expect(r.pois[4]?.extra.shop_hours).toBe('09:00-22:00');
  });

  it('pages until total, within the page budget', async () => {
    const page = (pn: number, n: number) =>
      Array.from({ length: n }, (_, i) => ({
        name: `p${pn}-${i}`,
        uid: `u${pn}-${i}`,
        location: { lat: 31.19, lng: 121.64 + i * 1e-4 },
      }));
    const t = spyTransport((u) => {
      const pn = Number(u.searchParams.get('page_num'));
      return baiduJson({ status: 0, total: 45, results: page(pn, pn < 2 ? 20 : 5) });
    });
    const client = testClient(t);
    const all = await client.placeAround('药店', CENTER_A);
    expect(all).toMatchObject({ pages: 3, complete: true, capped: false });
    expect(all.pois).toHaveLength(45);
    const cut = await testClient(t).placeAround('药店', CENTER_A, { radius: 800, maxPages: 2 });
    expect(cut).toMatchObject({ pages: 2, complete: false });
  });

  it('flags results capped at 150', async () => {
    const t = spyTransport(() =>
      baiduJson({
        status: 0,
        total: 150,
        results: Array.from({ length: 20 }, (_, i) => ({
          name: `x${i}`,
          uid: `x${i}`,
          location: { lat: 31, lng: 121 },
        })),
      }),
    );
    const r = await testClient(t).placeAround('美食', CENTER_A, { maxPages: 1 });
    expect(r).toMatchObject({ total: 150, capped: true, complete: false });
  });

  it('splits more than 10 keywords into several queries', async () => {
    const t = spyTransport(() => baiduJson({ status: 0, total: 0, results: [] }));
    const words = Array.from({ length: 12 }, (_, i) => `词${i}`);
    const r = await testClient(t).placeAround(words, CENTER_A);
    expect(t.urls.map((u) => (new URL(u).searchParams.get('query') ?? '').split('$').length)).toEqual([
      10, 2,
    ]);
    expect(r.keywords).toHaveLength(12);
  });

  it('place/v3/region answers an address with address_type (recorded)', async () => {
    const { transport } = spyReplay([fixture('api-probe/raw/08f_v3_region_haike1650.json')]);
    const r = await testClient(transport).placeRegion('海科路1650号', '上海');
    expect(r.resultType).toBe('address_type');
    expect(r.pois[0]).toMatchObject({
      uid: null,
      name: '海科路1650号',
      location: [121.62426890957015, 31.193070480100403],
    });
  });
});

describe('directionlite, geocoding, reverse geocoding, geoconv', () => {
  it('parses a recorded walking route with steps', async () => {
    const { transport } = spyReplay([fixture('api-probe/raw/05_directionlite_walking_b090_1250m.json')]);
    const route = await testClient(transport).walkingRoute([121.589561, 31.183127], [121.602701, 31.183126]);
    expect(route).not.toBeNull();
    expect(route).toMatchObject({ distanceM: 1551, durationS: 1396, via: 'api' });
    expect(route?.steps).toHaveLength(6);
    expect(route?.steps[0]).toMatchObject({
      distanceM: 463,
      durationS: 446,
      instruction: '走460米,过马路右转进入集慧路',
    });
    expect(route?.steps[0]?.path[0]).toEqual([121.58955889843, 31.183124113248]);
    expect(route?.path.length).toBeGreaterThan(20);
    const url = transport.urls[0] ?? '';
    expect(url).toMatch(/steps_info=1&timestamp=\d+&ak=.+&sn=[0-9a-f]{32}$/);
  });

  it('returns null for status 7 (no route)', async () => {
    const t = spyTransport(() => baiduJson({ status: 7, message: '无返回结果' }));
    expect(await testClient(t).walkingRoute([121.6, 31.2], [121.61, 31.21])).toBeNull();
  });

  it('geocoding keeps precise / confidence / comprehension (recorded mislocation)', async () => {
    const { transport } = spyReplay([fixture('api-probe/raw/01_geocoding_venue.json')]);
    const g = await testClient(transport).geocode('上海市浦东新区海科路1650号', { city: '上海市' });
    expect(g).toEqual({
      location: [121.58956054059783, 31.183126632536755],
      precise: false,
      confidence: 80,
      comprehension: 99,
      level: '门址',
      via: 'api',
    });
  });

  it('reverse geocoding gives district, town and the enclosing estate', async () => {
    const { transport } = spyReplay([fixture('zhangjiang/raw/bv_reverse_A.json')]);
    const r = await testClient(transport).reverseGeocode(CENTER_A, { pois: true, radius: 300 });
    expect(r).toMatchObject({
      district: '浦东新区',
      town: '张江镇',
      townCode: '310115125',
      street: '孙环路',
    });
    expect(r?.regions[0]).toMatchObject({ name: '申城佳苑', relation: '内' });
    expect(r?.pois).toHaveLength(20);
  });

  it('geoconv v2 converts WGS84 → BD-09 with model=2 (recorded)', async () => {
    const fx = fixture('zhangjiang/raw/bv_geoconv_wgs84_to_bd09.json');
    const pts = requestParam(fx, 'coords')
      .split(';')
      .map((p) => p.split(',').map(Number) as LngLat);
    const out = await testClient(spyReplay([fx]).transport).geoconv(pts, {
      model: GEOCONV_MODEL.WGS84_TO_BD09,
    });
    expect(out).toHaveLength(4);
    expect(out[0]).toEqual([121.64419947904986, 31.190073754820798]);
  });

  it('reports a bad geoconv reply instead of misaligning points', async () => {
    const t = spyTransport(() => baiduJson({ status: 0, result: [{ x: 1, y: 2 }] }));
    await expect(
      testClient(t).geoconv(
        [
          [121.6, 31.2],
          [121.7, 31.3],
        ],
        { model: 2 },
      ),
    ).rejects.toBeInstanceOf(BaiduUpstreamError);
  });
});

describe('health', () => {
  it('reports modes, quota and cache without any key material', async () => {
    const client = testClient(fakeMatrix());
    await client.routeMatrixWalking([CENTER_A], [[121.65, 31.2]]);
    const h = client.health();
    expect(h).toMatchObject({ mode: 'live', live: true, tier: 'personal', store: 'memory' });
    expect(h.auth.routematrix_walking).toBe('ip');
    expect(h.quota.routematrix_walking).toMatchObject({ used: 1, limit: 5000 });
    const text = JSON.stringify(h);
    for (const secret of [FAKE_ENV.BAIDU_SERVER_AK, FAKE_ENV.BAIDU_SERVER_SK, FAKE_ENV.BAIDU_MATRIX_AK]) {
      expect(text).not.toContain(secret);
    }
  });

  it('serves cached answers even without keys (sample mode with a warm cache)', async () => {
    const t = spyTransport(() =>
      baiduJson({ status: 0, result: { location: { lng: 121.6, lat: 31.2 }, precise: 1 } }),
    );
    const warm = testClient(t);
    await warm.geocode('上海市申城佳苑');
    const cold = testClient(t, {
      config: fakeConfig({ BAIDU_SERVER_AK: '', BAIDU_MATRIX_AK: '' }),
      cache: warm.cache,
    });
    expect((await cold.geocode('上海市申城佳苑'))?.via).toBe('cache');
    await expect(cold.geocode('别处')).rejects.toBeInstanceOf(BaiduConfigError);
    expect(t.urls).toHaveLength(1);
  });
});
