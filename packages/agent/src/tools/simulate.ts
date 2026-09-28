import {
  TASK_RULE_M,
  estimateRoute,
  siteCoverage,
  type HardCategory,
  type LngLat,
  type XY,
} from '@zoudedao/core';
import * as z from 'zod';
import {
  GB_RADIUS_M,
  describePlace,
  findCommunity,
  frameOf,
  routeEstimator,
  ruleOf,
  statusUnderRule,
  toBd09,
  type RuleStatus,
} from '../analysis.js';
import { FactBook, fmtNumber, round } from '../format.js';
import { resolveAnalysis } from './context.js';
import { ToolError, defineTool } from './types.js';

export type SimChange =
  'newly_covered' | 'pending_covered' | 'still_gap' | 'pending_unresolved' | 'shorter' | 'unchanged';

export interface SimRow {
  community: string;
  straight_m: number;
  /** L̂ from the new facility, metres (estimate); null when far beyond the rule. */
  est_m: number | null;
  current: RuleStatus;
  current_route_m: number | null;
  after: '估算可达' | '估算不可达';
  change: SimChange;
}

export interface SimulateData {
  analysis_id: string;
  category: HardCategory;
  rule_m: number;
  estimate: true;
  site: { center_bd09: LngLat; xy: XY; label: string | null; place: string };
  method: string;
  counts: Record<SimChange, number>;
  rows: SimRow[];
  caveats: string[];
}

const MEASURE: Record<HardCategory, string> = { 小学: '所', 菜市场: '家', 药店: '家' };

const ORDER: SimChange[] = [
  'newly_covered',
  'pending_covered',
  'shorter',
  'still_gap',
  'pending_unresolved',
  'unchanged',
];

export const simulateFacility = defineTool({
  name: 'simulate_facility',
  title: '新增设施模拟（估算）',
  description:
    '模拟“如果在某处新增一家小学/菜市场/药店”：用本次体检的绕行系数场估算新设施到每个小区的步行距离 L̂（不调用地图接口），' +
    '判断哪些当前缺这类设施的小区会进入判定距离、哪些待核实的小区会被满足、哪些已覆盖的小区步行会变近。' +
    '结果一律是估算，回答时必须写明“估算”并提醒需要实测核验。位置二选一：center_bd09（BD-09 [经度, 纬度]）或 near_community（放在某个小区旁）。' +
    '位置须在本次分析范围内（离分析中心约 1.6 km 以内）。',
  inputSchema: z.object({
    analysis_id: z.string().trim().min(1).max(80).describe('analyze_life_circle 返回的 analysis_id'),
    category: z.enum(['小学', '菜市场', '药店']).describe('新增哪类设施'),
    center_bd09: z.array(z.number()).length(2).optional().describe('新设施位置，BD-09 [经度, 纬度]'),
    near_community: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .optional()
      .describe('把新设施放在某个小区旁（按小区名匹配）'),
    label: z.string().trim().max(60).optional().describe('位置的叫法，如“孙环路口”，只用于展示'),
    rule: z
      .enum(['task', 'gb50180'])
      .optional()
      .describe(
        '判定口径：task 赛题 1 km；gb50180 国标半径（小学、菜市场 500 m，药店 300 m）；默认沿用本次分析的口径',
      ),
  }),
  outputSchema: z.looseObject({
    analysis_id: z.string(),
    category: z.string(),
    rule_m: z.number(),
    estimate: z.literal(true),
    rows: z.array(
      z.looseObject({
        community: z.string(),
        est_m: z.number().nullable(),
        current: z.string(),
        change: z.string(),
      }),
    ),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true },
  async run(args, ctx) {
    const { id, result } = await resolveAnalysis(ctx, args.analysis_id);
    if ((args.center_bd09 === undefined) === (args.near_community === undefined)) {
      throw new ToolError('invalid_input', 'center_bd09 和 near_community 需要且只能提供一个');
    }
    const category = args.category;
    let xy: XY;
    let label = args.label ?? null;
    if (args.center_bd09) {
      const [lng, lat] = args.center_bd09 as [number, number];
      xy = frameOf(result.meta).toXY(lng, lat);
    } else {
      const c = findCommunity(result, args.near_community!);
      if (!c) {
        throw new ToolError(
          'not_found',
          `本次分析里没有名为“${args.near_community}”的小区。可选：${result.communities.map((x) => x.name).join('、')}`,
        );
      }
      xy = c.centroid;
      label ??= `${c.name}旁`;
    }
    const extent = result.meta.extent_m ?? 1600;
    if (Math.hypot(xy[0], xy[1]) > extent) {
      throw new ToolError(
        'out_of_area',
        '这个位置在本次分析的耗时场范围之外，无法估算；请换一个离分析中心更近的位置，或以该位置为中心重新体检。',
      );
    }
    const rule_m =
      args.rule === 'gb50180'
        ? GB_RADIUS_M[category]
        : args.rule === 'task'
          ? TASK_RULE_M[category]
          : ruleOf(result, category);
    const estimator = routeEstimator(result);
    const demands = result.communities.map((c) => ({ id: c.name, xy: c.centroid }));
    const cov = siteCoverage({ id: 'what-if', xy }, demands, { category, rule_m, estimator });
    const covered = new Set(cov.covers);

    const rows: SimRow[] = result.communities.map((c) => {
      const straight = Math.hypot(c.centroid[0] - xy[0], c.centroid[1] - xy[1]);
      const est = straight <= rule_m * 2 ? Math.round(estimateRoute(xy, c.centroid, { estimator })) : null;
      const check = c.checks?.[category];
      const current: RuleStatus = check ? statusUnderRule(check, rule_m) : '未达标';
      const ok = covered.has(c.name);
      const route = check && check.route_m >= 0 ? check.route_m : null;
      let change: SimChange;
      if (current === '达标')
        change = ok && est !== null && route !== null && est < route ? 'shorter' : 'unchanged';
      else if (current === '未达标') change = ok ? 'newly_covered' : 'still_gap';
      else change = ok ? 'pending_covered' : 'pending_unresolved';
      return {
        community: c.name,
        straight_m: round(straight, 1),
        est_m: est,
        current,
        current_route_m: route,
        after: ok ? '估算可达' : '估算不可达',
        change,
      };
    });
    rows.sort(
      (a, b) => ORDER.indexOf(a.change) - ORDER.indexOf(b.change) || (a.est_m ?? 1e9) - (b.est_m ?? 1e9),
    );
    const counts = Object.fromEntries(
      ORDER.map((k) => [k, rows.filter((r) => r.change === k).length]),
    ) as Record<SimChange, number>;
    const place = describePlace(result, xy);
    const center = toBd09(result, xy);

    const book = new FactBook();
    const names = (kind: SimChange) =>
      rows
        .filter((r) => r.change === kind)
        .map((r) =>
          r.est_m !== null && r.est_m < 30
            ? `${r.community}（新设施就在小区旁）`
            : `${r.community}（L̂ ≈ ${book.add(`${r.community}到新${category}的估算步行距离 L̂`, r.est_m ?? 0, 'm')}）`,
        )
        .join('、');
    const gapsNow = counts.newly_covered + counts.still_gap;
    const pendingNow = counts.pending_covered + counts.pending_unresolved;
    const ruleText = `步行 ≤ ${fmtNumber(rule_m)} m`;
    let summary = `估算（未经实测核验）：在${label ? `“${label}”（${place}）` : place}新增 ${book.add('新增设施数', 1, MEASURE[category])}${category}，按${ruleText} 判定——`;
    if (!gapsNow) summary += `当前没有已核实的${category}缺口`;
    else if (counts.newly_covered) {
      summary += `当前 ${book.add(`${category}已核实缺口数`, gapsNow, '个')}缺口中，估算有 ${book.add('估算新进入判定距离的小区数', counts.newly_covered, '个')}可以补上：${names('newly_covered')}`;
    } else
      summary += `当前 ${book.add(`${category}已核实缺口数`, gapsNow, '个')}缺口都补不上（估算步行仍超出判定距离）`;
    if (pendingNow) {
      summary += counts.pending_covered
        ? `；${book.add('待核实数', pendingNow, '项')}待核实中，估算有 ${book.add('估算可由新设施满足的待核实数', counts.pending_covered, '项')}可由新设施直接满足：${names('pending_covered')}`
        : `；${book.add('待核实数', pendingNow, '项')}待核实都不能由新设施直接满足`;
    }
    if (counts.shorter) {
      summary += `；另有 ${book.add('估算步行变近的已覆盖小区数', counts.shorter, '个')}已覆盖的小区步行会变近`;
    }
    summary += '。L̂ 是按本次分析的绕行系数场估算的步行距离，不调用地图接口，需要实测算路核验后才能作为结论。';

    const data: SimulateData = {
      analysis_id: id,
      category,
      rule_m,
      estimate: true,
      site: { center_bd09: center, xy: [round(xy[0], 1), round(xy[1], 1)], label, place },
      method:
        'L̂(s, d) = max( max(ρ̂(s), ρ̂(d)) · |s − d|, |t̂(s) − t̂(d)| · v )，ρ̂ 与 t̂ 来自本次分析的耗时样本（core siting.ts）',
      counts,
      rows,
      caveats: [
        '估算，未经实测核验：落地前应从候选点对各小区做一次批量算路。',
        '在张江样例的 132 条实测路线上，L̂ 的 1 km 判定准确率为 92.4%（core siting.ts）。',
        '小区位置取分析结果中的小区代表点；大型小区不同出入口的步行距离会有差别。',
      ],
    };
    return { summary, data, facts: book.facts };
  },
});
