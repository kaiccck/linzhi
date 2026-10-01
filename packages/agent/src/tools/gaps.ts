import { type HardCategory } from '@zoudedao/core';
import * as z from 'zod';
import {
  HARD_CATEGORIES,
  checkRows,
  findCommunity,
  profileOf,
  ruleOf,
  speedOf,
  within15,
} from '../analysis.js';
import { AnchorBook } from '../anchors.js';
import { FactBook, fmtNumber } from '../format.js';
import {
  communitiesWithGaps,
  communityStatusRows,
  coveredRows,
  gapRows,
  pendingRows,
  type CommunityStatusRow,
  type CoveredRow,
  type GapRow,
  type PendingRow,
} from '../rows.js';
import { resolveAnalysis } from './context.js';
import { ToolError, defineTool } from './types.js';

export interface GapsData {
  analysis_id: string;
  name: string;
  profile: string;
  speed_mps: number;
  filter: { category: HardCategory | null; status: string | null; community: string | null };
  rule_m: Record<HardCategory, number>;
  counts: {
    checks: number;
    gaps: number;
    pseudo: number;
    blind: number;
    borderline: number;
    pending: number;
    /** 菜市场 gaps listed with a 买菜替代 (gaps[].alt, a shop within the rule on foot): still gaps. */
    with_alt: number;
  };
  gaps: GapRow[];
  pending: PendingRow[];
  /** Only with the community filter: the checks that are fine, so a question about one place is answered whole. */
  covered: CoveredRow[];
  communities_with_gaps: { community: string; missing: HardCategory[] }[];
  /** Every community in scope: verdict and walking minutes per category (answers "哪些小区都方便"). */
  by_community: CommunityStatusRow[];
  /**
   * Area-wide: communities (not facilities) that reach each category within 15 minutes. Empty with
   * the community filter, where it answered a different question than the one asked and a real model
   * read "within 6, total 12" as "6 of 12 schools".
   */
  within_15min: Partial<
    Record<HardCategory, { limit_m: number; within: number; undetermined: number; total: number }>
  >;
}

export const listServiceGaps = defineTool({
  name: 'list_service_gaps',
  title: '服务缺口清单',
  description:
    '列出一次体检中“小区 × 设施类别”的服务缺口，按步行距离从远到近排序，给出直线距离、实测步行距离、经由设施、步行分钟数。' +
    '只有已核实（verified=true）的检查才算缺口：伪覆盖 = 直线在判定距离内、步行超出；盲区 = 直线就已超出（route_basis=lower_bound 表示判定距离内根本没有这类设施，没有算路）；临界 = 步行距离与判定距离相差不超过 50 m。' +
    '未核实的检查单独列在 pending（待核实），回答时只能说“待核实”，不能说成缺口。' +
    '菜市场缺口可能带 alt（买菜替代：判定距离内步行能到的能买菜的超市或果蔬店及步行距离），只作参考，不算覆盖，缺口仍计为缺口；alt 为 null 表示判定距离内步行没有这样的店。' +
    '可按类别（小学/菜市场/药店）、状态和小区过滤；问某个小区时传 community（小区名，如“申城佳苑三期A块”），还会返回该小区能走到的设施（covered）。' +
    '老年人画像的 analysis_id 是原 id 加 ~elder（如 zj-a~elder），会给出 15 分钟内能走到的小区数。',
  inputSchema: z.object({
    analysis_id: z.string().trim().min(1).max(80).describe('analyze_life_circle 返回的 analysis_id'),
    category: z.enum(['小学', '菜市场', '药店']).optional().describe('只看某一类设施'),
    status: z.enum(['伪覆盖', '盲区', '临界']).optional().describe('只看某种状态'),
    community: z.string().trim().min(1).max(40).optional().describe('只看某个小区（按小区名匹配）'),
    include_pending: z.boolean().default(true).describe('是否附上待核实清单（不计入缺口）'),
    limit: z.number().int().min(1).max(200).default(50).describe('缺口最多返回多少条'),
  }),
  outputSchema: z.looseObject({
    analysis_id: z.string(),
    counts: z.looseObject({ gaps: z.number(), pseudo: z.number(), blind: z.number(), pending: z.number() }),
    gaps: z.array(
      z.looseObject({
        community: z.string(),
        category: z.string(),
        status: z.string(),
        straight_m: z.number(),
        route_m: z.number(),
      }),
    ),
    pending: z.array(z.looseObject({ community: z.string(), category: z.string(), reason: z.string() })),
    covered: z.array(z.looseObject({ community: z.string(), category: z.string(), route_m: z.number() })),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true },
  async run(args, ctx) {
    const { id, result } = await resolveAnalysis(ctx, args.analysis_id);
    let community: string | undefined;
    if (args.community) {
      community = findCommunity(result, args.community)?.name;
      if (!community) {
        throw new ToolError(
          'not_found',
          `本次分析里没有名为“${args.community}”的小区。可选：${result.communities.map((c) => c.name).join('、')}`,
        );
      }
    }
    const filter = {
      ...(args.category ? { category: args.category } : {}),
      ...(args.status ? { status: args.status } : {}),
      ...(community ? { community } : {}),
    };
    const all = gapRows(result, filter);
    const scope = {
      ...(args.category ? { category: args.category } : {}),
      ...(community ? { community } : {}),
    };
    const pending = args.include_pending ? pendingRows(result, scope) : [];
    const covered = community ? coveredRows(result, scope) : [];
    const cats = args.category ? [args.category] : [...HARD_CATEGORIES];
    const rows = checkRows(result).filter(
      (r) => cats.includes(r.category) && (!community || r.community.name === community),
    );
    const speed = speedOf(result);

    const data: GapsData = {
      analysis_id: id,
      name: result.meta.name,
      profile: profileOf(result),
      speed_mps: speed,
      filter: { category: args.category ?? null, status: args.status ?? null, community: community ?? null },
      rule_m: Object.fromEntries(HARD_CATEGORIES.map((c) => [c, ruleOf(result, c)])) as Record<
        HardCategory,
        number
      >,
      counts: {
        checks: rows.length,
        gaps: all.length,
        pseudo: all.filter((g) => g.status === '伪覆盖').length,
        blind: all.filter((g) => g.status === '盲区').length,
        borderline: all.filter((g) => g.borderline).length,
        pending: pending.length,
        with_alt: all.filter((g) => g.alt).length,
      },
      gaps: all.slice(0, args.limit),
      pending,
      covered,
      communities_with_gaps: communitiesWithGaps(all),
      by_community: communityStatusRows(result, scope),
      within_15min: community ? {} : Object.fromEntries(cats.map((c) => [c, within15(result, c)])),
    };

    const book = new FactBook();
    const m = (label: string, v: number) => book.add(label, v, 'm', { digits: 1, trim: true });
    const minutes = (label: string, v: number) => book.add(label, v, '分钟', { digits: 1 });
    /** "直线 818.5 m、步行 1,676 m（约 23.9 分钟）", or the lower-bound wording when nothing was routed. */
    const walk = (g: GapRow) => {
      const key = `${g.community}到${g.category}`;
      const straight = m(`${key}的直线距离`, g.straight_m);
      if (g.route_basis === 'lower_bound' || g.walk_min === null) {
        return `直线 ${straight}（判定距离内没有这类设施，无需算路）`;
      }
      return `直线 ${straight}、步行 ${m(`${key}的步行距离`, g.route_m)}（约 ${minutes(`${key}的步行时间`, g.walk_min)}）`;
    };
    /** "；可在联华超市(益江店)买菜（超市，步行 530 m，约 7.6 分钟；只作参考，不算覆盖）" for a 菜市场 gap. */
    const altText = (g: GapRow) => {
      if (g.alt === undefined) return '';
      if (g.alt === null) return '；判定距离内步行也没有能买菜的超市或果蔬店';
      const key = `${g.community}的买菜替代${g.alt.name}`;
      return `；可在${g.alt.name}买菜（${g.alt.kind}，步行 ${m(`${key}的步行距离`, g.alt.route_m)}，约 ${minutes(`${key}的步行时间`, g.alt.walk_min)}；只作参考，不算覆盖）`;
    };

    let summary: string;
    if (community) {
      const parts = cats.map((cat) => {
        const gap = all.find((g) => g.category === cat);
        if (gap) {
          const via = gap.via ? `最近能走到的是${gap.via}，` : '';
          return `${cat}步行 ${fmtNumber(gap.rule_m)} m 内走不到（${gap.status}${gap.borderline ? '、临界' : ''}）：${via}${walk(gap)}${altText(gap)}`;
        }
        const ok = covered.find((c) => c.category === cat);
        if (ok) {
          const key = `${community}到${cat}`;
          return `${cat}能走到：${ok.via ?? '最近的设施'}，步行 ${m(`${key}的步行距离`, ok.route_m)}（约 ${minutes(`${key}的步行时间`, ok.walk_min)}${ok.borderline ? '，临界' : ''}）`;
        }
        if (pending.some((p) => p.category === cat)) return `${cat}待核实（有更近的设施还没有算路）`;
        return `${cat}没有检查结果`;
      });
      const rule = HARD_CATEGORIES.every((c) => ruleOf(result, c) === 1000)
        ? '1,000 m'
        : cats.map((c) => `${c} ${fmtNumber(ruleOf(result, c))} m`).join('、');
      summary = `${result.meta.name} · ${community}（analysis_id: ${id}，判定距离 ${rule}）：${parts.join('；')}。`;
    } else {
      const scopeText = args.category
        ? `${args.category}`
        : `${book.add('设施类别数', cats.length, '类')}设施`;
      const rule = args.category
        ? `步行 ≤ ${fmtNumber(ruleOf(result, args.category))} m`
        : HARD_CATEGORIES.every((c) => ruleOf(result, c) === 1000)
          ? '步行 ≤ 1,000 m'
          : HARD_CATEGORIES.map((c) => `${c} ≤ ${fmtNumber(ruleOf(result, c))} m`).join('、');
      const statusTag = args.status ? `（只看${args.status}）` : '';
      const n = data.counts;
      summary = `${result.meta.name}（analysis_id: ${id}）${scopeText}，判定距离 ${rule}${statusTag}：${book.add('小区数', result.communities.length, '个')}小区中，`;
      if (!n.gaps) {
        summary += '没有已核实的缺口';
      } else {
        summary += `已核实缺口 ${book.add('已核实缺口数', n.gaps, '个')}（伪覆盖 ${book.num('伪覆盖数', n.pseudo, '个')}、盲区 ${book.num('盲区数', n.blind, '个')}）`;
        if (n.borderline) {
          summary += `，其中临界 ${book.add('临界数', n.borderline, '个')}（步行距离与判定距离相差不超过 50 m，建议实地核实）`;
        }
        if (!args.category) {
          summary += `，涉及 ${book.add('有缺口的小区数', data.communities_with_gaps.length, '个')}小区`;
        }
        if (n.with_alt) {
          summary += `；其中菜市场缺口 ${book.add('有买菜替代的菜市场缺口数', n.with_alt, '个')}在判定距离内步行能到能买菜的超市或果蔬店（买菜替代，只作参考，仍计为缺口）`;
        }
      }
      summary += pending.length
        ? `；另有 ${book.add('待核实数', pending.length, '项')}待核实，不计入缺口。`
        : '。';
      const top = all
        .slice(0, 3)
        .map((g) => `${g.community}的${g.category}（${g.status}${g.borderline ? '、临界' : ''}）${walk(g)}`);
      if (top.length) summary += `步行最远的：${top.join('；')}。`;
      if (pending.length) {
        const names = pending.slice(0, 3).map((p) => `${p.community}的${p.category}`);
        summary += `待核实：${names.join('、')}（原因：有更近的设施还没有算路）。`;
      }
    }
    // area-wide counts only for area-wide questions (see within_15min)
    if (profileOf(result) === 'elder' && !community) {
      const limit = book.add('老年人 15 分钟步行距离', Math.round(900 * speed), 'm');
      const parts = cats.map((c) => {
        const w = within15(result, c);
        const und = w.undetermined
          ? `，${book.num(`老年人15分钟可达${c}待核实数`, w.undetermined, '个')} 个待核实`
          : '';
        return `${c} ${book.add(`老年人15分钟内能走到${c}的小区数`, w.within, '个')}（共 ${book.num(`${c}检查小区数`, w.total, '个')} 个${und}）`;
      });
      summary += `按老年人步速 ${book.add('老年人步速', speed, 'm/s', { digits: 2, trim: true })}，15 分钟最多走 ${limit}：整个片区能在 15 分钟内走到的小区——${parts.join('；')}。`;
    }
    // the places named: each gap's community and the facility its walk reaches, then the pending ones
    const anchors = new AnchorBook(result, id);
    const via = (community: string, category: HardCategory) => {
      const check = result.communities.find((c) => c.name === community)?.checks?.[category];
      anchors.poi({ uid: check?.via_uid ?? null, name: check?.via ?? null });
    };
    for (const g of data.gaps) {
      anchors.community(g.community);
      if (g.via) via(g.community, g.category);
      // the 买菜替代 shop, when the inventory lists it
      const alt = g.alt && result.communities.find((c) => c.name === g.community)?.checks?.[g.category]?.alt;
      if (alt) anchors.poi({ uid: alt.uid, name: alt.name });
    }
    for (const c of covered) {
      anchors.community(c.community);
      if (c.via) via(c.community, c.category);
    }
    for (const p of pending) anchors.community(p.community);
    if (community) anchors.community(community);
    return { summary, data, facts: book.facts, anchors: anchors.anchors };
  },
});
