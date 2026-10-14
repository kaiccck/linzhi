import { describe, expect, it } from 'vitest';

import { readJson, readRaw, zjA, zjFrame } from '../test/fixtures.js';
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

  it('agrees with the POIs stored in the zj-a sample (minus the curated exclusions)', () => {
    const { pois } = cleanPois([...yaodian, ...multi], { project });
    const stored = zjA().pois.filter((p) => p.source === 'baidu');
    const excluded = new Set(
      readJson<{ entries: { uid?: string }[] }>('data/official/exclusions.json').entries.map((e) => e.uid),
    );
    const gone = pois.filter((p) => !stored.some((q) => q.uid === p.uid));
    expect(gone.map((p) => p.name)).toEqual(['上海市浦东新区育华学校(雪英校区)']);
    for (const p of pois) {
      if (excluded.has(p.uid)) continue;
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

  it('builds the 菜市场 facility set: stalls are market entrances, fresh supermarkets never count', () => {
    const { pois } = cleanPois([...multi, place('fx', '盒马鲜生(张江店)', '购物;超市;生鲜超市', 100, 100)], {
      project,
    });
    const market = facilitiesFor(pois, ['菜市场']);
    expect(market.map((p) => p.name).sort()).toEqual(
      [
        '优品生鲜(孙桥菜场店)',
        '浦商邻里荟(孙桥店)',
        '英英肉店(孙桥菜市场店)',
        '雨润生鲜精选(孙桥菜市场店)',
      ].sort(),
    );
    expect(pois.some((p) => p.name === '盒马鲜生(张江店)' && p.cat === '生鲜超市')).toBe(true);
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

  it('files 社区卫生 and the other 民生设施 under 养老, 地铁, 公交, 公园 and 超市', () => {
    expect(categorize('张江社区卫生服务中心', '医疗;综合医院')).toEqual({ cat: '社区卫生' });
    expect(categorize('孙桥社区卫生服务站', '医疗;诊所')).toEqual({ cat: '社区卫生' });
    expect(categorize('合庆镇卫生院', '医疗;综合医院')).toEqual({ cat: '社区卫生' });
    expect(categorize('公利医院', '医疗;综合医院')).toEqual({ cat: '其他' });
    expect(categorize('张江镇敬老院', '生活服务;养老院')).toEqual({ cat: '养老' });
    expect(categorize('孙桥社区老年人日间照料中心', '生活服务;其他')).toEqual({ cat: '养老' });
    expect(categorize('张江镇长者照护之家', '生活服务;其他')).toEqual({ cat: '养老' });
    expect(categorize('孙桥社区长者食堂', '美食;中餐厅')).toEqual({ cat: '养老' });
    expect(categorize('张江镇综合为老服务中心', '生活服务;其他')).toEqual({ cat: '养老' });
    // a buffet is a restaurant (餐饮), never an elderly meal point (助餐)
    expect(categorize('金钱豹自助餐', '美食;自助餐')).toEqual({ cat: '餐饮' });
    expect(categorize('鹏海绿地公园', '旅游景点;公园')).toEqual({ cat: '公园' });
    expect(categorize('万科翡翠公园', '房地产;住宅区')).toEqual({ cat: '其他' });
    // the everyday services counted from the centre (tags as Baidu answered, research/category-probe)
    expect(categorize('华东师范大学附属东昌中学(南校张江校区)', '教育培训;中学')).toEqual({ cat: '中学' });
    expect(categorize('全家便利店(孙桥路店)', '购物;便利店')).toEqual({ cat: '便利店' });
    expect(categorize('沙县小吃(申城佳苑店)', '美食;小吃快餐店')).toEqual({ cat: '餐饮' });
    expect(categorize('孙桥长者食堂', '美食;中餐厅')).toEqual({ cat: '养老' });
    // a produce shop Baidu tags 美食 is no restaurant (清美生鲜 around 万科翡翠公园)
    expect(categorize('清美生鲜(荣科路店)', '美食;其他')).toEqual({ cat: '其他' });
    expect(categorize('菜鸟驿站(孙环路34号店)', '生活服务;物流公司')).toEqual({ cat: '快递' });
    expect(categorize('孙耀路居民区党群服务站', '政府机构')).toEqual({ cat: '其他' });
    expect(categorize('中国农业银行(上海孙桥现代农业开发区支行)', '金融;银行')).toEqual({ cat: '银行' });
    expect(categorize('中国农业银行24小时自助银行', '金融;atm')).toEqual({ cat: '其他' });
    expect(categorize('张江镇市民健身中心', '运动健身;健身中心')).toEqual({ cat: '健身' });
    expect(categorize('麦8赫桌球棋牌(高木桥路店)', '运动健身;其他')).toEqual({ cat: '其他' });
    expect(categorize('张江图书馆', '教育培训;图书馆')).toEqual({ cat: '文化' });
    expect(categorize('浦东新区张江镇社区文化活动中心', '政府机构')).toEqual({ cat: '文化' });

    // a recorded union of the same kinds (社区卫生服务中心$养老院$幼儿园$超市$公交站$地铁站$公园$菜场)
    const mix = search('06d_place_v3_around_community_mix_p0.json');
    const { pois, dropped } = cleanPois(mix, { project });
    const cats = (cat: string) => pois.filter((p) => p.cat === cat).map((p) => p.name);
    expect(cats('公交')).toHaveLength(11);
    expect(cats('地铁')).toEqual(['华夏中路']);
    expect(cats('公园')).toEqual(['鹏海绿地公园']);
    expect(cats('幼儿园')).toEqual(['民办兴满幼儿园']);
    // station exits (出入口;其他) and the lift are entrances, not facilities of their own
    expect(dropped.filter((d) => d.reason === 'uncategorized').map((d) => d.name)).toEqual(
      expect.arrayContaining(['华夏中路地铁站-1口', '无障碍电梯(华夏中路地铁站1号口)']),
    );
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

  it('keeps kindergartens, not the early-education, childcare and training businesses filed with them', () => {
    // kindergartens and their campuses as Baidu names them around 张江 (data/samples)
    for (const name of [
      '浦东新区浦电幼儿园',
      '上海浦东新区民办海川之星幼儿园',
      '东方德尚幼儿园(申江部)',
      '东方德尚幼儿园孙环部',
      '周浦幼儿园-秀康部',
      '南门幼儿园(张江分园)',
    ]) {
      expect(categorize(name, '教育培训;幼儿园'), name).toEqual({ cat: '幼儿园' });
    }
    // a kindergarten's own name stays one, whatever business word it holds
    expect(categorize('某某艺术幼儿园', '教育培训;幼儿园')).toEqual({ cat: '幼儿园' });
    expect(categorize('某某双语幼儿园', '教育培训;其他')).toEqual({ cat: '幼儿园' });
    expect(categorize('某某幼儿园(托育部)', '教育培训;幼儿园')).toEqual({ cat: '幼儿园' });
    // the businesses, even where Baidu tags them 幼儿园; 托育 and 托儿所 take the under-3s only
    const excluded = (name: string, tag = '教育培训;幼儿园') => categorize(name, tag).excluded;
    expect(excluded('金宝贝早教中心')).toBe('早教');
    expect(excluded('贝贝托育园')).toBe('托育');
    expect(excluded('某某幼儿园托育中心')).toBe('托育');
    expect(excluded('阳光托儿所')).toBe('托儿所');
    expect(excluded('快乐宝贝亲子园')).toBe('亲子');
    expect(excluded('某某幼儿园托管中心', '教育培训;培训机构')).toBe('托管');
    expect(excluded('小天使舞蹈(北苑幼儿园旁)', '教育培训;培训机构')).toBe('舞蹈');
    expect(excluded('某某幼小衔接培训(幼儿园店)', '教育培训;培训机构')).toBe('衔接');
    expect(excluded('童趣幼儿园用品店', '购物;其他')).toBe('用品');
  });

  it('never takes a gate or a car park for the facility whose name it carries', () => {
    // the name decides only for tags that say nothing: a 出入口 / 停车场 tag, or such a name, is no facility
    expect(categorize('临河幼儿园(北门)', '出入口;门')).toEqual({ cat: '其他' });
    expect(categorize('孙桥小学-2号门', '出入口;门')).toEqual({ cat: '其他' });
    expect(categorize('张江社区卫生服务中心停车场', '交通设施;停车场')).toEqual({ cat: '其他' });
    expect(categorize('张江社区卫生服务中心停车场-出入口', '出入口;停车场出入口')).toEqual({ cat: '其他' });
    expect(categorize('张江社区卫生服务中心停车场', '')).toEqual({ cat: '其他' });
    expect(categorize('临河幼儿园东门', '')).toEqual({ cat: '其他' });
    // names that only start with a gate word are facilities all the same
    expect(categorize('南门幼儿园', '')).toEqual({ cat: '幼儿园' });
    expect(categorize('东门菜场', '')).toEqual({ cat: '菜市场' });
    // a tag of the category still decides: such a gate folds into its facility (parent_id, below)
    expect(categorize('孙桥小学(张江校区)-东门', '教育培训;小学')).toEqual({ cat: '小学' });

    const { pois, dropped } = cleanPois(
      [
        place('k', '临河幼儿园', '教育培训;幼儿园', 0, 0),
        place('kg', '临河幼儿园(北门)', '出入口;门', 0, 60),
        place('kp', '临河幼儿园停车场', '交通设施;停车场', 30, 0),
        place('ke', '金宝贝早教中心', '教育培训;幼儿园', 200, 0),
        place('c', '临河社区卫生服务中心', '医疗;综合医院', 400, 0),
        place('cp', '临河社区卫生服务中心停车场', '交通设施;停车场', 420, 0),
        // Baidu tags the stations like the centres
        place('cs', '滨河社区卫生服务站', '医疗;医院;社区卫生服务中心', 800, 0),
      ],
      { project },
    );
    expect(pois.map((p) => [p.uid, p.cat])).toEqual([
      ['k', '幼儿园'],
      ['c', '社区卫生'],
      ['cs', '社区卫生'],
    ]);
    expect(Object.fromEntries(dropped.map((d) => [d.uid, d.reason]))).toEqual({
      kg: 'uncategorized',
      kp: 'uncategorized',
      ke: 'blacklist:早教',
      cp: 'uncategorized',
    });
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
