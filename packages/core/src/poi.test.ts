import { describe, expect, it } from 'vitest';

import { readRaw, zjA, zjFrame } from '../test/fixtures.js';
import type { BaiduPlaceResult } from './poi.js';
import {
  categorize,
  cleanPois,
  countFacilities,
  facilitiesFor,
  normalizeName,
  routingPoint,
  stallMarketName,
} from './poi.js';
import { acceptedCategories } from './standards.js';

const frame = zjFrame();
const project = frame.toXY;
const search = (file: string) =>
  readRaw<{ status: number; results: BaiduPlaceResult[] }>(`research/api-probe/raw/${file}`).response.results;
const yaodian = search('08a_v3_around_yaodian_A.json');
const multi = search('08c_v2_search_multi_A.json');

/** A synthetic place result at local (x, y). */
function place(
  uid: string,
  name: string,
  tag: string,
  x: number,
  y: number,
  extra: { navi?: [number, number]; parent?: string } = {},
): BaiduPlaceResult {
  const ll = (px: number, py: number) => {
    const [lng, lat] = frame.toLngLat(px, py);
    return { lng, lat };
  };
  return {
    uid,
    name,
    location: ll(x, y),
    detail_info: {
      classified_poi_tag: tag,
      ...(extra.navi ? { navi_location: ll(...extra.navi) } : {}),
      ...(extra.parent ? { parent_id: extra.parent } : {}),
    },
  };
}

describe('cleaning real Baidu place search results', () => {
  it('keeps the 11 pharmacies of the v3 search, routed to their entrances', () => {
    const { pois, dropped } = cleanPois(yaodian, { project });
    expect(dropped).toEqual([]);
    expect(pois).toHaveLength(11);
    expect(pois.every((p) => p.cat === '药店' && p.navi_xy !== null && p.source === 'baidu')).toBe(true);
    const p = pois.find((q) => q.name === '益丰大药房(高木桥店)')!;
    expect(routingPoint(p)).toEqual(p.navi_xy);
    expect(p.straight_m).toBeCloseTo(234.1, 0);
  });

  it('merges v2 and v3 answers by uid and sorts markets, stalls, fresh supermarkets and schools', () => {
    const { pois, dropped } = cleanPois([...yaodian, ...multi], { project });
    expect(dropped).toEqual([]);
    expect(pois).toHaveLength(18);
    const count = (cat: string) => pois.filter((p) => p.cat === cat).length;
    expect([count('药店'), count('小学'), count('菜市场'), count('生鲜超市')]).toEqual([11, 3, 3, 1]);
    const by = (name: string) => pois.find((p) => p.name === name)!;
    const market = by('浦商邻里荟(孙桥店)');
    expect(market).toMatchObject({ cat: '菜市场', market_name: '孙桥菜市场' });
    expect(market.stall_of).toBeUndefined();
    // stall by its name and its parent_id
    expect(by('英英肉店(孙桥菜市场店)')).toMatchObject({
      cat: '菜市场',
      stall_of: '孙桥菜市场',
      stall_of_uid: market.uid,
    });
    // stall by name, matched to the market 13 m away (its own parent_id points elsewhere)
    expect(by('雨润生鲜精选(孙桥菜市场店)')).toMatchObject({
      stall_of: '孙桥菜市场',
      stall_of_uid: market.uid,
    });
    // a fresh supermarket inside the market: its own category, but part of the market entity
    expect(by('优品生鲜(孙桥菜场店)')).toMatchObject({ cat: '生鲜超市', stall_of: '孙桥菜市场' });
    expect(by('上海市浦东新区育华学校(雪英校区)').cat).toBe('小学');
    expect(countFacilities(pois, '菜市场')).toBe(1);
  });

  it('agrees with the POIs stored in the zj-a sample', () => {
    const { pois } = cleanPois([...yaodian, ...multi], { project });
    const stored = zjA().pois.filter((p) => p.source === 'baidu');
    for (const p of pois) {
      const s = stored.find((q) => q.uid === p.uid)!;
      expect([p.name, p.cat, p.stall_of ?? null, p.market_name ?? null]).toEqual([
        s.name,
        s.cat,
        s.stall_of ?? null,
        s.market_name ?? null,
      ]);
      expect(Math.hypot(p.xy[0] - s.xy[0], p.xy[1] - s.xy[1])).toBeLessThan(1);
      expect(Math.hypot(p.navi_xy![0] - s.navi_xy![0], p.navi_xy![1] - s.navi_xy![1])).toBeLessThan(1);
    }
  });

  it('builds facility sets per rule: stalls are market entrances, fresh supermarkets count only under GB 50180', () => {
    const { pois } = cleanPois([...multi, place('fx', '盒马鲜生(张江店)', '购物;超市;生鲜超市', 100, 100)], {
      project,
    });
    const task = facilitiesFor(pois, acceptedCategories('菜市场', 'task'));
    const gb = facilitiesFor(pois, acceptedCategories('菜市场', 'gb50180'));
    expect(task.map((p) => p.name).sort()).toEqual(
      [
        '优品生鲜(孙桥菜场店)',
        '浦商邻里荟(孙桥店)',
        '英英肉店(孙桥菜市场店)',
        '雨润生鲜精选(孙桥菜市场店)',
      ].sort(),
    );
    expect(gb).toHaveLength(task.length + 1);
    expect(gb.some((p) => p.name === '盒马鲜生(张江店)')).toBe(true);
  });
});

describe('categories and blacklists', () => {
  it('takes the category from the tag and falls back to name keywords for generic tags', () => {
    expect(categorize('孙桥小学(张江校区)', '教育培训;小学')).toEqual({ cat: '小学' });
    expect(categorize('浦商邻里荟(孙桥店)', '购物;农贸市场;菜市场')).toEqual({ cat: '菜市场' });
    expect(categorize('孙桥农贸市场', '购物;市场')).toEqual({ cat: '菜市场' });
    expect(categorize('某某学校(小学部)', '教育培训;中学')).toEqual({ cat: '小学' });
    expect(categorize('优品生鲜', '购物;超市;生鲜超市')).toEqual({ cat: '生鲜超市' });
    expect(categorize('联华超市', '购物;超市')).toEqual({ cat: '超市' });
    expect(categorize('某某咖啡', '美食;咖啡厅')).toEqual({ cat: '其他' });
  });

  it('drops tutoring and pet or device shops that look like schools and pharmacies', () => {
    const { pois, dropped } = cleanPois(
      [
        place('a', '学而思英语(小学部)', '教育培训;培训机构', 0, 100),
        place('b', '阳光小学生托管中心', '教育培训;培训机构', 0, 200),
        place('c', '某某实验小学', '教育培训;小学', 0, 300),
        place('d', '瑞派宠物药房', '医疗;药店', 0, 400),
        place('e', '惠民兽药店', '医疗;药店', 0, 500),
        place('f', '鱼跃医疗器械专卖', '医疗;药店', 0, 600),
        place('g', '国大药房', '医疗;药店', 0, 700),
        place('h', '星巴克', '美食;咖啡厅', 0, 800),
      ],
      { project },
    );
    expect(pois.map((p) => p.uid)).toEqual(['c', 'g']);
    expect(Object.fromEntries(dropped.map((d) => [d.uid, d.reason]))).toEqual({
      a: 'blacklist:英语',
      b: 'blacklist:托管',
      d: 'blacklist:宠物',
      e: 'blacklist:兽药',
      f: 'blacklist:医疗器械',
      h: 'uncategorized',
    });
    expect(
      cleanPois([place('h', '星巴克', '美食;咖啡厅', 0, 0)], { project, keepOther: true }).pois[0]!.cat,
    ).toBe('其他');
  });
});

describe('stalls and duplicates', () => {
  const market = place('m', '孙桥农贸市场', '购物;农贸市场;菜市场', 0, 0);

  it('attaches stall-type shops near a market and drops them elsewhere', () => {
    const { pois, dropped } = cleanPois(
      [market, place('s1', '王记水产', '购物;水产', 40, 0), place('s2', '李记水产', '购物;水产', 300, 0)],
      { project },
    );
    expect(pois.find((p) => p.uid === 's1')).toMatchObject({
      cat: '菜市场',
      stall_of: '孙桥农贸市场',
      stall_of_uid: 'm',
    });
    expect(dropped).toEqual([{ uid: 's2', name: '李记水产', reason: 'uncategorized' }]);
    expect(stallMarketName('英英肉店(孙桥菜场店)')).toBe('孙桥菜市场');
    expect(stallMarketName('益丰大药房(川杨店)')).toBeNull();
  });

  it('keeps a pharmacy inside a market building as a pharmacy', () => {
    const { pois } = cleanPois(
      [market, place('p', '益丰大药房(菜场店)', '医疗;药店', 10, 0, { parent: 'm' })],
      { project },
    );
    expect(pois.find((p) => p.uid === 'p')).toMatchObject({ cat: '药店' });
    expect(pois.find((p) => p.uid === 'p')!.stall_of).toBeUndefined();
  });

  it('merges same-category children and same names within 30 m, keeping the entrance', () => {
    const { pois, dropped } = cleanPois(
      [
        place('s', '孙桥小学（张江校区）', '教育培训;小学', 0, 0),
        place('s-gate', '孙桥小学(张江校区)-东门', '教育培训;小学', 80, 0, { parent: 's', navi: [85, 0] }),
        place('dup', '孙桥小学(张江校区)', '教育培训;小学', 20, 10, { navi: [25, 12] }),
        place('far', '孙桥小学(张江校区)', '教育培训;小学', 400, 0),
        place('ph', '益丰大药房', '医疗;药店', 5, 5),
      ],
      { project },
    );
    // the gate folds into its school first and hands over its entrance, so the school record stays
    expect(pois.map((p) => p.uid)).toEqual(['s', 'far', 'ph']);
    const kept = pois[0]!;
    expect(kept.merged_uids).toEqual(['s-gate', 'dup']);
    expect(kept.navi_xy![0]).toBeCloseTo(85, 0);
    expect(dropped.map((d) => d.reason)).toEqual(['duplicate:parent s', 'duplicate:name s']);
    // without an entrance of its own the first record yields to a copy that has one
    const swap = cleanPois(
      [
        place('a', '国大药房', '医疗;药店', 0, 0),
        place('b', '国大药房', '医疗;药店', 10, 0, { navi: [12, 0] }),
      ],
      { project },
    );
    expect(swap.pois.map((p) => p.uid)).toEqual(['b']);
    expect(normalizeName('孙桥小学（张江校区）')).toBe(normalizeName('孙桥小学(张江校区)'));
  });

  it('fills a missing entrance from a later copy of the same uid', () => {
    const noNavi = place('u', '国大药房', '医疗;药店', 0, 100);
    const withNavi = place('u', '国大药房', '医疗;药店', 0, 100, { navi: [0, 90] });
    const { pois } = cleanPois([noNavi, withNavi], { project });
    expect(pois).toHaveLength(1);
    expect(pois[0]!.navi_xy![1]).toBeCloseTo(90, 0);
  });
});
