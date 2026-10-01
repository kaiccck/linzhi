import { describe, expect, it } from 'vitest';
import {
  applyExclusions,
  excludedByPattern,
  excludes,
  exclusionPattern,
  exclusionProblem,
  matchesNamePattern,
  type FacilityExclusion,
} from './exclusions.js';
import type { FacilityCategory, Poi } from './types.js';

const poi = (uid: string, name: string, cat: FacilityCategory): Poi => ({
  uid,
  name,
  cat,
  xy: [0, 0],
  navi_xy: null,
  source: 'baidu',
});

/** The shape of the 叮咚买菜 entry of data/official/exclusions.json. */
const dingdong: FacilityExclusion = {
  category: ['生鲜超市', '超市', '菜市场'],
  name_pattern: '^叮咚买菜(?!.*(?:奥莱|黑钻))',
  reason: '叮咚买菜的站点是前置仓，线上下单、配送到家，不是可以步行去买菜的门店',
  source: 'https://www.sec.gov/Archives/edgar/data/1854545/000119312521204687/d121652d424b4.htm',
  date: '2026-09-28',
};

/** Station names only: the brand also runs walk-in stores named ××店. */
const xiaoxiang: FacilityExclusion = {
  category: ['生鲜超市', '超市', '菜市场'],
  name_pattern: '^(?:美团)?小象超市.*(?:站|仓)\\)?$',
  reason: '小象超市的“××站”是便民服务站（前置仓）',
  source: 'https://www.meituan.com/news/NN231201067004457',
  date: '2026-09-28',
};

describe('exclusions by name pattern', () => {
  it('drops every POI of the listed categories whose name matches, and records the pattern', () => {
    const pois = [
      poi('d1', '叮咚买菜(孙桥站)', '生鲜超市'),
      poi('d2', '叮咚买菜（张江站）', '超市'), // full-width brackets read as half-width
      poi('d3', '叮咚买菜', '菜市场'),
      poi('k1', '盒马鲜生(长泰广场店)', '生鲜超市'),
      poi('k2', '叮咚奥莱(九里亭店)', '超市'),
      poi('k3', '叮咚买菜黑钻世家(场中路店)', '生鲜超市'),
      poi('k4', '如海生鲜超市(中科路店)', '生鲜超市'),
    ];
    const out = applyExclusions(pois, [dingdong]);
    expect(out.pois.map((p) => p.uid)).toEqual(['k1', 'k2', 'k3', 'k4']);
    expect(out.excluded).toEqual([
      {
        uid: 'd1',
        name: '叮咚买菜(孙桥站)',
        category: '生鲜超市',
        reason: dingdong.reason,
        source: dingdong.source,
        date: '2026-09-28',
        pattern: dingdong.name_pattern,
      },
      expect.objectContaining({ uid: 'd2', category: '超市', pattern: dingdong.name_pattern }),
      expect.objectContaining({ uid: 'd3', category: '菜市场' }),
    ]);
  });

  it('applies only to the categories it lists', () => {
    const single = { ...dingdong, category: '生鲜超市' as const };
    expect(excludes(single, poi('d', '叮咚买菜(孙桥站)', '生鲜超市'))).toBe(true);
    expect(excludes(single, poi('d', '叮咚买菜(孙桥站)', '超市'))).toBe(false);
    expect(excludes(dingdong, poi('d', '叮咚买菜(孙桥站)', '药店'))).toBe(false);
  });

  it('keeps the walk-in stores of a brand whose stations it excludes', () => {
    expect(matchesNamePattern(xiaoxiang, '小象超市(张江站)')).toBe(true);
    expect(matchesNamePattern(xiaoxiang, '美团小象超市（孙桥站）')).toBe(true);
    expect(matchesNamePattern(xiaoxiang, '小象超市便民服务站')).toBe(true);
    expect(matchesNamePattern(xiaoxiang, '小象超市(华联万柳店)')).toBe(false);
    expect(matchesNamePattern(xiaoxiang, '小象超市')).toBe(false);
  });

  it('matches raw search rows whatever their category (the fusion pool)', () => {
    const uidOnly: FacilityExclusion = { ...dingdong, uid: 'x', name_pattern: '^叮咚' };
    expect(excludedByPattern('叮咚买菜(孙桥站)', [uidOnly, dingdong])).toBe(dingdong);
    expect(excludedByPattern('清美生鲜(创新西路店)', [dingdong])).toBeUndefined();
  });

  it('a uid entry still wins over its category, a name entry still needs the category', () => {
    const byUid: FacilityExclusion = { ...dingdong, uid: 'u1', category: '小学' };
    expect(excludes(byUid, poi('u1', '任意名称', '药店'))).toBe(true);
    const byName: FacilityExclusion = {
      category: '小学',
      name: '育华学校',
      reason: 'r',
      source: 's',
      date: 'd',
    };
    expect(excludes(byName, poi('a', '育华学校', '小学'))).toBe(true);
    expect(excludes(byName, poi('a', '育华学校', '幼儿园'))).toBe(false);
  });

  it('never matches with an invalid pattern, and says why the entry is unusable', () => {
    expect(exclusionPattern('(')).toBeNull();
    expect(excludes({ ...dingdong, name_pattern: '(' }, poi('d', '(', '生鲜超市'))).toBe(false);
    expect(exclusionProblem(dingdong)).toBeNull();
    expect(exclusionProblem({ ...dingdong, name_pattern: '(' })).toMatch(/name_pattern 不是有效的正则表达式/);
    expect(exclusionProblem({ ...dingdong, category: [] })).toMatch(/category/);
    expect(exclusionProblem({ ...dingdong, name_pattern: undefined })).toMatch(/uid、name 或 name_pattern/);
    expect(exclusionProblem({ ...dingdong, source: '' })).toMatch(/来源/);
    expect(exclusionProblem({ ...dingdong, date: '' })).toMatch(/date/);
    expect(exclusionProblem(null)).toMatch(/category/);
  });
});
