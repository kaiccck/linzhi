import { describe, expect, it } from 'vitest';

import { readJson, zjA } from '../test/fixtures.js';
import type { XY } from './coords.js';
import type { DemandPoint, RoutedPair } from './coverage.js';
import type { ExclusionList, FacilityExclusion } from './exclusions.js';
import {
  FRESH_ALT_K,
  FRESH_CHAINS,
  FRESH_RULE_TEXT,
  freshCandidates,
  freshKind,
  FRUIT_CHAINS,
  mergeFreshAlternatives,
  planFreshAlternatives,
  PRODUCE_CHAINS,
} from './fresh.js';
import { ruleDistance } from './standards.js';
import type { FacilityCategory, Poi } from './types.js';

const shop = (name: string, cat: FacilityCategory, tag: string, extra: Partial<Poi> = {}): Poi => ({
  uid: name,
  name,
  cat,
  tag,
  xy: [0, 0],
  navi_xy: null,
  source: 'baidu',
  ...extra,
});

/** data/official/exclusions.json: the 前置仓 of online grocers go by name pattern. */
const EXCLUSIONS = readJson<ExclusionList>('data/official/exclusions.json').entries;

describe('freshKind: which shops sell vegetables', () => {
  it('counts Baidu 生鲜超市, shops that say they sell produce, and branches of fresh-food chains', () => {
    const kind = (name: string, cat: FacilityCategory, tag: string) => freshKind(shop(name, cat, tag));
    expect(kind('如海生鲜超市(中科路店)', '生鲜超市', '购物;超市;生鲜超市')).toBe('生鲜超市');
    // the same brand filed under plain 超市: its name says 生鲜
    expect(kind('如海生鲜超市(益江路店)', '超市', '购物;超市')).toBe('果蔬店');
    expect(kind('百姓蔬菜', '超市', '购物;超市;果蔬超市')).toBe('果蔬店');
    // a 水果店 that also sells vegetables says so in its name (cleaned with keepOther: category 其他)
    expect(kind('百姓生鲜蔬果(益江路店)', '其他', '购物;水果店')).toBe('果蔬店');
    expect(kind('阿婆菜店', '其他', '购物;商铺')).toBe('果蔬店');
    for (const name of [
      '联华超市(益江店)',
      '联华(盛夏店)',
      '华联超市(虹御公寓店)',
      '世纪华联超市(张江店)',
      '世纪联华(金桥店)',
      '超盒算NB(大橘天地张江店)',
      '盒马NB(张江店)',
      '农工商超市(孙桥店)',
      '上海联华超市(川杨店)',
      'ALDI奥乐齐(张江店)',
      '奥乐齐(浦东嘉里城店)',
      '大润发(杨高南路店)',
    ]) {
      expect(kind(name, '超市', '购物;超市'), name).toBe('超市');
    }
    expect(kind('联华超市(益江店)', '超市', '购物;超市;大型超市')).toBe('超市');
  });

  it('never counts convenience stores, variety chains, markets, stalls or single-line shops', () => {
    const kind = (name: string, cat: FacilityCategory, tag: string, extra: Partial<Poi> = {}) =>
      freshKind(shop(name, cat, tag, extra));
    // 联华快客 is 联华's convenience chain, whatever Baidu files it under
    expect(kind('联华快客(张江店)', '超市', '购物;超市')).toBeNull();
    expect(kind('联华快客(孙桥路店)', '其他', '购物;便利店')).toBeNull();
    for (const name of [
      '全家(张江店)',
      '罗森(科苑路店)',
      '7-ELEVEn(晨晖路店)',
      '好德便利(孙桥店)',
      '可的便利',
    ]) {
      expect(kind(name, '超市', '购物;超市'), name).toBeNull();
    }
    expect(kind('喜士多生鲜便利', '生鲜超市', '购物;超市;生鲜超市')).toBeNull();
    expect(kind('某某超市', '超市', '购物;超市;便利店')).toBeNull();
    for (const name of ['全球优品(玉兰香苑四期店)', '名创优品(长泰广场店)', '屈臣氏(张江店)']) {
      expect(kind(name, '超市', '购物;超市'), name).toBeNull();
    }
    // a 超市 that is no branch of a fresh-food chain
    for (const name of [
      '惠民超市(申城佳苑店)',
      '天天乐购超市(张江店)',
      '物美价廉超市',
      '联润烟酒',
      '华夏超市',
    ]) {
      expect(kind(name, '超市', '购物;超市'), name).toBeNull();
    }
    // a stall inside a market is the market itself; so is the market
    expect(
      kind('优品生鲜(孙桥菜场店)', '生鲜超市', '购物;超市;生鲜超市', { stall_of: '孙桥菜市场' }),
    ).toBeNull();
    expect(kind('浦商邻里荟(孙桥店)', '菜市场', '购物;农贸市场;菜市场')).toBeNull();
    // butchers and restaurants, whatever their name says
    expect(kind('雨润生鲜精选', '其他', '购物;肉店')).toBeNull();
    expect(kind('老王川菜店', '其他', '美食;中餐厅')).toBeNull();
    expect(kind('大橙子水果超市(益江路店)', '其他', '购物;水果店')).toBeNull();
  });

  it('drops what the curated exclusions remove: the 前置仓 of online grocers', () => {
    const dingdong = shop('叮咚买菜(孙桥站)', '生鲜超市', '购物;超市;生鲜超市');
    // Baidu files the warehouse as a 生鲜超市: only the exclusion list tells it apart
    expect(freshKind(dingdong)).toBe('生鲜超市');
    expect(freshKind(dingdong, EXCLUSIONS)).toBeNull();
    expect(freshKind(shop('每日优鲜(唐镇店)', '生鲜超市', '购物;超市;生鲜超市'), EXCLUSIONS)).toBeNull();
    // by name pattern whatever the category (a row cleaned with keepOther is 其他)
    expect(freshKind(shop('美团买菜(张江生鲜站)', '其他', '购物;商铺'), EXCLUSIONS)).toBeNull();
    // real stores of the same brands stay
    expect(freshKind(shop('盒马鲜生(长泰广场店)', '生鲜超市', '购物;超市;生鲜超市'), EXCLUSIONS)).toBe(
      '生鲜超市',
    );
    const byUid: FacilityExclusion = {
      category: '超市',
      uid: 'x1',
      reason: '测试：已关店',
      source: 'https://example.gov.cn/x',
      date: '2026-09-29',
    };
    expect(freshKind(shop('联华超市(关店)', '超市', '购物;超市', { uid: 'x1' }), [byUid])).toBeNull();
  });

  it('knows produce chains by name whatever Baidu tags them, and fruit chains never count', () => {
    const kind = (name: string, cat: FacilityCategory, tag: string) => freshKind(shop(name, cat, tag));
    // measured: Baidu files this 清美 store under 美食 (cleaned with keepOther it is 其他)
    expect(kind('清美生鲜(荣科路店)', '其他', '美食')).toBe('生鲜超市');
    expect(kind('清美日日鲜(汤臣豪园店)', '生鲜超市', '购物;超市;生鲜超市')).toBe('生鲜超市');
    expect(kind('盒马鲜生(陆悦天地店)', '超市', '购物;超市')).toBe('生鲜超市');
    expect(kind('盒马mini(花木陆悦坊店)', '其他', '购物;便利店')).toBe('生鲜超市');
    expect(kind('谊品生鲜(张江店)', '其他', '购物;商铺')).toBe('生鲜超市');
    expect(kind('钱大妈(张江店)', '其他', '购物;肉店')).toBe('果蔬店');
    // 盒马NB is a discount supermarket: a 超市 of a fresh-food chain, not a 生鲜超市
    expect(kind('盒马NB(张江店)', '超市', '购物;超市')).toBe('超市');
    // the brand must start the name
    expect(kind('老街清美小吃', '其他', '美食;小吃快餐店')).toBeNull();
    // fruit only, whatever the tag or name says
    expect(kind('百果园(浦东孙桥路店)', '其他', '购物;水果店')).toBeNull();
    expect(kind('百果园(果蔬生鲜店)', '其他', '购物;果蔬生鲜')).toBeNull();
    // the curated exclusions still apply to chain stores
    const closed: FacilityExclusion = {
      category: '其他',
      uid: '清美生鲜(关店)',
      reason: '测试：已关店',
      source: 'https://example.gov.cn/x',
      date: '2026-09-29',
    };
    expect(freshKind(shop('清美生鲜(关店)', '其他', '美食'), [closed])).toBeNull();
  });

  it('states the rule in one sentence that names every chain', () => {
    expect(FRESH_RULE_TEXT.split('。').filter(Boolean)).toHaveLength(1);
    for (const chain of [...FRESH_CHAINS, ...Object.keys(PRODUCE_CHAINS), ...FRUIT_CHAINS])
      expect(FRESH_RULE_TEXT).toContain(chain);
    for (const word of ['生鲜超市', '便利店', '前置仓', '摊位', '不算覆盖', '只卖水果'])
      expect(FRESH_RULE_TEXT).toContain(word);
  });
});

describe('freshCandidates', () => {
  it('keeps Baidu shops of a fresh kind, never the market itself', () => {
    const pois = [
      shop('如海生鲜超市(中科路店)', '生鲜超市', '购物;超市;生鲜超市'),
      shop('联华超市(益江店)', '超市', '购物;超市'),
      shop('全球优品(玉兰香苑四期店)', '超市', '购物;超市'),
      shop('益江菜场', '菜市场', 'osm:amenity=marketplace', { source: 'osm' }),
      shop('百姓蔬菜', '超市', '购物;超市;果蔬超市', { source: 'osm' }),
      shop('联华超市(益江店)', '超市', '购物;超市'),
    ];
    expect(freshCandidates(pois).map((c) => [c.poi.name, c.kind])).toEqual([
      ['如海生鲜超市(中科路店)', '生鲜超市'],
      ['联华超市(益江店)', '超市'],
    ]);
  });
});

describe('the 买菜替代 of a gap: the k nearest within the rule routed, the shortest walk kept', () => {
  // S1 behind a wall (a 1,200 m walk), U1 the nearest walk, U2 third by straight line, F far away
  const cand = (name: string, cat: FacilityCategory, tag: string, xy: XY, navi: XY | null = null) =>
    shop(name, cat, tag, { uid: name, xy, navi_xy: navi });
  const pois = [
    cand('S1', '生鲜超市', '购物;超市;生鲜超市', [300, 0]),
    cand('联华超市(北店)', '超市', '购物;超市', [0, 500], [0, 480]),
    cand('联华超市(东店)', '超市', '购物;超市', [800, 0]),
    cand('百姓蔬菜', '超市', '购物;超市;果蔬超市', [3000, 0]),
  ];
  const WALK: Record<string, number> = {
    S1: 1200,
    '联华超市(北店)': 650,
    '联华超市(东店)': 900,
    百姓蔬菜: 800,
  };
  const candidates = freshCandidates(pois);
  const measure = (want: Map<string, { id: string }[]>): RoutedPair[] =>
    [...want].flatMap(([origin, dests]) =>
      dests.map((d) => ({
        origin_id: origin,
        dest_id: d.id,
        route_m: WALK[d.id]!,
        dur_s: Math.round(WALK[d.id]! / 1.17),
      })),
    );
  const home: DemandPoint = { id: 'home', xy: [0, 0] };

  it('routes the two nearest within the rule and keeps the shortest walk within it', () => {
    const want = planFreshAlternatives([home], candidates, [], { rule_m: 1000 });
    expect(FRESH_ALT_K).toBe(2);
    // by straight line: S1 300 m, 联华超市(北店) 500 m (entrance 480 m); 联华超市(东店) is third
    expect(want.get('home')!.map((d) => d.id)).toEqual(['S1', '联华超市(北店)']);
    // routed to the entrance
    expect(want.get('home')![1]!.xy).toEqual([0, 480]);
    const alts = mergeFreshAlternatives([home], candidates, measure(want), { rule_m: 1000 });
    // straight_m is to the entrance, where the walk ends
    expect(alts.get('home')).toEqual({
      name: '联华超市(北店)',
      uid: '联华超市(北店)',
      kind: '超市',
      xy: [0, 480],
      straight_m: 480,
      route_m: 650,
      dur_s: 556,
    });
  });

  it('reuses routes already measured and counts any routed candidate within the rule', () => {
    // routes measured earlier count too (联华超市(东店) below stands for one the coverage check made)
    const earlier: RoutedPair[] = [
      { origin_id: 'home', dest_id: '联华超市(北店)', route_m: 650, dur_s: 556 },
    ];
    const want = planFreshAlternatives([home], candidates, earlier, { rule_m: 1000 });
    expect(want.get('home')!.map((d) => d.id)).toEqual(['S1']);
    const third: RoutedPair = { origin_id: 'home', dest_id: '联华超市(东店)', route_m: 610, dur_s: 521 };
    const alts = mergeFreshAlternatives([home], candidates, [...earlier, ...measure(want), third], {
      rule_m: 1000,
    });
    expect(alts.get('home')).toMatchObject({ name: '联华超市(东店)', route_m: 610, kind: '超市' });
  });

  it('says none only when the nearest were asked and the list is complete that far out', () => {
    // under 500 m only S1 (a 1,200 m walk) and 联华超市(北店) (650 m) are in range: none qualifies
    const want = planFreshAlternatives([home], candidates, [], { rule_m: 500 });
    const routes = measure(want);
    expect(mergeFreshAlternatives([home], candidates, routes, { rule_m: 500 }).get('home')).toBeNull();
    // a "no route" answer is an answer
    const noRoute = routes.map((r) => ({ ...r, route_m: null, dur_s: null }));
    expect(mergeFreshAlternatives([home], candidates, noRoute, { rule_m: 500 }).get('home')).toBeNull();
    // one of the two nearest never routed (budget, a failed batch): not looked
    const partial = mergeFreshAlternatives([home], candidates, routes.slice(0, 1), { rule_m: 500 });
    expect(partial.has('home')).toBe(false);
    // nothing within the rule at all: none, unless the list may miss a shop that far out
    const far: DemandPoint = { id: 'far', xy: [0, -900] };
    expect(planFreshAlternatives([far], candidates, [], { rule_m: 300 }).size).toBe(0);
    expect(mergeFreshAlternatives([far], candidates, [], { rule_m: 300 }).get('far')).toBeNull();
    const cut = mergeFreshAlternatives([far], candidates, [], { rule_m: 300, known_m: 1000 });
    expect(cut.has('far')).toBe(false);
    expect(
      mergeFreshAlternatives([far], candidates, [], { rule_m: 300, known_m: 1200 }).get('far'),
    ).toBeNull();
  });

  it('keeps a shop found beyond the complete part of the list: it is still within the rule on foot', () => {
    const want = planFreshAlternatives([home], candidates, [], { rule_m: 1000 });
    const alts = mergeFreshAlternatives([home], candidates, measure(want), { rule_m: 1000, known_m: 100 });
    expect(alts.get('home')).toMatchObject({ name: '联华超市(北店)' });
  });
});

describe('the zj-a sample', () => {
  it('rebuilds every stored 买菜替代 from the saved search and routes (bv_fresh_A.json)', () => {
    const zj = zjA();
    const book = readJson<{
      query: { known_m: number | null };
      candidates: Pick<Poi, 'uid' | 'name' | 'cat' | 'tag' | 'xy' | 'navi_xy'>[];
      routes: {
        community: string;
        to: { uid: string; distance_m: number | null; duration_s: number | null }[];
      }[];
    }>('research/zhangjiang/raw/bv_fresh_A.json');
    const pool: Poi[] = [...zj.pois, ...book.candidates.map((c) => ({ ...c, source: 'baidu' as const }))];
    const routes: RoutedPair[] = book.routes.flatMap((r) =>
      r.to.map((t) => ({
        origin_id: r.community,
        dest_id: t.uid,
        route_m: t.distance_m,
        dur_s: t.duration_s,
      })),
    );
    let alts = 0;
    let nones = 0;
    const gaps = zj.communities
      .filter((c) => c.checks['菜市场'].verified && c.checks['菜市场'].status_main !== '覆盖')
      .map((c) => ({ id: c.name, xy: c.centroid }));
    const got = mergeFreshAlternatives(gaps, freshCandidates(pool, { exclusions: EXCLUSIONS }), routes, {
      rule_m: ruleDistance('菜市场')!,
      known_m: book.query.known_m ?? Infinity,
    });
    for (const c of zj.communities) {
      const stored = c.checks['菜市场'].alt;
      expect(stored, c.name).toEqual(got.get(c.name));
      if (stored) alts++;
      else if (stored === null) nones++;
    }
    // both 菜市场 gaps walk to 如海生鲜超市(中科路店)
    expect([alts, nones]).toEqual([2, 0]);
  });
});
