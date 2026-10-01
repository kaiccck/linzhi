/**
 * What the server remembers, against a mocked server: GET /api/history for the area menu (recent live
 * checks first, then the samples, each with "画圈 x → 走一遍 y"), a stored live check read back by
 * its id, and the what-if branches 规划 lists.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisResult } from '@zoudedao/core';
import rawA from '../../../../data/samples/zj-a.json?raw';
import { areaOptions } from '../components/TopBar.js';
import {
  getBranches,
  getHistory,
  getLiveAnalysis,
  headlineGaps,
  parseHistory,
  shortTime,
  type HistoryItem,
} from './history.js';
import { parseWhatIf } from './whatif.js';

const headline = {
  communities: 12,
  area_iso15_km2: 1.857,
  area_circle15_km2: 3.483,
  overstate_x: 1.88,
  walking_gaps: 8,
  pseudo: 7,
  blind: 1,
  pending: 2,
  walking_gaps_gb: 18,
  pseudo_gb: 7,
  blind_gb: 11,
  pending_gb: 0,
};
const HISTORY = {
  items: [
    {
      id: 'live-1a2b3c4d',
      sample: false,
      created_at: '2026-09-28T12:31:05.120Z',
      center_bd09: [121.61, 31.2],
      label: '海科路 × 学林路',
      profile: 'elder',
      rules: 'task',
      name: '学林路片区',
      headline: {
        communities: 20,
        area_iso15_km2: 1.9,
        area_circle15_km2: null,
        overstate_x: 1.83,
        walking_gaps: 9,
        pseudo: 6,
        blind: 3,
        pending: 0,
      },
    },
    {
      id: 'zj-a',
      sample: true,
      created_at: '2026-09-26T10:24:38.790Z',
      center_bd09: [121.644195, 31.19007],
      label: '孙环路 × 高木桥路',
      profile: 'adult',
      rules: 'task',
      name: '申城佳苑片区',
      headline,
    },
    { id: 'broken', sample: false, name: '没有 headline' },
  ],
  persistent: true,
  retention_days: 30,
};

const reply = (body: unknown, status = 200) =>
  vi.fn(
    async () =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );

describe('GET /api/history', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads the live checks and the samples, dropping what it cannot read', async () => {
    vi.stubGlobal('fetch', reply(HISTORY));
    const items = await getHistory(new AbortController().signal);
    expect(items.map((i) => i.id)).toEqual(['live-1a2b3c4d', 'zj-a']);
    expect(items[0]).toMatchObject({ sample: false, profile: 'elder', label: '海科路 × 学林路' });
    // GB 50180 numbers an older server sends are not read
    expect(items[1]!.headline).not.toHaveProperty('walking_gaps_gb');
    expect(parseHistory({ nope: 1 })).toBeNull();
  });

  it('says why when the server has no history', async () => {
    vi.stubGlobal('fetch', reply({ error: 'not_found', message: '接口不存在' }, 404));
    await expect(getHistory(new AbortController().signal)).rejects.toThrow('接口不存在');
  });

  it('counts the circle’s gaps (blind) against the walk’s (every verified gap)', () => {
    expect(headlineGaps(headline)).toEqual({ circle: 1, walk: 8 });
  });

  it('writes times as MM-DD hh:mm in the viewer’s zone', () => {
    const t = shortTime('2026-09-28T12:31:05.120Z');
    expect(t).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(shortTime('not a time')).toBe('');
  });
});

describe('the area menu', () => {
  const items = parseHistory(HISTORY)!;
  const samples = [
    { id: 'zj-a', name: '申城佳苑片区', center_label: '孙环路 × 高木桥路' },
    { id: 'zj-b', name: '玉兰香苑片区' },
  ];
  const base = {
    samples,
    history: items,
    rules: 'task' as const,
    onOpen: () => {},
  };

  it('lists the recent live checks first, then the samples, with their headlines', () => {
    const g = areaOptions({
      ...base,
      active: 'zj-a',
      activeLive: null,
      current: { code: 'A', name: '申城佳苑片区', live: false },
    });
    expect(g.live.map((o) => [o.code, o.name, o.gaps])).toEqual([
      ['实时', '学林路片区', { circle: 3, walk: 9 }],
    ]);
    expect(g.live[0]!.note).toMatch(/海科路 × 学林路 · 老人步速$/);
    expect(g.samples.map((o) => [o.code, o.current, o.gaps])).toEqual([
      ['A', true, { circle: 1, walk: 8 }],
      ['B', false, null],
    ]);
    // the row on screen does nothing; the others open
    expect(g.samples[0]!.open).toBeNull();
    expect(typeof g.samples[1]!.open).toBe('function');
  });

  it('opens a live check through the history, and marks the one on screen', () => {
    const opened: HistoryItem[] = [];
    const g = areaOptions({
      ...base,
      active: null,
      activeLive: 'live-1a2b3c4d',
      current: { code: '实时', name: '学林路片区', live: true },
      onOpenHistory: (h) => opened.push(h),
    });
    expect(g.live[0]!.current).toBe(true);
    expect(g.live[0]!.open).toBeNull();
    const other = areaOptions({
      ...base,
      active: 'zj-a',
      activeLive: null,
      current: { code: 'A', name: '申城佳苑片区', live: false },
      onOpenHistory: (h) => opened.push(h),
    });
    other.live[0]!.open!();
    expect(opened.map((h) => h.id)).toEqual(['live-1a2b3c4d']);
  });

  it('keeps the live result on screen at the top when the history does not list it (yet)', () => {
    const g = areaOptions({
      ...base,
      history: null,
      active: null,
      activeLive: 'live-99',
      current: { code: '实时', name: '地图点选', live: true },
    });
    expect(g.live).toHaveLength(1);
    expect(g.live[0]).toMatchObject({ key: '__live', note: '当前实时体检', current: true });
  });
});

describe('a stored live check, read back by its id', () => {
  afterEach(() => vi.unstubAllGlobals());
  const data = JSON.parse(rawA) as AnalysisResult;

  it('is stamped with its id when the result lacks it', async () => {
    const fetchMock = reply(data);
    vi.stubGlobal('fetch', fetchMock);
    const r = await getLiveAnalysis('live-1a2b3c4d', new AbortController().signal);
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('/api/analysis/live-1a2b3c4d');
    expect((r.meta as { analysis_id?: string }).analysis_id).toBe('live-1a2b3c4d');
  });

  it('rejects what is not an analysis, and an expired one with the server’s words', async () => {
    vi.stubGlobal('fetch', reply({ meta: {} }));
    await expect(getLiveAnalysis('live-1', new AbortController().signal)).rejects.toThrow('数据结构不完整');
    vi.stubGlobal(
      'fetch',
      reply({ error: 'not_found', message: '实时体检结果不存在或已过期，请重新体检' }, 404),
    );
    await expect(getLiveAnalysis('live-1', new AbortController().signal)).rejects.toThrow('已过期');
  });
});

describe('what-if branches', () => {
  afterEach(() => vi.unstubAllGlobals());
  const branch = {
    id: 'wi-5c1d2e3f',
    created_at: '2026-09-28T12:40:00.000Z',
    analysis_id: 'zj-a',
    category: '药店',
    rules: 'task',
    rule_m: 1000,
    site_bd09: [121.645361, 31.19485],
    measured: [
      {
        community: '川杨新苑四期',
        straight_m: 120,
        route_m: 132,
        dur_s: 111,
        before: '待核实',
        after: '覆盖',
      },
    ],
    newly_covered: ['川杨新苑四期'],
    skipped: [],
    quota: { routes: 12, cached: 0 },
  };

  it('reads each saved measurement with its site and category, and drops those measured under GB 50180', async () => {
    const fetchMock = reply({
      analysis_id: 'zj-a',
      branches: [branch, { id: 'wi-x', category: '书店' }, { ...branch, id: 'wi-gb', rules: 'gb50180' }],
    });
    vi.stubGlobal('fetch', fetchMock);
    const list = await getBranches('zj-a', new AbortController().signal);
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('/api/analysis/zj-a/branches');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: 'wi-5c1d2e3f',
      branch_id: 'wi-5c1d2e3f',
      category: '药店',
      site_bd09: [121.645361, 31.19485],
      newly_covered: ['川杨新苑四期'],
      quota: { routes: 12, cached: 0 },
    });
  });

  it('keeps the branch a fresh measurement was saved as', () => {
    const r = parseWhatIf({ ...branch, branch_id: 'wi-5c1d2e3f' });
    expect(r?.branch_id).toBe('wi-5c1d2e3f');
    expect(parseWhatIf({ measured: [], newly_covered: [] })?.branch_id).toBeUndefined();
  });
});
