import { afterEach, describe, expect, it, vi } from 'vitest';
import { gcj02ToBd09, haversine, wgs84ToBd09 } from '@zoudedao/core';
import { crsCode, fmtLngLat, parseCoords, toBd09 } from './coords.js';
import { conversionText, locateCoords } from './locate.js';

describe('parseCoords: the search plate reads coordinates in the forms people paste', () => {
  const at = { ok: true, lng: 121.644195, lat: 31.19007, swapped: false };
  it.each([
    ['121.644195,31.19007'],
    ['121.644195, 31.19007'],
    ['121.644195 31.19007'],
    ['  121.644195   31.19007  '],
    ['121.644195，31.19007'], // 全角逗号 (Chinese IME)
    ['121.644195 ，31.19007'],
    ['１２１．６４４１９５，３１．１９００７'], // full-width digits and point
    ['121.644195、31.19007'],
    ['121.644195;31.19007'],
    ['(121.644195, 31.19007)'],
    ['（121.644195，31.19007）'],
    ['[121.644195,31.19007]'],
  ])('%s', (text) => {
    expect(parseCoords(text)).toEqual(at);
  });

  it('reads latitude-first pairs back as longitude, latitude and says so', () => {
    expect(parseCoords('31.19007, 121.644195')).toEqual({ ...at, swapped: true });
  });

  it('keeps addresses and partial numbers as text', () => {
    for (const text of ['孙环路 高木桥路', '益江路208号', '121.64', '121.64,31.19,5', '海科路1650号 2', '']) {
      expect(parseCoords(text)).toBeNull();
    }
  });

  it('flags number pairs that are not a longitude/latitude in China instead of geocoding them', () => {
    expect(parseCoords('2.35, 48.85')).toEqual({ ok: false, reason: 'range' }); // Paris
    expect(parseCoords('-73.98 40.75')).toEqual({ ok: false, reason: 'range' });
    expect(parseCoords('200, 31')).toEqual({ ok: false, reason: 'range' });
  });
});

describe('local conversion (fallback when the server does not convert)', () => {
  it('uses the core formulas per frame; BD-09 passes through', () => {
    expect(toBd09(121.644195, 31.19007, 'bd09')).toEqual([121.644195, 31.19007]);
    expect(toBd09(121.6335, 31.1865, 'gcj02')).toEqual(gcj02ToBd09(121.6335, 31.1865));
    expect(toBd09(121.6335, 31.1865, 'wgs84')).toEqual(wgs84ToBd09(121.6335, 31.1865));
    // WGS-84 → BD-09 moves a Shanghai point by some 600 m: the reason the plate asks for the frame
    const [lng, lat] = toBd09(121.6335, 31.1865, 'wgs84');
    expect(haversine(121.6335, 31.1865, lng, lat)).toBeGreaterThan(400);
  });

  it('formats points with six decimals and names the frames by their codes', () => {
    expect(fmtLngLat([121.644195, 31.19007])).toBe('121.644195, 31.190070');
    expect(fmtLngLat([121.644201, 31.190069], 5)).toBe('121.64420, 31.19007');
    expect(['bd09', 'gcj02', 'wgs84'].map((c) => crsCode(c as 'bd09'))).toEqual([
      'BD-09',
      'GCJ-02',
      'WGS-84',
    ]);
  });

  it('words the conversion for the progress line', () => {
    expect(conversionText('wgs84', 'baidu_geoconv')).toBe('已用百度坐标转换：WGS-84 → BD-09');
    expect(conversionText('gcj02', 'local')).toBe('已按公开公式换算：GCJ-02 → BD-09');
    expect(conversionText('bd09', 'none')).toBe('百度 BD-09 坐标，无需转换');
    expect(conversionText(undefined, undefined)).toBeNull();
  });
});

describe('locateCoords: GET /api/locate?crs=…, then the local fallback', () => {
  afterEach(() => vi.unstubAllGlobals());
  const reply = (body: unknown, status = 200) =>
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
    );

  it('asks the server with the frame and takes its converted point', async () => {
    const candidate = {
      name: '坐标 121.633500, 31.186500',
      center_bd09: [121.644, 31.19],
      source: 'coordinate',
      crs: 'wgs84',
      converted_via: 'baidu_geoconv',
      confidence: 1,
      reason: '输入的经纬度',
    };
    const fetchMock = reply({ best: candidate, candidates: [candidate], needs_confirmation: false });
    vi.stubGlobal('fetch', fetchMock);
    const r = await locateCoords(121.6335, 31.1865, 'wgs84');
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe(
      '/api/locate?q=121.6335%2C31.1865&crs=wgs84',
    );
    expect(r).toEqual({ kind: 'coordinate', point: candidate });
  });

  it('converts locally (and says so) when the server answers without a coordinate candidate', async () => {
    vi.stubGlobal('fetch', reply({ best: null, candidates: [], needs_confirmation: true, warnings: [] }));
    const r = await locateCoords(121.6335, 31.1865, 'gcj02');
    expect(r.kind).toBe('coordinate');
    if (r.kind !== 'coordinate') return;
    const [lng, lat] = gcj02ToBd09(121.6335, 31.1865);
    expect(r.point.center_bd09[0]).toBeCloseTo(lng, 6);
    expect(r.point.center_bd09[1]).toBeCloseTo(lat, 6);
    expect(r.point).toMatchObject({ source: 'coordinate', crs: 'gcj02', converted_via: 'local' });
  });

  it('passes on what the server says went wrong instead of hiding it', async () => {
    vi.stubGlobal('fetch', reply({ error: 'rate_limited', message: '请求太频繁，请 1 分钟后再试' }, 429));
    expect(await locateCoords(121.6335, 31.1865, 'wgs84')).toEqual({
      kind: 'unavailable',
      message: '请求太频繁，请 1 分钟后再试',
    });
  });
});
