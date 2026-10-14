import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { RouteCell, RouteMatrix } from '@zoudedao/baidu';
import {
  checkedCategories,
  HARD_CATEGORIES,
  localFrame,
  TASK_CATEGORIES,
  type AnalysisResult,
  type LngLat,
} from '@zoudedao/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Analyzer } from '../src/analyzer.js';
import {
  branchId,
  HistoryStore,
  historyHeadline,
  type HistoryItem,
  type WhatIfBranch,
} from '../src/history.js';
import type { WhatIfResult, WhatIfRouter } from '../src/whatif.js';
import { ANALYZE_BODY, makeApp, parseSse, SAMPLES_DIR, withCategories } from './helpers.js';

const zjA = () => JSON.parse(readFileSync(join(SAMPLES_DIR, 'zj-a.json'), 'utf8')) as AnalysisResult;

/** A live-like result: zj-a under another name, centre and generation time. */
const liveResult = (generated = '2026-09-28T03:04:05.000Z'): AnalysisResult => {
  const r = zjA();
  return {
    ...r,
    meta: { ...r.meta, name: '实时测试片区', generated, center_bd09: [121.61, 31.2] },
  };
};

const fakeAnalyzer = (make: () => AnalysisResult = () => liveResult()): Analyzer => ({
  name: 'engine',
  analyze: async () => make(),
});

let dir: string;
let dbPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zdd-history-'));
  dbPath = join(dir, 'cache', 'analyses.sqlite');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const analyze = async (app: Awaited<ReturnType<typeof makeApp>>, body: object = ANALYZE_BODY) => {
  const events = parseSse((await app.inject({ method: 'POST', url: '/api/analyze', payload: body })).payload);
  const result = events.at(-1)?.data as AnalysisResult & { meta: { analysis_id: string } };
  return result.meta.analysis_id;
};

describe('HistoryStore', () => {
  it('keeps results in a WAL SQLite file that survives reopening, gzipped, with headline columns', () => {
    const store = new HistoryStore({ path: dbPath });
    expect(store.persistent).toBe(true);
    expect(store.path).toBe(dbPath);
    const item = store.saveAnalysis('live-0000000a', liveResult(), { label: '测试路口', profile: 'elder' });
    expect(item).toMatchObject({
      id: 'live-0000000a',
      sample: false,
      center_bd09: [121.61, 31.2],
      label: '测试路口',
      profile: 'elder',
      rules: 'task',
      name: '实时测试片区',
      headline: historyHeadline(zjA()),
    });
    expect(existsSync(`${dbPath}-wal`)).toBe(true);
    const gz = store.analysisGzip('live-0000000a')!;
    expect(gz.length).toBeLessThan(JSON.stringify(zjA()).length / 2);
    expect(JSON.parse(gunzipSync(gz).toString('utf8')).meta.name).toBe('实时测试片区');
    store.close();

    const again = new HistoryStore({ path: dbPath });
    expect(again.hasAnalysis('live-0000000a')).toBe(true);
    expect(again.getAnalysis('live-0000000a')!.communities).toHaveLength(12);
    expect(again.recent()).toEqual([item]);
    again.close();
  });

  it('counts headline gaps like the advisor: verified only, the task rule', () => {
    // zj-a: 60 checks of all five categories, every one measured
    const h = historyHeadline(zjA());
    expect(h).toMatchObject({
      communities: 12,
      categories: ['幼儿园', '小学', '菜市场', '药店', '社区卫生'],
      walking_gaps: 3,
      pseudo: 3,
      blind: 0,
      pending: 12,
    });
    expect(h.categories).toEqual(checkedCategories(zjA()));
    // the task's three alone: 8 gaps as ever; the ninth is 虹御公寓's 社区卫生 (伪覆盖)
    expect(historyHeadline(withCategories(zjA(), TASK_CATEGORIES))).toMatchObject({
      categories: ['小学', '菜市场', '药店'],
      walking_gaps: 2,
      pseudo: 2,
      blind: 0,
      pending: 12,
    });
    expect(zjA().communities.find((c) => c.name === '虹御公寓')!.checks['社区卫生']).toMatchObject({
      status_main: '伪覆盖',
      verified: true,
    });
    expect(h.walking_gaps).toBe(h.pseudo + h.blind);
    expect(Object.keys(h).filter((k) => k.endsWith('_gb'))).toEqual([]);
    expect(h.area_iso15_km2).toBeGreaterThan(1);
    // a 待核实 check is counted as such, never as a gap
    const open = zjA();
    const k = open.communities.find((c) => c.name === '虹御公寓')!.checks['药店'];
    Object.assign(k, { status: '伪覆盖', status_main: '伪覆盖', route_m: 1124, verified: false });
    expect(historyHeadline(open)).toMatchObject({ walking_gaps: 3, pending: 13 });
  });

  it('names the categories an analysis was checked for, so 3- and 5-category analyses tell apart', async () => {
    const three = withCategories(liveResult(), TASK_CATEGORIES);
    const five = withCategories(liveResult(), HARD_CATEGORIES);
    const h3 = historyHeadline(three);
    const h5 = historyHeadline(five);
    expect(h3.categories).toEqual(['小学', '菜市场', '药店']);
    expect(h5.categories).toEqual(['幼儿园', '小学', '菜市场', '药店', '社区卫生']);
    // every checked category counts alike: the five-category analysis has the three's gaps and its own
    const gaps = (r: AnalysisResult) =>
      r.communities.flatMap((c) =>
        Object.values(c.checks).filter((k) => k.verified !== false && k.status_main !== '覆盖'),
      ).length;
    expect(h3.walking_gaps).toBe(gaps(three));
    expect(h5.walking_gaps).toBe(gaps(five));
    expect(h5.walking_gaps).toBeGreaterThan(h3.walking_gaps);
    // an isochrone-only analysis checked nothing
    expect(historyHeadline({ ...liveResult(), communities: [] }).categories).toEqual([]);

    // kept with the stored row; a row stored before headlines named them is the task's three
    const store = new HistoryStore({ path: dbPath });
    store.saveAnalysis('live-00000003', three);
    store.saveAnalysis('live-00000005', five);
    store.saveAnalysis('live-00000006', liveResult());
    store.close();
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath);
    const { categories: _c, ...older } = historyHeadline(liveResult());
    db.prepare('UPDATE analyses SET headline = ? WHERE id = ?').run(JSON.stringify(older), 'live-00000006');
    db.close();
    const again = new HistoryStore({ path: dbPath });
    const byId = new Map(again.recent().map((i) => [i.id, i.headline.categories]));
    expect(Object.fromEntries(byId)).toEqual({
      'live-00000003': ['小学', '菜市场', '药店'],
      'live-00000005': ['幼儿园', '小学', '菜市场', '药店', '社区卫生'],
      'live-00000006': ['小学', '菜市场', '药店'],
    });
    again.close();
  });

  it('ignores the GB 50180 fields of rows older versions stored', async () => {
    const store = new HistoryStore({ path: dbPath });
    store.saveAnalysis('live-00000001', liveResult());
    const task = store.saveBranch(whatIf('live-00000001'));
    store.close();
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath);
    const headline = { ...historyHeadline(liveResult()), walking_gaps_gb: 18, pseudo_gb: 7, blind_gb: 11 };
    db.prepare('UPDATE analyses SET headline = ?, rules = ? WHERE id = ?').run(
      JSON.stringify(headline),
      'gb50180',
      'live-00000001',
    );
    const gb = { ...whatIf('live-00000001', [121.646, 31.195]), id: 'wi-gb', rules: 'gb50180', rule_m: 300 };
    db.prepare(
      `INSERT INTO branches (id, analysis_id, created_at, expires_at, category, rules, site_lng, site_lat, result)
       SELECT 'wi-gb', analysis_id, created_at + 1, expires_at, category, 'gb50180', 121.646, 31.195, ?
       FROM branches WHERE id = ?`,
    ).run(JSON.stringify(gb), task.id);
    db.close();
    const again = new HistoryStore({ path: dbPath });
    const [item] = again.recent();
    expect(item).toMatchObject({ id: 'live-00000001', rules: 'task' });
    expect(item!.headline).toEqual(historyHeadline(liveResult()));
    // a what-if measured under the GB 50180 radii is left out
    expect(again.branches('live-00000001').map((b) => b.id)).toEqual([task.id]);
    again.close();
  });

  it('lists the newest first, forgets analyses and branches after 30 days, keeps routes forever', () => {
    let now = Date.parse('2026-09-28T00:00:00Z');
    const store = new HistoryStore({ path: dbPath, now: () => now });
    store.saveAnalysis('live-00000001', liveResult());
    store.saveBranch(whatIf('live-00000001'));
    now += 60_000;
    store.saveAnalysis('live-00000002', liveResult());
    expect(store.recent().map((i) => i.id)).toEqual(['live-00000002', 'live-00000001']);
    expect(store.recent(1).map((i) => i.id)).toEqual(['live-00000002']);
    store.putRoute('a|b', {
      from_bd09: [121.6, 31.2],
      to_bd09: [121.61, 31.2],
      distance_m: 1000,
      duration_s: 900,
      path_bd09: [
        [121.6, 31.2],
        [121.61, 31.2],
      ],
      fetched_at: '2026-09-28T00:00:00.000Z',
    });
    expect(store.branches('live-00000001')).toHaveLength(1);
    expect(store.retentionDays).toBe(30);
    now += 30 * 86_400_000 - 30_000; // live-00000001 is now older than 30 days
    expect(store.recent().map((i) => i.id)).toEqual(['live-00000002']);
    expect(store.hasAnalysis('live-00000001')).toBe(false);
    expect(store.branches('live-00000001')).toEqual([]);
    expect(store.purge()).toBeGreaterThanOrEqual(2);
    expect(store.getRoute('a|b')?.distance_m).toBe(1000);
    store.close();
  });

  it('keeps one branch per what-if (analysis, category, rules, site), newest first', () => {
    let now = Date.parse('2026-09-28T00:00:00Z');
    const store = new HistoryStore({ path: dbPath, now: () => now });
    const a = store.saveBranch(whatIf('zj-a', [121.645361, 31.19485]));
    now += 1000;
    const b = store.saveBranch(whatIf('zj-a', [121.646, 31.195]));
    now += 1000;
    const again = store.saveBranch({ ...whatIf('zj-a', [121.645361, 31.19485]), newly_covered: [] });
    expect(again.id).toBe(a.id);
    expect(a.id).toBe(branchId(whatIf('zj-a', [121.645361, 31.19485])));
    expect(a.id).toMatch(/^wi-[0-9a-f]{8}$/);
    const list = store.branches('zj-a');
    expect(list.map((x) => x.id)).toEqual([a.id, b.id]);
    expect(list[0]).toMatchObject({ newly_covered: [], created_at: '2026-09-28T00:00:02.000Z' });
    expect(store.branches('zj-b')).toEqual([]);
    store.close();
  });

  it('falls back to memory when the file cannot be opened, and says so', () => {
    const warnings: string[] = [];
    // a directory where the database file should be
    const blocked = join(dir, 'blocked');
    mkdirSync(blocked);
    const store = new HistoryStore({ path: blocked, onWarning: (m) => warnings.push(m) });
    expect(store.persistent).toBe(false);
    expect(store.path).toBeNull();
    expect(warnings.join('\n')).toMatch(/无法打开体检历史数据库/);
    store.saveAnalysis('live-0000000b', liveResult());
    expect(store.recent().map((i) => i.id)).toEqual(['live-0000000b']);
    store.close();
    // a file that is no SQLite database
    const garbage = join(dir, 'garbage.sqlite');
    writeFileSync(garbage, 'not a database '.repeat(400));
    const broken = new HistoryStore({ path: garbage, onWarning: (m) => warnings.push(m) });
    expect(broken.persistent).toBe(false);
    expect(warnings).toHaveLength(2);
    broken.close();
    const memory = new HistoryStore({ path: null });
    expect(memory.persistent).toBe(false);
    memory.close();
  });
});

function whatIf(analysis_id: string, site: LngLat = [121.645361, 31.19485]): WhatIfResult {
  return {
    analysis_id,
    category: '药店',
    rules: 'task',
    rule_m: 1000,
    site_bd09: site,
    measured: [
      {
        community: '川杨新苑四期',
        straight_m: 120,
        route_m: 132,
        dur_s: 113,
        before: '待核实',
        after: '覆盖',
      },
    ],
    newly_covered: ['川杨新苑四期'],
    skipped: [],
    quota: { routes: 1, cached: 0 },
  };
}

/** Walks 1.3 × the straight line from the site to every community. */
function fakeRouter(): WhatIfRouter {
  const zj = zjA();
  const frame = localFrame(zj.meta.center_bd09[0], zj.meta.center_bd09[1]);
  return {
    routeMatrixWalking: async (origins, destinations) => {
      const cells = origins.map((a) =>
        destinations.map((b): RouteCell => {
          const [ax, ay] = frame.toXY(a[0], a[1]);
          const [bx, by] = frame.toXY(b[0], b[1]);
          const m = Math.round(1.3 * Math.hypot(ax - bx, ay - by));
          return { status: 'ok', distanceM: m, durationS: Math.round(m / 1.17), via: 'api' };
        }),
      );
      const n = origins.length * destinations.length;
      return {
        cells,
        errors: [],
        stats: {
          pairs: n,
          unique: n,
          identity: 0,
          fromCache: 0,
          joined: 0,
          fromApi: n,
          failed: 0,
          requests: 1,
          routesRequested: n,
        },
      } satisfies RouteMatrix;
    },
  };
}

describe('the history over HTTP', () => {
  it('stores every completed live analysis and lists it before the samples', async () => {
    const app = await makeApp({ mode: 'live', historyPath: dbPath }, { analyzer: fakeAnalyzer() });
    const id = await analyze(app, { ...ANALYZE_BODY, profile: 'elder' });
    expect(id).toMatch(/^live-[0-9a-f]{8}$/);

    const res = await app.inject('/api/history');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json() as { items: HistoryItem[]; persistent: boolean; retention_days: number };
    expect(body).toMatchObject({ persistent: true, retention_days: 30 });
    expect(body.items[0]).toEqual({
      id,
      sample: false,
      created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      center_bd09: [121.61, 31.2],
      label: ANALYZE_BODY.label,
      profile: 'elder',
      rules: 'task',
      name: '实时测试片区',
      headline: historyHeadline(zjA()),
    });
    const samples = body.items.filter((i) => i.sample);
    expect(samples.map((i) => i.id)).toEqual(['zj-a', 'zj-b', 'zj-c', 'zj-v']);
    expect(samples[0]).toMatchObject({ name: '申城佳苑片区', created_at: zjA().meta.generated });
    // the GB 50180 counts older versions kept never reach the headline
    expect(Object.keys(samples[1]!.headline).filter((k) => k.endsWith('_gb'))).toEqual([]);
    // every sample now carries checks of all five categories, and its headline says so
    for (const item of samples) expect(item.headline.categories, item.id).toEqual([...HARD_CATEGORIES]);
    await app.close();
  });

  it('resolves stored live ids after a restart: GET /api/analysis/:id and POST /api/ask', async () => {
    const first = await makeApp({ mode: 'live', historyPath: dbPath }, { analyzer: fakeAnalyzer() });
    const id = await analyze(first);
    await first.close();

    // a new process: nothing in memory, the id comes from the file
    const app = await makeApp({ historyPath: dbPath });
    const res = await app.inject(`/api/analysis/${id}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    const etag = res.headers.etag as string;
    expect(etag).toBe(`W/"${id}"`);
    const result = res.json() as AnalysisResult & { meta: { analysis_id: string } };
    expect(result.meta).toMatchObject({ analysis_id: id, name: '实时测试片区' });
    const zipped = await app.inject({ url: `/api/analysis/${id}`, headers: { 'accept-encoding': 'gzip' } });
    expect(zipped.headers['content-encoding']).toBe('gzip');
    expect(JSON.parse(gunzipSync(zipped.rawPayload).toString('utf8')).meta.analysis_id).toBe(id);
    const again = await app.inject({ url: `/api/analysis/${id}`, headers: { 'if-none-match': etag } });
    expect(again.statusCode).toBe(304);

    const ask = await app.inject({
      method: 'POST',
      url: '/api/ask',
      payload: { question: '买菜方便吗？', analysis_id: id },
    });
    expect(ask.statusCode).toBe(200);
    const answer = parseSse(ask.payload).find((e) => e.event === 'answer')?.data as {
      answer: string;
      analysis_id: string;
    };
    expect(answer.analysis_id).toBe(id);
    expect(answer.answer).toContain('实时测试片区');

    expect((await app.inject('/api/analysis/live-deadbeef')).json()).toEqual({
      error: 'not_found',
      message: '实时体检结果不存在或已过期，请重新体检',
    });
    await app.close();
  });

  it('does not write replayed results (ZDD_MODE=live without keys) to the history', async () => {
    const app = await makeApp({ mode: 'live', historyPath: dbPath });
    const id = await analyze(app);
    expect(id).toMatch(/^live-/);
    const items = (await app.inject('/api/history')).json().items as HistoryItem[];
    expect(items.every((i) => i.sample)).toBe(true);
    // still answerable while in memory
    expect((await app.inject(`/api/analysis/${id}`)).statusCode).toBe(200);
    await app.close();
  });

  it('saves each what-if measurement as a branch of its analysis', async () => {
    const app = await makeApp(
      { mode: 'live', historyPath: dbPath },
      { analyzer: fakeAnalyzer(), router: fakeRouter() },
    );
    const zj = zjA();
    const frame = localFrame(zj.meta.center_bd09[0], zj.meta.center_bd09[1]);
    const c = zj.communities.find((x) => x.name === '川杨新苑四期')!.centroid;
    const site = frame.toLngLat(c[0] + 120, c[1]);
    const post = () =>
      app.inject({
        method: 'POST',
        url: '/api/whatif',
        payload: { analysis_id: 'zj-a~elder', category: '药店', site_bd09: site },
      });
    const res = await post();
    expect(res.statusCode).toBe(200);
    const out = res.json() as WhatIfResult & { branch_id: string };
    expect(out.branch_id).toMatch(/^wi-[0-9a-f]{8}$/);
    await post(); // the same what-if again replaces its branch

    const branches = await app.inject('/api/analysis/zj-a/branches');
    expect(branches.statusCode).toBe(200);
    const body = branches.json() as { analysis_id: string; branches: WhatIfBranch[] };
    expect(body.analysis_id).toBe('zj-a');
    expect(body.branches).toHaveLength(1);
    const { branch_id: _id, ...measured } = out;
    expect(body.branches[0]).toEqual({ ...measured, id: out.branch_id, created_at: expect.any(String) });
    // ~elder names the same places
    expect((await app.inject('/api/analysis/zj-a~elder/branches')).json().branches).toHaveLength(1);

    // a live analysis starts without branches; unknown ids are 404
    const id = await analyze(app);
    expect((await app.inject(`/api/analysis/${id}/branches`)).json()).toEqual({
      analysis_id: id,
      branches: [],
    });
    const missing = await app.inject('/api/analysis/live-deadbeef/branches');
    expect(missing.statusCode).toBe(404);
    expect(missing.json().message).toMatch(/30 天/);
    await app.close();
  });

  it('keeps results in memory only without a history file (ZDD_HISTORY_PATH=off)', async () => {
    const app = await makeApp({ mode: 'live', historyPath: null }, { analyzer: fakeAnalyzer() });
    const id = await analyze(app);
    const body = (await app.inject('/api/history')).json() as { items: HistoryItem[]; persistent: boolean };
    expect(body.persistent).toBe(false);
    expect(body.items[0]?.id).toBe(id);
    await app.close();
    expect(existsSync(dbPath)).toBe(false);
  });
});
