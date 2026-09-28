import { BaiduConfigError, BaiduQuotaError, BaiduUpstreamError, QuotaLedger } from '@zoudedao/baidu';
import {
  acceptedCategories,
  buildIsochrone,
  detectBarriers,
  facilitiesFor,
  HARD_CATEGORIES,
  routingPoint,
  visibilityFilter,
  type AnalysisResult,
  type FacilityCategory,
  type LngLat,
  type XY,
} from '@zoudedao/core';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  analyze,
  createEngineAnalyzer,
  DEMAND_RADIUS_M,
  EngineError,
  ENGINE_SERVICES,
  FACILITY_BUFFER_M,
  planQuota,
  STAGES,
  type Emit,
  type EngineDeps,
  type EngineInput,
  type EngineOptions,
  type LiveMeta,
  type OfficialSummary,
} from '../src/index.js';
import { City, CITY_ORIGIN, officialMarkets } from './city.js';
import { FakeClient, type FakeOptions } from './fakeClient.js';

interface Ev {
  event: 'stage' | 'partial' | 'quota';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- event payloads are inspected loosely
  data: any;
  /** Client calls made before the event was emitted. */
  calls: number;
}

const city = new City();
const NOW = () => new Date('2026-09-27T02:00:00Z');
const INPUT: EngineInput = { center_bd09: CITY_ORIGIN, label: '河西路 × 滨河路', profile: 'adult' };
const dist = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]);

type Extra = Pick<EngineDeps, 'official'>;

function start(
  input: EngineInput = INPUT,
  fake: FakeOptions = {},
  opts: EngineOptions = {},
  extra: Extra = {},
) {
  const client = new FakeClient({ city, ...fake });
  const events: Ev[] = [];
  const emit: Emit = (event, data) => void events.push({ event, data, calls: client.calls.length });
  const promise = analyze(input, { client, now: NOW, ...extra }, emit, opts);
  return { promise, events, client };
}

async function run(
  input: EngineInput = INPUT,
  fake: FakeOptions = {},
  opts: EngineOptions = {},
  extra: Extra = {},
) {
  const s = start(input, fake, opts, extra);
  return { ...s, result: await s.promise };
}

/** Four-state verdict from the street graph itself, over the facilities the engine kept. */
function truth(
  r: AnalysisResult,
  gate: XY,
  cat: (typeof HARD_CATEGORIES)[number],
  rule: number,
  rules: 'task' | 'gb50180',
) {
  const fac = facilitiesFor(r.pois, acceptedCategories(cat, rules) as FacilityCategory[]);
  const walk = Math.min(...fac.map((p) => Math.round(city.walk(gate, routingPoint(p)))));
  const straight = Math.min(...fac.map((p) => dist(gate, p.xy)));
  return walk <= rule ? '覆盖' : straight <= rule ? '伪覆盖' : '盲区';
}

describe('live analysis of a synthetic river city', () => {
  const controller = new AbortController();
  let main: Awaited<ReturnType<typeof run>>;
  beforeAll(async () => {
    main = await run(INPUT, {}, { signal: controller.signal });
  });

  it('reports the stages in order, progress never going back, and only stage / partial / quota events', () => {
    const stages = main.events.filter((e) => e.event === 'stage');
    const order = stages.map((e) => e.data.stage).filter((s, i, all) => i === 0 || s !== all[i - 1]);
    expect(order).toEqual([...STAGES]);
    const progress = stages.map((e) => e.data.progress as number);
    expect(progress.every((p, i) => p >= 0 && p <= 1 && (i === 0 || p >= progress[i - 1]!))).toBe(true);
    expect(stages.every((e) => /[一-鿿]/.test(e.data.message))).toBe(true);
    expect(new Set(main.events.map((e) => e.event))).toEqual(new Set(['stage', 'partial', 'quota']));
    // refinement ran in rounds, each with its own stage event and partial
    expect(stages.filter((e) => e.data.stage === 'refine').length).toBe(main.result.stats.refine_rounds);
  });

  it('pushes a coarse field and contours right after the seed, before any path or refinement call', () => {
    const firstField = main.events.find((e) => e.event === 'partial' && e.data.field);
    expect(firstField).toBeDefined();
    const seedCalls = main.client.calls.findIndex((c) => c.service === 'routematrix_walking') + 1;
    expect(firstField!.calls).toBe(seedCalls);
    expect(firstField!.data.contours['900'].length).toBeGreaterThan(0);
    expect(firstField!.data.samples.every((s: { set: string }) => s.set === 'seed')).toBe(true);
    // each partial field is complete in itself (clients shallow-merge)
    for (const e of main.events.filter((x) => x.event === 'partial' && x.data.field)) {
      expect(e.data.field.t_s).toHaveLength(e.data.field.nx * e.data.field.ny);
      expect(e.data.contours_meta['900']).toHaveLength(e.data.contours['900'].length);
    }
    // meta first, then pois, then fields
    const partials = main.events.filter((e) => e.event === 'partial');
    expect(Object.keys(partials[0]!.data)).toEqual(['meta']);
    expect(Object.keys(partials[1]!.data)).toEqual(['pois']);
  });

  it('stays inside the personal budget, hands budget and signal to every call and releases the reservation', () => {
    const { client, result } = main;
    const billed = client.billed;
    expect(billed.routematrix_walking).toBeLessThanOrEqual(700);
    expect(billed.place).toBeLessThanOrEqual(6);
    expect(billed.directionlite_walking).toBeLessThanOrEqual(6);
    expect(billed.reverse_geocoding).toBe(1);
    const byStep = result.stats.quota_by_step as Record<string, number>;
    expect(byStep.seed).toBe(48);
    expect(byStep.refine).toBeLessThanOrEqual(192);
    expect(byStep.coverage).toBeGreaterThan(0);
    expect(byStep.coverage).toBeLessThanOrEqual(400);
    expect(byStep.siting).toBeLessThanOrEqual(60);
    expect(byStep.facilities! + byStep.residential!).toBe(billed.place);
    // the engine's own count is what the client billed
    expect(result.stats.quota_used).toEqual({
      reverse_geocoding: billed.reverse_geocoding,
      place: billed.place,
      directionlite_walking: billed.directionlite_walking,
      routematrix_walking: billed.routematrix_walking,
    });
    // routematrix requests stay within Baidu's 50 routes
    for (const c of client.calls.filter((x) => x.service === 'routematrix_walking'))
      expect(c.units).toBeLessThanOrEqual(50);
    // one reserved budget and the run's signal on every call
    expect(client.calls.every((c) => c.opts.signal === controller.signal)).toBe(true);
    expect(new Set(client.calls.map((c) => c.opts.budget)).size).toBe(1);
    expect(client.calls[0]!.opts.budget).toBeDefined();
    for (const s of ENGINE_SERVICES) {
      const u = client.ledger!.usage(s);
      expect(u.reserved).toBe(0);
      expect(u.used).toBe(billed[s] ?? 0);
      // the last quota event of a service shows the ledger's day total
      const last = main.events.filter((e) => e.event === 'quota' && e.data.service === s).pop();
      expect(last?.data).toEqual({ service: s, used: u.used, limit: u.limit });
    }
  });

  it('keeps the 15-minute isochrone on this side of the river except behind the bridge', () => {
    const r = main.result;
    const f = r.field;
    expect(r.stats.area_iso15_km2).toBeLessThan(0.7 * r.stats.area_circle15_km2);
    expect(r.stats.area_iso15_km2).toBeGreaterThan(0.4 * r.stats.area_circle15_km2);
    let farEast = 0;
    let leaked = 0;
    let behindBridge = 0;
    let wrong = 0;
    let inside = 0;
    for (let j = 0; j < f.ny; j++) {
      for (let i = 0; i < f.nx; i++) {
        const t = f.t_s[j * f.nx + i]!;
        if (t < 0) continue;
        const xy: XY = [f.x0 + i * f.cell_m, f.y0 + j * f.cell_m];
        const real = city.timeFromOrigin(xy);
        if (real < 900) inside++;
        if (t < 900 !== real < 900) wrong++;
        // the river runs along x = 450; the first street beyond it is x = 500, the bridge lands at (500, −300)
        if (xy[0] < 500) continue;
        if (dist(xy, [500, -300]) > 400) {
          farEast++;
          if (t < 900) leaked++;
        } else if (t < 900) behindBridge++;
      }
    }
    expect(farEast).toBeGreaterThan(1000);
    expect(leaked).toBe(0);
    expect(behindBridge).toBeGreaterThan(50);
    expect(wrong / inside).toBeLessThan(0.07);
    for (const ring of r.contours['900']) {
      for (const p of ring) if (p[0] > 500) expect(dist(p, [500, -300])).toBeLessThan(420);
    }
    // the river shows up as a line of barrier pieces north of the bridge, found from walking times alone
    const river = (r.barriers ?? []).filter((b) => Math.abs((b.a[0] + b.b[0]) / 2 - 450) < 80);
    expect(river.length).toBeGreaterThan(10);
    expect(Math.max(...river.map((b) => Math.max(b.a[1], b.b[1])))).toBeGreaterThan(800);
    expect(r.stats.barrier_segments).toBe(r.barriers!.length);
  });

  it('marks compounds whose nearest school or market is across the river 伪覆盖, like the street graph', () => {
    const r = main.result;
    const byName = new Map(r.communities.map((c) => [c.name, c]));
    const school = byName.get('滨河花园')!.checks['小学'];
    expect(school).toMatchObject({ status_main: '伪覆盖', verified: true, nearest_straight: '河东实验小学' });
    expect(school.straight_m).toBeLessThan(500);
    expect(school.route_m).toBeGreaterThan(1500);
    const market = byName.get('东岸新村')!.checks['菜市场'];
    expect(market).toMatchObject({ status_main: '伪覆盖', verified: true, nearest_straight: '河西生鲜市场' });
    let n = 0;
    for (const c of r.communities) {
      for (const cat of HARD_CATEGORIES) {
        const k = c.checks[cat];
        expect(k.verified, `${c.name} ${cat}`).toBe(true);
        expect(k.status_main, `${c.name} ${cat}`).toBe(truth(r, c.centroid, cat, 1000, 'task'));
        n++;
      }
    }
    expect(n).toBe(90);
    const counts = r.stats.community_status_counts as { main: Record<string, number>; total: number };
    expect(counts.total).toBe(90);
    expect(counts.main['伪覆盖']).toBeGreaterThanOrEqual(3);
    expect(r.gray_areas!.some((g) => g.kind === 'pseudo')).toBe(true);
  });

  it('cleans the facility list: stalls fold into their market, copies and blacklisted names never count', () => {
    const r = main.result;
    const names = r.pois.map((p) => p.name);
    for (const gone of ['爱宠宠物药店', '启明英语小学辅导中心', '益民大药房医保服务点'])
      expect(names).not.toContain(gone);
    expect(names.filter((n) => n === '河东实验小学')).toHaveLength(1);
    expect(r.pois.find((p) => p.name === '河东实验小学')!.navi_xy).not.toBeNull();
    expect(r.pois.find((p) => p.name === '王记肉铺(临河菜市场店)')).toMatchObject({ stall_of: '临河菜市场' });
    expect(r.pois.find((p) => p.name === '鲜丰生鲜(临河菜场店)')).toMatchObject({ stall_of: '临河菜市场' });
    expect(r.stats.facility_counts).toMatchObject({ 小学: 5, 菜市场: 4, 药店: 10 });
    expect(r.stats.pois_dropped).toBe(4);
    // every place page came from the budget: the union, then 生鲜超市 / 幼儿园 with the page left
    const queries = r.stats.place_queries as { keywords: string; complete: boolean }[];
    expect(queries[0]!.keywords.startsWith('小学$菜市场')).toBe(true);
    expect(queries.every((q) => q.complete)).toBe(true);
  });

  it('uses residential gates as demand points: sub-POIs merged, the nearest 30 inside the 15-minute circle', () => {
    const r = main.result;
    const names = r.communities.map((c) => c.name);
    expect(r.communities).toHaveLength(30);
    expect(r.stats.demand_found).toBeGreaterThan(30);
    expect(new Set(names).size).toBe(30);
    expect(names.filter((n) => n.startsWith('滨河花园'))).toEqual(['滨河花园']);
    expect(names).toEqual(expect.arrayContaining(['锦绣苑', '锦绣苑（2）', '临河小区']));
    for (const gone of ['远郊花园', '河西小区居委会', '北苑小区停车场']) expect(names).not.toContain(gone);
    const byName = new Map(r.communities.map((c) => [c.name, c]));
    expect(byName.get('滨河花园')).toMatchObject({ pts: [], centroid: [400, 470], gate: 'navi' });
    expect(byName.get('临河小区')).toMatchObject({ pts: [], centroid: [-200, 250], gate: 'gate_poi' });
    for (const c of r.communities) {
      expect(c.pts).toEqual([]);
      expect(Math.hypot(...c.centroid)).toBeLessThanOrEqual(DEMAND_RADIUS_M);
    }
    // compounds are searched within the demand radius, facilities 1 km beyond it; the field keeps 1600 m
    const radii = main.client.calls
      .filter((c) => c.service === 'place')
      .map((c) => (c.opts as { radius?: number }).radius);
    expect(new Set(radii)).toEqual(new Set([DEMAND_RADIUS_M + FACILITY_BUFFER_M, DEMAND_RADIUS_M]));
    const meta = r.meta as LiveMeta;
    expect(meta.facility_radius_m).toBe(2100);
    expect(meta.extent_m).toBe(1600);
    expect(meta.notes.join('\n')).toMatch(/没有轮廓/);
  });

  it('suggests sites for the gaps and verifies at most the top two per category', () => {
    const r = main.result;
    const sites = r.site_suggestions!;
    expect(Object.keys(sites).length).toBeGreaterThan(0);
    for (const [cat, list] of Object.entries(sites) as [
      (typeof HARD_CATEGORIES)[number],
      NonNullable<typeof sites.小学>,
    ][]) {
      expect(list.length).toBeGreaterThan(0);
      expect(list.length).toBeLessThanOrEqual(3);
      expect(list.filter((s) => s.verified).length).toBeLessThanOrEqual(2);
      const gaps = new Set(
        r.communities
          .filter((c) => c.checks[cat].verified && c.checks[cat].status_main !== '覆盖')
          .map((c) => c.name),
      );
      for (const s of list) {
        expect(s.label).toMatch(/步行路线约 \d+ 米处/);
        for (const id of s.covers) expect(gaps.has(id)).toBe(true);
        for (const row of s.routes)
          expect(s.verified ? (row.route_m ?? 0) : row.est_m).toBeLessThanOrEqual(1000);
      }
    }
    expect(sites['小学']!.some((s) => s.verified && s.covers.includes('滨河花园'))).toBe(true);
  });

  it('builds a result the web renders, reproducing its own field from its samples', () => {
    const r = main.result;
    // the web's isAnalysisResult (apps/web/src/data/loadAnalysis.ts)
    expect(r.meta.center_bd09).toEqual(CITY_ORIGIN);
    expect(typeof r.meta.frame_formula).toBe('string');
    expect(Array.isArray(r.communities) && Array.isArray(r.pois) && Array.isArray(r.paths)).toBe(true);
    expect(r.contours['900'].length).toBeGreaterThan(0);
    expect(r.baseline.circle_r15_m).toBe(1053);
    expect(r.stats.reach_by_bearing).toHaveLength(72);
    // the web's frame parser (apps/web/src/geo/frame.ts)
    const num = String.raw`(-?\d+(?:\.\d+)?)`;
    const mx = new RegExp(
      String.raw`x\s*=\s*\(\s*lng\s*-\s*${num}\s*\)\s*\*\s*${num}\s*\*\s*cos\(\s*${num}\s*deg\s*\)`,
    ).exec(r.meta.frame_formula);
    expect(mx?.slice(1).map(Number)).toEqual([CITY_ORIGIN[0], 111320, CITY_ORIGIN[1]]);
    expect(r.field).toMatchObject({ cell_m: 20, nx: 161, ny: 161, x0: -1600, y0: -1600 });
    expect(r.paths.length).toBe(4);
    expect(r.paths.every((p) => p.pts.length > 10 && p.pts.every((v) => v.length === 4))).toBe(true);
    expect(r.samples.some((s) => s.src === 'directionlite_path')).toBe(true);
    // live mode: Baidu only, no OpenStreetMap
    expect(r.base).toBeUndefined();
    expect(r.communities.some((c) => c.osm_id) || r.pois.some((p) => p.source === 'osm')).toBe(false);
    expect(r.meta.attribution.join('\n')).toMatch(/Baidu/);
    expect(r.meta.attribution.join('\n')).toMatch(/不使用 OpenStreetMap/);
    expect(r.meta).toMatchObject({
      name: '中心花园片区',
      center_label: '河西路 × 滨河路',
      extent_m: 1600,
      walk_speed_mps: 1.17,
    });
    // the web's place header reads region; obstacles are never named without a source
    expect(r.meta.region).toEqual({ city: '测试市', district: '临河区', town: '滨河街道' });
    expect(r.meta.barrier_names).toBeUndefined();
    // JSON-safe: no NaN or Infinity anywhere (JSON would turn them into null)
    const nonFinite: string[] = [];
    const text = JSON.stringify(r, (key, v: unknown) => {
      if (typeof v === 'number' && !Number.isFinite(v)) nonFinite.push(key);
      return v;
    });
    expect(nonFinite).toEqual([]);
    expect(JSON.parse(text).samples).toEqual(r.samples);
    // anyone can rebuild the field from the stored samples
    const timed = r.samples.filter((s) => s.straight_m >= 30);
    const rebuilt = buildIsochrone(r.samples, {
      extent_m: 1600,
      cell_m: 20,
      loo: false,
      field: { visible: visibilityFilter(detectBarriers(timed)) },
    });
    expect(rebuilt.field.t_s).toEqual(r.field.t_s);
  });

  it('estimates its own cost within ±15 % before starting (planQuota)', () => {
    const plan = planQuota(INPUT);
    expect(plan.max).toEqual({
      reverse_geocoding: 1,
      place: 6,
      directionlite_walking: 6,
      routematrix_walking: 700,
    });
    for (const s of ENGINE_SERVICES) {
      const actual = main.client.billed[s] ?? 0;
      const expected = plan.expected[s];
      // small integer counts (place pages, walks) are allowed one unit either way
      expect(Math.abs(actual - expected), s).toBeLessThanOrEqual(Math.max(1, 0.15 * expected));
      expect(actual).toBeLessThanOrEqual(plan.max[s]);
    }
    expect(plan.steps.map((s) => s.step)).toEqual([
      'locate',
      'facilities',
      'residential',
      'paths',
      'seed',
      'refine',
      'coverage',
      'siting',
    ]);
  });
});

describe('official lists: multi-source POI fusion', () => {
  const list = officialMarkets(city);
  let base: Awaited<ReturnType<typeof run>>;
  let fused: Awaited<ReturnType<typeof run>>;
  beforeAll(async () => {
    base = await run();
    fused = await run(INPUT, {}, {}, { official: [list] });
  });
  const poi = (r: AnalysisResult, name: string) => r.pois.find((p) => p.name === name);

  it('confirms, re-classifies and adds listed markets; closed and far entries change nothing', () => {
    const r = fused.result;
    // Baidu had it right: the list confirms it, the stalls stay merged into it
    expect(poi(r, '临河菜市场')).toMatchObject({
      cat: '菜市场',
      source: 'baidu',
      official: { list: list.id, name: '浦商菜市场临河店', address: '临河路88号' },
    });
    expect(poi(r, '临河菜市场')!.official!.reclassified_from).toBeUndefined();
    expect(poi(r, '王记肉铺(临河菜市场店)')).toMatchObject({ stall_of: '临河菜市场' });
    expect(poi(r, '鲜丰生鲜(临河菜场店)')).toMatchObject({ stall_of: '临河菜市场' });
    // tagged 生鲜超市 by Baidu: now a market, still routed to Baidu's entrance
    expect(poi(base.result, '浦商生鲜(河东店)')).toMatchObject({ cat: '生鲜超市' });
    expect(poi(r, '浦商生鲜(河东店)')).toMatchObject({
      cat: '菜市场',
      source: 'baidu',
      navi_xy: [800, -640],
      official: { name: '浦商生鲜河东店', reclassified_from: '生鲜超市' },
    });
    // never returned by Baidu's search (plain 购物): added at the official address
    expect(r.pois.find((p) => p.uid === `gov:${list.id}:2`)).toMatchObject({
      name: '浦商生鲜东岸店',
      cat: '菜市场',
      source: 'gov',
      navi_xy: null,
      official: { list: list.id, name: '浦商生鲜东岸店', address: '东岸路200号' },
    });
    expect(r.pois.some((p) => p.name === '浦商生鲜(东岸店)')).toBe(false);
    // closed for renovation: the Baidu POI stays as Baidu classified it, nothing is added
    expect(poi(r, '北街农贸市场')).toEqual(poi(base.result, '北街农贸市场'));
    expect(r.pois.some((p) => p.uid === `gov:${list.id}:3` || p.uid === `gov:${list.id}:4`)).toBe(false);
    expect(r.stats.facility_counts).toMatchObject({ 菜市场: 6, 生鲜超市: 2 });
    expect(base.result.stats.facility_counts).toMatchObject({ 菜市场: 4, 生鲜超市: 3 });
  });

  it('turns a compound from 伪覆盖 to 覆盖 through the market Baidu never returned, like the street graph', () => {
    const before = base.result.communities.find((c) => c.name === '东岸新村')!.checks['菜市场'];
    const after = fused.result.communities.find((c) => c.name === '东岸新村')!.checks['菜市场'];
    expect(before).toMatchObject({ status_main: '伪覆盖', verified: true });
    expect(after).toMatchObject({ status_main: '覆盖', verified: true, via: '浦商生鲜东岸店' });
    expect(after.route_m).toBeLessThan(200);
    for (const c of fused.result.communities) {
      for (const cat of HARD_CATEGORIES) {
        const k = c.checks[cat];
        expect(k.verified, `${c.name} ${cat}`).toBe(true);
        expect(k.status_main, `${c.name} ${cat}`).toBe(truth(fused.result, c.centroid, cat, 1000, 'task'));
      }
    }
    const gaps = (r: AnalysisResult) =>
      r.communities.filter((c) => c.checks['菜市场'].status_main !== '覆盖').length;
    expect(gaps(fused.result)).toBeLessThan(gaps(base.result));
  });

  it('reports what the list did in meta and stats, at no extra quota', () => {
    const meta = fused.result.meta as LiveMeta;
    expect(meta.notes).toContain(
      '菜市场名录（测试市临河区商务委员会《2026年一季度临河区菜市场实效测评得分及排名》）：范围内 3 家，' +
        '与百度 POI 一致 1 家，百度标为生鲜超市而改类 1 家，百度检索未返回、按官方地址补充 1 家；另有 1 家装修改造，未计入。',
    );
    expect(meta.attribution).toContain(
      '测试市临河区商务委员会《2026年一季度临河区菜市场实效测评得分及排名》（2026-03-20）：https://www.linhe.example.gov.cn/markets/2026q1.html',
    );
    // the web dates the measurements from the last Baidu line, which stays in place
    expect([...meta.attribution].reverse().find((a) => /baidu/i.test(a))).toMatch(/2026-09-27/);
    expect(meta.warnings.join('\n')).toMatch(
      /浦商生鲜东岸店（东岸路200号）的官方地址只定位到“道路”级（非精确）/,
    );
    expect(fused.result.stats.official).toEqual([
      {
        list: list.id,
        category: '菜市场',
        in_range: 3,
        confirmed: 1,
        reclassified: 1,
        added: 1,
        imprecise: 1,
        inactive_in_range: 1,
      } satisfies OfficialSummary,
    ]);
    expect((base.result.meta as LiveMeta).notes.join('\n')).not.toMatch(/名录/);
    for (const s of ['place', 'directionlite_walking', 'reverse_geocoding'] as const) {
      expect(fused.client.billed[s]).toBe(base.client.billed[s]);
    }
    expect(fused.client.billed.routematrix_walking).toBeLessThanOrEqual(700);
  });
});

describe('cancellation and failures', () => {
  it('stops cleanly when aborted mid-run: no further call or event, reservation returned', async () => {
    const controller = new AbortController();
    const reason = new Error('client disconnected');
    let eventsAtAbort = -1;
    const s = start(
      INPUT,
      {
        onCall: (c) => {
          if (c.service === 'routematrix_walking' && c.n === 3) {
            controller.abort(reason);
            eventsAtAbort = s.events.length;
          }
        },
      },
      { signal: controller.signal },
    );
    await expect(s.promise).rejects.toBe(reason);
    const calls = s.client.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(s.client.calls.length).toBe(calls);
    expect(s.client.calls.filter((c) => c.service === 'routematrix_walking')).toHaveLength(3);
    expect(s.events.length).toBe(eventsAtAbort);
    for (const svc of ENGINE_SERVICES) expect(s.client.ledger!.usage(svc).reserved).toBe(0);
  });

  it('rejects at once with an already aborted signal', async () => {
    const controller = new AbortController();
    const reason = new Error('server shutting down');
    controller.abort(reason);
    const s = start(INPUT, {}, { signal: controller.signal });
    await expect(s.promise).rejects.toBe(reason);
    expect(s.client.calls).toHaveLength(0);
    expect(s.events).toHaveLength(0);
  });

  it('turns a quota error mid-run into EngineError quota_exhausted and stops calling', async () => {
    const quota = new BaiduQuotaError('批量算路（步行）失败：status 302 天配额超限（天配额超限，限制访问）', {
      service: 'routematrix_walking',
      status: 302,
      scope: 'daily',
      hint: '今日配额已用尽：该服务今天停止调用，改用缓存或样例数据，北京时间次日 0 点恢复',
    });
    const s = start(INPUT, {
      onCall: (c) => (c.service === 'routematrix_walking' && c.n === 4 ? quota : undefined),
    });
    const err = await s.promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineError);
    expect(err).toMatchObject({ code: 'quota_exhausted', cause: quota });
    expect((err as EngineError).message).toMatch(/配额/);
    expect((err as EngineError).message).toMatch(/次日 0 点恢复/);
    expect(s.client.calls[s.client.calls.length - 1]).toMatchObject({ service: 'routematrix_walking', n: 4 });
    expect(new Set(s.events.map((e) => e.event))).toEqual(new Set(['stage', 'partial', 'quota']));
    expect(s.events.filter((e) => e.event === 'stage').pop()!.data.stage).toBe('refine');
    for (const svc of ENGINE_SERVICES) expect(s.client.ledger!.usage(svc).reserved).toBe(0);
  });

  it('maps key errors to auth and bad input to invalid_input', async () => {
    const auth = new BaiduConfigError('逆地理编码失败：status 211 APP SN校验失败', {
      service: 'reverse_geocoding',
      status: 211,
      hint: 'SN 校验失败：检查 BAIDU_SERVER_SK，或批量算路改用 BAIDU_MATRIX_AK',
    });
    const s = start(INPUT, { onCall: () => auth });
    await expect(s.promise).rejects.toMatchObject({ name: 'EngineError', code: 'auth' });
    expect(s.client.calls).toHaveLength(1);
    for (const bad of [
      { center_bd09: [2.35, 48.85] as LngLat },
      { center_bd09: [31.2, 121.5] as LngLat },
      { ...INPUT, profile: 'child' as never },
      { ...INPUT, rules: 'iso' as never },
      { ...INPUT, label: 42 as never },
    ]) {
      const b = start(bad);
      await expect(b.promise).rejects.toMatchObject({ name: 'EngineError', code: 'invalid_input' });
      expect(b.client.calls).toHaveLength(0);
    }
    const noSeed = start(INPUT, {}, { budget: { seed: 0 } });
    await expect(noSeed.promise).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringMatching(/budget.seed/),
    });
    expect(noSeed.client.calls).toHaveLength(0);
  });

  it('refuses to start when the day is nearly used up, before any call', async () => {
    const ledger = new QuotaLedger({
      tier: 'personal',
      limits: { routematrix_walking: 600, reverse_geocoding: 1 },
    });
    const s = start(INPUT, { ledger });
    const err = await s.promise.catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'EngineError', code: 'quota_exhausted' });
    // the optional reverse geocoding is never named as the reason
    expect((err as Error).message).toMatch(/^批量算路（步行）今日配额已用到 90%/);
    expect(s.client.calls).toHaveLength(0);
  });

  it('degrades gracefully when only optional lookups are short', async () => {
    // reverse geocoding nearly used up: skipped up front, the user's label names the place
    const ledger = new QuotaLedger({ tier: 'personal', limits: { reverse_geocoding: 1 } });
    const a = await run(INPUT, { ledger });
    expect(a.client.count('reverse_geocoding')).toBe(0);
    expect(a.result.meta.name).toBe('河西路 × 滨河路');
    expect(a.result.meta.region).toBeUndefined();
    expect((a.result.meta as LiveMeta).warnings.join('\n')).toMatch(/逆地理编码/);
    // a network failure of the optional 生鲜超市/幼儿园 query leaves the hard categories intact
    const net = new BaiduUpstreamError('网络错误：请求超时（10000 ms）', {
      service: 'place',
      kind: 'network',
    });
    const b = await run(INPUT, { onCall: (c) => (c.service === 'place' && c.n === 3 ? net : undefined) });
    expect((b.result.meta as LiveMeta).warnings.join('\n')).toMatch(/生鲜超市、幼儿园检索失败/);
    expect(b.result.stats.facility_counts).toMatchObject({ 小学: 5, 菜市场: 4, 药店: 10, 幼儿园: 0 });
    expect(b.result.communities).toHaveLength(30);
  });
});

describe('profiles, rules and clients', () => {
  it('elder profile: one canonical adult-speed result, refined for the elder boundary, no extra reach calls', async () => {
    const e = await run({ ...INPUT, profile: 'elder' });
    expect(e.result.meta).toMatchObject({ profile: 'elder', profile_speed_mps: 0.9, walk_speed_mps: 1.17 });
    const reach = e.events.find((x) => x.event === 'stage' && x.data.stage === 'reach')!;
    const coverage = e.events.find((x) => x.event === 'stage' && x.data.stage === 'coverage')!;
    expect(coverage.calls).toBe(reach.calls);
    // stored in routematrix (adult) seconds: clients scale by 1.17 / 0.9 for the elder view
    expect(e.result.baseline.circle_r15_m).toBe(1053);
    expect(e.client.billed.routematrix_walking).toBeLessThanOrEqual(700);
    const timed = e.result.samples.filter((s) => s.straight_m >= 30);
    const opts = {
      extent_m: 1600,
      cell_m: 20,
      loo: false,
      field: { visible: visibilityFilter(detectBarriers(timed)) },
    };
    const adult = buildIsochrone(e.result.samples, opts);
    expect(adult.field.t_s).toEqual(e.result.field.t_s);
    // the elder 15-minute line (adult ≈ 692 s) lies inside the adult one
    const elder = buildIsochrone(e.result.samples, { ...opts, speed: 0.9, sampleSpeed: 1.17 });
    expect(elder.stats.area_iso15_km2).toBeLessThan(e.result.stats.area_iso15_km2);
    // coverage is about metres, not minutes: the verdicts do not depend on the profile
    const byName = new Map(e.result.communities.map((c) => [c.name, c]));
    expect(byName.get('滨河花园')!.checks['小学'].status_main).toBe('伪覆盖');
  });

  it('GB 50180 rules: 500 / 300 m radii and 生鲜超市 standing in for a market', async () => {
    const g = await run({ ...INPUT, rules: 'gb50180' });
    const meta = g.result.meta as LiveMeta;
    expect(meta.rule_m).toEqual({ 小学: 500, 菜市场: 500, 药店: 300 });
    expect(g.result.baseline.rule_radius_m).toBe(500);
    const queries = g.result.stats.place_queries as { keywords: string }[];
    expect(queries[0]!.keywords).toContain('生鲜超市');
    for (const c of g.result.communities) {
      for (const cat of HARD_CATEGORIES) {
        const k = c.checks[cat];
        if (!k.verified) continue;
        expect(k.status_main, `${c.name} ${cat}`).toBe(
          truth(g.result, c.centroid, cat, meta.rule_m[cat], 'gb50180'),
        );
      }
    }
    // 叮咚生鲜超市 (east bank, near the bridge) serves as a market under GB 50180
    expect(g.result.communities.some((c) => c.checks['菜市场'].via === '叮咚生鲜超市')).toBe(true);
  });

  it('runs without a ledger: quota events count this run against its caps', async () => {
    const r = await run(INPUT, { ledger: null });
    expect(r.client.calls.every((c) => c.opts.budget === undefined)).toBe(true);
    const last = r.events
      .filter((e) => e.event === 'quota' && e.data.service === 'routematrix_walking')
      .pop()!;
    expect(last.data).toEqual({
      service: 'routematrix_walking',
      used: r.client.billed.routematrix_walking,
      limit: 700,
    });
    expect(r.result.communities).toHaveLength(30);
  });

  it('plugs into the server seam through createEngineAnalyzer', async () => {
    // structural copy of apps/server/src/analyzer.ts
    type ServerEvents = {
      stage: { stage: (typeof STAGES)[number]; message: string; progress: number };
      partial: Partial<AnalysisResult>;
      quota: { service: string; used: number; limit: number };
    };
    interface ServerAnalyzer {
      readonly name?: string;
      analyze(
        input: { center_bd09: LngLat; label?: string; profile: 'adult' | 'elder' },
        emit: <E extends keyof ServerEvents>(event: E, data: ServerEvents[E]) => void,
        signal: AbortSignal,
      ): Promise<AnalysisResult>;
    }
    const client = new FakeClient({ city });
    const analyzer: ServerAnalyzer = createEngineAnalyzer({ client, now: NOW });
    expect(analyzer.name).toBe('engine');
    const seen: string[] = [];
    const result = await analyzer.analyze(
      { center_bd09: CITY_ORIGIN, profile: 'adult' },
      (event) => void seen.push(event),
      new AbortController().signal,
    );
    expect(result.communities).toHaveLength(30);
    expect(new Set(seen)).toEqual(new Set(['stage', 'partial', 'quota']));
    const stopped = new AbortController();
    const reason = new Error('analysis timed out');
    stopped.abort(reason);
    await expect(
      analyzer.analyze({ center_bd09: CITY_ORIGIN, profile: 'adult' }, () => {}, stopped.signal),
    ).rejects.toBe(reason);
  });
});
