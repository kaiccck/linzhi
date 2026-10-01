import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BaiduQuotaError, type BaiduError, type RouteCell, type RouteMatrix } from '@zoudedao/baidu';
import {
  HARD_CATEGORIES,
  localFrame,
  shownStatus,
  TASK_CATEGORIES,
  type AnalysisResult,
  type LngLat,
} from '@zoudedao/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Analyzer } from '../src/analyzer.js';
import type { WhatIfResult, WhatIfRouter } from '../src/whatif.js';
import { ANALYZE_BODY, makeApp, parseSse, SAMPLES_DIR, withCategories } from './helpers.js';

const zjA = () => JSON.parse(readFileSync(join(SAMPLES_DIR, 'zj-a.json'), 'utf8')) as AnalysisResult;

/**
 * Temp samples dir: zj-a as is, a copy whose pharmacy check at 川杨新苑四期 is 待核实 (as zj-a's was
 * before its nearer pharmacies were routed), and copies checked for the task's three categories and for
 * all five.
 */
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'zdd-whatif-'));
  copyFileSync(join(SAMPLES_DIR, 'zj-a.json'), join(dir, 'zj-a.json'));
  const pending = zjA();
  Object.assign(pending.communities.find((c) => c.name === '川杨新苑四期')!.checks['药店'], {
    route_m: 1031,
    status: '临界',
    status_main: '伪覆盖',
    borderline: true,
    route_upper_bound: true,
    verified: false,
  });
  writeFileSync(join(dir, 'pending.json'), JSON.stringify(pending));
  writeFileSync(join(dir, 'three.json'), JSON.stringify(withCategories(zjA(), TASK_CATEGORIES)));
  writeFileSync(join(dir, 'five.json'), JSON.stringify(withCategories(zjA(), HARD_CATEGORIES)));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const zj = zjA();
const frame = localFrame(zj.meta.center_bd09[0], zj.meta.center_bd09[1]);
const byName = (name: string) => zj.communities.find((c) => c.name === name)!;
// 120 m east of 川杨新苑四期, whose market check is 伪覆盖 (1,281 m on foot for 734 m in a straight line)
const target = byName('川杨新苑四期').centroid;
const SITE: LngLat = frame.toLngLat(target[0] + 120, target[1]);

interface Call {
  origins: readonly LngLat[];
  destinations: readonly LngLat[];
  signal: AbortSignal | undefined;
  partial: boolean | undefined;
}

/** Walks 1.3 × the straight line, like a detour-free street grid; `fail` answers every cell failed. */
function fakeRouter(opts: { fail?: BaiduError; hang?: boolean } = {}) {
  const calls: Call[] = [];
  const router: WhatIfRouter = {
    routeMatrixWalking: async (origins, destinations, o = {}) => {
      calls.push({ origins, destinations, signal: o.signal, partial: o.partial });
      if (opts.hang) {
        return new Promise<RouteMatrix>((_resolve, reject) => {
          o.signal?.addEventListener('abort', () => reject(o.signal?.reason as Error));
        });
      }
      const cells = origins.map((a) =>
        destinations.map((b): RouteCell => {
          if (opts.fail) return { status: 'failed', distanceM: null, durationS: null, via: 'api' };
          const [ax, ay] = frame.toXY(a[0], a[1]);
          const [bx, by] = frame.toXY(b[0], b[1]);
          const m = Math.round(1.3 * Math.hypot(ax - bx, ay - by));
          return { status: 'ok', distanceM: m, durationS: Math.round(m / 1.17), via: 'api' };
        }),
      );
      const n = origins.length * destinations.length;
      return {
        cells,
        errors: opts.fail ? [opts.fail] : [],
        stats: {
          pairs: n,
          unique: n,
          identity: 0,
          fromCache: 0,
          joined: 0,
          fromApi: opts.fail ? 0 : n,
          failed: opts.fail ? n : 0,
          requests: 1,
          routesRequested: opts.fail ? 0 : n,
        },
      };
    },
  };
  return { router, calls };
}

const post = (payload: unknown, remoteAddress?: string) => ({
  method: 'POST' as const,
  url: '/api/whatif',
  payload: payload as object,
  ...(remoteAddress ? { remoteAddress } : {}),
});

describe('POST /api/whatif', () => {
  it('is live-only: 409 in sample mode and in replay mode, whatever the body', async () => {
    const sample = await makeApp({ samplesDir: dir });
    const res = await sample.inject(post({ nonsense: true }));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'live_mode_disabled' });
    expect(res.json().message).toMatch(/样例模式/);
    await sample.close();
    const replay = await makeApp({ mode: 'live', samplesDir: dir });
    expect(
      (await replay.inject(post({ analysis_id: 'zj-a', category: '药店', site_bd09: SITE }))).statusCode,
    ).toBe(409);
    await replay.close();
  });

  it('routes from the site to every community within 1.5 × the rule and re-judges them', async () => {
    const { router, calls } = fakeRouter();
    const app = await makeApp({ mode: 'live', samplesDir: dir }, { router });
    const res = await app.inject(post({ analysis_id: 'zj-a', category: '菜市场', site_bd09: SITE }));
    expect(res.statusCode).toBe(200);
    const body = res.json() as WhatIfResult;
    expect(body).toMatchObject({
      analysis_id: 'zj-a',
      category: '菜市场',
      rules: 'task',
      rule_m: 1000,
      skipped: [],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.origins).toEqual([SITE]);
    expect(calls[0]!.partial).toBe(true);
    const site = frame.toXY(SITE[0], SITE[1]);
    const within = zj.communities.filter(
      (c) => Math.hypot(c.centroid[0] - site[0], c.centroid[1] - site[1]) <= 1500,
    );
    expect(body.measured.map((r) => r.community).sort()).toEqual(within.map((c) => c.name).sort());
    expect(calls[0]!.destinations).toHaveLength(within.length);
    const row = body.measured.find((r) => r.community === '川杨新苑四期')!;
    expect(row).toMatchObject({ straight_m: 120, route_m: 156, before: '伪覆盖', after: '覆盖' });
    expect(body.newly_covered).toContain('川杨新苑四期');
    // covered communities stay covered, and nothing covered is listed as newly covered
    for (const r of body.measured) {
      if (r.before === '覆盖') expect(body.newly_covered).not.toContain(r.community);
      expect(Math.abs(r.route_m! - 1.3 * r.straight_m)).toBeLessThanOrEqual(1);
    }
    expect(body.measured.map((r) => r.route_m)).toEqual(
      [...body.measured.map((r) => r.route_m)].sort((a, b) => a! - b!),
    );
    expect(body.quota).toEqual({ routes: within.length, cached: 0 });
    // a 待核实 check gets its verdict from a measured walk within the rule
    const open = await app.inject(post({ analysis_id: 'pending', category: '药店', site_bd09: SITE }));
    const pending = (open.json() as WhatIfResult).measured.find((r) => r.community === '川杨新苑四期');
    expect(pending).toMatchObject({ route_m: 156, before: '待核实', after: '覆盖' });
    expect((open.json() as WhatIfResult).newly_covered).toContain('川杨新苑四期');
    await app.close();
  });

  it('simulates every category the analysis checked, and refuses one it did not check', async () => {
    const { router, calls } = fakeRouter();
    const app = await makeApp({ mode: 'live', samplesDir: dir }, { router });
    // an analysis of all five: 幼儿园 and 社区卫生 are simulated like the task's three
    const five = withCategories(zjA(), HARD_CATEGORIES);
    const before = five.communities.find((c) => c.name === '川杨新苑四期')!.checks;
    for (const category of ['幼儿园', '社区卫生'] as const) {
      const res = await app.inject(post({ analysis_id: 'five', category, site_bd09: SITE }));
      expect(res.statusCode, category).toBe(200);
      const body = res.json() as WhatIfResult;
      expect(body).toMatchObject({ analysis_id: 'five', category, rules: 'task', rule_m: 1000 });
      expect(body.measured.find((r) => r.community === '川杨新苑四期')).toMatchObject({
        route_m: 156,
        before: shownStatus(before[category]),
        after: '覆盖',
      });
    }
    expect(calls).toHaveLength(2);
    // an analysis of the task's three has no 幼儿园 verdicts to compare with: a clear 400, no route asked
    for (const category of ['幼儿园', '社区卫生'] as const) {
      const res = await app.inject(post({ analysis_id: 'three', category, site_bd09: SITE }));
      expect(res.statusCode, category).toBe(400);
      expect(res.json()).toEqual({
        error: 'invalid_input',
        message: expect.stringMatching(
          new RegExp(
            `^分析 three 没有检查${category}：它只检查了小学、菜市场、药店.*无法模拟新增${category}`,
          ),
        ),
      });
    }
    expect(calls).toHaveLength(2);
    // the task's three still work on it
    const market = await app.inject(post({ analysis_id: 'three', category: '菜市场', site_bd09: SITE }));
    expect(market.statusCode).toBe(200);
    await app.close();
  });

  it('accepts rules "task" from older clients and refuses the retired GB 50180 rule', async () => {
    const { router, calls } = fakeRouter();
    const app = await makeApp({ mode: 'live', samplesDir: dir }, { router });
    const res = await app.inject(
      post({ analysis_id: 'zj-a', category: '药店', site_bd09: SITE, rules: 'task' }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ rules: 'task', rule_m: 1000 });
    const gb = await app.inject(
      post({ analysis_id: 'zj-a', category: '药店', site_bd09: SITE, rules: 'gb50180' }),
    );
    expect(gb.statusCode).toBe(400);
    expect(gb.json()).toEqual({
      error: 'invalid_input',
      message: expect.stringMatching(/^rules 只能是 task（赛题口径：步行 1 公里）/),
    });
    expect(calls).toHaveLength(1);
    await app.close();
  });

  it('answers about a live result by its meta.analysis_id', async () => {
    const live = { ...zjA(), meta: { ...zjA().meta, generated: '2026-09-28T01:00:00.000Z' } };
    const analyzer: Analyzer = { name: 'test', analyze: async () => live };
    const { router } = fakeRouter();
    const app = await makeApp({ mode: 'live', samplesDir: dir }, { analyzer, router });
    const events = parseSse(
      (await app.inject({ method: 'POST', url: '/api/analyze', payload: ANALYZE_BODY })).body,
    );
    const id = (
      events.find((e) => e.event === 'result')!.data as AnalysisResult & { meta: { analysis_id: string } }
    ).meta.analysis_id;
    expect(id).toMatch(/^live-[0-9a-f]{8}$/);
    const res = await app.inject(post({ analysis_id: id, category: '小学', site_bd09: SITE }));
    expect(res.statusCode).toBe(200);
    expect((res.json() as WhatIfResult).analysis_id).toBe(id);
    const gone = await app.inject(post({ analysis_id: 'live-00000000', category: '小学', site_bd09: SITE }));
    expect(gone.statusCode).toBe(404);
    expect(gone.json().message).toMatch(/过期|不存在/);
    await app.close();
  });

  it('validates the body in Chinese: China box, category, rules, id', async () => {
    const { router, calls } = fakeRouter();
    const app = await makeApp({ mode: 'live', samplesDir: dir }, { router });
    for (const [payload, field] of [
      [{ analysis_id: 'zj-a', category: '药店', site_bd09: [2.35, 48.85] }, /site_bd09/],
      [
        { analysis_id: 'zj-a', category: '医院', site_bd09: SITE },
        /^category 只能是 幼儿园、小学、菜市场、药店、社区卫生 之一$/,
      ],
      [{ analysis_id: 'zj-a', category: '药店', site_bd09: SITE, rules: 'iso' }, /rules/],
      [{ analysis_id: '../x', category: '药店', site_bd09: SITE }, /analysis_id/],
      [{ analysis_id: 'zj-a', category: '药店', site_bd09: ['121.6', '31.2'] }, /site_bd09/],
    ] as const) {
      const res = await app.inject(post(payload));
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json()).toMatchObject({ error: 'invalid_input', message: expect.stringMatching(field) });
    }
    expect(calls).toHaveLength(0);
    // a site far from every community needs no route at all
    const far = await app.inject(post({ analysis_id: 'zj-a', category: '药店', site_bd09: [121.9, 31.0] }));
    expect(far.json()).toMatchObject({ measured: [], newly_covered: [], quota: { routes: 0, cached: 0 } });
    expect(calls).toHaveLength(0);
    await app.close();
  });

  it('maps Baidu failures to the API error codes', async () => {
    const quota = new BaiduQuotaError('批量算路（步行）今日配额已用到 90%', {
      service: 'routematrix_walking',
      scope: 'soft',
      hint: '北京时间次日 0 点恢复',
    });
    const { router } = fakeRouter({ fail: quota });
    const app = await makeApp({ mode: 'live', samplesDir: dir }, { router });
    const res = await app.inject(post({ analysis_id: 'zj-a', category: '药店', site_bd09: SITE }));
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: 'quota_exhausted', message: expect.stringMatching(/配额/) });
    await app.close();
  });

  it('limits each IP to 10 per 10 minutes', async () => {
    const { router } = fakeRouter();
    const app = await makeApp({ mode: 'live', samplesDir: dir }, { router });
    const body = { analysis_id: 'zj-a', category: '药店', site_bd09: [121.9, 31.0] };
    for (let i = 0; i < 10; i++) expect((await app.inject(post(body, '10.0.0.1'))).statusCode).toBe(200);
    const limited = await app.inject(post(body, '10.0.0.1'));
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({
      error: 'rate_limited',
      message: expect.stringMatching(/每 10 分钟 10 次/),
    });
    expect((await app.inject(post(body, '10.0.0.2'))).statusCode).toBe(200);
    await app.close();
  });

  it('ends with 504 on timeout and aborts the route call when the client disconnects', async () => {
    const slow = fakeRouter({ hang: true });
    const app = await makeApp(
      { mode: 'live', samplesDir: dir, whatifTimeoutMs: 50 },
      { router: slow.router },
    );
    const res = await app.inject(post({ analysis_id: 'zj-a', category: '药店', site_bd09: SITE }));
    expect(res.statusCode).toBe(504);
    expect(res.json()).toMatchObject({ error: 'timeout', message: expect.stringMatching(/超时/) });
    expect(slow.calls[0]!.signal!.aborted).toBe(true);
    await app.close();

    const hang = fakeRouter({ hang: true });
    const live = await makeApp({ mode: 'live', samplesDir: dir }, { router: hang.router });
    await live.listen({ host: '127.0.0.1', port: 0 });
    const { port } = live.server.address() as AddressInfo;
    const client = new AbortController();
    const pending = fetch(`http://127.0.0.1:${port}/api/whatif`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ analysis_id: 'zj-a', category: '药店', site_bd09: SITE }),
      signal: client.signal,
    }).catch((e: unknown) => e);
    for (let k = 0; k < 50 && !hang.calls.length; k++) await new Promise((r) => setTimeout(r, 10));
    expect(hang.calls).toHaveLength(1);
    client.abort();
    await pending;
    const signal = hang.calls[0]!.signal!;
    for (let k = 0; k < 50 && !signal.aborted; k++) await new Promise((r) => setTimeout(r, 10));
    expect(signal.aborted).toBe(true);
    expect((signal.reason as Error).message).toBe('client disconnected');
    await live.close();
  });
});
