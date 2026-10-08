import { BaiduConfigError, BaiduQuotaError, BaiduUpstreamError, QuotaLedger } from '@zoudedao/baidu';
import {
  buildIsochrone,
  checkedCategories,
  detectBarriers,
  facilitiesFor,
  facilityStats,
  HARD_CATEGORIES,
  routingPoint,
  visibilityFilter,
  type AnalysisResult,
  type CatchmentList,
  type HardCategory,
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
  FRESH_KEYWORDS,
  LIVELIHOOD_KEYWORDS,
  LIVELIHOOD_RADIUS_M,
  planQuota,
  STAGES,
  type Emit,
  type EngineDeps,
  type EngineInput,
  type EngineOptions,
  type CatchmentStats,
  type LiveMeta,
  type OfficialList,
  type OfficialSummary,
} from '../src/index.js';
import { City, CITY_ORIGIN, cityPois, officialMarkets } from './city.js';
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

type Extra = Pick<EngineDeps, 'official' | 'catchment' | 'exclusions'>;

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

/**
 * The street graph's shortest walk from a gate to a facility of the category the engine kept (the
 * engine's own answer can differ by 1 m: its routes go through BD-09 and back).
 */
function nearestWalk(r: AnalysisResult, gate: XY, cat: HardCategory) {
  const fac = facilitiesFor(r.pois, [cat]);
  return Math.min(...fac.map((p) => Math.round(city.walk(gate, routingPoint(p)))));
}

/** Four-state verdict from the street graph itself, over the facilities the engine kept. */
function truth(r: AnalysisResult, gate: XY, cat: HardCategory, rule: number) {
  const fac = facilitiesFor(r.pois, [cat]);
  const walk = nearestWalk(r, gate, cat);
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
    expect(billed.routematrix_walking).toBeLessThanOrEqual(1030);
    expect(billed.place).toBeLessThanOrEqual(12);
    expect(billed.directionlite_walking).toBeLessThanOrEqual(6);
    expect(billed.reverse_geocoding).toBe(1);
    const byStep = result.stats.quota_by_step as Record<string, number>;
    expect(byStep.seed).toBe(48);
    expect(byStep.refine).toBeLessThanOrEqual(192);
    expect(byStep.coverage).toBeGreaterThan(0);
    expect(byStep.coverage).toBeLessThanOrEqual(650);
    expect(byStep.siting).toBeGreaterThan(0);
    expect(byStep.siting).toBeLessThanOrEqual(100);
    // the 41 rows of the five checked categories take three pages, 生鲜超市 the fourth
    expect(byStep.facilities).toBe(4);
    expect(byStep.livelihood).toBe(2);
    // the 买菜替代 search: the city's shops fit one page
    expect(byStep.fresh).toBe(1);
    expect(byStep.facilities! + byStep.livelihood! + byStep.residential! + byStep.fresh!).toBe(billed.place);
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

  it('marks compounds whose nearest school, market or kindergarten is across the river 伪覆盖, like the street graph', () => {
    const r = main.result;
    const byName = new Map(r.communities.map((c) => [c.name, c]));
    const school = byName.get('滨河花园')!.checks['小学'];
    expect(school).toMatchObject({ status_main: '伪覆盖', verified: true, nearest_straight: '河东实验小学' });
    expect(school.straight_m).toBeLessThan(500);
    // across the bridge 河东实验小学 is over 1.5 km on foot; 临河第一小学 on this bank, more than 1 km away
    // even in a straight line (so the rule's early stop never routed it), is the nearest walk
    expect(school).toMatchObject({ via: '临河第一小学', route_upper_bound: false });
    expect(school.route_m).toBeGreaterThan(1200);
    const walk = nearestWalk(r, byName.get('滨河花园')!.centroid, '小学');
    expect(Math.abs(school.route_m - walk)).toBeLessThanOrEqual(1);
    const market = byName.get('东岸新村')!.checks['菜市场'];
    expect(market).toMatchObject({ status_main: '伪覆盖', verified: true, nearest_straight: '河西生鲜市场' });
    // the campus 东岸幼儿园(滨江部) is 522 m away in a straight line, across the river; this bank's
    // kindergartens are over 1 km on foot
    const kindergarten = byName.get('滨河花园')!.checks['幼儿园'];
    expect(kindergarten).toMatchObject({
      status_main: '伪覆盖',
      verified: true,
      nearest_straight: '东岸幼儿园(滨江部)',
    });
    expect(kindergarten.route_m).toBeGreaterThan(1000);
    let n = 0;
    for (const c of r.communities) {
      // a fresh run checks every community for all five categories
      expect(Object.keys(c.checks), c.name).toEqual([...HARD_CATEGORIES]);
      for (const cat of HARD_CATEGORIES) {
        const k = c.checks[cat];
        expect(k.verified, `${c.name} ${cat}`).toBe(true);
        expect(k.status_main, `${c.name} ${cat}`).toBe(truth(r, c.centroid, cat, 1000));
        n++;
      }
    }
    expect(n).toBe(150);
    expect(checkedCategories(r)).toEqual([...HARD_CATEGORIES]);
    const counts = r.stats.community_status_counts as {
      main: Record<string, number>;
      by_category: Record<string, Record<string, number>>;
      total: number;
    };
    expect(counts.total).toBe(150);
    expect(Object.keys(counts.by_category)).toEqual([...HARD_CATEGORIES]);
    expect(counts.main['伪覆盖']).toBeGreaterThanOrEqual(3);
    expect(r.gray_areas!.some((g) => g.kind === 'pseudo')).toBe(true);
    expect((r.meta as LiveMeta).rule_m).toEqual({
      幼儿园: 1000,
      小学: 1000,
      菜市场: 1000,
      药店: 1000,
      社区卫生: 1000,
    });
    expect((r.meta as LiveMeta).notes[0]).toMatch(
      /^逐小区检查 5 类设施：幼儿园、小学、菜市场、药店、社区卫生/,
    );
    expect(
      main.events.some(
        (e) =>
          e.event === 'stage' &&
          /30 个小区 × 5 类设施（幼儿园、小学、菜市场、药店、社区卫生）/.test(e.data.message),
      ),
    ).toBe(true);
  });

  it('walks to the nearest facility in every check: what the early stop left nearer is routed after', () => {
    const r = main.result;
    let routed = 0;
    for (const c of r.communities) {
      for (const cat of HARD_CATEGORIES) {
        const k = c.checks[cat];
        const what = `${c.name} ${cat}`;
        expect(k.unrouted_nearer, what).toBeUndefined();
        expect(k.route_upper_bound, what).toBe(false);
        if (k.route_basis !== 'routed') continue;
        expect(Math.abs(k.route_m - nearestWalk(r, c.centroid, cat)), what).toBeLessThanOrEqual(1);
        routed++;
      }
    }
    expect(routed).toBeGreaterThan(140);
    const nearest = r.stats.coverage_nearest_routes as number;
    expect(nearest).toBeGreaterThan(0);
    expect(nearest).toBeLessThan((r.stats.quota_by_step as Record<string, number>).coverage! / 2);
    expect(main.events.some((e) => e.event === 'stage' && /盲区判定补算/.test(e.data.message))).toBe(true);
  });

  it('gives 菜市场 gaps a 买菜替代 within the rule on foot, like the street graph, and only them', () => {
    const r = main.result;
    const counts = { gaps: 0, with_alt: 0, none: 0, not_looked: 0 };
    for (const c of r.communities) {
      expect(c.checks_gb, c.name).toBeUndefined();
      for (const cat of HARD_CATEGORIES) {
        const k = c.checks[cat];
        const what = `${c.name} ${cat}`;
        if (cat !== '菜市场' || !k.verified || k.status_main === '覆盖') {
          expect(k.alt, what).toBeUndefined();
          continue;
        }
        counts.gaps++;
        if (k.alt === undefined) counts.not_looked++;
        else if (k.alt === null) counts.none++;
        else {
          counts.with_alt++;
          // a measured walk within the rule to the shop's entrance, as the street graph walks it
          expect(k.alt.route_m, what).toBeLessThanOrEqual(1000);
          expect(
            Math.abs(k.alt.route_m - Math.round(city.walk(c.centroid, k.alt.xy))),
            what,
          ).toBeLessThanOrEqual(1);
          // stalls of 临河菜市场 are the market itself
          expect(['鲜丰生鲜(临河菜场店)', '王记肉铺(临河菜市场店)']).not.toContain(k.alt.name);
        }
      }
    }
    // the whole budget was there: every gap was looked at
    expect(counts.not_looked).toBe(0);
    expect(r.stats.fresh_alternatives).toEqual(counts);
    expect(r.stats.fresh_alternatives_gb).toBeUndefined();
    expect(counts.with_alt).toBeGreaterThan(0);
    expect(r.stats).toMatchObject({ fresh_alt_budget_limited: false, fresh_alt_failed_cells: 0 });
    expect(r.stats.fresh_alt_routes as number).toBeGreaterThan(0);
    expect(main.events.some((e) => e.event === 'stage' && /买菜替代/.test(e.data.message))).toBe(true);
    expect((r.meta as LiveMeta).notes.join('\n')).toMatch(/买菜替代（checks\.菜市场\.alt）/);
  });

  it('keeps the upper-bound flags when the coverage budget runs out before the top-up', async () => {
    const byStep = main.result.stats.quota_by_step as Record<string, number>;
    const rounds =
      byStep.coverage! -
      (main.result.stats.coverage_nearest_routes as number) -
      (main.result.stats.fresh_alt_routes as number);
    const { result: r } = await run(INPUT, {}, { budget: { coverage: rounds } });
    expect(r.stats).toMatchObject({
      coverage_nearest_routes: 0,
      coverage_budget_limited: true,
      fresh_alt_routes: 0,
    });
    expect((r.stats.quota_by_step as Record<string, number>).coverage).toBe(rounds);
    const was = new Map(main.result.communities.map((c) => [c.name, c.checks]));
    let flagged = 0;
    for (const c of r.communities) {
      for (const cat of HARD_CATEGORIES) {
        const k = c.checks[cat];
        if (k.unrouted_nearer) flagged++;
        expect(k.route_upper_bound).toBe(!!k.unrouted_nearer);
        // the top-up only shortens walks: the verdicts are the same without it
        expect(k.status_main, `${c.name} ${cat}`).toBe(was.get(c.name)![cat].status_main);
        expect(k.route_m).toBeGreaterThanOrEqual(was.get(c.name)![cat].route_m);
      }
    }
    expect(flagged).toBeGreaterThan(0);
  });

  it('cleans the facility list: stalls fold into their market, copies and blacklisted names never count', () => {
    const r = main.result;
    const names = r.pois.map((p) => p.name);
    for (const gone of [
      '爱宠宠物药店',
      '启明英语小学辅导中心',
      '益民大药房医保服务点',
      // what the 幼儿园 and 社区卫生 keywords bring along: early education, childcare for the
      // under-3s, a kindergarten's gate, a health centre's car park
      '金色童年早教中心',
      '贝贝托育园',
      '临河幼儿园(北门)',
      '临河社区卫生服务中心停车场',
    ])
      expect(names).not.toContain(gone);
    // a kindergarten's campus and an 艺术 kindergarten are kindergartens all the same
    for (const kept of ['东岸幼儿园(滨江部)', '北城艺术幼儿园'])
      expect(r.pois.find((p) => p.name === kept)?.cat, kept).toBe('幼儿园');
    expect(names.filter((n) => n === '河东实验小学')).toHaveLength(1);
    expect(r.pois.find((p) => p.name === '河东实验小学')!.navi_xy).not.toBeNull();
    expect(r.pois.find((p) => p.name === '王记肉铺(临河菜市场店)')).toMatchObject({ stall_of: '临河菜市场' });
    expect(r.pois.find((p) => p.name === '鲜丰生鲜(临河菜场店)')).toMatchObject({ stall_of: '临河菜市场' });
    expect(r.stats.facility_counts).toMatchObject({ 幼儿园: 7, 小学: 5, 菜市场: 4, 药店: 10, 社区卫生: 5 });
    expect(r.stats.pois_dropped).toBe(8);
    // every place page came from the budget: one union of the five checked categories (exactly 10
    // keywords, the scarcest first), then 生鲜超市 with the page left (the 民生设施 union and the 买菜替代
    // search after them have budget lines and completeness of their own)
    const queries = r.stats.place_queries as { keywords: string; pages: number; complete: boolean }[];
    expect(queries[0]).toMatchObject({
      keywords: '小学$社区卫生服务中心$社区卫生服务站$幼儿园$菜市场$菜场$农贸市场$生鲜市场$药店$药房',
      pages: 3,
      complete: true,
    });
    expect(queries[1]).toMatchObject({ keywords: '生鲜超市', complete: true });
    expect(queries.slice(-2).map((q) => q.keywords)).toEqual([
      LIVELIHOOD_KEYWORDS.join('$'),
      FRESH_KEYWORDS.join('$'),
    ]);
    const inventory = r.stats.facility_inventory as Record<string, { complete: boolean; radius_m: number }>;
    for (const cat of HARD_CATEGORIES) {
      expect(inventory[cat], cat).toMatchObject({
        complete: true,
        radius_m: DEMAND_RADIUS_M + FACILITY_BUFFER_M,
      });
    }
  });

  it('adds the other 民生设施 from one union and counts what the 15-minute walk reaches (圈内设施统计)', () => {
    const r = main.result;
    const queries = r.stats.place_queries as {
      keywords: string;
      max_pages: number;
      pages: number;
      complete: boolean;
    }[];
    const union = queries.find((q) => q.keywords === LIVELIHOOD_KEYWORDS.join('$'))!;
    // 社区卫生 is checked per community now: its keywords belong to the facility union
    expect(LIVELIHOOD_KEYWORDS.length).toBeLessThanOrEqual(10);
    expect(LIVELIHOOD_KEYWORDS.filter((k) => k.includes('社区卫生'))).toEqual([]);
    // 55 rows within 1.1 km: two pages, the bus stops' far tail cut
    expect(union).toMatchObject({ max_pages: 2, pages: 2, complete: false });
    const inventory = r.stats.facility_inventory as Record<string, { complete: boolean; radius_m: number }>;
    for (const cat of ['养老', '地铁', '公园', '超市']) {
      expect(inventory[cat], cat).toMatchObject({ complete: true, radius_m: DEMAND_RADIUS_M });
    }
    expect(inventory['公交']!.complete).toBe(false);
    expect(inventory['公交']!.radius_m).toBeLessThan(DEMAND_RADIUS_M);
    expect((r.meta as LiveMeta).notes.join('\n')).toMatch(/公交只统计到离中心 \d+ 米/);
    expect((r.meta as LiveMeta).notes.join('\n')).toMatch(
      /民生设施：养老、地铁、公园、超市、公交用一次地点检索/,
    );

    const names = (cat: string) =>
      r.pois
        .filter((p) => p.cat === cat)
        .map((p) => p.name)
        .sort();
    // the centre and the stations within the 2.1 km facility radius, from the checked categories' union
    expect(names('社区卫生')).toEqual(
      [
        '临河社区卫生服务中心',
        '北街社区卫生服务站',
        '南苑社区卫生服务站',
        '河东社区卫生服务站',
        '滨河社区卫生服务站',
      ].sort(),
    );
    expect(names('养老')).toEqual(['临河街道长者食堂', '滨河养老院']);
    expect(names('地铁')).toEqual(['东岸路', '河西路']);
    expect(names('公园')).toEqual(['滨河公园']);
    // 盒马生鲜超市 came with the 生鲜超市 group already and is not counted twice
    expect(names('超市')).toEqual(['家乐福超市', '盒马生鲜超市', '联华超市(河西店)']);
    expect(names('公交').length).toBeGreaterThan(10);
    expect(new Set(r.pois.map((p) => p.uid)).size).toBe(r.pois.length);
    for (const gone of ['河西路地铁站-1口', '无障碍电梯(河西路地铁站2号口)']) {
      expect(r.pois.map((p) => p.name)).not.toContain(gone);
    }
    // the union adds counted facilities only: no checked facility enters the checks through it
    expect(r.stats.facility_counts).toMatchObject({ 小学: 5, 菜市场: 4, 药店: 10, 社区卫生: 5, 地铁: 2 });

    // stats.facility_stats is core's facilityStats over the result, at the stored adult speed
    const stats = r.stats.facility_stats!;
    expect(stats).toEqual(facilityStats(r));
    const by = new Map(stats.map((s) => [s.category, s]));
    expect(stats.map((s) => s.category)).toEqual(
      expect.arrayContaining([
        '小学',
        '幼儿园',
        '菜市场',
        '药店',
        '社区卫生',
        '养老',
        '公交',
        '地铁',
        '公园',
        '超市',
      ]),
    );
    // 东岸路 station lies inside the straight circle, but the walk needs the bridge
    expect(by.get('地铁')).toMatchObject({ found: 2, walk: 1, circle: 2, nearest: '河西路' });
    // the whole 2.1 km inventory is found; two lie inside the straight circle (河东社区卫生服务站 just
    // outside it) and both are within the 15-minute walk
    expect(by.get('社区卫生')).toMatchObject({
      found: 5,
      walk: 2,
      circle: 2,
      nearest: '临河社区卫生服务中心',
    });
    // one stop per name, both directions folded
    expect(by.get('公交')!.found).toBe(names('公交').length - 1);
    for (const s of stats) {
      expect(s.walk).toBeLessThanOrEqual(s.found);
      expect(s.nearest_s === null || s.nearest_s > 0).toBe(true);
    }
    // it goes out with the isochrone, before the coverage stage
    const reachPartial = main.events.find((e) => e.event === 'partial' && e.data.stats?.facility_stats);
    expect(reachPartial!.data.stats.facility_stats).toEqual(stats);
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
    // centroid is the gate every walk starts from; label_xy the compound's own POI, for the map
    expect(byName.get('滨河花园')).toMatchObject({
      pts: [],
      centroid: [400, 470],
      label_xy: [360, 470],
      gate: 'navi',
    });
    expect(byName.get('临河小区')).toMatchObject({
      pts: [],
      centroid: [-200, 250],
      label_xy: [-250, 250],
      gate: 'gate_poi',
    });
    for (const c of r.communities) {
      expect(c.pts).toEqual([]);
      expect(c.label_xy).toHaveLength(2);
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
        expect(s.label).toMatch(/步行路线约 \d+ m 处/);
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
      place: 12,
      directionlite_walking: 6,
      routematrix_walking: 1030,
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
      'livelihood',
      'residential',
      'fresh',
      'detail',
      'paths',
      'seed',
      'refine',
      'coverage',
      'siting',
      'catchment',
    ]);
    // browser POIs' details only when the input has some
    expect(plan.steps.find((s) => s.step === 'detail')).toMatchObject({ expected: 0, max: 0 });
    const withBrowser = planQuota({
      ...INPUT,
      browser_pois: [{ uid: 'a'.repeat(24), name: '某超市', keyword: '超市', bd09: INPUT.center_bd09 }],
    });
    expect(withBrowser.max.place).toBe(17);
    expect(withBrowser.steps.find((s) => s.step === 'detail')).toMatchObject({
      stage: 'facilities',
      service: 'place',
      expected: 2,
      max: 5,
    });
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
        expect(k.status_main, `${c.name} ${cat}`).toBe(truth(fused.result, c.centroid, cat, 1000));
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
    for (const s of ['directionlite_walking', 'reverse_geocoding'] as const) {
      expect(fused.client.billed[s]).toBe(base.client.billed[s]);
    }
    // the market the list adds closes the last 菜市场 gap: the 买菜替代 search is not needed any more
    expect(fused.result.stats.fresh_alternatives).toMatchObject({ gaps: 0 });
    expect(fused.client.billed.place).toBeLessThanOrEqual(base.client.billed.place!);
    expect(fused.client.billed.routematrix_walking).toBeLessThanOrEqual(1030);
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
    // a network failure of the optional 生鲜超市 query (the 4th place call, after the union's three
    // pages) leaves the five checked categories intact
    const net = new BaiduUpstreamError('网络错误：请求超时（10000 ms）', {
      service: 'place',
      kind: 'network',
    });
    const b = await run(INPUT, { onCall: (c) => (c.service === 'place' && c.n === 4 ? net : undefined) });
    expect((b.result.meta as LiveMeta).warnings.join('\n')).toMatch(/生鲜超市检索失败/);
    expect(b.result.stats.facility_counts).toMatchObject({
      幼儿园: 7,
      小学: 5,
      菜市场: 4,
      药店: 10,
      社区卫生: 5,
      生鲜超市: 0,
    });
    expect(b.result.communities).toHaveLength(30);
    // so does a failed 民生设施 union (the 5th place call): the checks and their routes are unchanged
    const c = await run(INPUT, { onCall: (x) => (x.service === 'place' && x.n === 5 ? net : undefined) });
    const meta = c.result.meta as LiveMeta;
    expect(meta.warnings.join('\n')).toMatch(/养老、地铁、公园、超市、公交检索失败/);
    expect(meta.notes.join('\n')).toMatch(
      /本次没有检索养老、地铁、公园、超市、公交.*只含逐小区检查的幼儿园、小学、菜市场、药店、社区卫生与生鲜超市/,
    );
    expect(c.result.pois.some((p) => p.cat === '公交' || p.cat === '养老')).toBe(false);
    // 社区卫生 is checked, from the facility union: the 民生设施 union failing costs it nothing
    expect(c.result.stats.facility_counts).toMatchObject({ 社区卫生: 5 });
    expect(c.result.stats.facility_stats!.map((s) => s.category)).toEqual([
      '小学',
      '幼儿园',
      '菜市场',
      '生鲜超市',
      '超市',
      '药店',
      '社区卫生',
    ]);
    expect(c.result.communities).toEqual(a.result.communities);
  });

  it('skips the 民生设施 union up front when the place quota only fits the checks', async () => {
    // personal soft limit 90 %: 9 of 10 pages — the 8 pages without the 买菜替代 search and the union
    // still fit (6 for the five checked categories, 2 for the compounds)
    const ledger = new QuotaLedger({ tier: 'personal', limits: { place: 10 } });
    const r = await run(INPUT, { ledger });
    const meta = r.result.meta as LiveMeta;
    expect(meta.warnings.join('\n')).toMatch(
      /地点检索今日配额接近上限：本次不检索养老、地铁、公园、超市、公交，圈内设施统计只含逐小区检查的幼儿园、小学、菜市场、药店、社区卫生与生鲜超市/,
    );
    const byStep = r.result.stats.quota_by_step as Record<string, number>;
    expect(byStep.livelihood).toBe(0);
    expect(byStep.fresh).toBe(0);
    expect(r.client.billed.place).toBeLessThanOrEqual(8);
    expect(r.result.communities).toHaveLength(30);
    expect(r.result.communities.every((c) => Object.keys(c.checks).length === 5)).toBe(true);
    expect(ledger.usage('place').reserved).toBe(0);
    // a quota too short for the checks themselves still refuses the run
    const tight = new QuotaLedger({ tier: 'personal', limits: { place: 8 } });
    await expect(run(INPUT, { ledger: tight })).rejects.toMatchObject({ code: 'quota_exhausted' });
  });
});

describe('profiles and clients', () => {
  it('elder profile: one canonical adult-speed result, refined for the elder boundary, no extra reach calls', async () => {
    const e = await run({ ...INPUT, profile: 'elder' });
    expect(e.result.meta).toMatchObject({ profile: 'elder', profile_speed_mps: 0.9, walk_speed_mps: 1.17 });
    const reach = e.events.find((x) => x.event === 'stage' && x.data.stage === 'reach')!;
    const coverage = e.events.find((x) => x.event === 'stage' && x.data.stage === 'coverage')!;
    expect(coverage.calls).toBe(reach.calls);
    // stored in routematrix (adult) seconds: clients scale by 1.17 / 0.9 for the elder view
    expect(e.result.baseline.circle_r15_m).toBe(1053);
    expect(e.client.billed.routematrix_walking).toBeLessThanOrEqual(1030);
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

  it('runs without a ledger: quota events count this run against its caps', async () => {
    const r = await run(INPUT, { ledger: null });
    expect(r.client.calls.every((c) => c.opts.budget === undefined)).toBe(true);
    const last = r.events
      .filter((e) => e.event === 'quota' && e.data.service === 'routematrix_walking')
      .pop()!;
    expect(last.data).toEqual({
      service: 'routematrix_walking',
      used: r.client.billed.routematrix_walking,
      limit: 1030,
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

describe('curated exclusions by name pattern', () => {
  let task: Awaited<ReturnType<typeof run>>;
  beforeAll(async () => {
    task = await run();
  });

  it('drops delivery warehouses by name pattern: never a facility, never a 买菜替代', async () => {
    const pattern = '^叮咚';
    const x = await run(
      INPUT,
      {},
      {},
      {
        exclusions: [
          {
            category: ['生鲜超市', '超市', '菜市场'],
            name_pattern: pattern,
            reason: '测试：前置仓，线上下单、配送到家',
            source: 'https://www.linhe.example.gov.cn/y.html',
            date: '2026-09-28',
          },
        ],
      },
    );
    const r = x.result;
    expect(r.pois.some((p) => p.name.startsWith('叮咚'))).toBe(false);
    expect(r.stats.excluded).toEqual([
      expect.objectContaining({ uid: 'f2', name: '叮咚生鲜超市', category: '生鲜超市', pattern }),
    ]);
    expect((r.stats.facility_counts as Record<string, number>)['生鲜超市']).toBe(
      (task.result.stats.facility_counts as Record<string, number>)['生鲜超市']! - 1,
    );
    expect((r.meta as LiveMeta).notes.join('\n')).toMatch(/排除清单.*叮咚生鲜超市（生鲜超市：测试：前置仓/);
    let verified = 0;
    for (const c of r.communities) {
      // the warehouse the 买菜替代 search finds again stays excluded there too
      expect(c.checks['菜市场'].alt?.name).not.toBe('叮咚生鲜超市');
      for (const cat of HARD_CATEGORIES) {
        const k = c.checks[cat];
        expect(k.via).not.toBe('叮咚生鲜超市');
        if (!k.verified) continue;
        verified++;
        expect(k.status_main, `${c.name} ${cat}`).toBe(truth(r, c.centroid, cat, 1000));
      }
    }
    expect(verified).toBeGreaterThan(140);
  });
});

describe('对口小学, exclusions and school / health lists in a live run', () => {
  // a second campus of 临河第一小学 north of the river bend
  const campusCity = new City([
    ...cityPois(),
    { uid: 's1n', name: '临河第一小学(北校区)', tag: '教育培训;小学', xy: [-310, 690], navi: [-300, 700] },
  ]);
  const table: CatchmentList = {
    id: 'linhe-catchment-2026',
    kind: 'catchment',
    title: '2026年临河区公办小学招生地段公示',
    publisher: '测试市临河区教育局',
    published: '2026-04-01',
    url: 'https://www.linhe.example.gov.cn/catchment.html',
    region: { city: '测试市', district: '临河区' },
    coverage: { towns: ['滨河街道'] },
    schools: [
      {
        school: '临河第一小学',
        entries: [
          { lane: '河西路1弄', compound: '滨河花园' },
          { lane: '河西路3弄', compound: '临河小区' },
          { lane: '河西路5弄', compound: '枫林苑一期' },
        ],
      },
      { school: '河东实验小学', entries: [{ lane: '东岸路2弄', compound: '东岸新村' }] },
      { school: '南苑小学', entries: [{ lane: '南街8弄', compound: '枫林苑二期' }] },
      { school: '北城小学', entries: [{ lane: '北街9弄', compound: '桂花园' }] },
      {
        school: '已撤并小学',
        entries: [
          { lane: '西街1弄', compound: '梧桐里' },
          { lane: '旧村', note: '已动迁' },
        ],
      },
    ],
  };
  let r: AnalysisResult;
  let client: FakeClient;
  beforeAll(async () => {
    client = new FakeClient({ city: campusCity });
    r = await analyze(INPUT, { client, now: NOW, catchment: [table] }, () => {});
  });
  const byName = (name: string) => r.communities.find((c) => c.name === name)!;

  it('assigns matched compounds their school, routed to its gate, the nearer campus when the table names none', () => {
    const binhe = byName('滨河花园').catchment!;
    const gate = byName('滨河花园').centroid;
    const west = Math.round(campusCity.walk(gate, [-700, 330]));
    const north = Math.round(campusCity.walk(gate, [-300, 700]));
    expect(north).toBeLessThan(west);
    expect(binhe).toMatchObject({
      school: '临河第一小学（北校区）',
      school_uid: 's1n',
      route_m: north,
      source: 'linhe-catchment-2026',
      matched_by: 'name:滨河花园',
    });
    expect(binhe.note).toBe(
      `对口表未写校区，找到 2 个校区，取步行较近的一个（另：临河第一小学 步行 ${west} 米）`,
    );
    expect(byName('东岸新村').catchment).toMatchObject({
      school: '河东实验小学',
      route_m: Math.round(campusCity.walk(byName('东岸新村').centroid, [700, 330])),
    });
    // the school is nowhere in the inventory: matched, but no walk
    expect(byName('梧桐里').catchment).toMatchObject({ school: '已撤并小学', route_m: null, straight_m: -1 });
    // two rows, two schools: no guess
    expect(byName('枫林苑').catchment).toBeUndefined();
    const stats = r.stats.catchment as CatchmentStats;
    expect(stats).toMatchObject({
      list: 'linhe-catchment-2026',
      communities: 30,
      matched: 5,
      ambiguous: ['枫林苑'],
    });
    expect(stats.unmatched).toHaveLength(24);
    expect(stats.routed).toBe(4);
    expect(stats.school_not_found).toBe(1);
    // routes the coverage check measured are reused; the rest come from the catchment budget line
    const byStep = r.stats.quota_by_step as Record<string, number>;
    expect(byStep.catchment).toBe(stats.new_routes);
    expect(stats.new_routes).toBeGreaterThan(0);
    expect(stats.new_routes).toBeLessThan(2 * stats.matched);
    const note = (r.meta as LiveMeta).notes.find((n) => n.startsWith('对口小学'))!;
    expect(note).toContain(
      '30 个小区中 5 个按官方地段表匹配到对口学校（小区名 5），25 个未匹配（其中 1 个的同名条目对口不同学校，未判定）',
    );
  });

  it('skips the table outside its district, and runs dry without budget', async () => {
    const other = await analyze(
      INPUT,
      {
        client: new FakeClient({ city: campusCity }),
        now: NOW,
        catchment: [{ ...table, region: { city: '测试市', district: '别的区' } }],
      },
      () => {},
    );
    expect(other.communities.every((c) => c.catchment === undefined)).toBe(true);
    expect((other.meta as LiveMeta).notes.join('\n')).toMatch(/不做对口匹配/);
    const dry = await analyze(
      INPUT,
      { client: new FakeClient({ city: campusCity }), now: NOW, catchment: [table] },
      () => {},
      { budget: { catchment: 0 } },
    );
    expect((dry.stats.quota_by_step as Record<string, number>).catchment).toBe(0);
    const ck = dry.communities.find((c) => c.name === '滨河花园')!.catchment!;
    // the nearer campus was never routed: straight lines only, and the note says why
    expect(ck.note).toMatch(/预算已用完/);
  });

  it('applies curated exclusions after cleaning and fusion, and says so', async () => {
    const x = await run(
      INPUT,
      {},
      {},
      {
        exclusions: [
          {
            category: '小学',
            uid: 's3',
            name: '南苑小学',
            reason: '测试：已停办',
            source: 'https://www.linhe.example.gov.cn/x.html',
            date: '2026-09-28',
          },
        ],
      },
    );
    const res = x.result;
    expect(res.pois.some((p) => p.name === '南苑小学')).toBe(false);
    expect(res.stats.excluded).toEqual([
      expect.objectContaining({ uid: 's3', name: '南苑小学', category: '小学', reason: '测试：已停办' }),
    ]);
    expect(res.stats.facility_counts).toMatchObject({ 小学: 4 });
    expect((res.meta as LiveMeta).notes.join('\n')).toMatch(
      /排除清单.*南苑小学（小学：测试：已停办，2026-09-28 核实）/,
    );
    for (const c of res.communities) {
      for (const cat of HARD_CATEGORIES) {
        expect(c.checks[cat].via).not.toBe('南苑小学');
        if (c.checks[cat].verified) expect(c.checks[cat].status_main).toBe(truth(res, c.centroid, cat, 1000));
      }
    }
  });

  it('checks all five categories with the school and health lists fused in the main pass, 社区卫生 at the facility radius', async () => {
    const ll = (xy: XY) => city.toLngLat(xy).map((v) => Number(v.toFixed(6))) as LngLat;
    const door = { precise: true, confidence: 80, level: '门址' };
    const base = {
      publisher: '测试市临河区教育局',
      published: '2026-04-01',
      url: 'https://www.linhe.example.gov.cn/l.html',
      region: { city: '测试市', district: '临河区' },
    };
    const schools: OfficialList = {
      ...base,
      id: 'linhe-schools-2026',
      category: '小学',
      title: '2026年临河区小学招生信息公示',
      entries: [
        { name: '北城小学', address: '北街1号', status: 'active', bd09: ll([-540, 1230]), geocode: door },
        {
          name: '河西新村小学',
          address: '河西路99号',
          status: 'active',
          bd09: ll([-200, 610]),
          geocode: door,
        },
      ],
    };
    const health: OfficialList = {
      ...base,
      publisher: '测试市临河区卫生健康委员会',
      id: 'linhe-health',
      category: '社区卫生',
      title: '临河区社区卫生服务中心信息',
      entries: [
        {
          name: '临河社区卫生服务中心',
          address: '河西路10号',
          status: 'active',
          bd09: ll([-410, -90]),
          geocode: door,
        },
        // a centre Baidu's search never returns, 1.14 km out: beyond the 民生设施 radius (where the
        // list used to be fused), within the 2.1 km facility radius of the checked categories
        {
          name: '东岸社区卫生服务中心',
          address: '东岸路300号',
          status: 'active',
          bd09: ll([700, -900]),
          geocode: door,
        },
      ],
    };
    const [plain, f] = await Promise.all([run(), run(INPUT, {}, {}, { official: [schools, health] })]);
    const res = f.result;
    const poi = (name: string) => res.pois.find((p) => p.name === name);
    expect(poi('北城小学')).toMatchObject({
      source: 'baidu',
      official: { list: 'linhe-schools-2026', name: '北城小学' },
    });
    expect(poi('河西新村小学')).toMatchObject({
      source: 'gov',
      cat: '小学',
      uid: 'gov:linhe-schools-2026:1',
    });
    // the added school is a candidate of the checks, and the verdicts still follow the street graph
    expect(res.communities.some((c) => c.checks['小学'].via === '河西新村小学')).toBe(true);
    for (const c of res.communities) {
      expect(Object.keys(c.checks), c.name).toEqual([...HARD_CATEGORIES]);
      for (const cat of HARD_CATEGORIES) {
        expect(c.checks[cat].verified, `${c.name} ${cat}`).toBe(true);
        expect(c.checks[cat].status_main, `${c.name} ${cat}`).toBe(truth(res, c.centroid, cat, 1000));
      }
    }
    // the health list confirms Baidu's centre and adds the one Baidu misses, with the checked categories
    expect(poi('临河社区卫生服务中心')).toMatchObject({
      source: 'baidu',
      cat: '社区卫生',
      official: { list: 'linhe-health' },
    });
    const added = poi('东岸社区卫生服务中心')!;
    expect(added).toMatchObject({ source: 'gov', cat: '社区卫生', uid: 'gov:linhe-health:1' });
    expect(added.straight_m).toBeGreaterThan(LIVELIHOOD_RADIUS_M);
    expect(added.straight_m).toBeLessThan(DEMAND_RADIUS_M + FACILITY_BUFFER_M);
    expect(res.stats.official).toEqual([
      expect.objectContaining({ list: 'linhe-schools-2026', category: '小学', confirmed: 1, added: 1 }),
      expect.objectContaining({
        list: 'linhe-health',
        category: '社区卫生',
        in_range: 2,
        confirmed: 1,
        added: 1,
      }),
    ]);
    // …and closes the 社区卫生 gaps east of the bridge, like the street graph walks them
    const check = (r: AnalysisResult, name: string) =>
      r.communities.find((c) => c.name === name)!.checks['社区卫生'];
    expect(check(plain.result, '银河小区')).toMatchObject({ status_main: '盲区', verified: true });
    expect(check(res, '银河小区')).toMatchObject({
      status_main: '覆盖',
      verified: true,
      via: '东岸社区卫生服务中心',
    });
    expect(check(plain.result, '丁香小区').status_main).toBe('伪覆盖');
    expect(check(res, '丁香小区')).toMatchObject({ status_main: '覆盖', via: '东岸社区卫生服务中心' });
    const gaps = (r: AnalysisResult) =>
      (r.stats.community_status_counts as { by_category: Record<string, { 伪覆盖: number; 盲区: number }> })
        .by_category['社区卫生']!;
    expect(gaps(res).伪覆盖 + gaps(res).盲区).toBeLessThan(
      gaps(plain.result).伪覆盖 + gaps(plain.result).盲区,
    );
    expect(res.stats.facility_stats!.find((s) => s.category === '社区卫生')!.found).toBe(6);
    expect((res.meta as LiveMeta).notes.join('\n')).toMatch(
      /社区卫生名录（测试市临河区卫生健康委员会《临河区社区卫生服务中心信息》）：范围内 2 家，与百度 POI 一致 1 家/,
    );
  });
});

describe('browser POIs: what place search omits, detailed and cleaned like search rows', () => {
  const hex = (n: number) => n.toString(16).padStart(24, 'b');
  const HIDDEN = [
    // Baidu has them, place search never returns them (as 盒马鲜生(陆悦天地店) around 万科翡翠公园)
    {
      uid: hex(1),
      name: '鲜果多生鲜超市(东岸店)',
      tag: '购物;超市;生鲜超市',
      xy: [620, 600],
      navi: [600, 600],
    },
    { uid: hex(2), name: '惠康大药房(东岸店)', tag: '医疗;药店', xy: [700, 500] },
    // a produce chain Baidu files under 美食: no facility, but a 买菜替代 for 东岸新村
    { uid: hex(3), name: '清美生鲜(东岸店)', tag: '美食', xy: [520, 690] },
    // what the browser lists under 生鲜 but sells no vegetables
    { uid: hex(4), name: '生鲜火锅(东岸店)', tag: '美食;火锅店', xy: [540, 640] },
    { uid: hex(5), name: '百果园(东岸店)', tag: '购物;水果店', xy: [505, 655] },
    // beyond the facility radius
    { uid: hex(6), name: '远郊超市', tag: '购物;超市', xy: [2500, 0] },
  ].map((p) => ({ ...p, xy: p.xy as XY, navi: p.navi as XY | undefined, hidden: true }));
  // one the searches do return
  const SEARCHED = { uid: hex(7), name: '河西便民药房', tag: '医疗;药店', xy: [-100, 100] as XY };
  const bcity = new City([...cityPois(), ...HIDDEN, SEARCHED]);
  const keyword = (tag: string) => (tag.includes('药') ? '药店' : tag.includes('超市') ? '超市' : '生鲜');
  const BROWSER = [
    ...[...HIDDEN, SEARCHED].map((p) => ({
      uid: p.uid,
      name: p.name,
      keyword: keyword(p.tag),
      bd09: bcity.toLngLat(p.xy),
    })),
    // invalid items are dropped, not fatal
    { uid: 'not-a-uid', name: '坏数据', keyword: '超市', bd09: bcity.toLngLat([0, 0]) },
    { uid: hex(8), name: '境外', keyword: '超市', bd09: [0, 0] as LngLat },
  ];
  const WITH = { ...INPUT, browser_pois: BROWSER };
  let r: Awaited<ReturnType<typeof run>>;
  beforeAll(async () => {
    r = await run(WITH, { city: bcity });
  });

  it('details the new ones within the radius in one request and counts what the tags make facilities', () => {
    const res = r.result;
    expect(res.stats.browser_pois).toEqual({
      offered: 7,
      new: 5,
      detailed: 5,
      kept: 2,
      budget_limited: false,
    });
    expect((res.stats.quota_by_step as Record<string, number>).detail).toBe(1);
    const byName = new Map(res.pois.map((p) => [p.name, p]));
    expect(byName.get('鲜果多生鲜超市(东岸店)')).toMatchObject({
      cat: '生鲜超市',
      found_by: 'jsapi',
      uid: hex(1),
    });
    expect(byName.get('惠康大药房(东岸店)')).toMatchObject({ cat: '药店', found_by: 'jsapi' });
    // found by the search as well: no provenance mark
    expect(byName.get('河西便民药房')).toBeDefined();
    expect(byName.get('河西便民药房')!.found_by).toBeUndefined();
    for (const name of ['清美生鲜(东岸店)', '生鲜火锅(东岸店)', '百果园(东岸店)', '远郊超市']) {
      expect(byName.has(name), name).toBe(false);
    }
    expect(res.pois.filter((p) => p.found_by === 'jsapi')).toHaveLength(2);
    const notes = (res.meta as LiveMeta).notes.join('\n');
    expect(notes).toMatch(/地图前端补充：浏览器地图检索（JSAPI）列出 7 处设施，其中 5 处.*计入 2 处/);
    expect(
      r.events.some(
        (e) =>
          e.event === 'stage' &&
          /地图前端找到 5 处服务端检索没有返回的设施，查询其中 5 处/.test(e.data.message),
      ),
    ).toBe(true);
  });

  it('feeds the detail rows to the 买菜替代 pool: a produce chain tagged 美食 stands in, a fruit shop does not', () => {
    const dongan = r.result.communities.find((c) => c.name === '东岸新村')!;
    const k = dongan.checks['菜市场'];
    expect(k.status_main).not.toBe('覆盖');
    expect(k.alt).toMatchObject({ name: '清美生鲜(东岸店)', kind: '生鲜超市' });
  });

  it('gives way without budget: nothing detailed, a warning, the run goes on', async () => {
    const x = await run(WITH, { city: bcity }, { budget: { detailCalls: 0 } });
    expect(x.result.stats.browser_pois).toEqual({
      offered: 7,
      new: 5,
      detailed: 0,
      kept: 0,
      budget_limited: true,
    });
    expect((x.result.stats.quota_by_step as Record<string, number>).detail).toBe(0);
    expect(x.result.pois.some((p) => p.found_by)).toBe(false);
    expect((x.result.meta as LiveMeta).warnings.join('\n')).toMatch(/没有详情查询预算/);
  });

  it('is the first thing given up when the day’s place quota is short', async () => {
    // personal soft limit 90 %: 12 of 14 pages — the run fits without the 5 detail requests
    const ledger = new QuotaLedger({ tier: 'personal', limits: { place: 14 } });
    const x = await run(WITH, { city: bcity, ledger });
    const meta = x.result.meta as LiveMeta;
    expect(meta.warnings.join('\n')).toMatch(/本次不查询地图前端补充的设施详情/);
    expect(meta.warnings.join('\n')).not.toMatch(/本次不检索/);
    const byStep = x.result.stats.quota_by_step as Record<string, number>;
    expect(byStep.detail).toBe(0);
    expect(byStep.livelihood).toBeGreaterThan(0);
    expect(x.result.stats.browser_pois).toMatchObject({ new: 5, detailed: 0, budget_limited: true });
    expect(ledger.usage('place').reserved).toBe(0);
  });

  it('spends nothing and adds no stats without browser POIs', async () => {
    const x = await run(INPUT, { city: bcity });
    expect(x.result.stats.browser_pois).toBeUndefined();
    expect((x.result.stats.quota_by_step as Record<string, number>).detail).toBe(0);
    expect(x.result.pois.some((p) => p.name === '惠康大药房(东岸店)')).toBe(false);
  });
});
