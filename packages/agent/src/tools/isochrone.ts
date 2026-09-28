import * as z from 'zod';
import { profileOf } from '../analysis.js';
import { FactBook } from '../format.js';
import { CRS_ZH, LEVEL_OF_MINUTES, isochroneCollection, type FeatureCollection } from '../geo.js';
import { resolveAnalysis } from './context.js';
import { defineTool } from './types.js';

const STYLE_KEYS = new Set([
  'fill',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'marker-color',
  'marker-symbol',
]);

/** Properties without geometry or styling: what a model needs to talk about the layers. */
export function featureSummaries(fc: FeatureCollection): unknown {
  return {
    type: fc.type,
    name: fc.name,
    coordinate_system: fc.coordinate_system,
    features: fc.features.map((f) => ({
      geometry_type: f.geometry.type,
      properties: Object.fromEntries(Object.entries(f.properties).filter(([k]) => !STYLE_KEYS.has(k))),
    })),
    note: '几何坐标已省略；完整 GeoJSON 在工具结果的 data 中',
  };
}

export const getIsochrone = defineTool({
  name: 'get_isochrone',
  title: '步行等时圈',
  description:
    '返回一次体检的 5/10/15 分钟步行等时圈 GeoJSON（FeatureCollection：每档一个 MultiPolygon，保留孔洞——孔洞是圈里走不到的地方），' +
    '并附直线 15 分钟圆作对照、分析中心点。默认 WGS84 坐标，可直接粘贴到 geojson.io；叠加百度地图用 crs=bd09，高德/腾讯用 gcj02。' +
    '几何数据很大，回答用户时只引用面积等属性，不要复述坐标。',
  inputSchema: z.object({
    analysis_id: z.string().trim().min(1).max(80).describe('analyze_life_circle 返回的 analysis_id'),
    levels: z
      .array(z.literal([5, 10, 15]))
      .min(1)
      .max(3)
      .optional()
      .describe('要哪些等时圈（分钟），默认 [5, 10, 15]'),
    crs: z
      .enum(['wgs84', 'gcj02', 'bd09'])
      .default('wgs84')
      .describe('坐标系：wgs84（默认，GPS/geojson.io）、gcj02（高德/腾讯）、bd09（百度地图）'),
    simplify: z
      .number()
      .min(0)
      .max(50)
      .default(0)
      .describe('多边形简化容差（米），0 表示不简化；取 10 左右可明显减小数据量'),
    include_circle: z.boolean().default(true).describe('是否附带直线 15 分钟圆作对照'),
  }),
  outputSchema: z.looseObject({
    type: z.literal('FeatureCollection'),
    coordinate_system: z.enum(['wgs84', 'gcj02', 'bd09']),
    features: z.array(
      z.looseObject({
        type: z.literal('Feature'),
        geometry: z.looseObject({ type: z.string() }),
        properties: z.record(z.string(), z.unknown()),
      }),
    ),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true },
  llmView: featureSummaries,
  async run(args, ctx) {
    const { id, result } = await resolveAnalysis(ctx, args.analysis_id);
    const levels = args.levels ?? [5, 10, 15];
    const fc = isochroneCollection(result, {
      levels,
      crs: args.crs,
      simplify: args.simplify,
      includeCircle: args.include_circle,
    });
    const book = new FactBook();
    const areas = [...new Set(levels)]
      .sort((a, b) => b - a)
      .map((minutes) => {
        const a = result.stats.areas_km2?.[LEVEL_OF_MINUTES[minutes]];
        if (!a) return `${minutes} 分钟`;
        const iso = book.add(`${minutes} 分钟步行可达面积`, a.iso, 'km²', { digits: 3 });
        const circle = book.add(`${minutes} 分钟直线圆面积`, a.circle, 'km²', { digits: 3 });
        return `${minutes} 分钟 ${iso}（直线圆 ${circle}）`;
      });
    const f15 = fc.features.find((f) => f.properties.kind === 'isochrone' && f.properties.minutes === 15);
    let shape = '';
    if (f15) {
      const polygons = Number(f15.properties.polygons);
      const holes = Number(f15.properties.holes);
      shape = `15 分钟范围由 ${book.add('15 分钟等时圈多边形数', polygons, '个')}多边形组成${holes ? `，含 ${book.add('15 分钟等时圈孔洞数', holes, '个')}孔洞（圈内走不到的地方）` : ''}。`;
    }
    const who = profileOf(result) === 'elder' ? '（老年人画像）' : '';
    const tip = args.crs === 'wgs84' ? '可直接粘贴到 geojson.io 查看。' : '';
    const summary = `${result.meta.name}${who}的步行等时圈 GeoJSON（analysis_id: ${id}，坐标系 ${CRS_ZH[args.crs]}）：${areas.join('、')}。${shape}${tip}`;
    return { summary, data: fc, facts: book.facts };
  },
});
