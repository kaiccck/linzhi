import * as z from 'zod';
import { FactBook, fmtNumber } from '../format.js';
import type { LocateResult, PlaceCandidate } from '../types.js';
import { availableText } from './context.js';
import { ToolError, defineTool } from './types.js';

const SOURCE_ZH: Record<string, string> = {
  geocoding: '地理编码',
  place_region: '地点检索',
  sample: '内置样例',
};

function describe(c: PlaceCandidate, book: FactBook): string {
  const lng = book.num(`${c.name} 经度（BD-09）`, c.center_bd09[0], '°', { digits: 6, trim: true });
  const lat = book.num(`${c.name} 纬度（BD-09）`, c.center_bd09[1], '°', { digits: 6, trim: true });
  const parts = [`${c.name}${c.address ? `（${c.address}）` : ''}`, `BD-09 [${lng}, ${lat}]`];
  parts.push(`来源：${SOURCE_ZH[c.source] ?? c.source}`);
  if (typeof c.confidence === 'number') {
    parts.push(`可信度 ${book.num(`${c.name} 可信度`, c.confidence, '', { digits: 2, trim: true })}`);
  }
  if (c.sample_id) parts.push(`对应样例 ${c.sample_id}`);
  return parts.join('，');
}

export const locatePlace = defineTool({
  name: 'locate_place',
  title: '地点定位',
  description:
    '把地名或地址解析成候选中心点（BD-09 坐标）。用户只说了地名、还不知道 analysis_id 或坐标时先用它。' +
    '返回候选列表和 needs_confirmation：为 true 时必须把候选列给用户确认，不要替用户挑选。' +
    '候选带 sample_id 时表示它是内置样例，可直接用 analyze_life_circle {sample_id} 体检（不消耗地图配额）。' +
    '服务端处于样例模式或本地运行时，只能匹配内置样例社区及其中的小区。',
  inputSchema: z.object({
    query: z.string().trim().min(1).max(60).describe('地名或地址，例如“申城佳苑”“海科路1650号”'),
    city: z.string().trim().min(1).max(20).optional().describe('城市，默认上海市'),
  }),
  outputSchema: z.looseObject({
    query: z.string(),
    best: z.looseObject({ name: z.string(), center_bd09: z.array(z.number()) }).nullable(),
    candidates: z.array(
      z.looseObject({ name: z.string(), center_bd09: z.array(z.number()), source: z.string() }),
    ),
    needs_confirmation: z.boolean(),
    warnings: z.array(z.string()),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  async run(args, ctx) {
    if (!ctx.backend.locate) {
      throw new ToolError('not_supported', `当前数据源不支持地点定位。${await availableText(ctx)}`);
    }
    const r: LocateResult = await ctx.backend.locate(args.query, args.city, ctx.signal);
    const book = new FactBook();
    const warn = r.warnings.length ? `（${r.warnings.join('；')}）` : '';
    if (!r.candidates.length) {
      return {
        summary: `没有找到“${args.query}”${warn}。${await availableText(ctx)}`,
        data: r,
        facts: book.facts,
      };
    }
    const shown = r.candidates.slice(0, 3);
    const count = book.add('候选地点数', r.candidates.length, '个');
    let summary = `“${args.query}”找到 ${count}候选${warn}：${shown.map((c) => describe(c, book)).join('；')}。`;
    const best = r.best ?? shown[0]!;
    if (r.needs_confirmation) {
      summary += '候选不唯一或可信度不够，请先让用户确认是哪一个，再体检。';
    } else if (best.sample_id) {
      summary += `可以直接体检：analyze_life_circle {"sample_id": "${best.sample_id}"}。`;
    } else {
      summary += `可以直接体检：analyze_life_circle {"center_bd09": [${fmtNumber(best.center_bd09[0], 6, true)}, ${fmtNumber(best.center_bd09[1], 6, true)}]}。`;
    }
    return { summary, data: r, facts: book.facts };
  },
});
