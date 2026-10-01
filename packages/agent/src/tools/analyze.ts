import type { AnalysisResult, LngLat } from '@zoudedao/core';
import * as z from 'zod';
import { AnchorBook, type Anchor } from '../anchors.js';
import { HARD_CATEGORIES, checkRows, isWalkGap, profileOf } from '../analysis.js';
import type { StoredAnalysis } from '../backend.js';
import { FactBook } from '../format.js';
import {
  categorySentence,
  facilitySentence,
  gapSentence,
  graySentence,
  overview,
  profileSentence,
  provenance,
  reachSentence,
  type Overview,
} from '../summary.js';
import type { LocateResult, Profile } from '../types.js';
import { ELDER_SUFFIX, availableText, resolveAnalysis, sampleNear } from './context.js';
import { ToolError, defineTool, type ToolContext } from './types.js';

export type AnalyzeData =
  | (Overview & { status: 'ok'; note?: string })
  | { status: 'needs_confirmation' | 'not_found'; query: string; locate: LocateResult };

async function runLive(
  ctx: ToolContext,
  center: LngLat,
  label: string | undefined,
  profile: Profile,
): Promise<{ stored: StoredAnalysis; note: string }> {
  // quota first: a sample centred on (almost) the same point answers without a single API call
  const near = await sampleNear(ctx, center);
  if (near) {
    return {
      stored: await resolveAnalysis(ctx, near.id),
      note: `该位置与样例“${near.name}”（${near.id}）的中心基本重合，直接使用样例结果，不消耗地图配额。`,
    };
  }
  if (!ctx.backend.analyze) {
    throw new ToolError(
      'live_unavailable',
      `当前使用本地样例数据，不能分析新地点。${await availableText(ctx)}要分析任意地点，请启动配置了百度 Key 的邻至服务，并设置 ZDD_API_URL 指向它。`,
    );
  }
  const result = await ctx.backend.analyze(
    { center_bd09: center, ...(label ? { label } : {}), profile },
    ctx.onProgress,
    ctx.signal,
  );
  const id = ctx.store.put(result, { source: 'live' });
  return { stored: ctx.store.get(id)!, note: '' };
}

async function withProfile(
  ctx: ToolContext,
  stored: StoredAnalysis,
  profile: Profile,
): Promise<StoredAnalysis> {
  const current = profileOf(stored.result);
  if (profile === current) return stored;
  if (profile === 'elder') return resolveAnalysis(ctx, `${stored.id}${ELDER_SUFFIX}`);
  if (stored.id.endsWith(ELDER_SUFFIX)) return resolveAnalysis(ctx, stored.id.slice(0, -ELDER_SUFFIX.length));
  throw new ToolError(
    'invalid_input',
    `分析 ${stored.id} 是老年人画像的实时结果，成人画像请重新体检该地点。`,
  );
}

/**
 * The places the headline is about: the 灰色区域 layers, the communities with verified gaps, and the
 * nearest facility of each category of the 圈内设施统计.
 */
export function overviewAnchors(result: AnalysisResult, id: string, o: Overview): Anchor[] {
  const book = new AnchorBook(result, id).grayAreas();
  for (const r of checkRows(result)) if (isWalkGap(r.check)) book.communityAt(r.index);
  for (const row of o.facilities?.rows ?? []) {
    if (row.nearest) book.poi({ name: row.nearest, category: row.category });
  }
  return book.anchors;
}

/** The headline of one analysis in the product's words; shared with the template advisor. */
export function analysisSummary(o: Overview, book: FactBook, note = ''): string {
  const tag = o.profile === 'elder' ? '，老年人画像' : '';
  const src = provenance(o, book);
  const parts = [
    `${o.name}（analysis_id: ${o.analysis_id}${tag}；${src}）：`,
    gapSentence(o, book),
    reachSentence(o, book),
    categorySentence(o, book),
    profileSentence(o, book),
  ];
  if (o.profile === 'elder') {
    const within = HARD_CATEGORIES.map((c) => {
      const w = o.within_15min[c];
      const und = w.undetermined
        ? `（另 ${book.num(`老年人15分钟可达${c}待核实数`, w.undetermined, '个')} 个待核实）`
        : '';
      return `${c} ${book.add(`老年人15分钟内能走到${c}的小区数`, w.within, '个')}${und}`;
    });
    parts.push(`15 分钟内能走到的小区：${within.join('、')}。`);
  }
  parts.push(facilitySentence(o, book), graySentence(o, book));
  if (note) parts.push(note);
  return parts.filter(Boolean).join('');
}

const analyzeSchema = z.object({
  sample_id: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .optional()
    .describe('内置样例 id，例如 zj-a（上海张江申城佳苑片区）'),
  analysis_id: z.string().trim().min(1).max(80).optional().describe('已有分析的 id，只读取、不重算'),
  center_bd09: z.array(z.number()).length(2).optional().describe('BD-09 坐标 [经度, 纬度]，对该点做实时体检'),
  place: z.string().trim().min(1).max(60).optional().describe('地名或地址，会先定位'),
  label: z.string().trim().max(80).optional().describe('中心点的名称，只用于展示'),
  profile: z
    .enum(['adult', 'elder'])
    .optional()
    .describe(
      'adult：成人（百度步速 1.17 m/s）；elder：老年人（0.9 m/s）。新体检默认成人；读取已有分析时默认保持它原来的画像',
    ),
});

export const analyzeLifeCircle = defineTool<typeof analyzeSchema, AnalyzeData>({
  name: 'analyze_life_circle',
  title: '生活圈体检',
  description:
    '对一个社区做 15 分钟步行生活圈体检，或读取已有结果，返回 analysis_id 和核心数字：15 分钟步行可达面积与直线圆面积、' +
    '画圆高估倍数、15 分钟有效步行半径中位数、小学/菜市场/药店在已核实检查中的覆盖/伪覆盖/盲区数、待核实数，' +
    '以及“画圆法找到的缺口 vs 实测步行核实的缺口”；' +
    '圈内设施统计 facilities.rows（小学、幼儿园、菜市场、超市、药店、社区卫生、养老、公交、地铁、公园：清单数 found、直线 15 分钟圆内 circle、' +
    '15 分钟步行可达 walk、最近一处 nearest 与步行分钟 nearest_min；complete=false 表示清单被检索页数截断，数量是下限），' +
    '以及灰色区域 gray_areas（缺至少 n 类必需设施或有伪覆盖的范围：面积、块数、涉及小区）。' +
    '“圈里有几家药店”“附近有什么设施”这类问题用 facilities 回答。' +
    'sample_id、analysis_id、center_bd09、place 四选一：sample_id 读内置样例（如 zj-a 申城佳苑片区）；analysis_id 读已有结果；' +
    'center_bd09 对该点实时体检（需要服务端实时模式和百度 Key，约 1 分钟）；place 先定位，候选不唯一时返回候选，请用户确认后再调用。' +
    'profile=elder 按老年人步速 0.9 m/s 重算时间（路线距离与 1 km 判定不变），返回新的 analysis_id。' +
    '后续的 get_isochrone、list_service_gaps、simulate_facility、export_report 都使用这里返回的 analysis_id；' +
    '已知 analysis_id（包括老年人画像 <id>~elder）时可以直接调用它们，不必先调用本工具。' +
    '待核实（verified=false）的检查不是缺口，回答时不要把它们算进伪覆盖或盲区。',
  inputSchema: analyzeSchema,
  outputSchema: z.looseObject({
    status: z.enum(['ok', 'needs_confirmation', 'not_found']),
    analysis_id: z.string().optional(),
    name: z.string().optional(),
    headline: z
      .looseObject({
        straight_gaps: z.number(),
        walking_gaps: z.number(),
        missed_by_circle: z.number(),
        missed_share_pct: z.number().nullable(),
        pending: z.number(),
      })
      .optional(),
    facilities: z
      .looseObject({
        rows: z.array(
          z.looseObject({
            category: z.string(),
            found: z.number(),
            circle: z.number(),
            walk: z.number(),
            nearest_min: z.number().nullable(),
          }),
        ),
      })
      .nullable()
      .optional(),
    gray_areas: z
      .array(
        z.looseObject({ kind: z.enum(['gap', 'pseudo']), min_missing: z.number(), area_km2: z.number() }),
      )
      .optional(),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  async run(args, ctx) {
    const given = [args.sample_id, args.analysis_id, args.center_bd09, args.place].filter(
      (v) => v !== undefined,
    );
    if (given.length !== 1) {
      throw new ToolError(
        'invalid_input',
        `sample_id、analysis_id、center_bd09、place 需要且只能提供一个。${await availableText(ctx)}`,
      );
    }
    let stored: StoredAnalysis;
    let note = '';
    if (args.sample_id !== undefined || args.analysis_id !== undefined) {
      stored = await resolveAnalysis(ctx, (args.sample_id ?? args.analysis_id)!);
    } else if (args.center_bd09) {
      const [lng, lat] = args.center_bd09 as [number, number];
      if (!(lng > 72 && lng < 138 && lat > 0.8 && lat < 56)) {
        throw new ToolError('invalid_input', 'center_bd09 须为中国境内的 BD-09 坐标 [经度, 纬度]');
      }
      ({ stored, note } = await runLive(ctx, [lng, lat], args.label, args.profile ?? 'adult'));
    } else {
      const place = args.place!;
      if (!ctx.backend.locate)
        throw new ToolError('not_supported', '当前数据源不支持地点定位，请提供 sample_id 或 center_bd09');
      const loc = await ctx.backend.locate(place, undefined, ctx.signal);
      const book = new FactBook();
      if (!loc.candidates.length || !loc.best) {
        return {
          summary: `没有找到“${place}”。${await availableText(ctx)}`,
          data: { status: 'not_found', query: place, locate: loc },
          facts: book.facts,
        };
      }
      if (loc.needs_confirmation) {
        const list = loc.candidates.slice(0, 5).map((c) => {
          const lng = book.num(`${c.name} 经度（BD-09）`, c.center_bd09[0], '°', { digits: 6, trim: true });
          const lat = book.num(`${c.name} 纬度（BD-09）`, c.center_bd09[1], '°', { digits: 6, trim: true });
          return `${c.name}${c.address ? `（${c.address}）` : ''} [${lng}, ${lat}]${c.sample_id ? `（样例 ${c.sample_id}）` : ''}`;
        });
        return {
          summary: `“${place}”有 ${book.add('候选地点数', loc.candidates.length, '个')}候选，需要用户确认后再体检：${list.join('；')}。确认后用 sample_id 或 center_bd09 再调用本工具。`,
          data: { status: 'needs_confirmation', query: place, locate: loc },
          facts: book.facts,
        };
      }
      const best = loc.best;
      if (best.sample_id) {
        stored = await resolveAnalysis(ctx, best.sample_id);
        note = `“${place}”对应内置样例 ${best.sample_id}。`;
      } else {
        ({ stored, note } = await runLive(ctx, best.center_bd09, best.name, args.profile ?? 'adult'));
      }
    }
    if (args.profile) stored = await withProfile(ctx, stored, args.profile);
    const o = overview(stored.result, stored.id);
    const book = new FactBook();
    const summary = analysisSummary(o, book, note);
    return {
      summary,
      data: { status: 'ok' as const, ...o, ...(note ? { note } : {}) },
      facts: book.facts,
      anchors: overviewAnchors(stored.result, stored.id, o),
    };
  },
});
