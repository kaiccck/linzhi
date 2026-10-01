import { bd09ToWgs84, buildIsochrone, facilityStats, localFrame, type AnalysisResult } from '@zoudedao/core';
import { describe, expect, it } from 'vitest';
import { deriveProfile, frameOf } from '../src/analysis.js';
import { AnalysisStore } from '../src/backend.js';
import type { FeatureCollection, Position } from '../src/geo.js';
import { checkGrounding, entityNames } from '../src/grounding.js';
import type { GapsData } from '../src/tools/gaps.js';
import { TOOL_NAMES, createToolRegistry, toOpenAITools } from '../src/tools/registry.js';
import type { ReportData } from '../src/tools/report.js';
import type { SimulateData } from '../src/tools/simulate.js';
import { ToolError, type ToolContext } from '../src/tools/types.js';
import type { Overview } from '../src/summary.js';
import type { AnalyzeEvent, AnalyzeInput } from '../src/types.js';
import { SHANGHAI, localCtx, pendingCtx, sphericalRingArea, zjA } from './helpers.js';

const reg = createToolRegistry();
const fact = (facts: { label: string; value: number }[], label: string) =>
  facts.find((f) => f.label === label)?.value;

describe('registry', () => {
  it('exposes the seven tools of 技术设计文档 §8.2 in order, with Chinese titles and descriptions', () => {
    expect(TOOL_NAMES).toEqual([
      'locate_place',
      'analyze_life_circle',
      'get_isochrone',
      'list_service_gaps',
      'simulate_facility',
      'compare_sites',
      'export_report',
    ]);
    for (const t of reg.tools) {
      expect(t.title).toMatch(/[一-鿿]/);
      expect(t.description.length).toBeGreaterThan(60);
      expect(t.description).toMatch(/[一-鿿]/);
    }
  });

  it('exports OpenAI function tools with plain JSON Schema parameters', () => {
    const tools = toOpenAITools();
    expect(tools).toHaveLength(7);
    for (const t of tools) {
      expect(t.type).toBe('function');
      expect(t.function.parameters.type).toBe('object');
      expect(t.function.parameters).not.toHaveProperty('$schema');
    }
    const iso = tools.find((t) => t.function.name === 'get_isochrone')!.function.parameters as {
      required: string[];
      properties: Record<string, { enum?: unknown[] }>;
    };
    expect(iso.required).toEqual(['analysis_id']);
    expect(iso.properties.crs!.enum).toEqual(['wgs84', 'gcj02', 'bd09']);
  });

  it('rejects bad arguments with Chinese messages', async () => {
    const err = await reg
      .run('get_isochrone', { analysis_id: '', crs: 'utm' }, localCtx())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).code).toBe('invalid_input');
    expect((err as Error).message).toMatch(/参数 analysis_id/);
    expect((err as Error).message).toMatch(/参数 crs/);
    await expect(reg.run('no_such_tool', {}, localCtx())).rejects.toThrow(/没有名为 no_such_tool 的工具/);
  });
});

describe('analyze_life_circle on zj-a', () => {
  it('reproduces the product claims: circle finds 1 gap, walking verifies 8, 87.5 % missed', async () => {
    const r = await reg.run('analyze_life_circle', { sample_id: 'zj-a' }, localCtx());
    const o = r.data as Overview & { status: string };
    expect(o.status).toBe('ok');
    expect(o.analysis_id).toBe('zj-a');
    expect(o.headline).toMatchObject({
      communities: 12,
      categories: 3,
      checks: 36,
      straight_gaps: 1,
      walking_gaps: 8,
      pseudo: 7,
      blind: 1,
      missed_by_circle: 7,
      missed_share_pct: 87.5,
      pending: 0,
    });
    expect(o.by_category.小学).toMatchObject({ 覆盖: 6, 伪覆盖: 5, 盲区: 1, 待核实: 0 });
    expect(o.by_category.菜市场).toMatchObject({ 覆盖: 10, 伪覆盖: 2, 盲区: 0, 临界: 1, 待核实: 0 });
    // every pharmacy walk was measured to the nearest pharmacy: none is left 待核实
    expect(o.by_category.药店).toMatchObject({ 覆盖: 12, 伪覆盖: 0, 盲区: 0, 待核实: 0 });
    expect(o.isochrone).toMatchObject({
      area_iso15_km2: 1.857,
      area_circle15_km2: 3.483,
      overstate_x: 1.88,
      reach_share_pct: 53.3,
      circle_r15_m: 1053,
    });
    expect(o.isochrone.reach15).toEqual({ median_m: 775, min_m: 466, max_m: 935, bearings: 72 });

    expect(r.summary).toContain(
      '画圆法（直线 1 km）只找到 1 个服务缺口，按实测步行距离已核实 8 个，画圆漏掉了其中 7 个（87.5%）',
    );
    expect(r.summary).not.toContain('待核实');
    const open = await reg.run('analyze_life_circle', { sample_id: 'zj-a' }, pendingCtx());
    expect((open.data as Overview).headline).toMatchObject({ walking_gaps: 8, pending: 2 });
    expect(open.summary).toContain('另有 2 项待核实');
    expect(r.summary).toContain('1.857 km²');
    expect(r.summary).toContain('1.88 倍');
    expect(r.summary).toContain('775 m');
    expect(fact(r.facts, '画圆漏掉的比例')).toBe(87.5);
    expect(fact(r.facts, '步行已核实缺口数')).toBe(8);
  });

  it('derives the elderly profile from the same routes: times scale, the 1 km verdicts do not', async () => {
    const ctx = localCtx();
    const r = await reg.run('analyze_life_circle', { sample_id: 'zj-a', profile: 'elder' }, ctx);
    const o = r.data as Overview;
    expect(o.analysis_id).toBe('zj-a~elder');
    expect(o.profile).toBe('elder');
    expect(o.speed_mps).toBe(0.9);
    expect(o.headline.walking_gaps).toBe(8);
    expect(o.isochrone.circle_r15_m).toBe(810);
    expect(o.isochrone.area_circle15_km2).toBe(2.061);
    // 15 elderly minutes = 900 · 0.9 / 1.17 ≈ 692 adult seconds: between the 10- and 15-minute areas
    expect(o.isochrone.area_iso15_km2).toBeGreaterThan(0.833);
    expect(o.isochrone.area_iso15_km2).toBeLessThan(1.857);
    expect(o.within_15min.菜市场).toMatchObject({ limit_m: 810, within: 7, total: 12 });
    expect(r.summary).toContain('0.9 m/s');
    // the derived result is cached and can be referenced by id
    expect(ctx.store.has('zj-a~elder')).toBe(true);
    const again = await reg.run('analyze_life_circle', { analysis_id: 'zj-a~elder' }, ctx);
    expect((again.data as Overview).isochrone.area_iso15_km2).toBe(o.isochrone.area_iso15_km2);
  });

  it('states the 圈内设施统计 and the 灰色区域 with their numbers', async () => {
    const r = await reg.run('analyze_life_circle', { sample_id: 'zj-a' }, localCtx());
    const o = r.data as Overview;
    const row = (cat: string) => o.facilities!.rows.find((x) => x.category === cat)!;
    // stored stats.facility_stats, in STAT_ORDER
    expect(o.facilities!.rows.map((x) => x.category)).toEqual(
      zjA().stats.facility_stats!.map((x) => x.category),
    );
    expect(row('药店')).toMatchObject({
      found: 11,
      circle: 9,
      walk: 8,
      nearest: '医保药店(高木桥路店)',
      nearest_min: 2.7,
    });
    expect(row('地铁')).toMatchObject({ found: 1, circle: 1, walk: 0 });
    // the 民生设施 union was cut short at the bus stops: counts are lower bounds there
    expect(row('公交')).toMatchObject({ complete: false, known_radius_m: 324 });
    expect(row('药店').complete).toBeNull();
    expect(o.facilities!.none_within_walk).toEqual(['小学', '地铁']);
    expect(o.facilities!.circle_r_m).toBe(1053);
    expect(o.gray_areas.map((g) => [g.kind, g.min_missing, g.polygons, g.area_km2])).toEqual([
      ['gap', 1, 1, 0.861],
      ['gap', 2, 1, 0.118],
      ['pseudo', 1, 1, 0.75],
    ]);
    expect(o.gray_areas[1]!.communities).toEqual(['川杨新苑四期']);
    expect(r.summary).toContain('圈内设施（15 分钟步行可达 / 直线 15 分钟圆内）：小学 0 / 1，');
    expect(r.summary).toContain('药店 8 / 9');
    expect(r.summary).toContain('公交 5 / 5（清单不全，至少）');
    expect(r.summary).toContain('15 分钟内一处也走不到：小学、地铁。');
    expect(r.summary).toContain('药店 2.7 分钟');
    expect(r.summary).toContain('缺至少 2 类必需设施 0.118 km²（1 处）');
    expect(fact(r.facts, '15 分钟步行可达的药店数')).toBe(8);
    expect(fact(r.facts, '灰色区域（缺至少1类）面积')).toBe(0.861);

    // the elder profile counts at 0.9 m/s over the same field, like the web (scale 1.17 / 0.9)
    const e = (await reg.run('analyze_life_circle', { sample_id: 'zj-a', profile: 'elder' }, localCtx()))
      .data as Overview;
    const elder = facilityStats(zjA(), { scale: 1.17 / 0.9 });
    expect(e.facilities!.rows.map((x) => [x.category, x.walk, x.circle])).toEqual(
      elder.map((x) => [x.category, x.walk, x.circle]),
    );
    expect(e.facilities!.circle_r_m).toBe(810);
    expect(e.facilities!.rows.find((x) => x.category === '药店')!.walk).toBeLessThan(row('药店').walk);
    // verdicts are distances: the 灰色区域 do not change with the profile
    expect(e.gray_areas).toEqual(o.gray_areas);
  });

  it('agrees with core rebuilding the isochrone from the raw samples at 0.9 m/s', async () => {
    const derived = deriveProfile(zjA(), 'elder');
    const rebuilt = buildIsochrone(zjA().samples, { speed: 0.9, loo: false });
    for (const level of ['300', '600', '900'] as const) {
      const a = derived.stats.areas_km2[level];
      const b = rebuilt.stats.areas_km2[level];
      expect(Math.abs(a.iso / b.iso - 1)).toBeLessThan(0.01);
      expect(a.circle).toBe(b.circle);
    }
    expect(derived.stats.overstate_x).toBe(rebuilt.stats.overstate_x);
    // the adult result is untouched and the elder one says what it is
    expect(zjA().stats.area_iso15_km2).toBe(1.857);
    expect(derived.stats.facility_stats).toEqual(facilityStats(zjA(), { scale: 1.17 / 0.9 }));
    expect(zjA().stats.facility_stats).toEqual(facilityStats(zjA()));
    expect(derived.meta).toMatchObject({ profile: 'elder', profile_speed_mps: 0.9, walk_speed_mps: 1.17 });
  });

  it('needs exactly one of sample_id, analysis_id, center_bd09, place', async () => {
    await expect(reg.run('analyze_life_circle', {}, localCtx())).rejects.toThrow(
      /只能提供一个.*zj-a（申城佳苑片区）/,
    );
    await expect(
      reg.run('analyze_life_circle', { sample_id: 'zj-a', place: '申城佳苑' }, localCtx()),
    ).rejects.toThrow(/只能提供一个/);
    await expect(reg.run('analyze_life_circle', { sample_id: 'nope' }, localCtx())).rejects.toThrow(
      /找不到分析 nope/,
    );
  });

  it('reuses a sample centred on the requested point instead of spending quota', async () => {
    const r = await reg.run('analyze_life_circle', { center_bd09: [121.6442, 31.19008] }, localCtx());
    expect((r.data as Overview).analysis_id).toBe('zj-a');
    expect(r.summary).toContain('不消耗地图配额');
  });

  it('explains that sample-only data cannot analyse a new point', async () => {
    await expect(reg.run('analyze_life_circle', { center_bd09: [121.5, 31.2] }, localCtx())).rejects.toThrow(
      /不能分析新地点.*ZDD_API_URL/,
    );
  });

  it('resolves a place name to the sample, and reports unknown places without guessing', async () => {
    const r = await reg.run('analyze_life_circle', { place: '申城佳苑' }, localCtx());
    expect((r.data as Overview).analysis_id).toBe('zj-a');
    const miss = await reg.run('analyze_life_circle', { place: '陆家嘴' }, localCtx());
    expect(miss.data).toMatchObject({ status: 'not_found' });
    expect(miss.summary).toContain('没有找到“陆家嘴”');
  });

  it('runs a live analysis through the backend and stores it under a live- id', async () => {
    const base = localCtx();
    const events: AnalyzeEvent[] = [];
    const moved: AnalysisResult = {
      ...zjA(),
      meta: {
        ...zjA().meta,
        name: '测试片区',
        center_bd09: [121.61, 31.2],
        generated: '2026-09-27T01:00:00.000Z',
      },
    };
    const inputs: AnalyzeInput[] = [];
    const ctx: ToolContext = {
      store: new AnalysisStore(),
      onProgress: (e) => events.push(e),
      backend: {
        kind: 'fake',
        listSamples: () => base.backend.listSamples(),
        getAnalysis: (id) => base.backend.getAnalysis(id),
        async analyze(input, onEvent) {
          inputs.push(input);
          onEvent?.({ type: 'stage', stage: 'seed', message: '粗采样', progress: 0.2 });
          return moved;
        },
      },
    };
    const r = await reg.run('analyze_life_circle', { center_bd09: [121.61, 31.2], label: '测试点' }, ctx);
    const o = r.data as Overview;
    expect(o.analysis_id).toMatch(/^live-[0-9a-f]{8}$/);
    expect(o.source).toBe('live');
    expect(inputs).toEqual([{ center_bd09: [121.61, 31.2], label: '测试点', profile: 'adult' }]);
    expect(events).toHaveLength(1);
    const iso = await reg.run('get_isochrone', { analysis_id: o.analysis_id }, ctx);
    expect((iso.data as FeatureCollection).features.length).toBeGreaterThan(3);
  });
});

describe('get_isochrone', () => {
  const fc = async (args: Record<string, unknown> = {}) =>
    (await reg.run('get_isochrone', { analysis_id: 'zj-a', ...args }, localCtx())).data as FeatureCollection;

  it('returns closed WGS84 rings inside Shanghai with the right-hand rule', async () => {
    const data = await fc();
    expect(data.type).toBe('FeatureCollection');
    expect(data.coordinate_system).toBe('wgs84');
    const kinds = data.features.map((f) => `${f.properties.kind}${f.properties.minutes ?? ''}`);
    expect(kinds).toEqual(['isochrone15', 'isochrone10', 'isochrone5', 'baseline_circle15', 'center']);
    for (const f of data.features) {
      const polys: Position[][][] =
        f.geometry.type === 'MultiPolygon'
          ? f.geometry.coordinates
          : f.geometry.type === 'Polygon'
            ? [f.geometry.coordinates]
            : [[[f.geometry.coordinates]]];
      for (const poly of polys) {
        poly.forEach((ring, k) => {
          for (const [lng, lat] of ring) {
            expect(lng).toBeGreaterThan(SHANGHAI.minLng);
            expect(lng).toBeLessThan(SHANGHAI.maxLng);
            expect(lat).toBeGreaterThan(SHANGHAI.minLat);
            expect(lat).toBeLessThan(SHANGHAI.maxLat);
          }
          if (f.geometry.type === 'Point') return;
          expect(ring.length).toBeGreaterThanOrEqual(4);
          expect(ring[0]).toEqual(ring[ring.length - 1]);
          // exterior counter-clockwise, holes clockwise (RFC 7946 §3.1.6)
          expect(Math.sign(sphericalRingArea(ring))).toBe(k === 0 ? 1 : -1);
        });
      }
    }
  });

  it('keeps the 15-minute area within 2 % of stats.area_iso15_km2, holes subtracted', async () => {
    const data = await fc();
    const areaOf = (minutes: number) => {
      const f = data.features.find(
        (x) => x.properties.kind === 'isochrone' && x.properties.minutes === minutes,
      )!;
      if (f.geometry.type !== 'MultiPolygon') throw new Error('expected MultiPolygon');
      return f.geometry.coordinates.flat().reduce((s, ring) => s + sphericalRingArea(ring), 0) / 1e6;
    };
    const stats = zjA().stats;
    expect(Math.abs(areaOf(15) / stats.area_iso15_km2 - 1)).toBeLessThan(0.02);
    expect(Math.abs(areaOf(10) / stats.areas_km2['600'].iso - 1)).toBeLessThan(0.02);
    expect(Math.abs(areaOf(5) / stats.areas_km2['300'].iso - 1)).toBeLessThan(0.02);
    const f15 = data.features[0]!;
    expect(f15.properties).toMatchObject({ area_km2: 1.857, holes: 1 });
    const circle = data.features.find((f) => f.properties.kind === 'baseline_circle')!;
    if (circle.geometry.type !== 'Polygon') throw new Error('expected Polygon');
    const circleKm2 = sphericalRingArea(circle.geometry.coordinates[0]!) / 1e6;
    expect(Math.abs(circleKm2 / stats.area_circle15_km2 - 1)).toBeLessThan(0.02);
  });

  it('inverts the local frame exactly: the centre point lands on meta.center_bd09', async () => {
    const meta = zjA().meta;
    const frame = frameOf(meta);
    const ref = localFrame(meta.center_bd09[0], meta.center_bd09[1]);
    expect(frame.kx).toBeCloseTo(ref.kx, 9);
    expect(frame.ky).toBeCloseTo(ref.ky, 9);
    const bd = await fc({ crs: 'bd09', levels: [15] });
    const center = bd.features.find((f) => f.properties.kind === 'center')!;
    expect(center.geometry.coordinates).toEqual(meta.center_bd09);
    const wgs = await fc({ levels: [15] });
    const c2 = wgs.features.find((f) => f.properties.kind === 'center')!;
    const expected = bd09ToWgs84(meta.center_bd09[0], meta.center_bd09[1]);
    expect(c2.geometry.coordinates[0]).toBeCloseTo(expected[0], 6);
    expect(c2.geometry.coordinates[1]).toBeCloseTo(expected[1], 6);
    // one contour vertex, by hand: local XY → BD-09 by the formula in meta.frame_formula
    const [x, y] = zjA().contours['900'][0]![0]!;
    const f15 = bd.features[0]!;
    if (f15.geometry.type !== 'MultiPolygon') throw new Error('expected MultiPolygon');
    const [lng, lat] = f15.geometry.coordinates[0]![0]![0]!;
    expect(lng).toBeCloseTo(121.644195 + x / (111320 * Math.cos((31.19007 * Math.PI) / 180)), 6);
    expect(lat).toBeCloseTo(31.19007 + y / 110574, 6);
  });

  it('honours levels, simplification and the circle switch', async () => {
    const full = await fc({ levels: [15] });
    const light = await fc({ levels: [15], simplify: 20, include_circle: false });
    expect(light.features.map((f) => f.properties.kind)).toEqual(['isochrone', 'center']);
    const count = (d: FeatureCollection) => JSON.stringify(d.features[0]!.geometry).length;
    expect(count(light)).toBeLessThan(count(full) / 2);
  });

  it('summarises areas without geometry for the model', async () => {
    const r = await reg.run('get_isochrone', { analysis_id: 'zj-a' }, localCtx());
    expect(r.summary).toContain('15 分钟 1.857 km²（直线圆 3.483 km²）');
    const view = reg.get('get_isochrone')!.llmView!(r.data) as { features: { properties: object }[] };
    expect(JSON.stringify(view)).not.toContain('coordinates');
    expect(view.features[0]!.properties).toMatchObject({ minutes: 15, area_km2: 1.857 });
  });
});

describe('list_service_gaps', () => {
  it('lists the 8 verified gaps by walking distance and keeps pending checks apart', async () => {
    const r = await reg.run('list_service_gaps', { analysis_id: 'zj-a' }, localCtx());
    const d = r.data as GapsData;
    expect(d.counts).toMatchObject({ checks: 36, gaps: 8, pseudo: 7, blind: 1, borderline: 0, pending: 0 });
    expect(d.gaps[0]).toMatchObject({
      community: '申城佳苑三期B块',
      category: '小学',
      status: '伪覆盖',
      straight_m: 818.5,
      route_m: 1676,
    });
    expect(d.gaps[1]).toMatchObject({
      community: '申城佳苑三期A块',
      category: '小学',
      status: '盲区',
      route_m: 1652,
    });
    // 盲区: the nearest school is beyond the rule already in a straight line (the value moves as the
    // official school list is refreshed)
    expect(d.gaps[1]!.straight_m).toBeGreaterThan(1000);
    const routes = d.gaps.map((g) => g.route_m);
    expect(routes).toEqual([...routes].sort((a, b) => b - a));
    expect(d.gaps.some((g) => g.category === '药店')).toBe(false);
    expect(d.pending).toEqual([]);
    expect(d.communities_with_gaps).toHaveLength(7);
    expect(r.summary).toContain('已核实缺口 8 个（伪覆盖 7、盲区 1）');
    // a check with a nearer facility never routed is listed apart, never as a gap
    const open = await reg.run('list_service_gaps', { analysis_id: 'zj-a' }, pendingCtx());
    const p = open.data as GapsData;
    expect(p.counts).toMatchObject({ gaps: 8, pending: 2 });
    expect(p.pending.map((x) => `${x.community}/${x.category}`)).toEqual([
      '川杨新苑四期/药店',
      '虹御公寓/药店',
    ]);
    expect(p.pending[0]!.unrouted_nearer[0]).toEqual({ name: '益丰大药房(川杨店)', straight_m: 177.9 });
    expect(open.summary).toContain('待核实');
  });

  it('filters by category and status', async () => {
    const ctx = localCtx();
    const market = (await reg.run('list_service_gaps', { analysis_id: 'zj-a', category: '菜市场' }, ctx))
      .data as GapsData;
    expect(market.counts).toMatchObject({ checks: 12, gaps: 2, pseudo: 2, blind: 0 });
    // the only borderline verified check (虹御公寓 → 菜市场, 968 m) is walkable, so no gap is 临界
    const edge = (await reg.run('list_service_gaps', { analysis_id: 'zj-a', status: '临界' }, ctx))
      .data as GapsData;
    expect(edge.gaps).toEqual([]);
    const blind = (await reg.run('list_service_gaps', { analysis_id: 'zj-a', status: '盲区' }, ctx))
      .data as GapsData;
    expect(blind.gaps.map((g) => [g.community, g.category, g.route_m])).toEqual([
      ['申城佳苑三期A块', '小学', 1652],
    ]);
    const noPending = (
      await reg.run('list_service_gaps', { analysis_id: 'zj-a', include_pending: false }, ctx)
    ).data as GapsData;
    expect(noPending.pending).toEqual([]);
    const pharmacy = await reg.run('list_service_gaps', { analysis_id: 'zj-a', category: '药店' }, ctx);
    expect((pharmacy.data as GapsData).counts.gaps).toBe(0);
    expect(pharmacy.summary).toContain('没有已核实的缺口');
  });

  it('gives elderly 15-minute reach per category on the elder profile', async () => {
    const ctx = localCtx();
    const r = await reg.run('list_service_gaps', { analysis_id: 'zj-a~elder', category: '菜市场' }, ctx);
    const d = r.data as GapsData;
    expect(d.within_15min.菜市场).toEqual({ limit_m: 810, within: 7, undetermined: 0, total: 12 });
    expect(d.gaps[0]!.walk_min).toBe(23.7); // 1,281 m at 0.9 m/s
    expect(r.summary).toContain('15 分钟最多走 810 m');
  });

  it('lists every community with its verdict and walking minutes per category', async () => {
    const ctx = localCtx();
    const d = (await reg.run('list_service_gaps', { analysis_id: 'zj-a' }, ctx)).data as GapsData;
    expect(d.by_community).toHaveLength(12);
    expect(d.by_community.find((r) => r.community === '申城佳苑三期B块')).toEqual({
      community: '申城佳苑三期B块',
      status: { 小学: '伪覆盖', 菜市场: '覆盖', 药店: '覆盖' },
      walk_min: { 小学: 23.9, 菜市场: 7.7, 药店: 3.8 },
    });
    expect(d.by_community.find((r) => r.community === '虹御公寓')).toMatchObject({
      status: { 药店: '覆盖' },
      walk_min: { 药店: 11.4 }, // 797 m to 益丰大药房(孙桥路店)
    });
    // 待核实 carries no walk time: it is not measured yet
    const open = (await reg.run('list_service_gaps', { analysis_id: 'zj-a' }, pendingCtx())).data as GapsData;
    const pending = open.by_community.find((r) => r.community === '虹御公寓')!;
    expect(pending.status.药店).toBe('待核实');
    expect(pending.walk_min.药店).toBeNull();
    const elder = (await reg.run('list_service_gaps', { analysis_id: 'zj-a~elder', category: '菜市场' }, ctx))
      .data as GapsData;
    expect(elder.by_community.find((r) => r.community === '川杨新苑四期')).toEqual({
      community: '川杨新苑四期',
      status: { 菜市场: '伪覆盖' },
      walk_min: { 菜市场: 23.7 },
    });
  });

  it('carries the 买菜替代 of 菜市场 gaps as plain fields, never as coverage', async () => {
    const ctx = localCtx();
    const r = await reg.run('list_service_gaps', { analysis_id: 'zj-a', category: '菜市场' }, ctx);
    const d = r.data as GapsData;
    // still two gaps: a shop within the rule on foot counts for nothing
    expect(d.counts).toMatchObject({ gaps: 2, pseudo: 2, with_alt: 2 });
    expect(d.gaps.map((g) => [g.community, g.alt])).toEqual([
      [
        '川杨新苑四期',
        { name: '如海生鲜超市(中科路店)', kind: '生鲜超市', straight_m: 125.6, route_m: 122, walk_min: 1.7 },
      ],
      [
        '川杨新苑三期',
        { name: '如海生鲜超市(中科路店)', kind: '生鲜超市', straight_m: 336.7, route_m: 445, walk_min: 6.3 },
      ],
    ]);
    expect(r.summary).toContain('其中菜市场缺口 2 个在判定距离内步行能到能买菜的超市或果蔬店');
    const one = await reg.run(
      'list_service_gaps',
      { analysis_id: 'zj-a', community: '川杨新苑三期', category: '菜市场' },
      ctx,
    );
    expect(one.summary).toContain(
      '可在如海生鲜超市(中科路店)买菜（生鲜超市，步行 445 m，约 6.3 分钟；只作参考，不算覆盖）',
    );
    expect(one.facts).toContainEqual(expect.objectContaining({ value: 445, unit: 'm' }));
    // only 菜市场 rows carry it
    const all = (await reg.run('list_service_gaps', { analysis_id: 'zj-a' }, ctx)).data as GapsData;
    expect(all.gaps.filter((g) => g.alt !== undefined).map((g) => g.category)).toEqual(['菜市场', '菜市场']);
    // the elder profile times the same walk at 0.9 m/s
    const elder = (await reg.run('list_service_gaps', { analysis_id: 'zj-a~elder', category: '菜市场' }, ctx))
      .data as GapsData;
    expect(elder.gaps.find((g) => g.community === '川杨新苑三期')!.alt).toMatchObject({
      route_m: 445,
      walk_min: 8.2,
    });
  });

  it('keeps area-wide 15-minute counts out of a single community', async () => {
    const ctx = localCtx();
    for (const id of ['zj-a', 'zj-a~elder']) {
      const r = await reg.run(
        'list_service_gaps',
        { analysis_id: id, community: '申城佳苑三期B块', category: '小学' },
        ctx,
      );
      const d = r.data as GapsData;
      expect(d.within_15min).toEqual({});
      expect(r.summary).not.toContain('整个片区');
      expect(r.summary).toContain('申城佳苑三期B块');
    }
  });
});

describe('simulate_facility', () => {
  it('is always an estimate with L̂ per community', async () => {
    const r = await reg.run(
      'simulate_facility',
      { analysis_id: 'zj-a', category: '小学', near_community: '申城佳苑三期B块' },
      localCtx(),
    );
    const d = r.data as SimulateData;
    expect(d.estimate).toBe(true);
    expect(r.summary.startsWith('估算（未经实测核验）')).toBe(true);
    expect(r.summary).toContain('需要实测算路核验');
    expect(d.rows).toHaveLength(12);
    const byName = Object.fromEntries(d.rows.map((x) => [x.community, x]));
    expect(byName['申城佳苑三期B块']).toMatchObject({ current: '未达标', change: 'newly_covered' });
    expect(byName['申城佳苑二期B块']!.change).toBe('newly_covered');
    expect(d.counts.newly_covered).toBeGreaterThanOrEqual(4);
    for (const row of d.rows) {
      if (row.est_m !== null) expect(row.est_m).toBeGreaterThanOrEqual(Math.floor(row.straight_m));
      if (row.change === 'newly_covered') expect(row.est_m).toBeLessThanOrEqual(1000);
    }
  });

  it('never turns a pending check into a gap and says when it cannot help', async () => {
    const args = {
      analysis_id: 'zj-a',
      category: '药店',
      center_bd09: [121.644195, 31.19007],
      label: '孙环路口',
    };
    for (const [ctx, pending] of [
      [localCtx(), 0],
      [pendingCtx(), 2],
    ] as const) {
      const r = await reg.run('simulate_facility', args, ctx);
      const d = r.data as SimulateData;
      expect(d.site.center_bd09).toEqual([121.644195, 31.19007]);
      expect(d.counts.newly_covered + d.counts.still_gap).toBe(0);
      expect(d.counts.pending_covered + d.counts.pending_unresolved).toBe(pending);
      expect(r.summary).toContain('当前没有已核实的药店缺口');
      expect(r.summary).toContain('孙环路口');
    }
  });

  it('rejects unclear or far-away sites', async () => {
    const ctx = localCtx();
    await expect(
      reg.run('simulate_facility', { analysis_id: 'zj-a', category: '药店' }, ctx),
    ).rejects.toThrow(/只能提供一个/);
    await expect(
      reg.run(
        'simulate_facility',
        { analysis_id: 'zj-a', category: '药店', near_community: '不存在小区' },
        ctx,
      ),
    ).rejects.toThrow(/没有名为“不存在小区”的小区/);
    await expect(
      reg.run(
        'simulate_facility',
        { analysis_id: 'zj-a', category: '药店', center_bd09: [121.5, 31.1] },
        ctx,
      ),
    ).rejects.toThrow(/范围之外/);
  });
});

describe('compare_sites', () => {
  it('puts analyses side by side with unique labels and honest ties', async () => {
    const r = await reg.run('compare_sites', { analysis_ids: ['zj-a', 'zj-a~elder'] }, localCtx());
    const rows = (r.data as { rows: { label: string; walking_gaps: number; area_iso15_km2: number }[] }).rows;
    expect(rows.map((x) => x.label)).toEqual(['申城佳苑片区', '申城佳苑片区（老年人）']);
    expect(rows[0]!.walking_gaps).toBe(rows[1]!.walking_gaps);
    expect(r.summary).toContain('各分析的已核实步行缺口数相同（都是 8 个）');
    expect(r.summary).toContain('画圆高估最严重的是 申城佳苑片区（1.88 倍）');
    await expect(reg.run('compare_sites', { analysis_ids: ['zj-a', 'zj-a'] }, localCtx())).rejects.toThrow(
      /至少需要 2 个不同/,
    );
  });
});

describe('export_report', () => {
  it('renders a deterministic Chinese report, conclusion first', async () => {
    const a = await reg.run('export_report', { analysis_id: 'zj-a' }, localCtx());
    const b = await reg.run('export_report', { analysis_id: 'zj-a' }, localCtx());
    const md = (a.data as ReportData).content as string;
    expect(md).toBe((b.data as ReportData).content);
    expect((a.data as ReportData).filename).toBe('zoudedao-zj-a-report.md');
    const lines = md.split('\n');
    expect(lines[0]).toBe('# 申城佳苑片区 · 15 分钟生活圈体检报告');
    expect(lines[2]).toMatch(
      /^> \*\*结论：\*\* 申城佳苑片区的 12 个小区中，有 7 个步行 1 km 内缺少至少一类必需设施/,
    );
    expect(lines[2]).toContain(
      '画圆法只找到 1 个缺口，按实测步行距离已核实 8 个，画圆漏掉了其中 7 个（87.5%）。',
    );
    for (const heading of [
      '## 一、关键数字',
      '## 三、什么是“伪覆盖”',
      '## 四、规划建议',
      '## 五、方法、数据来源与局限',
      '### 局限',
    ]) {
      expect(md).toContain(heading);
    }
    expect(md).toContain('| 15 分钟步行可达面积 | 1.857 km² |');
    expect(md).toContain('| 画圆高估倍数 | 1.88 倍 |');
    expect(md).toContain(
      '例如：申城佳苑三期B块到孙桥小学(申江校区)（小学），直线只有 818.5 m，实际步行 1,676 m。',
    );
    expect(md).not.toMatch(/国标|GB 50180/);
    const gapTable = (report: string) => {
      const from = report.indexOf('### 服务缺口明细');
      return report.slice(from, report.indexOf('\n#', from + 1));
    };
    expect(gapTable(md)).not.toContain('| 药店 |');
    expect(md).not.toContain('### 待核实');
    // pending checks are listed apart and never in the gap table
    const open = await reg.run('export_report', { analysis_id: 'zj-a' }, pendingCtx());
    const pmd = (open.data as ReportData).content as string;
    expect(pmd.split('\n')[2]).toContain('（87.5%）；另有 2 项待核实');
    expect(gapTable(pmd)).not.toContain('| 药店 |');
    expect(pmd.slice(pmd.indexOf('### 待核实'))).toContain('| 虹御公寓 | 药店 | 1,124 m（上界）');
    // siting suggestions are labelled as estimates
    expect(md).toMatch(/\*\*小学\*\*.*_估算，未经实测核验_/);
    expect(md).toContain('不含红绿灯等待');
    expect(md).toContain('小区位置取 OpenStreetMap 小区地块的几何中心');
    // 圈内设施 and 灰色区域
    expect(md).toContain('### 圈内设施：15 分钟走得到几处');
    expect(md).toContain('| 药店 | 11 家 | 9 家 | 8 家 | 医保药店(高木桥路店)，2.7 分钟 |');
    expect(md).toContain('| 公交 | 至少 5 个（清单只到离中心 324 m） | 至少 5 个 | 至少 5 个 |');
    expect(md).toContain('15 分钟内一处也走不到：小学、地铁。');
    expect(md).toContain('### 灰色区域（设施匮乏的范围）');
    expect(md).toContain('| 缺至少 2 类 | 0.118 km² | 1 | 川杨新苑四期 |');
    expect(md).toContain('范围为小区轮廓及其外 120 m（轮廓外的位置取最近小区的判定，水面不计）。');
    // as many categories as the analysis lists (the inventory grows as official lists are fused in)
    const o = (await reg.run('analyze_life_circle', { sample_id: 'zj-a' }, localCtx())).data as Overview;
    expect(a.summary).toContain(`报告含圈内设施统计（${o.facilities!.rows.length} 类）与灰色区域（3 层）`);
  });

  it('exports GeoJSON with isochrones, communities, POIs and estimated site suggestions', async () => {
    const r = await reg.run('export_report', { analysis_id: 'zj-a', format: 'geojson' }, localCtx());
    const d = r.data as ReportData;
    expect(d.mime_type).toBe('application/geo+json');
    const fc = d.content as FeatureCollection;
    const count = (kind: string) => fc.features.filter((f) => f.properties.kind === kind).length;
    expect(count('isochrone')).toBe(3);
    expect(count('baseline_circle')).toBe(1);
    expect(count('community')).toBe(12);
    expect(count('community_outline')).toBe(12);
    expect(count('poi')).toBe(zjA().pois.length);
    expect(count('gray_area')).toBe(3);
    expect(count('site_suggestion')).toBeGreaterThan(0);
    for (const s of fc.features.filter((f) => f.properties.kind === 'site_suggestion')) {
      expect(s.properties).toMatchObject({ verified: false, estimate: true });
    }
    const hongyu = (collection: FeatureCollection) =>
      collection.features.find((f) => f.properties.kind === 'community' && f.properties.name === '虹御公寓')!;
    expect(hongyu(fc).properties).toMatchObject({ 药店_status: '覆盖', 药店_verified: true, missing: '' });
    const open = await reg.run('export_report', { analysis_id: 'zj-a', format: 'geojson' }, pendingCtx());
    expect(hongyu((open.data as ReportData).content as FeatureCollection).properties).toMatchObject({
      药店_status: '待核实',
      药店_verified: false,
      missing: '',
    });
    const siyi = fc.features.find(
      (f) => f.properties.kind === 'community' && f.properties.name === '川杨新苑四期',
    )!;
    expect(siyi.properties).toMatchObject({ status: '伪覆盖', missing: '小学、菜市场', missing_count: 2 });
    // facilities carry their walk from the centre, as the 圈内设施统计 counts them
    const pharmacy = fc.features.find((f) => f.properties.name === '医保药店(高木桥路店)')!;
    expect(pharmacy.properties).toMatchObject({ walk_min: 2.7, within_walk15: true, within_circle15: true });
    const pois = fc.features.filter((f) => f.properties.kind === 'poi' && !f.properties.stall_of);
    const walkable = (cat: string) =>
      pois.filter((f) => f.properties.category === cat && f.properties.within_walk15).length;
    expect(walkable('药店')).toBe(8);
    expect(fc.facility_stats!.find((x) => x.category === '药店')).toMatchObject({ walk: 8, circle: 9 });
    const two = fc.features.find((f) => f.properties.kind === 'gray_area' && f.properties.min_missing === 2)!;
    expect(two.properties).toMatchObject({
      gap_kind: 'gap',
      area_km2: 0.118,
      polygons: 1,
      communities: '川杨新苑四期',
    });
    expect(d.content).toBeDefined();
    expect(r.summary).toContain('圈内设施统计在 facility_stats 中');
  });

  it('exports the structured report model as JSON', async () => {
    type Model = { verdict: string; gaps: unknown[]; pending: unknown[] };
    const r = await reg.run('export_report', { analysis_id: 'zj-a', format: 'json' }, localCtx());
    const model = (r.data as ReportData).content as Model;
    expect(model.gaps).toHaveLength(8);
    expect(model.pending).toHaveLength(0);
    const open = await reg.run('export_report', { analysis_id: 'zj-a', format: 'json' }, pendingCtx());
    expect(((open.data as ReportData).content as Model).pending).toHaveLength(2);
  });
});

describe('every summary asserts only numbers listed in its facts; data matches the output schema', () => {
  const calls: [string, Record<string, unknown>][] = [
    ['locate_place', { query: '申城佳苑' }],
    ['analyze_life_circle', { sample_id: 'zj-a' }],
    ['analyze_life_circle', { sample_id: 'zj-a', profile: 'elder' }],
    ['get_isochrone', { analysis_id: 'zj-a', crs: 'gcj02' }],
    ['list_service_gaps', { analysis_id: 'zj-a' }],
    ['list_service_gaps', { analysis_id: 'zj-a~elder', category: '菜市场' }],
    ['simulate_facility', { analysis_id: 'zj-a', category: '药店', center_bd09: [121.644195, 31.19007] }],
    ['simulate_facility', { analysis_id: 'zj-a', category: '小学', near_community: '申城佳苑三期B块' }],
    ['compare_sites', { analysis_ids: ['zj-a', 'zj-a~elder'] }],
    ['export_report', { analysis_id: 'zj-a', format: 'geojson' }],
    ['export_report', { analysis_id: 'zj-a' }],
  ];
  it.each(calls)('%s %j', async (name, args) => {
    const r = await reg.run(name, args, localCtx());
    const g = checkGrounding(r.summary, [{ id: 'T1', facts: r.facts, names: entityNames(r.data) }], {
      citations: false,
    });
    expect(g.unsupported).toEqual([]);
    expect(g.checked).toBeGreaterThan(0);
    const schema = reg.get(name)!.outputSchema!;
    expect(schema.safeParse(JSON.parse(JSON.stringify(r.data))).error).toBeUndefined();
  });
});
