/**
 * 步行路线证据 (GET /api/route) against a mocked server, and the bundled sample's stored routes a
 * page without a server reads instead: the request carries the contract's fields, a stored route is
 * read in the analysis' own metres, and every failure says honestly why there is no route.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { XY } from '@zoudedao/core';
import routesA from '../../../../data/samples/routes/zj-a.json?raw';
import { bundledRoute, getRoute, parseRoute, parseStoredRoutes, type RouteRequest } from './route.js';

const req: RouteRequest = {
  analysis_id: 'zj-a',
  community: '申城佳苑三期B块',
  category: '小学',
};
const toXY = (lng: number, lat: number): XY => [(lng - 121.644195) * 95000, (lat - 31.19007) * 110574];

/** The A-11 answer as the server gives it (docs/api.md), its path cut to four points. */
const A11 = {
  analysis_id: 'zj-a',
  community: { name: '申城佳苑三期B块', code: 'A-11', xy: [-30.4, -410.2], bd09: [121.643876, 31.18636] },
  facility: {
    name: '孙桥小学(申江校区)',
    uid: '2718beba73c5a7c45cd4fe3e',
    category: '小学',
    xy: [-779.2, -740.8],
    bd09: [121.636013, 31.18337],
    entrance_xy: [-848.9, -738.1],
  },
  category: '小学',
  rules: 'task',
  check: { status: '伪覆盖', verified: true, route_m: 1676, straight_m: 818.5, rule_m: 1000 },
  path_bd09: [
    [121.643871, 31.186321],
    [121.643951, 31.186342],
    [121.64, 31.185],
    [121.635276, 31.183388],
  ],
  path_xy: [
    [-30.9, -414.5],
    [-23.2, -412.2],
    [-400, -560],
    [-849.3, -738.9],
  ],
  distance_m: 1676,
  duration_s: 1543,
  straight_m: 881.6,
  source: 'stored',
  fetched_at: '2026-09-28T11:56:20.995Z',
};

const reply = (body: unknown, status = 200) =>
  vi.fn(
    async () =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );

describe('getRoute', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('asks for one unit’s check by analysis, community and category', async () => {
    const fetchMock = reply(A11);
    vi.stubGlobal('fetch', fetchMock);
    const r = await getRoute(req, toXY, new AbortController().signal);
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    const q = new URL(url, 'http://x').searchParams;
    expect(url.startsWith('/api/route?')).toBe(true);
    expect(Object.fromEntries(q)).toEqual({
      analysis_id: 'zj-a',
      community: '申城佳苑三期B块',
      category: '小学',
    });
    // the route in the analysis' own metres, as the server wrote it
    expect(r.path).toEqual(A11.path_xy);
    expect(r.distance_m).toBe(1676);
    expect(r.facility).toEqual({
      name: '孙桥小学(申江校区)',
      category: '小学',
      xy: [-779.2, -740.8],
      entrance_xy: [-848.9, -738.1],
    });
    expect(r.community?.code).toBe('A-11');
    expect(r.source).toBe('stored');
  });

  it('says a route never fetched needs the server key in sample mode (409)', async () => {
    vi.stubGlobal('fetch', reply({ error: 'live_mode_disabled' }, 409));
    await expect(getRoute(req, toXY, new AbortController().signal)).rejects.toThrow(
      /还没有保存过.*百度 Key（live 模式）/,
    );
  });

  it('passes the server’s own reason through (a check that was never routed)', async () => {
    vi.stubGlobal(
      'fetch',
      reply({ error: 'not_found', message: '这项判定没有算路：判定距离内没有这类设施' }, 404),
    );
    await expect(getRoute(req, toXY, new AbortController().signal)).rejects.toThrow('这项判定没有算路');
  });

  it('names the missing endpoint on an older server', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Not Found', { status: 404 })),
    );
    await expect(getRoute(req, toXY, new AbortController().signal)).rejects.toThrow('GET /api/route');
  });

  it('says so when there is no server at all, and treats a broken answer as an error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await expect(getRoute(req, toXY, new AbortController().signal)).rejects.toThrow('无法连接邻至服务端');
    vi.stubGlobal('fetch', reply({ distance_m: 1676, path_xy: [[0, 0]] }));
    await expect(getRoute(req, toXY, new AbortController().signal)).rejects.toThrow('返回数据不完整');
  });
});

describe('parseRoute', () => {
  it('reads a route asked for by coordinates alone (no local metres) through the frame', () => {
    const r = parseRoute({ ...A11, path_xy: null, community: null, facility: null }, toXY);
    expect(r?.path).toHaveLength(4);
    expect(r!.path[0]![0]).toBeCloseTo(toXY(121.643871, 31.186321)[0], 6);
    expect(r?.community).toBeNull();
    expect(parseRoute({ nope: true }, toXY)).toBeNull();
  });
});

describe('the bundled sample’s stored routes (no server)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const file = JSON.parse(routesA) as unknown;

  it('reads every stored route of the file', () => {
    const list = parseStoredRoutes(file);
    expect(list.length).toBe((file as { routes: unknown[] }).routes.length);
    expect(list.find((r) => r.community === '申城佳苑三期B块' && r.category === '小学')?.distance_m).toBe(
      1676,
    );
  });

  it('finds a route by community and category, in the frame on screen', async () => {
    vi.stubGlobal('fetch', reply(file));
    const r = await bundledRoute('zj-a', { community: '申城佳苑三期B块', category: '小学' }, toXY);
    expect(r?.distance_m).toBe(1676);
    expect(r?.source).toBe('bundled');
    expect(r?.path.length).toBeGreaterThan(10);
    // stored for the task rule only: the GB check of the same pair is another route
    expect(await bundledRoute('zj-a', { community: '申城佳苑三期B块', category: '菜市场' }, toXY)).toBeNull();
    // another sample's routes are not shipped with the page
    expect(await bundledRoute('zj-b', { community: '梦想园', category: '菜市场' }, toXY)).toBeNull();
  });
});
