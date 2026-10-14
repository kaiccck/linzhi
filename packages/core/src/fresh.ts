/**
 * 买菜替代 (fresh-food substitutes): where a community's 菜市场 check is a verified gap, the nearest shop
 * within the rule on foot where vegetables can be bought. Informational only: the check's verdict and
 * every count stay as they are. Shanghai's own guidance counts only indoor wet markets (室内菜场) but
 * lets an existing 菜店 stand in inside a blind spot, so a substitute reads 有替代, never 已覆盖; and
 * Baidu's 超市 category mixes grocery supermarkets with variety stores, so only these shops count
 * (freshKind, FRESH_RULE_TEXT):
 *
 *   生鲜超市  Baidu's 生鲜超市 category
 *   果蔬店    a shop whose tag says 果蔬 / 蔬菜 / 菜店, or whose name says 蔬菜 / 果蔬 / 蔬果 / 菜店 / 生鲜
 *   超市      a 超市 whose name starts with a chain known to sell fresh produce (FRESH_CHAINS)
 *   (chain)   a store of a produce chain, whatever Baidu tags it (PRODUCE_CHAINS: 盒马, 清美, 谊品生鲜 →
 *             生鲜超市, 钱大妈 → 果蔬店)
 *
 * Never: a market or a stall inside one (it is the market itself, the check has it already), what the
 * curated exclusions remove (前置仓 of online grocers), convenience stores (联华快客 is one), variety and
 * daily-goods chains, fruit chains (百果园: fruit only), restaurants, and single-line shops (butchers,
 * fishmongers …) whatever their name.
 *
 * Flow (engine fresh.ts):
 *
 *   candidates = freshCandidates(pois, { exclusions })                   // what the check does not count
 *   want = planFreshAlternatives(gaps, candidates, routes, { rule_m })    // the k nearest within the rule
 *   for batch of planMatrixBatches(gaps, want): routes.push(...)
 *   alts = mergeFreshAlternatives(gaps, candidates, routes, { rule_m })   // shortest walk ≤ rule, or null
 */
import type { XY } from './coords.js';
import {
  pruneCandidates,
  rankCandidates,
  type CoverageCandidate,
  type DemandPoint,
  type OdDestination,
  type RoutedPair,
} from './coverage.js';
import { excludedByPattern, excludes, type FacilityExclusion } from './exclusions.js';
import { routingPoint } from './poi.js';
import type { FreshAlternative, FreshKind, Poi } from './types.js';

/**
 * Supermarket chains known to sell fresh produce. A 超市 counts when its name starts with one (after an
 * optional 上海 or Latin brand prefix, e.g. ALDI奥乐齐): 天天乐购超市 or 物美价廉超市 are no branches.
 * 世纪华联 is the franchise banner of 华联.
 */
export const FRESH_CHAINS: readonly string[] = [
  '联华',
  '世纪联华',
  '华联',
  '世纪华联',
  '农工商',
  '大润发',
  '家乐福',
  '麦德龙',
  '山姆',
  '盒马',
  '超盒算',
  '永辉',
  '奥乐齐',
  '物美',
  '百联',
  '易买得',
  '乐购',
];

/**
 * Produce chains whose stores sell vegetables whatever Baidu tags them (清美生鲜(荣科路店) is filed under
 * 美食, 钱大妈 at times under 肉店): a shop whose name starts with one counts as that kind. 盒马, 清美
 * and 谊品生鲜 run fresh-food supermarkets (Baidu tags most of their stores 生鲜超市); 钱大妈 runs small
 * community stores of vegetables, fruit and meat, a 果蔬店. 盒马NB is 盒马's discount supermarket and
 * counts through FRESH_CHAINS as a 超市.
 */
export const PRODUCE_CHAINS: Readonly<Record<string, FreshKind>> = {
  盒马: '生鲜超市',
  清美: '生鲜超市',
  谊品生鲜: '生鲜超市',
  钱大妈: '果蔬店',
};

/** Fruit chains: no vegetables, whatever Baidu tags them or the name says. */
export const FRUIT_CHAINS: readonly string[] = ['百果园'];

/** Candidates routed per gap point (nearest first, by straight line). */
export const FRESH_ALT_K = 2;

/** The rule in one Chinese sentence, for the UI and the report to quote. */
export const FRESH_RULE_TEXT =
  '买菜替代指菜市场判定为缺口的小区在判定距离内步行能到的能买菜的店——百度归为生鲜超市的店，' +
  '标签或店名写明蔬菜、果蔬、菜店或生鲜的购物店（肉店、水产、熟食等只卖一类的店除外），' +
  `${Object.keys(PRODUCE_CHAINS).join('、')}的门店（不论百度如何分类），` +
  `或${FRESH_CHAINS.join('、')}的超市门店；便利店、百货杂货连锁、${FRUIT_CHAINS.join('、')}等只卖水果的店、` +
  '线上买菜的前置仓和菜市场里的摊位不算，替代只作参考，不算覆盖，也不改变任何判定和计数。';

const CONVENIENCE_TAG = /便利店/;
/** Convenience brands (联华快客 is 联华's convenience chain) and variety / daily-goods chains. */
// (no lookbehind: the mini program runs on JavaScript engines without it — iOS before 16.4)
const NOT_GROCERY_NAME =
  /便利|快客|全家(?!福)|罗森|(?:^|[^0-9])7-?(?:eleven|11)(?![0-9])|好德|可的|喜士多|美宜佳|全球优品|名创优品|屈臣氏|九木杂物社|无印良品|KKV/i;
/** Shops that sell one line only, whatever their name says (雨润生鲜精选 is a butcher). */
const SINGLE_LINE_TAG = /肉店|水产|海鲜|禽|蛋品|豆制品|熟食/;
const PRODUCE_TAG = /果蔬|蔬菜|菜店/;
const PRODUCE_NAME = /蔬菜|果蔬|蔬果|菜店|生鲜/;
const CHAIN_NAME = new RegExp(`^(?:上海)?(?:[A-Za-z]+\\s*)?(?:${FRESH_CHAINS.join('|')})(?!价廉)`, 'i');
// 盒马NB is a discount supermarket (a 超市 through FRESH_CHAINS), not one of 盒马's fresh-food formats
const PRODUCE_CHAIN_NAME = new RegExp(`^(?:上海)?(${Object.keys(PRODUCE_CHAINS).join('|')})(?!NB)`, 'i');
const FRUIT_CHAIN_NAME = new RegExp(`^(?:上海)?(?:${FRUIT_CHAINS.join('|')})`);

/**
 * Why a POI counts as a 买菜替代, or null when it does not (rules in the header). `exclusions` are the
 * curated ones (data/official/exclusions.json): by uid, or by name pattern whatever the category.
 */
export function freshKind(
  p: Pick<Poi, 'uid' | 'name' | 'cat' | 'tag' | 'stall_of' | 'merged_uids'>,
  exclusions: readonly FacilityExclusion[] = [],
): FreshKind | null {
  // a market and its stalls are what the 菜市场 check is about
  if (p.cat === '菜市场' || p.stall_of) return null;
  if (excludedByPattern(p.name, exclusions) || exclusions.some((x) => excludes(x, p))) return null;
  const name = p.name.normalize('NFKC');
  const tag = p.tag ?? '';
  // the chains are known by name, whatever Baidu's tag says (美食, 便利店, 肉店 …)
  if (FRUIT_CHAIN_NAME.test(name)) return null;
  const chain = PRODUCE_CHAIN_NAME.exec(name);
  if (chain && !NOT_GROCERY_NAME.test(name)) return PRODUCE_CHAINS[chain[1]!] ?? null;
  if (CONVENIENCE_TAG.test(tag) || NOT_GROCERY_NAME.test(name)) return null;
  if (p.cat === '生鲜超市') return '生鲜超市';
  // shops only: a restaurant named 川菜店 or 生鲜火锅 sells no vegetables
  const shop = tag.startsWith('购物') || p.cat === '超市';
  if (!shop || SINGLE_LINE_TAG.test(tag)) return null;
  if (PRODUCE_TAG.test(tag) || PRODUCE_NAME.test(name)) return '果蔬店';
  if (p.cat === '超市' && CHAIN_NAME.test(name)) return '超市';
  return null;
}

export interface FreshCandidate {
  poi: Poi;
  kind: FreshKind;
}

/** The 买菜替代 candidates among POIs: Baidu POIs whose freshKind is not null (never a 菜市场 or its stalls). */
export function freshCandidates(
  pois: readonly Poi[],
  opts: { exclusions?: readonly FacilityExclusion[] } = {},
): FreshCandidate[] {
  const out: FreshCandidate[] = [];
  const seen = new Set<string>();
  for (const poi of pois) {
    if (poi.source !== 'baidu' || seen.has(poi.uid)) continue;
    const kind = freshKind(poi, opts.exclusions);
    if (!kind) continue;
    seen.add(poi.uid);
    out.push({ poi, kind });
  }
  return out;
}

export interface FreshAltOptions {
  /** The 菜市场 rule distance, metres. */
  rule_m: number;
  /** Nearest candidates routed per point (default FRESH_ALT_K). */
  k?: number;
  /**
   * Distance from the analysis centre (the origin of the local frame) within which the candidate list
   * is complete; a point whose rule disk reaches beyond it never gets null, as a nearer shop may be
   * missing. Default Infinity.
   */
  known_m?: number;
  /** m/s for a route Baidu gave no duration for (default 1.17). */
  speed?: number;
}

const r1 = (v: number) => Math.round(v * 10) / 10;

function routesOf(routes: readonly RoutedPair[]): Map<string, Map<string, RoutedPair>> {
  const out = new Map<string, Map<string, RoutedPair>>();
  for (const r of routes) {
    let m = out.get(r.origin_id);
    if (!m) out.set(r.origin_id, (m = new Map()));
    const prev = m.get(r.dest_id);
    // a failed attempt never hides a successful one
    if (!prev || (prev.route_m === null && r.route_m !== null)) m.set(r.dest_id, r);
  }
  return out;
}

/** Candidates whose entrance lies within the rule, nearest first: a walk is never shorter than that. */
function inRange(point: DemandPoint, pois: readonly Poi[], rule: number): CoverageCandidate[] {
  return pruneCandidates(rankCandidates(point.xy, pois), rule);
}

/**
 * Destinations to route per gap point: the k nearest candidates within the rule (by straight line to
 * the entrance) that were never routed from it. Routes already measured are reused, never asked again.
 */
export function planFreshAlternatives(
  points: readonly DemandPoint[],
  candidates: readonly FreshCandidate[],
  routes: readonly RoutedPair[],
  opts: FreshAltOptions,
): Map<string, OdDestination[]> {
  const k = opts.k ?? FRESH_ALT_K;
  const pois = candidates.map((c) => c.poi);
  const byOrigin = routesOf(routes);
  const out = new Map<string, OdDestination[]>();
  for (const p of points) {
    const mine = byOrigin.get(p.id);
    const want = inRange(p, pois, opts.rule_m)
      .slice(0, k)
      .filter((c) => !mine?.has(c.poi.uid))
      .map((c): OdDestination => ({ id: c.poi.uid, xy: routingPoint(c.poi), poi: c.poi }));
    if (want.length) out.set(p.id, want);
  }
  return out;
}

/**
 * The 买菜替代 of every gap point from the routes measured: the candidate within the rule with the
 * shortest measured walk ≤ rule (any candidate routed from the point counts, not only the k nearest);
 * null when none qualifies although the k nearest were all routed (a "no route" answer included) and
 * the candidate list is complete out to the point's rule disk. A point without an entry was not looked
 * at (a batch skipped for budget or failed, or a list that may miss a nearer shop).
 */
export function mergeFreshAlternatives(
  points: readonly DemandPoint[],
  candidates: readonly FreshCandidate[],
  routes: readonly RoutedPair[],
  opts: FreshAltOptions,
): Map<string, FreshAlternative | null> {
  const rule = opts.rule_m;
  const k = opts.k ?? FRESH_ALT_K;
  const known = opts.known_m ?? Infinity;
  const speed = opts.speed ?? 1.17;
  const kind = new Map(candidates.map((c) => [c.poi.uid, c.kind]));
  const pois = candidates.map((c) => c.poi);
  const byOrigin = routesOf(routes);
  const out = new Map<string, FreshAlternative | null>();
  for (const p of points) {
    const mine = byOrigin.get(p.id);
    const ranked = inRange(p, pois, rule);
    let best: { c: CoverageCandidate; route_m: number; dur_s: number } | null = null;
    for (const c of ranked) {
      const r = mine?.get(c.poi.uid);
      if (!r || r.route_m === null || !(r.route_m > 0) || r.route_m > rule) continue;
      const dur = r.dur_s !== null && r.dur_s > 0 ? r.dur_s : Math.round(r.route_m / speed);
      if (!best || r.route_m < best.route_m || (r.route_m === best.route_m && dur < best.dur_s)) {
        best = { c, route_m: r.route_m, dur_s: dur };
      }
    }
    if (best) {
      const xy: XY = routingPoint(best.c.poi);
      out.set(p.id, {
        name: best.c.poi.name,
        uid: best.c.poi.uid,
        kind: kind.get(best.c.poi.uid)!,
        xy: [r1(xy[0]), r1(xy[1])],
        // to the entrance the walk ends at: never longer than the walk
        straight_m: r1(best.c.bound_m),
        route_m: best.route_m,
        dur_s: best.dur_s,
      });
      continue;
    }
    // nothing within the rule on foot: a verdict only when the nearest were asked and nothing is missing
    if (ranked.slice(0, k).some((c) => !mine?.has(c.poi.uid))) continue;
    if (Math.hypot(p.xy[0], p.xy[1]) + rule > known) continue;
    out.set(p.id, null);
  }
  return out;
}
