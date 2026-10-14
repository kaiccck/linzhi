import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { frameOf } from '@zoudedao/agent';
import { BaiduQuotaError, type WalkingRoute } from '@zoudedao/baidu';
import {
  checkedCategories,
  HARD_CATEGORIES,
  routingPoint,
  TASK_CATEGORIES,
  type AnalysisResult,
  type LngLat,
} from '@zoudedao/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkPair, routeKey, type RouteWalker } from '../src/route.js';
import { WindowLimiter, type RouteResponse } from '../src/routes/route.js';
import { makeApp, SAMPLES_DIR, withCategories } from './helpers.js';

const zjA = () => JSON.parse(readFileSync(join(SAMPLES_DIR, 'zj-a.json'), 'utf8')) as AnalysisResult;
const zj = zjA();
const frame = frameOf(zj.meta);
const bd = (p: readonly number[]): LngLat => [Number(p[0]!.toFixed(6)), Number(p[1]!.toFixed(6))];

// 川杨新苑四期 → 浦商生鲜(申城佳苑店): 1,281 m for a straight 733.7 m, the task rule's 伪覆盖 of 菜市场
const COMMUNITY = '川杨新苑四期';
const pair = checkPair(zj, 'zj-a', { community: COMMUNITY, category: '菜市场' });
if ('kind' in pair) throw new Error('fixture: 川杨新苑四期 has a routed 菜市场 check');

describe('policy-only school route endpoints', () => {
  it('refuses a legacy nearest-school route when the assigned campus is unresolved', () => {
    const data = zjA();
    const c = data.communities[0]!;
    const poi = data.pois.find((p) => p.cat === '小学')!;
    c.checks.小学 = { ...c.checks.药店, via: poi.name, via_uid: poi.uid, route_basis: 'routed' };
    expect(checkPair(data, 'zj-a', { community: c.name, category: '小学' })).toMatchObject({
      kind: 'not_routed',
    });
  });
  it('uses the assigned school gate even if an old check points to another primary school', () => {
    const data = JSON.parse(readFileSync(join(SAMPLES_DIR, 'zj-b.json'), 'utf8')) as AnalysisResult;
    const c = data.communities.find((c) => c.catchment?.assignment_status === 'confirmed')!;
    const wrong = data.pois.find((p) => p.cat === '小学' && p.uid !== c.catchment!.school_uid)!;
    c.checks.小学 = { ...c.checks.小学, via: wrong.name, via_uid: wrong.uid, route_m: 1, dur_s: 1 };
    const pair = checkPair(data, 'zj-b', { community: c.name, category: '小学' });
    expect(pair).not.toHaveProperty('kind');
    if ('kind' in pair) return;
    expect(pair.facility.uid).toBe(c.catchment!.school_uid);
    expect(pair.facility.entrance_xy).toEqual(c.catchment!.school_xy);
    expect(pair.check.route_m).toBe(c.catchment!.route_m);
    expect(pair.facility.uid).not.toBe(wrong.uid);
  });
});

/**
 * Temp samples dir: zj-a, a copy whose 药店 checks were never routed, copies checked for the task's
 * three categories and for all five, and a stored route.
 */
let dir: string;
let dbPath: string;
const storedPair = checkPair(zj, 'zj-a', { community: '申城佳苑二期B块', category: '菜市场' });
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
  writeFileSync(join(dir, 'zz-three.json'), JSON.stringify(withCategories(zjA(), TASK_CATEGORIES)));
  writeFileSync(join(dir, 'zz-five.json'), JSON.stringify(withCategories(zjA(), HARD_CATEGORIES)));
  if ('kind' in storedPair) throw new Error('fixture');
  mkdirSync(join(dir, 'routes'));
  writeFileSync(
    join(dir, 'routes', 'zj-a.json'),
    JSON.stringify({
      analysis_id: 'zj-a',
      routes: [
        {
          community: '申城佳苑二期B块',
          category: '菜市场',
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
    const hit = await app.inject(get(checkQuery('申城佳苑二期B块', '菜市场')));
    expect(hit.statusCode).toBe(200);
    expect(hit.json()).toMatchObject({
      source: 'stored',
      distance_m: 1250,
      fetched_at: '2026-09-28T12:00:00.000Z',
      community: { name: '申城佳苑二期B块' },
      facility: { name: '浦商生鲜(申城佳苑店)' },
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
    const task = checkPair(zj, 'zj-a', { community: '申城佳苑一期A块', category: '菜市场' });
    if ('kind' in task) throw new Error('fixture');
    const res = await app.inject(get({ ...checkQuery(task.community.code, '菜市场'), rules: 'task' }));
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

  it('walks a 幼儿园 or 社区卫生 check like any other in an analysis of all five', async () => {
    const { walker, calls } = fakeWalker();
    const app = await makeApp({ mode: 'live', samplesDir: dir }, { walker });
    const five = withCategories(zjA(), HARD_CATEGORIES);
    for (const category of ['幼儿园', '社区卫生'] as const) {
      const k = five.communities.find((c) => c.name === COMMUNITY)!.checks[category];
      const via = five.pois.find((p) => p.uid === k.via_uid)!;
      const res = await app.inject(get({ ...checkQuery(COMMUNITY, category), analysis_id: 'zz-five' }));
      expect(res.statusCode, category).toBe(200);
      expect(res.json()).toMatchObject({
        analysis_id: 'zz-five',
        category,
        rules: 'task',
        facility: { name: via.name, uid: via.uid, category },
        check: { status: k.status, route_m: k.route_m, rule_m: 1000, via: via.name },
        source: 'baidu',
      });
      expect(calls.at(-1)!.destination).toEqual(
        bd(frame.toLngLat(routingPoint(via)[0], routingPoint(via)[1])),
      );
    }
    expect(calls).toHaveLength(2);
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
      [
        { ...checkQuery(), category: '医院' },
        400,
        /^category 只能是 幼儿园、小学、菜市场、药店、社区卫生 之一$/,
      ],
      [{ ...checkQuery(), rules: 'x' }, 400, /rules 只能是/],
      [{ ...checkQuery(), analysis_id: '../zj-a' }, 400, /analysis_id 须为分析编号/],
      [{ from: '121.6,31.2' }, 400, /from 和 to 都要给出/],
      [{ from: '2.35,48.85', to: '121.6,31.2' }, 400, /中国境内/],
      [{ from: '121.6,31.2', to: '121.7,31.2' }, 400, /超过 3000 米/],
      [{ from: '121.6,31.2', to: '121.61,31.2', community: COMMUNITY }, 400, /二选一/],
      [checkQuery('没有这个小区'), 404, /没有小区“没有这个小区”.*川杨新苑四期/],
      [{ ...checkQuery(), analysis_id: 'zj-zz' }, 404, /找不到分析 zj-zz/],
      [{ ...checkQuery(COMMUNITY, '药店'), analysis_id: 'zz-lb' }, 404, /没有算路/],
      // an analysis of the task's three has no 幼儿园 or 社区卫生 checks to show a route for
      [
        { ...checkQuery(COMMUNITY, '幼儿园'), analysis_id: 'zz-three' },
        404,
        /^分析 zz-three 没有检查幼儿园（只检查了小学、菜市场、药店/,
      ],
      [{ ...checkQuery(COMMUNITY, '社区卫生'), analysis_id: 'zz-three' }, 404, /没有检查社区卫生/],
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
      expect((await app.inject(get(checkQuery('申城佳苑二期B块', '菜市场')))).statusCode).toBe(200);
    }
    expect((await app.inject(get(checkQuery()))).statusCode).toBe(200); // Baidu, counted
    expect((await app.inject(get(checkQuery()))).statusCode).toBe(200); // now stored: free
    const limited = await app.inject(get(checkQuery('申城佳苑一期A块', '菜市场')));
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({
      error: 'rate_limited',
      message: expect.stringMatching(/每个 IP 每 10 分钟 1 次，已保存的路线不计.*请 \d+ 分钟后再试/),
    });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(500);
    expect(calls).toHaveLength(1);
    // another IP has its own budget
    expect((await app.inject(get(checkQuery('申城佳苑一期A块', '菜市场'), '10.0.0.9'))).statusCode).toBe(200);
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
    const walked: Record<string, number> = {};
    const bounds: string[] = [];
    for (const id of ['zj-a', 'zj-b', 'zj-c', 'zj-v']) {
      const r = JSON.parse(readFileSync(join(SAMPLES_DIR, `${id}.json`), 'utf8')) as AnalysisResult;
      for (const c of r.communities) {
        for (const category of checkedCategories(r)) {
          const k = c.checks[category];
          if (!k.verified || (k.status_main !== '伪覆盖' && category !== '小学')) continue;
          const what = `${id} ${c.name} ${category}`;
          const res = await app.inject(get({ analysis_id: id, community: c.name, category }));
          // proven by a lower bound (every entrance beyond the rule, so nothing was routed): no walk
          // to draw, and the answer says so
          if ((k.route_basis ?? 'routed') !== 'routed') {
            expect(res.statusCode, what).toBe(404);
            expect(res.json().message, what).toMatch(/没有算路/);
            bounds.push(what);
            continue;
          }
          expect(res.statusCode, what).toBe(200);
          const body = res.json() as RouteResponse;
          expect(body, what).toMatchObject({ source: 'stored', facility: { uid: k.via_uid } });
          // the walk Baidu draws is the one the check measured, give or take the engines' rounding
          expect(Math.abs(body.distance_m - k.route_m), what).toBeLessThan(50);
          walked[category] = (walked[category] ?? 0) + 1;
        }
      }
    }
    // after the community review (data/official/community-review.json): committee offices, gates,
    // offices, duplicates and points with no official record are no longer communities, and with
    // them went the 药店 gaps of the mislocated points east of 玉兰香苑
    expect(walked).toEqual({ 幼儿园: 1, 小学: 22, 菜市场: 6, 社区卫生: 8 });
    expect(bounds).toEqual([]);
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
