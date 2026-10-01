import * as z from 'zod';
import { FactBook } from '../format.js';
import { reportCollection, type FeatureCollection } from '../geo.js';
import { buildReportModel, renderMarkdown, type ReportModel } from '../report.js';
import { gapSentence } from '../summary.js';
import { resolveAnalysis } from './context.js';
import { defineTool } from './types.js';

export type ReportFormat = 'markdown' | 'geojson' | 'json';

export interface ReportData {
  analysis_id: string;
  format: ReportFormat;
  title: string;
  filename: string;
  mime_type: string;
  content: string | FeatureCollection | ReportModel;
}

const FORMAT_ZH: Record<ReportFormat, string> = {
  markdown: 'Markdown 文档',
  geojson: 'GeoJSON 地图数据',
  json: 'JSON 结构化数据',
};

/** File-name safe form of an analysis id ("zj-a~elder" → "zj-a-elder"). */
export const fileId = (id: string): string =>
  id.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'analysis';

export const exportReport = defineTool({
  name: 'export_report',
  title: '导出体检报告',
  description:
    '导出一次体检的报告：markdown（结论先行的中文体检报告：关键数字、圈内设施统计（15 分钟步行可达 vs 直线圆内 vs 清单、最近一处的步行分钟）、各类设施缺口表、灰色区域、待核实清单、伪覆盖解释、规划建议、方法与局限）；' +
    'geojson（等时圈、直线圆、小区检查结果、设施点（含 walk_min 步行分钟、within_walk15、within_circle15）、灰色区域（面积、涉及小区）、规划建议点，圈内设施统计在 facility_stats 中，WGS84，可在 geojson.io 或 QGIS 打开）；json（报告的结构化数据）。' +
    '报告完全由分析结果确定性生成，不含模型生成的内容。用户要“报告”“导出”“下载”时使用。',
  inputSchema: z.object({
    analysis_id: z.string().trim().min(1).max(80).describe('analyze_life_circle 返回的 analysis_id'),
    format: z.enum(['markdown', 'geojson', 'json']).default('markdown').describe('导出格式，默认 markdown'),
    crs: z.enum(['wgs84', 'gcj02', 'bd09']).default('wgs84').describe('仅 geojson：坐标系，默认 wgs84'),
  }),
  outputSchema: z.looseObject({
    analysis_id: z.string(),
    format: z.enum(['markdown', 'geojson', 'json']),
    title: z.string(),
    filename: z.string(),
    mime_type: z.string(),
    content: z.unknown(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true },
  llmView(data: ReportData) {
    if (data.format === 'geojson') {
      const fc = data.content as FeatureCollection;
      const kinds: Record<string, number> = {};
      for (const f of fc.features) {
        const k = String(f.properties.kind);
        kinds[k] = (kinds[k] ?? 0) + 1;
      }
      return {
        ...data,
        content: { feature_counts: kinds, note: '几何数据已省略；完整 GeoJSON 在工具结果的 data 中' },
      };
    }
    return data;
  },
  async run(args, ctx) {
    const { id, result } = await resolveAnalysis(ctx, args.analysis_id);
    const model = buildReportModel(result, id);
    const base = `zoudedao-${fileId(id)}`;
    let data: ReportData;
    if (args.format === 'geojson') {
      data = {
        analysis_id: id,
        format: 'geojson',
        title: model.title,
        filename: `${base}.geojson`,
        mime_type: 'application/geo+json',
        content: reportCollection(result, args.crs),
      };
    } else if (args.format === 'json') {
      data = {
        analysis_id: id,
        format: 'json',
        title: model.title,
        filename: `${base}-report.json`,
        mime_type: 'application/json',
        content: model,
      };
    } else {
      data = {
        analysis_id: id,
        format: 'markdown',
        title: model.title,
        filename: `${base}-report.md`,
        mime_type: 'text/markdown',
        content: renderMarkdown(model),
      };
    }
    const book = new FactBook();
    const o = model.overview;
    let summary = `已生成《${model.title}》（${FORMAT_ZH[args.format]}，文件名 ${data.filename}）。结论：${gapSentence(o, book)}`;
    const extras = [
      o.facilities ? `圈内设施统计（${book.add('统计的设施类别数', o.facilities.rows.length, '类')}）` : '',
      o.gray_areas.length ? `灰色区域（${book.add('灰色区域图层数', o.gray_areas.length, '层')}）` : '',
    ].filter(Boolean);
    if (args.format === 'geojson') {
      const fc = data.content as FeatureCollection;
      summary += `共 ${book.add('GeoJSON 要素数', fc.features.length, '个')}要素：等时圈、直线圆、小区检查结果、设施点（含 15 分钟步行时间）${result.gray_areas?.length ? '、灰色区域' : ''}、规划建议点${o.facilities ? '；圈内设施统计在 facility_stats 中' : ''}。`;
    } else if (extras.length) {
      summary += `报告含${extras.join('与')}。`;
    }
    return { summary, data, facts: book.facts };
  },
});
