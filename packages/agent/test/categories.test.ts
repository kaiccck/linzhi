/**
 * The categories an analysis was checked for drive every tool and answer. The samples in data/samples
 * check 幼儿园、小学、菜市场、药店、社区卫生 per community on the same 1 km rule (zj-a: one gap outside
 * the task's three, 虹御公寓's 社区卫生; zj-b: 幼儿园 and 社区卫生 gaps of both kinds). An analysis made
 * before the two were added checked the task's 小学、菜市场、药店 only: zjAThree() (helpers.ts) is zj-a
 * as such an analysis.
 */
import { HARD_CATEGORIES, TASK_CATEGORIES } from '@zoudedao/core';
import { describe, expect, it } from 'vitest';
import { createAdvisor } from '../src/advisor.js';
import { AnalysisStore, LocalBackend } from '../src/backend.js';
import type { Fact } from '../src/format.js';
import type { FeatureCollection } from '../src/geo.js';
import { checkGrounding, entityNames } from '../src/grounding.js';
import { parseIntent } from '../src/intent.js';
import { buildReportModel } from '../src/report.js';
import { siteSuggestionsOf } from '../src/siting.js';
import type { CompareData } from '../src/tools/compare.js';
import type { GapsData } from '../src/tools/gaps.js';
import { createToolRegistry } from '../src/tools/registry.js';
import type { ReportData } from '../src/tools/report.js';
import type { SimulateData } from '../src/tools/simulate.js';
import { ToolError, type ToolContext } from '../src/tools/types.js';
import type { Overview } from '../src/summary.js';
import { ADDED_CATEGORIES, SAMPLES_DIR, localCtx, threeCtx, zjAThree } from './helpers.js';

const reg = createToolRegistry();
const FIVE = [...HARD_CATEGORIES];
const THREE = [...TASK_CATEGORIES];
const ADDED: readonly string[] = ADDED_CATEGORIES;

/** Runs a tool and checks that its summary asserts only numbers listed in its facts. */
async function run(name: string, args: Record<string, unknown>, ctx: ToolContext) {
  const r = await reg.run(name, args, ctx);
  const g = checkGrounding(r.summary, [{ id: 'T1', facts: r.facts, names: entityNames(r.data) }], {
    citations: false,
  });
  expect([name, g.unsupported]).toEqual([name, []]);
  expect(reg.get(name)!.outputSchema!.safeParse(JSON.parse(JSON.stringify(r.data))).error).toBeUndefined();
  return r;
}

/** The part of a Markdown report from a heading to the next heading of the same or a higher level. */
const section = (md: string, heading: string) => {
  const from = md.indexOf(heading);
  expect(from).toBeGreaterThanOrEqual(0);
  const level = /^#+/.exec(heading)![0].length;
  const next = new RegExp(`\\n#{1,${level}} `).exec(md.slice(from + heading.length));
  return md.slice(from, next ? from + heading.length + next.index : undefined);
};

const backend = () => new LocalBackend({ samplesDir: SAMPLES_DIR });

/** An advisor over the samples whose zj-a is the older, three-category copy. */
const olderAdvisor = () => {
  const store = new AnalysisStore();
  store.put(zjAThree(), { id: 'zj-a', source: 'sample' });
  return createAdvisor({ backend: backend(), store });
};

describe('five checked categories (the samples as stored)', () => {
  it('analyze_life_circle counts all five checked categories, in display order', async () => {
    const ctx = localCtx();
    const r = await run('analyze_life_circle', { sample_id: 'zj-a' }, ctx);
    const o = r.data as Overview;
    // the stored checks list 幼儿园 and 社区卫生 last: every output follows the display order
    expect(o.checked_categories).toEqual(FIVE);
    expect(Object.keys(o.by_category)).toEqual(FIVE);
    expect(Object.keys(o.within_15min)).toEqual(FIVE);
    expect(Object.keys(o.headline.rule_m)).toEqual(FIVE);
    expect(o.headline).toMatchObject({ communities: 12, categories: 5, checks: 60, walking_gaps: 9 });
    expect(o.by_category.幼儿园).toMatchObject({ 覆盖: 12, 伪覆盖: 0, 盲区: 0, 临界: 0, 待核实: 0 });
    expect(o.by_category.社区卫生).toMatchObject({ 覆盖: 11, 伪覆盖: 1, 盲区: 0, 临界: 0, 待核实: 0 });
    expect(r.summary).toContain(
      '各类设施（按小区计，已核实）——幼儿园：覆盖 12、伪覆盖 0、盲区 0；小学：覆盖 6、伪覆盖 5、盲区 1；',
    );
    expect(r.summary).toContain('；社区卫生：覆盖 11、伪覆盖 1、盲区 0。');
    expect(r.facts).toContainEqual({ label: '社区卫生伪覆盖数（已核实）', value: 1, unit: '个' });

    const e = await run('analyze_life_circle', { sample_id: 'zj-a', profile: 'elder' }, ctx);
    expect(Object.keys((e.data as Overview).within_15min)).toEqual(FIVE);
    expect(e.summary).toContain(
      '15 分钟内能走到的小区：幼儿园 12 个、小学 5 个、菜市场 7 个、药店 12 个、社区卫生 9 个。',
    );
  });

  it('list_service_gaps lists the gaps of every checked category and filters by the new ones', async () => {
    const ctx = localCtx();
    const all = await run('list_service_gaps', { analysis_id: 'zj-a' }, ctx);
    const d = all.data as GapsData;
    expect(d.checked_categories).toEqual(FIVE);
    expect(Object.keys(d.rule_m)).toEqual(FIVE);
    expect(d.counts).toMatchObject({ checks: 60, gaps: 9, pseudo: 8, blind: 1, borderline: 0 });
    expect(new Set(d.gaps.map((g) => g.category))).toEqual(new Set(['小学', '菜市场', '社区卫生']));
    expect(d.communities_with_gaps).toHaveLength(8);
    expect(d.communities_with_gaps.find((c) => c.community === '虹御公寓')!.missing).toEqual(['社区卫生']);
    expect(all.summary).toContain('5 类设施，判定距离 步行 ≤ 1,000 m');
    const hongyu = d.by_community.find((c) => c.community === '虹御公寓')!;
    expect(Object.keys(hongyu.status)).toEqual(FIVE);
    expect(hongyu.status).toMatchObject({ 幼儿园: '覆盖', 药店: '覆盖', 社区卫生: '伪覆盖' });

    const clinic = (await run('list_service_gaps', { analysis_id: 'zj-a', category: '社区卫生' }, ctx))
      .data as GapsData;
    expect(clinic.counts).toMatchObject({ checks: 12, gaps: 1, pseudo: 1, blind: 0 });
    expect(clinic.gaps.map((g) => [g.community, g.straight_m, g.route_m])).toEqual([
      ['虹御公寓', 874.3, 1083],
    ]);
    // checked and clean is "no gaps" — unlike a category the analysis never checked (below)
    const kinder = await run('list_service_gaps', { analysis_id: 'zj-a', category: '幼儿园' }, ctx);
    expect((kinder.data as GapsData).counts).toMatchObject({ checks: 12, gaps: 0 });
    expect(kinder.summary).toContain('幼儿园，判定距离 步行 ≤ 1,000 m：12 个小区中，没有已核实的缺口');
    const yulan = (await run('list_service_gaps', { analysis_id: 'zj-b', category: '幼儿园' }, ctx))
      .data as GapsData;
    expect(yulan.counts).toMatchObject({ checks: 28, gaps: 4, pseudo: 4, blind: 0, borderline: 1 });
    expect(yulan.gaps.map((g) => [g.community, g.borderline])).toEqual([
      ['创新公寓', false],
      ['东窑新村', false],
      ['华陇小区', false],
      ['日月光集团-员工生活区', true],
    ]);

    const one = await run('list_service_gaps', { analysis_id: 'zj-a', community: '虹御公寓' }, ctx);
    expect(one.summary).toContain('幼儿园能走到：浦东新区浦电幼儿园，步行 396 m');
    expect(one.summary).toContain(
      '社区卫生步行 1,000 m 内走不到（伪覆盖）：最近能走到的是上海市浦东新区孙桥社区卫生服务中心川杨新苑社区卫生服务站，直线 874.3 m、步行 1,083 m',
    );
    const elder = await run('list_service_gaps', { analysis_id: 'zj-a~elder', category: '社区卫生' }, ctx);
    expect((elder.data as GapsData).within_15min.社区卫生).toEqual({
      limit_m: 810,
      within: 9,
      undetermined: 0,
      total: 12,
    });
  });

  it('simulate_facility takes the new categories, each with its measure word', async () => {
    const ctx = localCtx();
    const clinic = await run(
      'simulate_facility',
      { analysis_id: 'zj-a', category: '社区卫生', near_community: '虹御公寓' },
      ctx,
    );
    const d = clinic.data as SimulateData;
    expect(clinic.summary.startsWith('估算（未经实测核验）')).toBe(true);
    expect(clinic.summary).toContain('新增 1 处社区卫生服务站');
    expect(d.counts).toMatchObject({ newly_covered: 1, still_gap: 0 });
    expect(d.rows.find((r) => r.community === '虹御公寓')).toMatchObject({
      current: '未达标',
      change: 'newly_covered',
    });
    expect(clinic.facts).toContainEqual({ label: '新增设施数', value: 1, unit: '处' });
    const kinder = await run(
      'simulate_facility',
      { analysis_id: 'zj-b', category: '幼儿园', near_community: '创新公寓' },
      ctx,
    );
    expect(kinder.summary).toContain('新增 1 所幼儿园');
    expect((kinder.data as SimulateData).counts).toMatchObject({ newly_covered: 3, still_gap: 1 });
    // a checked category without gaps: nothing to fix, said as such
    const none = await run(
      'simulate_facility',
      { analysis_id: 'zj-a', category: '幼儿园', near_community: '虹御公寓' },
      ctx,
    );
    expect(none.summary).toContain('当前没有已核实的幼儿园缺口');
  });

  it('the report and the GeoJSON carry all five, the task’s three named as such', async () => {
    const ctx = localCtx();
    const md = ((await run('export_report', { analysis_id: 'zj-a' }, ctx)).data as ReportData)
      .content as string;
    expect(md.split('\n')[2]).toContain(
      '有 8 个步行 1 km 内缺少至少一类必需设施（幼儿园、小学、菜市场、药店或社区卫生）',
    );
    const checks = section(md, '## 二、');
    expect(checks.startsWith('## 二、12 个小区 × 5 类必需设施')).toBe(true);
    const rows = FIVE.map((c) => checks.indexOf(`| ${c} | 1,000 m |`));
    expect(rows.every((i) => i > 0)).toBe(true);
    expect(rows).toEqual([...rows].sort((a, b) => a - b));
    expect(checks).toContain('| 虹御公寓 | 社区卫生 | 伪覆盖 |');
    expect(md).toContain(
      '逐类检查幼儿园、小学、菜市场、药店、社区卫生（其中小学、菜市场、药店是赛题要求，幼儿园、社区卫生按同一判定距离一并检查）',
    );
    const siting = section(md, '## 四、规划建议');
    // checked without gaps: none needed is a finding here
    expect(siting).toContain('- **幼儿园**：没有已核实的缺口，暂不需要新增。');
    expect(siting).toContain('- **社区卫生**（已核实缺口小区：虹御公寓）');
    expect(siting).toContain('- **药店**：没有已核实的缺口，暂不需要新增。');
    const model = buildReportModel(await ctx.backend.getAnalysis('zj-b'), 'zj-b');
    expect(model.siting.map((s) => s.category)).toEqual(FIVE);
    // zj-b stores suggestions for the task's three only: the added ones are estimated, never "none"
    expect(Object.fromEntries(model.siting.map((s) => [s.category, s.source]))).toMatchObject({
      幼儿园: 'estimated',
      小学: 'analysis',
      菜市场: 'analysis',
      社区卫生: 'estimated',
    });

    const fc = (
      (await run('export_report', { analysis_id: 'zj-a', format: 'geojson' }, ctx)).data as ReportData
    ).content as FeatureCollection;
    const hongyu = fc.features.find(
      (f) => f.properties.kind === 'community' && f.properties.name === '虹御公寓',
    )!;
    expect(hongyu.properties).toMatchObject({
      幼儿园_status: '覆盖',
      社区卫生_status: '伪覆盖',
      missing: '社区卫生',
      missing_count: 1,
    });
    const sites = fc.features.filter((f) => f.properties.kind === 'site_suggestion');
    expect(new Set(sites.map((f) => f.properties.category))).toEqual(new Set(['小学', '菜市场', '社区卫生']));
    const colour = (cat: string) =>
      new Set(
        fc.features
          .filter((f) => f.properties.kind === 'poi' && f.properties.category === cat)
          .map((f) => f.properties['marker-color']),
      );
    expect(colour('幼儿园')).toEqual(new Set(['#0B7A3E']));
    expect(colour('社区卫生')).toEqual(new Set(['#0B7A3E']));
    expect(colour('超市')).toEqual(new Set(['#9A9A9A']));
  });

  it('compare_sites compares gap totals only over the categories every analysis checked', async () => {
    const ctx = localCtx();
    ctx.store.put(zjAThree(), { id: 'zj-a3', source: 'sample' });
    const r = await run('compare_sites', { analysis_ids: ['zj-b', 'zj-a3'] }, ctx);
    const d = r.data as CompareData;
    expect(d.common_categories).toEqual(THREE);
    const [five, three] = d.rows;
    expect(five).toMatchObject({ checked_categories: FIVE, walking_gaps: 44, common_gaps: 19 });
    expect(Object.keys(five!.gaps_by_category)).toEqual(FIVE);
    expect(five!.gaps_by_category).toMatchObject({ 幼儿园: 4, 社区卫生: 21 });
    expect(three).toMatchObject({ checked_categories: THREE, walking_gaps: 8, common_gaps: 8 });
    expect(Object.keys(three!.gaps_by_category)).toEqual(THREE);
    expect(r.summary).toContain('逐小区检查幼儿园、小学、菜市场、药店、社区卫生，步行已核实缺口 44 个');
    expect(r.summary).toContain(
      '各分析逐小区检查的设施类别不同，已核实缺口总数不能直接比较——只看共同检查的小学、菜市场、药店：玉兰香苑片区 19 个、申城佳苑片区 8 个，最多的是 玉兰香苑片区。',
    );
    expect(r.summary).not.toContain('已核实步行缺口最多的是');
    // the same categories on both sides: totals compare as before
    const same = await run('compare_sites', { analysis_ids: ['zj-a', 'zj-a~elder'] }, ctx);
    expect((same.data as CompareData).common_categories).toEqual(FIVE);
    expect(same.summary).toContain('各分析的已核实步行缺口数相同（都是 9 个）');
  });

  it('the advisor reads 看病 and kindergarten questions as checks of their own', async () => {
    const intent = (q: string) => parseIntent(q, [], FIVE);
    expect(intent('老人看病方便吗')).toMatchObject({
      kind: 'gaps',
      categories: ['社区卫生'],
      profile: 'elder',
    });
    expect(intent('去社区医院看医生远不远').categories).toEqual(['社区卫生']);
    expect(intent('附近有卫生服务中心吗').kind).toBe('gaps');
    expect(intent('买药配药方便吗').categories).toEqual(['药店']);
    // 孩子 alone means school; with a kindergarten word it means the kindergarten
    expect(intent('孩子上学方便吗').categories).toEqual(['小学']);
    expect(intent('孩子上幼儿园方便吗').categories).toEqual(['幼儿园']);
    expect(intent('小孩去托班远不远').categories).toEqual(['幼儿园']);
    expect(intent('孩子上幼儿园和小学都方便吗').categories).toEqual(['幼儿园', '小学']);
    expect(intent('如果在孙环路口新建一个社区卫生服务站呢')).toMatchObject({
      kind: 'simulate',
      categories: ['社区卫生'],
    });
    expect(intent('圈里有几所幼儿园').kind).toBe('facilities');
    expect(parseIntent('附近有幼儿园和超市吗').facilityCategories).toEqual(['幼儿园', '超市']);

    const advisor = createAdvisor({ backend: backend() });
    const ill = await advisor.ask('申城佳苑的老人看病方便吗？');
    expect(ill.citations.map((c) => [c.tool, c.args])).toEqual([
      ['analyze_life_circle', { analysis_id: 'zj-a', profile: 'elder' }],
      ['list_service_gaps', { analysis_id: 'zj-a~elder', category: '社区卫生' }],
    ]);
    expect(ill.answer.split('\n')[0]).toBe(
      '结论：不太方便：申城佳苑片区 12 个小区中，有 1 个步行 1,000 m 内走不到社区卫生（伪覆盖 1、盲区 0）[T2]。',
    );
    const kinder = await advisor.ask('申城佳苑三期B块的孩子上幼儿园方便吗');
    expect(kinder.citations.map((c) => [c.tool, c.args])).toEqual([
      ['list_service_gaps', { analysis_id: 'zj-a', category: '幼儿园', community: '申城佳苑三期B块' }],
    ]);
    expect(kinder.answer).toContain(
      '结论：方便：申城佳苑三期B块的幼儿园能走到：东方德尚幼儿园孙环部，步行 234 m',
    );
    const site = await advisor.ask('如果在虹御公寓旁边新建一个社区卫生服务站呢？');
    expect(site.citations[0]!.args).toMatchObject({ category: '社区卫生', near_community: '虹御公寓' });
    expect(site.answer).toMatch(/^估算（未经实测核验）：.*新增 1 处社区卫生服务站/);
    for (const a of [ill, kinder, site]) expect(a.grounding).toMatchObject({ ok: true, uncited: [] });
  });
});

describe('an older three-category analysis (zj-a without its 幼儿园 and 社区卫生 checks)', () => {
  it('never lists 幼儿园 or 社区卫生 as checked, as gaps or as needing nothing new', async () => {
    const ctx = threeCtx();
    const overview = await run('analyze_life_circle', { sample_id: 'zj-a' }, ctx);
    const o = overview.data as Overview;
    expect(overview.summary).toContain('各类设施（按小区计，已核实）——小学：');
    // 覆盖、伪覆盖、盲区 of each checked category, and of no other
    const verdicts = (overview.facts as Fact[]).filter((f) => f.label.endsWith('数（已核实）'));
    expect(verdicts).toHaveLength(9);
    expect(verdicts.every((f) => THREE.some((c) => f.label.startsWith(c)))).toBe(true);
    expect(o.checked_categories).toEqual(THREE);
    expect(Object.keys(o.by_category)).toEqual(THREE);
    expect(Object.keys(o.within_15min)).toEqual(THREE);
    expect(Object.keys(o.headline.rule_m)).toEqual(THREE);
    const gaps = await run('list_service_gaps', { analysis_id: 'zj-a' }, ctx);
    const d = gaps.data as GapsData;
    expect(d.checked_categories).toEqual(THREE);
    expect(Object.keys(d.rule_m)).toEqual(THREE);
    expect(gaps.summary).toContain('3 类设施');
    for (const row of d.by_community) expect(Object.keys(row.status)).toEqual(THREE);

    const md = ((await run('export_report', { analysis_id: 'zj-a' }, ctx)).data as ReportData)
      .content as string;
    expect(md.split('\n')[2]).toContain('缺少至少一类必需设施（小学、菜市场或药店）');
    expect(md).toContain('逐类检查小学、菜市场、药店（均为赛题要求）');
    for (const heading of ['## 二、', '## 四、规划建议']) {
      for (const cat of ADDED) expect(section(md, heading)).not.toContain(cat);
    }
    expect(section(md, '## 二、')).toContain('12 个小区 × 3 类必需设施');
    // the 圈内设施统计 still counts them from the centre: that is not a per-community check
    expect(section(md, '### 圈内设施')).toContain('| 社区卫生 |');
    expect(buildReportModel(zjAThree(), 'zj-a').siting.map((s) => s.category)).toEqual(THREE);
    expect(Object.keys(siteSuggestionsOf(zjAThree())).sort()).toEqual([...THREE].sort());

    const fc = (
      (await run('export_report', { analysis_id: 'zj-a', format: 'geojson' }, ctx)).data as ReportData
    ).content as FeatureCollection;
    for (const f of fc.features) {
      if (f.properties.kind === 'community') {
        expect(Object.keys(f.properties).filter((k) => ADDED.some((c) => k.startsWith(c)))).toEqual([]);
      }
      if (f.properties.kind === 'site_suggestion') expect(THREE).toContain(f.properties.category);
      if (f.properties.kind === 'poi' && ADDED.includes(String(f.properties.category))) {
        expect(f.properties['marker-color']).toBe('#9A9A9A');
      }
    }
  });

  it('says a category was not checked instead of reporting no gaps', async () => {
    const ctx = threeCtx();
    for (const args of [{ category: '幼儿园' }, { category: '社区卫生', community: '虹御公寓' }]) {
      const err = await reg
        .run('list_service_gaps', { analysis_id: 'zj-a', ...args }, ctx)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe('not_checked');
      expect((err as Error).message).toContain(
        `申城佳苑片区（analysis_id: zj-a）没有逐小区检查${args.category}：这份分析只逐小区检查了小学、菜市场、药店`,
      );
      expect((err as Error).message).not.toMatch(/没有已核实|没有缺口/);
    }
    const sim = await reg
      .run(
        'simulate_facility',
        { analysis_id: 'zj-a', category: '社区卫生', near_community: '虹御公寓' },
        ctx,
      )
      .catch((e: unknown) => e);
    expect((sim as ToolError).code).toBe('not_checked');
    expect((sim as Error).message).toContain('无法估算新增社区卫生服务站能补上哪些缺口');

    const advisor = olderAdvisor();
    const kinder = await advisor.ask('申城佳苑有几个小区走不到幼儿园？');
    expect(kinder.citations.map((c) => [c.tool, c.args])).toEqual([
      ['analyze_life_circle', { analysis_id: 'zj-a' }],
    ]);
    expect(kinder.answer.split('\n')[0]).toBe(
      '结论：申城佳苑片区没有逐小区检查幼儿园：这份分析只逐小区检查了小学、菜市场、药店，说不出哪些小区步行 1 km 内走不到幼儿园 [T1]。',
    );
    expect(kinder.answer).toContain(
      '- 圈内设施统计（从分析中心出发）——申城佳苑片区：15 分钟步行能走到幼儿园 ',
    );
    expect(kinder.answer).not.toMatch(/比较方便|没有已核实/);
    const what = await advisor.ask('如果在孙环路口开一家幼儿园呢？');
    expect(what.citations).toEqual([]);
    expect(what.answer.startsWith('结论：没法估算新增幼儿园的效果——申城佳苑片区没有逐小区检查幼儿园')).toBe(
      true,
    );
    const mixed = await advisor.ask('申城佳苑有几个小区走不到幼儿园和药店？');
    expect(mixed.citations.map((c) => c.args)).toEqual([{ analysis_id: 'zj-a', category: '药店' }]);
    expect(mixed.answer).toContain(
      '申城佳苑片区没有逐小区检查幼儿园：这份分析只逐小区检查了小学、菜市场、药店，以上不含幼儿园。',
    );
    // 看病 on an analysis without 社区卫生 checks: the 圈内设施统计, said to be from the centre
    const ill = await advisor.ask('申城佳苑的老人看病方便吗？');
    expect(ill.citations.map((c) => c.tool)).toEqual(['analyze_life_circle']);
    expect(ill.answer).toContain('15 分钟步行能走到社区卫生');
    expect(ill.answer).toContain('不是逐小区的判定');
    for (const a of [kinder, what, mixed, ill]) {
      expect(a.grounding).toMatchObject({ ok: true, unsupported: [], uncited: [] });
    }
  });
});
