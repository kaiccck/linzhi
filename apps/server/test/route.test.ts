import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { frameOf } from '@zoudedao/agent';
import { BaiduQuotaError, type WalkingRoute } from '@zoudedao/baidu';
import { routingPoint, type AnalysisResult, type LngLat } from '@zoudedao/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkPair, routeKey, type RouteWalker } from '../src/route.js';
import { WindowLimiter, type RouteResponse } from '../src/routes/route.js';
import { makeApp, SAMPLES_DIR } from './helpers.js';

const zjA = () => JSON.parse(readFileSync(join(SAMPLES_DIR, 'zj-a.json'), 'utf8')) as AnalysisResult;
const zj = zjA();
const frame = frameOf(zj.meta);
const bd = (p: readonly number[]): LngLat => [Number(p[0]!.toFixed(6)), Number(p[1]!.toFixed(6))];

// 川杨新苑四期 → 浦商生鲜(申城佳苑店): 1,281 m for a straight 733.7 m, the task rule's 伪覆盖 of 菜市场
const COMMUNITY = '川杨新苑四期';
const pair = checkPair(zj, 'zj-a', { community: COMMUNITY, category: '菜市场' });
if ('kind' in pair) throw new Error('fixture: 川杨新苑四期 has a routed 菜市场 check');

/** Temp samples dir: zj-a, a copy whose 药店 checks were never routed, and a stored route. */
let dir: string;
let dbPath: string;
const storedPair = checkPair(zj, 'zj-a', { community: '申城佳苑二期B块', category: '小学' });
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'zdd-route-'));
  dbPath = join(dir, 'history.sqlite');
  copyFileSync(join(SAMPLES_DIR, 'zj-a.json'), join(dir, 'zj-a.json'));
  const unrouted = zjA();
  for (const c of unrouted.communities) {
    c.checks['药店'] = {
      ...c.checks['药店'],
      route_basis: 'lower_bound',
      via: undefined,
      via_uid: undefined,
    };
  }
  writeFileSync(join(dir, 'zz-lb.json'), JSON.stringify(unrouted));
  if ('kind' in storedPair) throw new Error('fixture');
  mkdirSync(join(dir, 'routes'));
  writeFileSync(
    join(dir, 'routes', 'zj-a.json'),
    JSON.stringify({
      analysis_id: 'zj-a',
      routes: [
        {
          community: '申城佳苑二期B块',
          category: '小学',
          from_bd09: storedPair.from,
          to_bd09: storedPair.to,
          distance_m: 1250,
          duration_s: 1130,
          path_bd09: [storedPair.from, storedPair.to],
          fetched_at: '2026-09-28T12:00:00.000Z',
        },
      ],
    }),
  );
  writeFileSync(join(dir, 'routes', 'broken.json'), '{ nope');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface Call {
  origin: LngLat;
  destination: LngLat;
  stepsInfo: boolean | undefined;
  signal: AbortSignal | undefined;
}

/** An L-shaped walk (east, then north) with two steps; `answer` overrides it. */
function fakeWalker(answer?: () => Promise<WalkingRoute | null>) {
  const calls: Call[] = [];
  const walker: RouteWalker = {
    walkingRoute: async (origin, destination, o = {}) => {
      calls.push({ origin, destination, stepsInfo: o.stepsInfo, signal: o.signal });
      if (answer) return answer();
      const corner: LngLat = [destination[0], origin[1]];
      return {
        distanceM: 1290,
        durationS: 1160,
        origin,
        destination,
        steps: [],
        path: [origin, corner, destination],
        via: 'api',
      };
    },
  };
  return { walker, calls };
}

const get = (query: Record<string, string>, remoteAddress?: string) => ({
  method: 'GET' as const,
  url: '/api/route',
  query,
  ...(remoteAddress ? { remoteAddress } : {}),
});
const checkQuery = (community = COMMUNITY, category = '菜市场') => ({
  analysis_id: 'zj-a',
  community,
  category,
});

describe('GET /api/route', () => {
  it('walks from the community to the facility its check routed to, through Baidu, once per pair', async () => {
    const { walker, calls } = fakeWalker();
    const app = await makeApp({ mode: 'live', samplesDir: dir, historyPath: dbPath }, { walker });
    const res = await app.inject(get(checkQuery()));
    expect(res.statusCode).toBe(200);
    const body = res.json() as RouteResponse;
    const c = zj.communities.find((x) => x.name === COMMUNITY)!;
    const via = zj.pois.find((p) => p.uid === c.checks['菜市场'].via_uid)!;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      origin: bd(frame.toLngLat(c.centroid[0], c.centroid[1])),
      destination: bd(frame.toLngLat(routingPoint(via)[0], routingPoint(via)[1])),
      stepsInfo: true,
    });
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(body).toMatchObject({
      analysis_id: 'zj-a',
      category: '菜市场',
      rules: 'task',
      community: { name: COMMUNITY, code: expect.stringMatching(/^A-\d\d$/), xy: c.centroid },
      facility: { name: '浦商生鲜(申城佳苑店)', uid: via.uid, category: '菜市场' },
      check: {
        status_main: '伪覆盖',
        verified: true,
        route_m: 1281,
        rule_m: 1000,
        via: '浦商生鲜(申城佳苑店)',
      },
      distance_m: 1290,
      duration_s: 1160,
      source: 'baidu',
    });
    expect(body.path_bd09).toHaveLength(3);
    expect(body.path_xy).toHaveLength(3);
    // path_xy is the path in the analysis frame: it starts at the community and ends at the entrance
    expect(body.path_xy![0]![0]).toBeCloseTo(c.centroid[0], 0);
    expect(body.path_xy![2]![1]).toBeCloseTo(routingPoint(via)[1], 0);
    expect(body.straight_m).toBeGreaterThan(700);
    expect(body.straight_m).toBeLessThan(body.distance_m);

    // kept forever per pair: again (and after a restart) without calling Baidu
    const again = (await app.inject(get(checkQuery()))).json() as RouteResponse;
    expect(again).toMatchObject({ source: 'stored', distance_m: 1290, fetched_at: body.fetched_at });
    expect(calls).toHaveLength(1);
    await app.close();
    const restarted = await makeApp({ samplesDir: dir, historyPath: dbPath });
    const stored = await restarted.inject(get(checkQuery()));
    expect(stored.statusCode).toBe(200);
    expect(stored.json()).toMatchObject({ source: 'stored', path_bd09: body.path_bd09 });
    await restarted.close();
  });

  it('serves the routes stored with the samples in sample mode; anything else is 409', async () => {
    const app = await makeApp({ samplesDir: dir });
    const hit = await app.inject(get(checkQuery('申城佳苑二期B块', '小学')));
    expect(hit.statusCode).toBe(200);
    expect(hit.json()).toMatchObject({
      source: 'stored',
      distance_m: 1250,
      fetched_at: '2026-09-28T12:00:00.000Z',
      community: { name: '申城佳苑二期B块' },
      facility: { name: '孙桥小学(张江校区)' },
    });
    const miss = await app.inject(get(checkQuery()));
    expect(miss.statusCode).toBe(409);
    expect(miss.json()).toEqual({ error: 'live_mode_disabled', message: expect.stringMatching(/样例模式/) });
    // replay mode (ZDD_MODE=live without keys) has no walker either
    const replay = await makeApp({ mode: 'live', samplesDir: dir });
    expect((await replay.inject(get(checkQuery()))).statusCode).toBe(409);
    await replay.close();
    await app.close();
  });

  it('accepts rules=task from older clients, by map code too, and refuses the retired gb50180', async () => {
    const { walker, calls } = fakeWalker();
    const app = await makeApp({ mode: 'live', samplesDir: dir }, { walker });
    const task = checkPair(zj, 'zj-a', { community: '申城佳苑一期A块', category: '小学' });
    if ('kind' in task) throw new Error('fixture');
    const res = await app.inject(get({ ...checkQuery(task.community.code, '小学'), rules: 'task' }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      rules: 'task',
      community: { name: '申城佳苑一期A块' },
      check: { rule_m: 1000 },
    });
    expect(calls[0]!.destination).toEqual(task.to);
    const gb = await app.inject(get({ ...checkQuery(), rules: 'gb50180' }));
    expect(gb.statusCode).toBe(400);
    expect(gb.json()).toEqual({
      error: 'invalid_input',
      message: expect.stringMatching(/rules 只能是 task/),
    });
    expect(calls).toHaveLength(1);
    await app.close();
  });

  it('takes two BD-09 points, with path_xy only when an analysis gives the frame', async () => {
    const { walker, calls } = fakeWalker();
    const app = await makeApp({ mode: 'live', samplesDir: dir }, { walker });
    const from = '121.644195,31.19007';
    const to = '121.6455，31.1935';
    const bare = (await app.inject(get({ from, to }))).json() as RouteResponse;
    expect(bare).toMatchObject({
      analysis_id: null,
      community: null,
      facility: null,
      check: null,
      path_xy: null,
    });
    expect(calls[0]).toMatchObject({ origin: [121.644195, 31.19007], destination: [121.6455, 31.1935] });
    const framed = (await app.inject(get({ from, to, analysis_id: 'zj-a' }))).json() as RouteResponse;
    expect(framed.path_xy![0]).toEqual([0, 0]);
    expect(framed.source).toBe('stored');
    await app.close();
  });

  it('answers bad requests in Chinese', async () => {
    const { walker, calls } = fakeWalker();
    const app = await makeApp({ mode: 'live', samplesDir: dir }, { walker });
    const cases: [Record<string, string>, number, RegExp][] = [
      [{}, 400, /analysis_id、community、category/],
      [{ analysis_id: 'zj-a', community: COMMUNITY }, 400, /analysis_id、community、category/],
      [{ ...checkQuery(), category: '医院' }, 400, /category 只能是/],
      [{ ...checkQuery(), rules: 'x' }, 400, /rules 只能是/],
      [{ ...checkQuery(), analysis_id: '../zj-a' }, 400, /analysis_id 须为分析编号/],
      [{ from: '121.6,31.2' }, 400, /from 和 to 都要给出/],
      [{ from: '2.35,48.85', to: '121.6,31.2' }, 400, /中国境内/],
      [{ from: '121.6,31.2', to: '121.7,31.2' }, 400, /超过 3000 米/],
      [{ from: '121.6,31.2', to: '121.61,31.2', community: COMMUNITY }, 400, /二选一/],
      [checkQuery('没有这个小区'), 404, /没有小区“没有这个小区”.*川杨新苑四期/],
      [{ ...checkQuery(), analysis_id: 'zj-zz' }, 404, /找不到分析 zj-zz/],
      [{ ...checkQuery(COMMUNITY, '药店'), analysis_id: 'zz-lb' }, 404, /没有算路/],
    ];
    for (const [query, status, message] of cases) {
      const res = await app.inject(get(query));
      expect(res.statusCode, JSON.stringify(query)).toBe(status);
      expect(res.json().message, JSON.stringify(query)).toMatch(message);
    }
    expect(calls).toHaveLength(0);
    await app.close();
  });

  it('maps Baidu answers: no route 404, quota 429, a hung call 504', async () => {
    const none = fakeWalker(async () => null);
    let app = await makeApp({ mode: 'live', samplesDir: dir }, { walker: none.walker });
    const res = await app.inject(get(checkQuery()));
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toMatch(/没有找到这两点之间的步行路线/);
    await app.close();

    const quota = fakeWalker(async () => {
      throw new BaiduQuotaError('轻量步行路线今日配额已用尽', {
        service: 'directionlite_walking',
        scope: 'daily',
      });
    });
    app = await makeApp({ mode: 'live', samplesDir: dir }, { walker: quota.walker });
    const limited = await app.inject(get(checkQuery()));
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toBe('quota_exhausted');
    await app.close();

    let aborted: unknown;
    const hang = fakeWalker(
      () =>
        new Promise<WalkingRoute | null>((_resolve, reject) => {
          hang.calls[0]!.signal!.addEventListener('abort', () => {
            aborted = hang.calls[0]!.signal!.reason;
            reject(aborted as Error);
          });
        }),
    );
    app = await makeApp({ mode: 'live', samplesDir: dir, routeTimeoutMs: 100 }, { walker: hang.walker });
    const slow = await app.inject(get(checkQuery()));
    expect(slow.statusCode).toBe(504);
    expect(slow.json()).toEqual({ error: 'timeout', message: expect.stringMatching(/超时/) });
    expect(aborted).toBeDefined();
    await app.close();
  });

  it('limits only the lookups that need Baidu: 30 per IP per 10 minutes (ZDD_ROUTE_PER_10MIN)', async () => {
    const { walker, calls } = fakeWalker();
    const app = await makeApp(
      {
        mode: 'live',
        samplesDir: dir,
        rateLimit: { globalPerMinute: 1000, analyzePerHour: 6, locatePerMinute: 30, routePer10Min: 1 },
      },
      { walker },
    );
    // stored routes never count: the judges at the venue share one IP
    for (let k = 0; k < 5; k++) {
      expect((await app.inject(get(checkQuery('申城佳苑二期B块', '小学')))).statusCode).toBe(200);
    }
    expect((await app.inject(get(checkQuery()))).statusCode).toBe(200); // Baidu, counted
    expect((await app.inject(get(checkQuery()))).statusCode).toBe(200); // now stored: free
    const limited = await app.inject(get(checkQuery('申城佳苑一期A块', '小学')));
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({
      error: 'rate_limited',
      message: expect.stringMatching(/每个 IP 每 10 分钟 1 次，已保存的路线不计.*请 \d+ 分钟后再试/),
    });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(500);
    expect(calls).toHaveLength(1);
    // another IP has its own budget
    expect((await app.inject(get(checkQuery('申城佳苑一期A块', '小学'), '10.0.0.9'))).statusCode).toBe(200);
    await app.close();
  });

  it('counts hits in a sliding window per key', () => {
    let now = 0;
    const limiter = new WindowLimiter(2, 1000, () => now);
    expect([limiter.take('a'), limiter.take('a')]).toEqual([0, 0]);
    now = 400;
    expect(limiter.take('a')).toBe(600);
    expect(limiter.take('b')).toBe(0);
    now = 1001;
    expect(limiter.take('a')).toBe(0);
  });

  it('has every verified task-rule 伪覆盖 of the four samples stored: the demo never waits', async () => {
    const app = await makeApp({
      rateLimit: { globalPerMinute: 1000, analyzePerHour: 6, locatePerMinute: 30, routePer10Min: 1000 },
    });
    let checked = 0;
    for (const id of ['zj-a', 'zj-b', 'zj-c', 'zj-v']) {
      const r = JSON.parse(readFileSync(join(SAMPLES_DIR, `${id}.json`), 'utf8')) as AnalysisResult;
      for (const c of r.communities) {
        for (const category of ['小学', '菜市场', '药店'] as const) {
          const k = c.checks[category];
          if (!k.verified || k.status_main !== '伪覆盖') continue;
          const res = await app.inject(get({ analysis_id: id, community: c.name, category }));
          expect(res.statusCode, `${id} ${c.name} ${category}`).toBe(200);
          const body = res.json() as RouteResponse;
          expect(body).toMatchObject({ source: 'stored', facility: { name: k.via } });
          // the walk Baidu draws is the one the check measured, give or take the engines' rounding
          expect(Math.abs(body.distance_m - k.route_m)).toBeLessThan(50);
          checked++;
        }
      }
    }
    expect(checked).toBe(27);
    await app.close();
  });

  it('keys stored routes by both ends to 1e-5°', () => {
    expect(routeKey([121.644191, 31.190071], [121.6, 31.2])).toBe(
      routeKey([121.644194, 31.190074], [121.6, 31.2]),
    );
    expect(routeKey([121.64419, 31.19007], [121.6, 31.2])).not.toBe(
      routeKey([121.64421, 31.19007], [121.6, 31.2]),
    );
  });
});
