import type { HardCategory } from '@zoudedao/core';
import * as z from 'zod';
import { HARD_CATEGORIES, TASK_CATEGORIES } from '../analysis.js';
import { FactBook } from '../format.js';
import { overview, type Overview } from '../summary.js';
import { resolveAnalysis } from './context.js';
import { ToolError, defineTool } from './types.js';

export interface CompareRow {
  analysis_id: string;
  name: string;
  /** Unique display name (profile or id appended when names repeat). */
  label: string;
  profile: string;
  area_iso15_km2: number;
  area_circle15_km2: number;
  overstate_x: number;
  reach_share_pct: number;
  reach15_median_m: number | null;
  communities: number;
  straight_gaps: number;
  walking_gaps: number;
  missed_by_circle: number;
  missed_share_pct: number | null;
  pending: number;
  /** The categories this analysis checked per community (5 on new analyses, the task's 3 on older ones). */
  checked_categories: HardCategory[];
  /** Verified walking gaps per checked category (categories it did not check are absent, not 0). */
  gaps_by_category: Partial<Record<HardCategory, number>>;
  /** Verified walking gaps over the categories every compared analysis checked (common_categories). */
  common_gaps: number;
}

export interface CompareData {
  rows: CompareRow[];
  /**
   * Categories every compared analysis checked. When the analyses checked different ones, only gaps
   * over these compare (walking_gaps of a five-category check and a three-category check do not).
   */
  common_categories: HardCategory[];
}

export const compareSites = defineTool({
  name: 'compare_sites',
  title: '社区对比',
  description:
    '并排对比 2–4 个已完成的体检（不同社区，或同一社区的成人/老年人画像，如 zj-a 与 zj-a~elder）：15 分钟可达面积、画圆高估倍数、有效半径、' +
    '画圆法缺口数与步行核实缺口数、各类设施缺口数、待核实数，并指出高估最严重、缺口最多的一个。' +
    `各分析逐小区检查的类别（checked_categories）不同时（新的体检 ${HARD_CATEGORIES.length} 类，较早的 ${TASK_CATEGORIES.length} 类），缺口总数不能直接比较，只按共同检查的类别（common_categories、common_gaps）比较。` +
    '只读取已有结果，不会发起新的分析。',
  inputSchema: z.object({
    analysis_ids: z
      .array(z.string().trim().min(1).max(80))
      .min(2)
      .max(4)
      .describe('要对比的 analysis_id，2–4 个'),
  }),
  outputSchema: z.looseObject({
    rows: z.array(z.looseObject({ analysis_id: z.string(), label: z.string(), walking_gaps: z.number() })),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true },
  async run(args, ctx) {
    const ids = [...new Set(args.analysis_ids)];
    if (ids.length < 2) throw new ToolError('invalid_input', '至少需要 2 个不同的 analysis_id');
    const list = await Promise.all(ids.map((id) => resolveAnalysis(ctx, id)));
    const overviews = list.map(({ id, result }) => overview(result, id));
    const common = HARD_CATEGORIES.filter((c) => overviews.every((o) => o.checked_categories.includes(c)));
    const gapsOf = (o: Overview, c: HardCategory) => o.by_category[c].伪覆盖 + o.by_category[c].盲区;
    const rows: CompareRow[] = overviews.map((o) => ({
      analysis_id: o.analysis_id,
      name: o.name,
      label: o.profile === 'elder' ? `${o.name}（老年人）` : o.name,
      profile: o.profile,
      area_iso15_km2: o.isochrone.area_iso15_km2,
      area_circle15_km2: o.isochrone.area_circle15_km2,
      overstate_x: o.isochrone.overstate_x,
      reach_share_pct: o.isochrone.reach_share_pct,
      reach15_median_m: o.isochrone.reach15?.median_m ?? null,
      communities: o.headline.communities,
      straight_gaps: o.headline.straight_gaps,
      walking_gaps: o.headline.walking_gaps,
      missed_by_circle: o.headline.missed_by_circle,
      missed_share_pct: o.headline.missed_share_pct,
      pending: o.headline.pending,
      checked_categories: o.checked_categories,
      gaps_by_category: Object.fromEntries(o.checked_categories.map((c) => [c, gapsOf(o, c)])),
      common_gaps: common.reduce((n, c) => n + gapsOf(o, c), 0),
    }));
    // a five-category check and a three-category one: their gap totals count different things
    const mixed = rows.some((r) => r.checked_categories.length !== common.length);
    for (const r of rows) {
      if (rows.filter((x) => x.label === r.label).length > 1) r.label = `${r.label}［${r.analysis_id}］`;
    }

    const book = new FactBook();
    const lines = rows.map((r) => {
      const p = `${r.label} `;
      const area = book.add(`${p}15 分钟步行可达面积`, r.area_iso15_km2, 'km²', { digits: 3 });
      const x = book.add(`${p}画圆高估倍数`, r.overstate_x, '倍', { digits: 2 });
      const med =
        r.reach15_median_m !== null
          ? `、有效半径中位数 ${book.add(`${p}15 分钟有效半径中位数`, r.reach15_median_m, 'm', { digits: 1, trim: true })}`
          : '';
      const walking = book.add(`${p}步行已核实缺口数`, r.walking_gaps, '个');
      const straight = book.add(`${p}画圆法找到的缺口数`, r.straight_gaps, '个');
      const pending = r.pending ? `，待核实 ${book.add(`${p}待核实数`, r.pending, '项')}` : '';
      // with different category sets, each total says what it counts
      const scope = mixed ? `逐小区检查${r.checked_categories.join('、')}，` : '';
      return `${r.label}：15 分钟可达 ${area}、画圆高估 ${x}${med}；${scope}步行已核实缺口 ${walking}（画圆法只找到 ${straight}）${pending}`;
    });
    const top = (key: 'overstate_x' | 'walking_gaps' | 'common_gaps') => {
      const max = Math.max(...rows.map((r) => r[key]));
      return { max, rows: rows.filter((r) => r[key] === max) };
    };
    const over = top('overstate_x');
    const xText = book.add('最大画圆高估倍数', over.max, '倍', { digits: 2 });
    let tail =
      over.rows.length === rows.length
        ? `各分析的画圆高估倍数相同（${xText}）`
        : `画圆高估最严重的是 ${over.rows.map((r) => r.label).join('、')}（${xText}）`;
    if (!mixed) {
      const gaps = top('walking_gaps');
      const gText = book.add('最多的步行已核实缺口数', gaps.max, '个');
      if (gaps.rows.length === rows.length) tail += `；各分析的已核实步行缺口数相同（都是 ${gText}）。`;
      else if (gaps.max)
        tail += `；已核实步行缺口最多的是 ${gaps.rows.map((r) => r.label).join('、')}（${gText}）。`;
      else tail += '。';
    } else if (!common.length) {
      tail += '；各分析逐小区检查的设施类别没有共同的，已核实缺口数不能比较。';
    } else {
      // only the categories every analysis checked compare
      const gaps = top('common_gaps');
      const each = rows
        .map(
          (r) => `${r.label} ${book.add(`${r.label} 共同检查类别的步行已核实缺口数`, r.common_gaps, '个')}`,
        )
        .join('、');
      tail += `；各分析逐小区检查的设施类别不同，已核实缺口总数不能直接比较——只看共同检查的${common.join('、')}：${each}`;
      if (gaps.rows.length === rows.length) tail += '，各分析相同。';
      else if (gaps.max) tail += `，最多的是 ${gaps.rows.map((r) => r.label).join('、')}。`;
      else tail += '。';
    }
    const summary = `对比 ${book.add('对比的分析数', rows.length, '个')}分析——${lines.join('；')}。${tail}`;
    const data: CompareData = { rows, common_categories: common };
    return { summary, data, facts: book.facts };
  },
});
