import type { HardCategory } from '@zoudedao/core';
import * as z from 'zod';
import { HARD_CATEGORIES } from '../analysis.js';
import { FactBook } from '../format.js';
import { overview } from '../summary.js';
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
  gaps_by_category: Record<HardCategory, number>;
}

export const compareSites = defineTool({
  name: 'compare_sites',
  title: '社区对比',
  description:
    '并排对比 2–4 个已完成的体检（不同社区，或同一社区的成人/老年人画像，如 zj-a 与 zj-a~elder）：15 分钟可达面积、画圆高估倍数、有效半径、' +
    '画圆法缺口数与步行核实缺口数、各类设施缺口数、待核实数，并指出高估最严重、缺口最多的一个。只读取已有结果，不会发起新的分析。',
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
    const rows: CompareRow[] = list.map(({ id, result }) => {
      const o = overview(result, id);
      return {
        analysis_id: id,
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
        gaps_by_category: Object.fromEntries(
          HARD_CATEGORIES.map((c) => [c, o.by_category[c].伪覆盖 + o.by_category[c].盲区]),
        ) as Record<HardCategory, number>,
      };
    });
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
      return `${r.label}：15 分钟可达 ${area}、画圆高估 ${x}${med}；步行已核实缺口 ${walking}（画圆法只找到 ${straight}）${pending}`;
    });
    const top = (key: 'overstate_x' | 'walking_gaps') => {
      const max = Math.max(...rows.map((r) => r[key]));
      return { max, rows: rows.filter((r) => r[key] === max) };
    };
    const over = top('overstate_x');
    const gaps = top('walking_gaps');
    const xText = book.add('最大画圆高估倍数', over.max, '倍', { digits: 2 });
    let tail =
      over.rows.length === rows.length
        ? `各分析的画圆高估倍数相同（${xText}）`
        : `画圆高估最严重的是 ${over.rows.map((r) => r.label).join('、')}（${xText}）`;
    const gText = book.add('最多的步行已核实缺口数', gaps.max, '个');
    if (gaps.rows.length === rows.length) tail += `；各分析的已核实步行缺口数相同（都是 ${gText}）。`;
    else if (gaps.max)
      tail += `；已核实步行缺口最多的是 ${gaps.rows.map((r) => r.label).join('、')}（${gText}）。`;
    else tail += '。';
    const summary = `对比 ${book.add('对比的分析数', rows.length, '个')}分析——${lines.join('；')}。${tail}`;
    return { summary, data: { rows }, facts: book.facts };
  },
});
