import { describe, expect, it } from 'vitest';

import { readJson } from '../test/fixtures.js';
import {
  catchmentCovers,
  compoundParts,
  isCatchmentHit,
  matchCatchment,
  schoolCampuses,
  type CatchmentHit,
  type CatchmentList,
} from './catchment.js';
import { applyExclusions, type FacilityExclusion } from './exclusions.js';
import type { Poi } from './types.js';

const list = readJson<CatchmentList>('data/official/pudong-catchment-2025.json');

const SUNQIAO = '上海市浦东新区孙桥小学';
const ERZHONG_ZJ = '上海市浦东新区第二中心小学（张江校区）';
const ZJ_CENTRAL = '上海市浦东新区张江镇中心小学';

function hit(name: string, address?: string): CatchmentHit {
  const m = matchCatchment(list, name, address);
  if (!isCatchmentHit(m)) throw new Error(`${name}: ${JSON.stringify(m)}`);
  return m;
}

describe('compound names', () => {
  it('normalises phases, blocks, prefixes and 社区/小区', () => {
    expect(compoundParts('张江玉兰香苑-二期', ['张江镇', '张江'])).toMatchObject({
      prefix: '张江',
      base: '玉兰香苑',
      phase: '二期',
      block: null,
    });
    expect(compoundParts('玉兰香苑一期A组')).toMatchObject({ base: '玉兰香苑', phase: '一期', block: 'A块' });
    expect(compoundParts('玉兰香苑3期').full).toBe('玉兰香苑三期');
    expect(compoundParts('万科翡翠公园-I期').full).toBe('万科翡翠公园一期');
    expect(compoundParts('万科翡翠公园-六期').full).toBe('万科翡翠公园六期');
    expect(compoundParts('川杨新苑-南区')).toMatchObject({ base: '川杨新苑', block: '南区' });
    expect(compoundParts('樟盛苑社区').full).toBe('樟盛苑');
    expect(compoundParts('孙桥黄浦花园', ['孙桥'])).toMatchObject({ prefix: '孙桥', full: '黄浦花园' });
  });
});

describe('对口小学 matching against the 2025 浦东 table (张江镇 rows)', () => {
  it('covers 张江镇 only, by reverse-geocoded region', () => {
    expect(catchmentCovers(list, { city: '上海市', district: '浦东新区', town: '张江镇' })).toBe(true);
    expect(catchmentCovers(list, { city: '上海市', district: '浦东新区', town: '北蔡镇' })).toBe(false);
    expect(catchmentCovers(list, { city: '上海市', district: '闵行区', town: '张江镇' })).toBe(false);
    expect(catchmentCovers(list, undefined)).toBe(false);
    expect(catchmentCovers({ ...list, coverage: {} }, { district: '浦东新区' })).toBe(true);
  });

  it('assigns every 申城佳苑 sample compound to 孙桥小学, whatever lies closer', () => {
    const names = [
      '川杨新苑三期',
      '申城佳苑一期B块',
      '孙桥花苑',
      '申城佳苑二期B块',
      '川杨新苑四期',
      '申城佳苑三期B块',
      '孙桥黄浦花园',
      '虹御公寓',
      '申城佳苑一期A块',
      '申城佳苑二期A块',
      '申城佳苑三期A块',
      '申城佳苑一期C块',
    ];
    for (const n of names) expect(hit(n), n).toMatchObject({ school: SUNQIAO, method: 'name' });
    expect(hit('孙桥黄浦花园').matched_by).toBe('name:黄浦花园');
    expect(hit('申城佳苑二期A块').entries.map((e) => e.lane)).toEqual(['孙建路815弄']);
  });

  it('matches lanes from the name or the address before names', () => {
    expect(hit('顺和路60弄')).toMatchObject({
      school: SUNQIAO,
      method: 'lane',
      matched_by: 'lane:顺和路60弄',
    });
    expect(hit('益江路286弄小区')).toMatchObject({ school: ERZHONG_ZJ, method: 'lane' });
    expect(hit('益丰路55弄109号')).toMatchObject({ school: ZJ_CENTRAL, method: 'lane' });
    expect(hit('某小区', '上海市浦东新区张江镇孙环路177弄')).toMatchObject({
      school: SUNQIAO,
      method: 'lane',
    });
    // 益江路55弄 is not in the table (益丰路55弄 is): no guess
    expect(matchCatchment(list, '益江路55弄113号')).toEqual({ reason: 'none' });
  });

  it('matches phases and blocks the name leaves out, when all such rows agree', () => {
    expect(hit('玉兰香苑一期B组')).toMatchObject({ school: ERZHONG_ZJ, method: 'name' });
    expect(hit('玉兰香苑3期')).toMatchObject({
      school: ERZHONG_ZJ,
      method: 'name',
      matched_by: 'name:玉兰香苑三期',
    });
    expect(hit('玉兰香苑-一期')).toMatchObject({
      school: ERZHONG_ZJ,
      method: 'phase',
      matched_by: 'phase:玉兰香苑一期B块/玉兰香苑一期A块',
    });
    expect(hit('张江玉兰香苑-二期')).toMatchObject({ school: ERZHONG_ZJ, method: 'phase' });
    expect(hit('张江玉兰香苑-B块').entries.map((e) => e.compound)).toEqual([
      '玉兰香苑一期B块',
      '玉兰香苑二期B块',
    ]);
    expect(hit('樟盛苑社区')).toMatchObject({ school: ZJ_CENTRAL, method: 'name' });
    // 申城佳苑二期 ↔ 申城佳苑二期A块 / B块 / C块
    expect(hit('申城佳苑二期')).toMatchObject({
      school: SUNQIAO,
      method: 'phase',
      matched_by: 'phase:申城佳苑二期B块/申城佳苑二期A块/申城佳苑二期C块',
    });
    expect(hit('川杨新苑-南区')).toMatchObject({ school: SUNQIAO, method: 'base' });
    expect(hit('张江荣科苑')).toMatchObject({
      school: '上海市浦东新区万科实验小学（张江校区）',
      method: 'base',
    });
  });

  it('leaves unknown compounds, 居委 names and relocated villages unmatched', () => {
    for (const n of ['万科翡翠公园', '江夏社区', '川杨兰苑', '科荣园', '张江公馆', '江东村']) {
      expect(matchCatchment(list, n), n).toEqual({ reason: 'none' });
    }
    // same stripped name under two different place prefixes is not the same compound
    expect(matchCatchment(list, '张江公寓')).toEqual({ reason: 'none' });
    expect(hit('孙桥公寓').school).toBe(SUNQIAO);
  });

  it('refuses to choose when the rows name different schools', () => {
    const two: CatchmentList = {
      ...list,
      schools: [
        { school: '甲小学', entries: [{ lane: '甲路1弄', compound: '花园城一期' }] },
        { school: '乙小学', entries: [{ lane: '乙路2弄', compound: '花园城二期' }] },
      ],
    };
    expect(matchCatchment(two, '花园城')).toEqual({
      reason: 'ambiguous',
      schools: ['甲小学', '乙小学'],
      method: 'base',
    });
    expect(matchCatchment(two, '花园城二期')).toMatchObject({ school: '乙小学', method: 'name' });
  });
});

describe('campuses of an assigned school', () => {
  const poi = (uid: string, name: string, xy: [number, number], extra: Partial<Poi> = {}): Poi => ({
    uid,
    name,
    cat: '小学',
    xy,
    navi_xy: [xy[0] + 5, xy[1]],
    source: 'baidu',
    ...extra,
  });
  const pois = [
    poi('zj', '孙桥小学(张江校区)', [-636, 348]),
    poi('sj', '孙桥小学(申江校区)', [-779, -741]),
    poi('ez', '浦东新区第二中心小学(张江校区)', [-900, 2400]),
    poi('zc', '上海市张江中心小学', [100, 2000], {
      official: { list: 'pudong-schools-2026', name: '上海市浦东新区张江镇中心小学' },
    }),
  ];

  it('finds both campuses when the table names none, one when it names a campus', () => {
    expect(schoolCampuses(SUNQIAO, pois).map((s) => s.uid)).toEqual(['zj', 'sj']);
    expect(schoolCampuses(ERZHONG_ZJ, pois)).toEqual([
      { name: '浦东新区第二中心小学(张江校区)', uid: 'ez', xy: [-900, 2400], route_xy: [-895, 2400] },
    ]);
    // Baidu spells it 上海市张江中心小学; the official name the list confirmed decides
    expect(schoolCampuses(ZJ_CENTRAL, pois)).toMatchObject([{ uid: 'zc', name: ZJ_CENTRAL, official: true }]);
    expect(schoolCampuses('上海中医药大学附属浦东实验小学', pois)).toEqual([]);
    expect(
      schoolCampuses('上海中医药大学附属浦东实验小学', pois, [
        { name: '上海中医药大学附属浦东实验小学', xy: [10, 20] },
      ]),
    ).toEqual([{ name: '上海中医药大学附属浦东实验小学', official: true, xy: [10, 20], route_xy: [10, 20] }]);
  });
});

describe('curated exclusions', () => {
  const yuhua: FacilityExclusion = {
    category: '小学',
    uid: '593850fb69993a5cdf1e527e',
    name: '上海市浦东新区育华学校(雪英校区)',
    reason: '2026 年不在招生名单中',
    source: 'https://www.pudong.gov.cn/zwgk/ywjy-jyjzdgz/2026/97/354049.html',
    date: '2026-09-28',
  };
  const school = (uid: string, name: string, extra: Partial<Poi> = {}): Poi => ({
    uid,
    name,
    cat: '小学',
    xy: [0, 0],
    navi_xy: null,
    source: 'baidu',
    ...extra,
  });

  it('drops by uid (a merged duplicate included), else by category and name, and says why', () => {
    const pois = [
      school('593850fb69993a5cdf1e527e', '上海市浦东新区育华学校(雪英校区)'),
      school('keep', '孙桥小学(张江校区)'),
      school('dup-holder', '育华学校', { merged_uids: ['593850fb69993a5cdf1e527e'] }),
    ];
    const out = applyExclusions(pois, [yuhua]);
    expect(out.pois.map((p) => p.uid)).toEqual(['keep']);
    expect(out.excluded).toEqual([
      {
        uid: '593850fb69993a5cdf1e527e',
        name: '上海市浦东新区育华学校(雪英校区)',
        category: '小学',
        reason: yuhua.reason,
        source: yuhua.source,
        date: '2026-09-28',
      },
      expect.objectContaining({ uid: 'dup-holder' }),
    ]);
    const byName = { ...yuhua, uid: undefined, name: '育华学校' };
    expect(applyExclusions(pois, [byName]).pois.map((p) => p.uid)).toEqual([
      '593850fb69993a5cdf1e527e',
      'keep',
    ]);
    // a same-named POI of another category stays
    expect(applyExclusions([{ ...pois[2]!, cat: '幼儿园' }], [byName]).excluded).toEqual([]);
    expect(applyExclusions(pois, []).pois).toHaveLength(3);
  });
});
