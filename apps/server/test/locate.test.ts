import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BaiduConfigError,
  BaiduQuotaError,
  BaiduUpstreamError,
  createBaiduClient,
  MemoryStore,
  replayConfig,
  type BaiduClient,
  type GeocodeResult,
  type PlacePoi,
  type PlaceSearchResult,
} from '@zoudedao/baidu';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { LocateResponse } from '../src/routes/locate.js';
import { makeApp } from './helpers.js';

const url = (q: string, city?: string) =>
  `/api/locate?q=${encodeURIComponent(q)}${city === undefined ? '' : `&city=${encodeURIComponent(city)}`}`;

/** Real client (fake keys, memory store) whose three network methods are stubbed per test. */
function stubbedClient() {
  const client: BaiduClient = createBaiduClient({
    config: replayConfig('personal'),
    store: new MemoryStore(),
    mode: 'replay',
  });
  return {
    client,
    geocode: vi.spyOn(client, 'geocode'),
    reverseGeocode: vi.spyOn(client, 'reverseGeocode').mockResolvedValue(null as never),
    placeRegion: vi.spyOn(client, 'placeRegion'),
  };
}

const geocoded = (location: [number, number], precise: boolean): GeocodeResult => ({
  location,
  precise,
  confidence: 50,
  comprehension: 100,
  level: precise ? '门址' : '道路',
  via: 'api',
});

const poi = (name: string, address: string, location: [number, number]): PlacePoi =>
  ({ uid: `uid-${name}`, name, address, location, area: '浦东新区', town: '张江镇' }) as unknown as PlacePoi;

const placeResult = (pois: PlacePoi[]): PlaceSearchResult =>
  ({ pois, resultType: 'poi_type', total: pois.length, capped: false }) as unknown as PlaceSearchResult;

describe('GET /api/locate in sample mode', () => {
  it('matches the sample catalogue by name or centre label, ignoring case and spaces', async () => {
    const app = await makeApp();
    const byName = await app.inject(url('申城佳苑'));
    expect(byName.statusCode).toBe(200);
    expect(byName.json<LocateResponse>()).toEqual({
      query: '申城佳苑',
      city: '上海市',
      best: {
        name: '申城佳苑片区',
        address: '孙环路 × 高木桥路',
        center_bd09: [121.644195, 31.19007],
        source: 'sample',
        confidence: 1,
        reason: expect.any(String),
        sample_id: 'zj-a',
      },
      candidates: [expect.objectContaining({ sample_id: 'zj-a' })],
      needs_confirmation: false,
      warnings: [expect.stringContaining('样例模式')],
    });

    const byLabel = (await app.inject(url('孙环路×高木桥路'))).json<LocateResponse>();
    expect(byLabel.best?.sample_id).toBe('zj-a');

    const none = (await app.inject(url('人民广场'))).json<LocateResponse>();
    expect(none).toMatchObject({ best: null, candidates: [], needs_confirmation: true });
    await app.close();
  });

  it('is case-insensitive and lists several hits with their distance to the best one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zdd-locate-'));
    const sample = (name: string, center: [number, number]) =>
      JSON.stringify({ meta: { name, center_bd09: center, center_label: 'Demo Road' } });
    writeFileSync(join(dir, 'a.json'), sample('Zhangjiang Alpha', [121.6, 31.2]));
    writeFileSync(join(dir, 'b.json'), sample('Zhangjiang Beta', [121.61, 31.2]));
    const app = await makeApp({ samplesDir: dir });

    const res = (await app.inject(url('ZHANGJIANG'))).json<LocateResponse>();
    expect(res.candidates.map((c) => c.sample_id)).toEqual(['a', 'b']);
    expect(res.needs_confirmation).toBe(true);
    expect(res.candidates[0]?.distance_to_best_m).toBeUndefined();
    expect(res.candidates[1]?.distance_to_best_m).toBeGreaterThan(900);
    expect(res.candidates[1]?.distance_to_best_m).toBeLessThan(1000);
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ['/api/locate', 'q 须为'],
    [url('   '), 'q 须为'],
    [url('路'.repeat(61)), 'q 须为'],
    [`${url('申城佳苑')}&q=again`, 'q 须为'],
    [url('申城佳苑', '市'.repeat(21)), 'city 须为'],
  ])('rejects %s with 400 invalid_input', async (path, hint) => {
    const app = await makeApp();
    const res = await app.inject(path);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_input', message: expect.stringContaining(hint) });
    await app.close();
  });
});

describe('GET /api/locate in live mode', () => {
  const apps: { close(): Promise<unknown> }[] = [];
  afterAll(async () => {
    for (const app of apps) await app.close();
  });

  async function liveApp(
    stub: ReturnType<typeof stubbedClient>,
    locatePerMinute = 30,
    locateTimeoutMs = 20_000,
  ) {
    const app = await makeApp(
      {
        mode: 'live',
        rateLimit: { globalPerMinute: 1000, analyzePerHour: 6, locatePerMinute },
        locateTimeoutMs,
      },
      { baidu: stub.client },
    );
    apps.push(app);
    return app;
  }

  it('returns a precise geocoding hit directly, defaulting the city to 上海市', async () => {
    const stub = stubbedClient();
    stub.geocode.mockResolvedValue(geocoded([121.624269, 31.19307], true));
    const app = await liveApp(stub);

    const res = await app.inject(url('海科路1650号'));
    expect(res.statusCode).toBe(200);
    expect(res.json<LocateResponse>()).toMatchObject({
      query: '海科路1650号',
      city: '上海市',
      best: {
        name: '海科路1650号',
        center_bd09: [121.624269, 31.19307],
        source: 'geocoding',
        confidence: 0.9,
      },
      needs_confirmation: false,
      warnings: [],
    });
    expect(stub.geocode).toHaveBeenCalledWith('海科路1650号', expect.objectContaining({ city: '上海市' }));
    expect(stub.placeRegion).not.toHaveBeenCalled();
  });

  it('ranks place-search candidates, splits name and address, and caches identical lookups', async () => {
    const stub = stubbedClient();
    stub.geocode.mockResolvedValue(geocoded([121.5, 31.1], false));
    stub.placeRegion.mockResolvedValue(
      placeResult([
        poi('AI小镇服务中心', '海科路1650号', [121.624269, 31.19307]),
        poi('海科路1650号东塔', '海科路1650号', [121.6249, 31.1932]),
      ]),
    );
    const app = await liveApp(stub);

    const first = (await app.inject(url('AI小镇服务中心'))).json<LocateResponse>();
    expect(first.best).toMatchObject({
      name: 'AI小镇服务中心',
      address: '海科路1650号',
      source: 'place_region',
      uid: 'uid-AI小镇服务中心',
    });
    expect(first.best?.distance_to_best_m).toBeUndefined();
    const others = first.candidates.slice(1);
    expect(others.length).toBeGreaterThan(0);
    for (const c of others) expect(c.distance_to_best_m).toEqual(expect.any(Number));

    const again = (await app.inject(url('AI小镇服务中心'))).json<LocateResponse>();
    expect(again).toEqual(first);
    expect(stub.geocode).toHaveBeenCalledTimes(1);

    await app.inject(url('AI小镇服务中心', '北京市'));
    expect(stub.geocode).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      new BaiduQuotaError('地理编码今日配额已用到 90%（4500/5000），拒绝新的实时调用', { scope: 'soft' }),
      429,
      'quota_exhausted',
    ],
    [new BaiduConfigError('地理编码没有可用的 Key', { hint: '配置 BAIDU_SERVER_AK' }), 503, 'auth'],
    [
      new BaiduUpstreamError('请求失败：https://api.map.baidu.com/geocoding/v3/?address=x&ak=SECRETAK123', {
        kind: 'network',
      }),
      502,
      'upstream',
    ],
  ])('maps Baidu errors to the unified error JSON (%#)', async (err, status, code) => {
    const stub = stubbedClient();
    stub.geocode.mockRejectedValue(err);
    const app = await liveApp(stub);
    const res = await app.inject(url('海科路1650号'));
    expect(res.statusCode).toBe(status);
    expect(res.json()).toEqual({ error: code, message: expect.any(String) });
    expect(res.payload).not.toMatch(/SECRETAK123|https?:\/\//);

    // Failures are not cached: the next search tries again.
    await app.inject(url('海科路1650号'));
    expect(stub.geocode).toHaveBeenCalledTimes(2);
  });

  it('answers 500 without details when the failure is not a Baidu error', async () => {
    const stub = stubbedClient();
    stub.geocode.mockRejectedValue(new TypeError('boom'));
    const app = await liveApp(stub);
    const res = await app.inject(url('海科路1650号'));
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal', message: '服务器内部错误，请稍后再试' });
  });

  it('gives up at the deadline with 504 timeout and aborts the Baidu calls', async () => {
    const stub = stubbedClient();
    let aborted: unknown;
    // Honour the signal like the real client does …
    stub.geocode.mockImplementation(
      (_q, opts) =>
        new Promise((_resolve, reject) =>
          opts?.signal?.addEventListener('abort', () => {
            aborted = opts.signal?.reason;
            reject(opts.signal?.reason);
          }),
        ),
    );
    const app = await liveApp(stub, 30, 50);
    const res = await app.inject(url('海科路1650号'));
    expect(res.statusCode).toBe(504);
    expect(res.json()).toEqual({ error: 'timeout', message: expect.stringContaining('地址搜索超时') });
    expect((aborted as Error).name).toBe('TimeoutError');

    // … and also when a call ignores it.
    const deaf = stubbedClient();
    deaf.geocode.mockReturnValue(new Promise(() => {}));
    const deafApp = await liveApp(deaf, 30, 50);
    expect((await deafApp.inject(url('海科路1650号'))).statusCode).toBe(504);
  });

  it('has its own per-IP rate limit', async () => {
    const stub = stubbedClient();
    stub.geocode.mockResolvedValue(geocoded([121.624269, 31.19307], true));
    const app = await liveApp(stub, 2);
    expect((await app.inject(url('甲'))).statusCode).toBe(200);
    expect((await app.inject(url('乙'))).statusCode).toBe(200);
    const limited = await app.inject(url('丙'));
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({
      error: 'rate_limited',
      message: expect.stringContaining('地址搜索过于频繁'),
    });
  });
});
