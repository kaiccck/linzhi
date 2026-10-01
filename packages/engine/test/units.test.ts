import {
  BaiduConfigError,
  BaiduInputError,
  BaiduQuotaError,
  BaiduUpstreamError,
  QuotaLedger,
  type PlacePoi,
  type PlaceSearchResult,
  type ReverseGeocodeResult,
  type RouteCell,
  type RouteMatrix,
} from '@zoudedao/baidu';
import {
  cleanPois,
  localFrame,
  type Community,
  type FacilityCheck,
  type FacilityExclusion,
  type LngLat,
  type Poi,
  type XY,
} from '@zoudedao/core';
import { describe, expect, it } from 'vitest';

import type { CheckSet, MatrixFn } from '../src/coverage.js';
import { runCoverage } from '../src/coverage.js';
import { searchFacilities, toPlaceResult } from '../src/facilities.js';
import {
  LIVELIHOOD_KEYWORDS,
  LIVELIHOOD_RADIUS_M,
  livelihoodPois,
  searchLivelihood,
  areaName,
  baseName,
  BROWSER_POIS_MAX,
  browserPois,
  detailBrowserPois,
  residentialNote,
  withBrowserRows,
  branchToken,
  EngineError,
  FRESH_KEYWORDS,
  fuseOfficial,
  officialNameKey,
  runFreshAlternatives,
  sameStreet,
  inventoryOf,
  knownRadius,
  planQuota,
  resolveBudget,
  residentialDemand,
  serviceCaps,
  stepCaps,
  streetAddress,
  toEngineError,
  type DemandSite,
  type EngineClient,
  type FacilityGroup,
  type OfficialList,
  type QuotaEvent,
} from '../src/index.js';
import { abortable, Meter } from '../src/meter.js';
import { CITY_ORIGIN } from './city.js';

const frame = localFrame(CITY_ORIGIN[0], CITY_ORIGIN[1]);

function placePoi(uid: string, name: string, tag: string, xy: XY, navi?: XY): PlacePoi {
  return {
    uid,
    name,
    location: frame.toLngLat(xy[0], xy[1]),
    naviLocation: navi ? frame.toLngLat(navi[0], navi[1]) : null,
    address: null,
    province: null,
    city: null,
    area: null,
    town: null,
    townCode: null,
    telephone: null,
    tag,
    classifiedTag: tag,
    type: null,
    label: null,
    brand: null,
    distanceM: null,
    parentId: null,
    children: [],
    extra: {},
  };
}

function meter(overrides = {}, onQuota: (e: QuotaEvent) => void = () => {}) {
  const b = resolveBudget('personal', overrides);
  return new Meter(stepCaps(b), serviceCaps(b), { onQuota });
}

describe('residential demand points', () => {
  it('strips gate and building suffixes but keeps phases and blocks', () => {
    expect(baseName('滨河花园-1号门')).toBe('滨河花园');
    expect(baseName('滨河花园东门')).toBe('滨河花园');
    expect(baseName('滨河花园(东门)')).toBe('滨河花园');
    expect(baseName('滨河花园北1门')).toBe('滨河花园');
    expect(baseName('滨河花园-南大门')).toBe('滨河花园');
    expect(baseName('滨河花园人行出入口')).toBe('滨河花园');
    expect(baseName('滨河花园-3号楼')).toBe('滨河花园');
    expect(baseName('滨河花园5栋')).toBe('滨河花园');
    expect(baseName('滨河花园-3号楼东门')).toBe('滨河花园');
    expect(baseName('申城佳苑一期A块')).toBe('申城佳苑一期A块');
    expect(baseName('申城佳苑(北区)')).toBe('申城佳苑(北区)');
    expect(baseName('金门花园')).toBe('金门花园');
    expect(baseName('北门')).toBe('北门');
  });

  it('merges a compound with its gates, buildings and copies; the gate is navi, else a gate POI, else the POI', () => {
    const pois = [
      placePoi('a', '滨河花园', '房地产;住宅区', [300, 300], [320, 300]),
      placePoi('a2', '滨河花园', '房地产;住宅区', [305, 310]),
      placePoi('a3', '滨河花园-3号楼', '房地产;住宅区', [290, 330]),
      placePoi('a4', '滨河花园东门', '出入口;门', [360, 300]),
      placePoi('b', '临河小区', '房地产;住宅区', [-400, 0]),
      placePoi('b1', '临河小区-2号门', '出入口;门', [-400, 90]),
      placePoi('b2', '临河小区东门', '出入口;门', [-350, 0]),
      placePoi('c', '枫林苑', '房地产;住宅区', [0, -500]),
      placePoi('d', '银河小区北门', '出入口;门', [600, 600]),
      placePoi('e', '产业园东北门', '出入口;门', [700, -100]),
      placePoi('f', '河西小区居委会', '政府机构;居民委员会', [50, 50]),
      placePoi('g1', '锦绣苑', '房地产;住宅区', [-900, -700]),
      placePoi('g2', '锦绣苑', '房地产;住宅区', [-200, -1300]),
      placePoi('h', '远郊花园', '房地产;住宅区', [1580, 0], [1620, 0]),
    ];
    const r = residentialDemand(pois, { frame, extent_m: 1600, max: 30 });
    const by = new Map(r.demand.map((d) => [d.id, d]));
    // xy is where residents walk from (the gate); label_xy where the compound itself sits on the map
    expect(by.get('滨河花园')).toMatchObject({
      uid: 'a',
      xy: [320, 300],
      label_xy: [300, 300],
      gate: 'navi',
      merged: ['a2', 'a3', 'a4'],
    });
    expect(by.get('临河小区')).toMatchObject({ gate: 'gate_poi', xy: [-350, 0], label_xy: [-400, 0] });
    expect(by.get('枫林苑')).toMatchObject({ gate: 'location', xy: [0, -500], label_xy: [0, -500] });
    // a gate alone stands for a compound only when its name says 小区
    expect(by.get('银河小区')).toMatchObject({ gate: 'gate_poi', uid: 'd', label_xy: [600, 600] });
    expect(by.has('产业园')).toBe(false);
    expect(by.has('远郊花园')).toBe(false);
    expect([...by.keys()]).toEqual(expect.arrayContaining(['锦绣苑', '锦绣苑（2）']));
    expect(r.dropped.map((d) => d.reason)).toEqual(
      expect.arrayContaining(['gate_without_compound', 'not_residential:政府机构;居民委员会']),
    );
    expect(r.found).toBe(7); // 产业园 is no compound; 远郊花园 is found but lies outside the extent
    // nearest first, capped
    expect(r.demand.map((d) => d.straight_m)).toEqual(
      [...r.demand.map((d) => d.straight_m)].sort((a, b) => a - b),
    );
    expect(residentialDemand(pois, { frame, extent_m: 1600, max: 3 }).demand.map((d) => d.id)).toEqual([
      '临河小区',
      '滨河花园',
      '枫林苑',
    ]);
    expect(r.dedupe).toMatchObject({
      parents_dropped: 0,
      children_merged: 0,
      numeral_merged: 0,
      alias_merged: 0,
    });
  });
});

describe('residential dedupe: phases, parents and aliases', () => {
  const HOME = '房地产;住宅区';
  const home = (
    uid: string,
    name: string,
    xy: XY,
    more: { parent?: string; address?: string; navi?: XY } = {},
  ) => ({
    ...placePoi(uid, name, HOME, xy, more.navi),
    parentId: more.parent ?? null,
    address: more.address ?? null,
  });
  const run = (pois: PlacePoi[]) => residentialDemand(pois, { frame, extent_m: 1600, max: 30 });
  const names = (r: ReturnType<typeof run>) => r.demand.map((d) => d.name).sort();

  it('reads I期, 1期 and 一期 as one phase; the main POI names it', () => {
    const r = run([
      home('p1', '翡翠园-I期', [0, 40], { navi: [10, 40] }),
      home('p1b', '翡翠园-1期', [200, 100]),
      home('p1c', '翡翠园一期', [100, 0]),
      home('p1d', '翡翠园第Ⅰ期', [60, 60]),
      home('p2', '翡翠园-二期', [300, 300]),
      // far apart, no common parent: two compounds, each under its own name
      home('q1', '锦绣苑-1期', [-900, -700]),
      home('q2', '锦绣苑一期', [-200, -1300]),
    ]);
    expect(names(r)).toEqual(['翡翠园-I期', '翡翠园-二期', '锦绣苑-1期', '锦绣苑一期'].sort());
    expect(r.demand.find((d) => d.name === '翡翠园-I期')).toMatchObject({
      uid: 'p1',
      xy: [10, 40],
      label_xy: [0, 40],
      gate: 'navi',
      merged: ['p1b', 'p1c', 'p1d'],
    });
    expect(r.dedupe.numeral_merged).toBe(3);
    expect(r.dedupe.items).toContainEqual({
      rule: 'phase_numeral',
      name: '翡翠园-1期',
      uid: 'p1b',
      into: '翡翠园-I期',
    });
  });

  it('merges one parent’s children of the same phase however far apart Baidu put them', () => {
    // measured: 万科翡翠公园-I期 and -1期, both children of 万科翡翠公园, 407 m apart
    const r = run([
      home('w1', '万科翡翠公园-I期', [-9, 43], { parent: 'W' }),
      home('w2', '万科翡翠公园-1期', [-304, -237], { parent: 'W' }),
    ]);
    expect(names(r)).toEqual(['万科翡翠公园-I期']);
    expect(r.demand[0]!.merged).toEqual(['w2']);
  });

  it('keeps the phase spelling whose address names no other compound or phase', () => {
    // measured: -I期 is filed under "川和路万科翡翠公园-六期", its point next to 六期; -1期 sits in the south
    const I = home('w1', '万科翡翠公园-I期', [-9, 43], {
      parent: 'W',
      navi: [0, 40],
      address: '上海市浦东新区川和路万科翡翠公园-六期',
    });
    const one = home('w2', '万科翡翠公园-1期', [-304, -237], {
      parent: 'W',
      navi: [-300, -250],
      address: '上海市浦东新区环科路677弄',
    });
    const six = home('w6', '万科翡翠公园-六期', [68, 110], {
      parent: 'W',
      address: '上海市浦东新区川和路333弄',
    });
    // the estate's own name in an address is no other compound: 四期 stays clean
    const four = home('w4', '万科翡翠公园-四期', [-50, -114], {
      parent: 'W',
      address: '上海市浦东新区川和路388弄1~23号万科翡翠公园四期',
    });
    const r = run([I, one, six, four]);
    expect(names(r)).toEqual(['万科翡翠公园-1期', '万科翡翠公园-六期', '万科翡翠公园-四期'].sort());
    expect(r.demand.find((d) => d.name === '万科翡翠公园-1期')).toMatchObject({
      uid: 'w2',
      xy: [-300, -250],
      label_xy: [-304, -237],
      merged: ['w1'],
    });
    expect(r.dedupe.items).toContainEqual({
      rule: 'phase_numeral',
      name: '万科翡翠公园-I期',
      uid: 'w1',
      into: '万科翡翠公园-1期',
    });
    // an address naming another compound of the list counts too
    const other = run([
      home('a', '某某苑-I期', [0, 0], { address: '某路1号万科翡翠公园-六期' }),
      home('b', '某某苑一期', [50, 0]),
      six,
    ]);
    expect(names(other)).toEqual(['万科翡翠公园-六期', '某某苑一期']);
    // both clean, or both naming something else: Baidu's order
    expect(names(run([{ ...I, address: null }, one, six]))).toEqual([
      '万科翡翠公园-I期',
      '万科翡翠公园-六期',
    ]);
    expect(names(run([I, { ...one, address: '环科路万科翡翠公园-二期' }, six]))).toEqual([
      '万科翡翠公园-I期',
      '万科翡翠公园-六期',
    ]);
  });

  it('drops a phase whose address and point both point to another listed phase of its estate', () => {
    const six = home('w6', '万科翡翠公园-六期', [68, 110], {
      parent: 'W',
      address: '上海市浦东新区川和路333弄',
    });
    const five = home('w5', '万科翡翠公园-五期', [99, 1], {
      parent: 'W',
      address: '上海市浦东新区川和路399弄',
    });
    // measured (zj-v): I期 filed under 六期, 102 m from it, with no other spelling of 1期 listed
    const I = home('w1', '万科翡翠公园-I期', [-9, 43], {
      parent: 'W',
      address: '上海市浦东新区川和路万科翡翠公园-六期',
    });
    const r = run([I, six, five]);
    expect(names(r)).toEqual(['万科翡翠公园-五期', '万科翡翠公园-六期'].sort());
    expect(r.dedupe.misplaced_dropped).toBe(1);
    expect(r.dropped).toContainEqual({ name: '万科翡翠公园-I期', reason: 'misplaced_phase' });
    expect(r.dedupe.items).toContainEqual({
      rule: 'misplaced_phase',
      name: '万科翡翠公园-I期',
      uid: 'w1',
      points_to: '万科翡翠公园-六期',
    });
    // the address names another phase, but the point is 300 m away: kept
    const far = home('w1', '万科翡翠公园-I期', [68, -190], {
      address: '上海市浦东新区川和路万科翡翠公园-六期',
    });
    expect(names(run([far, six]))).toEqual(['万科翡翠公园-I期', '万科翡翠公园-六期']);
    // the named phase is not listed: kept
    expect(names(run([I, five]))).toEqual(['万科翡翠公园-I期', '万科翡翠公园-五期']);
    // its own phase or the estate alone in the address: kept
    const four = home('w4', '万科翡翠公园-四期', [-50, -114], { address: '川和路388弄万科翡翠公园四期' });
    const near = home('w3', '万科翡翠公园-3期', [-60, -100], { address: '川和路万科翡翠公园' });
    expect(names(run([four, near]))).toEqual(['万科翡翠公园-3期', '万科翡翠公园-四期']);
    // another estate's phase is no misplacement
    const other = home('x1', '某某苑-二期', [68, 10], { address: '川和路万科翡翠公园-六期' });
    expect(names(run([other, six]))).toEqual(['万科翡翠公园-六期', '某某苑-二期']);
    // a phase merged with another spelling of itself was settled by the tie-break: 1期 stays
    const one = home('w2', '万科翡翠公园-1期', [-304, -237], { parent: 'W', address: '环科路677弄' });
    const merged = run([I, one, six]);
    expect(names(merged)).toEqual(['万科翡翠公园-1期', '万科翡翠公园-六期']);
    expect(merged.dedupe.misplaced_dropped).toBe(0);
  });

  it('drops a parent whose phases are listed; merges a single child into its parent', () => {
    const r = run([
      home('W', '万科翡翠公园', [-98, -52], { navi: [-90, -60] }),
      home('w1', '万科翡翠公园-I期', [-9, 43], { parent: 'W' }),
      home('w3', '万科·翡翠公园-3期', [-122, -1], { parent: 'W' }),
      home('w4', '万科翡翠公园-四期', [-50, -114], { parent: 'W' }),
      placePoi('wg', '万科翡翠公园-南门', '出入口;门', [-98, -120]),
      home('Y', '玉兰香苑-一期', [9, 202], { navi: [20, 202] }),
      home('ya', '玉兰香苑一期A组', [-190, 96], { parent: 'Y', navi: [-180, 96] }),
      placePoi('yag', '玉兰香苑一期A组-东门', '出入口;门', [-90, 149]),
      home('Z', '樟盛苑', [-290, 393]),
      home('z1', '樟盛苑社区', [-295, 483], { parent: 'Z' }),
      // a parent that is not in the list changes nothing
      home('b1', '玉兰香苑一期B组', [134, 212], { parent: 'NOT_LISTED' }),
      home('b3', '玉兰香苑3期', [299, -143], { parent: 'NOT_LISTED' }),
    ]);
    expect(names(r)).toEqual(
      [
        '万科翡翠公园-I期',
        '万科·翡翠公园-3期',
        '万科翡翠公园-四期',
        '玉兰香苑-一期',
        '樟盛苑',
        '玉兰香苑一期B组',
        '玉兰香苑3期',
      ].sort(),
    );
    // the parent stays the main: its name, uid, gate and location
    expect(r.demand.find((d) => d.name === '玉兰香苑-一期')).toMatchObject({
      uid: 'Y',
      xy: [20, 202],
      label_xy: [9, 202],
      merged: expect.arrayContaining(['ya', 'yag']),
    });
    expect(r.demand.find((d) => d.name === '樟盛苑')!.merged).toEqual(['z1']);
    expect(r.dedupe).toMatchObject({
      parents_dropped: 1,
      children_merged: 2,
      numeral_merged: 0,
      alias_merged: 0,
    });
    expect(r.dropped).toContainEqual({ name: '万科翡翠公园', reason: 'parent_of_phases' });
    expect(r.dedupe.items).toContainEqual({
      rule: 'parent_of_phases',
      name: '万科翡翠公园',
      uid: 'W',
      phases: ['万科翡翠公园-I期', '万科·翡翠公园-3期', '万科翡翠公园-四期'],
    });
    expect(r.dedupe.items).toContainEqual({
      rule: 'parent_child',
      name: '玉兰香苑一期A组',
      uid: 'ya',
      into: '玉兰香苑-一期',
    });
    expect(r.found).toBe(7);
  });

  it('hands a dropped phase’s own phases up: the estate goes when its phases are blocks', () => {
    const r = run([
      home('E', '某某花园', [0, 0]),
      home('e1', '某某花园一期', [100, 0], { parent: 'E' }),
      home('e1a', '某某花园一期A块', [120, 20], { parent: 'e1' }),
      home('e1b', '某某花园一期B块', [80, -20], { parent: 'e1' }),
    ]);
    expect(names(r)).toEqual(['某某花园一期A块', '某某花园一期B块']);
    expect(r.dedupe.parents_dropped).toBe(2);
  });

  it('merges an alias only when its address names the compound and the points are within 30 m', () => {
    const r = run([
      home('Y', '玉兰香苑-一期', [9, 202], { parent: 'NOT_LISTED' }),
      home('ya', '玉兰香苑一期A组', [-190, 96], { parent: 'Y', address: '上海市浦东新区益江路126弄1~112号' }),
      home('al', '益江路286弄小区', [-191, 103], { address: '上海市浦东新区盛夏路玉兰香苑一期A组' }),
      // an address naming a compound 107 m away merges nothing (measured in zj-b)
      home('j4', '玉兰香苑-四期', [607, 144]),
      home('jy', '江苑社区', [501, 131], { address: '上海市张东路玉兰香苑-四期' }),
      // neighbours with their own names stay apart, however close
      home('d1', '东窑新村', [998, -237], { address: '上海市浦东新区龚卢路310号临' }),
      home('d2', '华陇小区', [1028, -234], { address: '将中路461弄' }),
      home('h1', '华顺社区', [846, 82], { address: '上海市浦东新区张江镇' }),
      home('h2', '川杨兰苑', [837, 82], { address: '上海市浦东新区中科路2130号' }),
      // a short name in an address proves nothing
      home('s1', '花园', [500, 500]),
      home('s2', '某某公寓', [505, 500], { address: '某路1号花园' }),
    ]);
    expect(names(r)).toEqual(
      [
        '玉兰香苑-一期',
        '玉兰香苑-四期',
        '江苑社区',
        '东窑新村',
        '华陇小区',
        '华顺社区',
        '川杨兰苑',
        '花园',
        '某某公寓',
      ].sort(),
    );
    const y = r.demand.find((d) => d.name === '玉兰香苑-一期')!;
    expect(y).toMatchObject({ uid: 'Y', label_xy: [9, 202] });
    expect(y.merged.sort()).toEqual(['al', 'ya']);
    expect(r.dedupe).toMatchObject({ children_merged: 1, alias_merged: 1 });
    expect(r.dedupe.items).toContainEqual({
      rule: 'alias',
      name: '益江路286弄小区',
      uid: 'al',
      into: '玉兰香苑-一期',
    });
  });
});

describe('browser POIs: validation, choice within the budget, cleaning', () => {
  const hex = (n: number) => n.toString(16).padStart(24, 'c');
  const at = (xy: XY): LngLat => frame.toLngLat(xy[0], xy[1]);

  it('keeps valid items only, deduplicated and capped, and never throws', () => {
    const ok = {
      uid: hex(1).toUpperCase(),
      name: ' 盒马鲜生(陆悦天地店) ',
      keyword: '生鲜超市',
      bd09: at([546, 0]),
    };
    expect(browserPois([ok])).toEqual([
      { uid: hex(1), name: '盒马鲜生(陆悦天地店)', keyword: '生鲜超市', bd09: at([546, 0]) },
    ]);
    const bad = [
      null,
      'x',
      { ...ok, uid: 'abc' },
      { ...ok, uid: `${hex(2)}0` },
      { ...ok, uid: hex(3), name: '' },
      { ...ok, uid: hex(4), name: '长'.repeat(61) },
      { ...ok, uid: hex(5), keyword: '关键词关键词关键词关键' },
      { ...ok, uid: hex(6), bd09: [0, 0] },
      { ...ok, uid: hex(7), bd09: [121.6, Number.NaN] },
      { ...ok, uid: hex(8), bd09: [121.6] },
      { ...ok, uid: hex(9), bd09: '121.6,31.2' },
      ok, // the same uid again
    ];
    expect(browserPois([ok, ...bad]).map((p) => p.uid)).toEqual([hex(1)]);
    expect(browserPois({ uid: hex(1) })).toEqual([]);
    expect(browserPois(undefined)).toEqual([]);
    const many = Array.from({ length: 450 }, (_, i) => ({ ...ok, uid: hex(1000 + i) }));
    expect(browserPois(many)).toHaveLength(BROWSER_POIS_MAX);
  });

  it('details what the searches missed, scarce keywords and nearest first, within the detail line', async () => {
    const offered = [
      ...Array.from({ length: 8 }, (_, i) => ({
        uid: hex(100 + i),
        name: `超市${i}`,
        keyword: '超市',
        bd09: at([100 + i, 0]),
      })),
      { uid: hex(200), name: '远的小学', keyword: '小学', bd09: at([2000, 0]) },
      { uid: hex(201), name: '近的药房', keyword: '药房', bd09: at([900, 0]) },
      { uid: hex(202), name: '菜场', keyword: '菜场', bd09: at([1500, 0]) },
      { uid: hex(203), name: '生鲜店', keyword: '生鲜', bd09: at([50, 0]) },
      { uid: hex(204), name: '已检索的药店', keyword: '药店', bd09: at([10, 0]) },
      { uid: hex(205), name: '太远的超市', keyword: '超市', bd09: at([2200, 0]) },
      { uid: hex(206), name: '叮咚买菜(河西站)', keyword: '生鲜', bd09: at([20, 0]) },
    ];
    const asked: string[][] = [];
    const client = {
      placeDetail: async (uids: readonly string[]) => {
        asked.push([...uids]);
        return {
          uids: [...uids],
          pois: uids.map((u) => placePoi(u, '某店', '购物;超市', [0, 0])),
          missing: [],
          requests: Math.ceil(uids.length / 10),
          apiCalls: Math.ceil(uids.length / 10),
          via: 'api' as const,
        };
      },
    } as unknown as EngineClient;
    const warnings: string[] = [];
    const exclusions: FacilityExclusion[] = [
      {
        category: '生鲜超市',
        name_pattern: '^叮咚买菜\\(.+站\\)$',
        reason: '前置仓',
        source: 'https://example.gov.cn/x',
        date: '2026-09-29',
      },
    ];
    const run = (m: Meter) =>
      detailBrowserPois({
        meter: m,
        client,
        frame,
        radius_m: 2100,
        offered,
        known: new Set([hex(204)]),
        exclusions,
        warn: (w) => warnings.push(w),
      });
    const one = await run(meter({ detailCalls: 1 }));
    // chosen by priority, asked in uid order (stable cache keys)
    expect(asked[0]).toEqual(
      [
        hex(200), // 小学
        hex(202), // 菜场
        hex(201), // 药房
        hex(203), // 生鲜
        ...[0, 1, 2, 3, 4, 5].map((i) => hex(100 + i)), // 超市, nearest first
      ].sort(),
    );
    expect(one.stats).toEqual({ offered: 15, new: 12, detailed: 10, kept: 0, budget_limited: true });
    expect(warnings[0]).toMatch(/12 处.*只够其中 10 处/);
    const two = await run(meter({ detailCalls: 5 }));
    expect(asked[1]).toHaveLength(12);
    expect(two.stats).toMatchObject({ new: 12, detailed: 12, budget_limited: false });
    const none = await run(meter({ detailCalls: 0 }));
    expect(asked).toHaveLength(2);
    expect(none.stats).toMatchObject({ detailed: 0, budget_limited: true });
  });

  it('cleans detail rows with the search rows; a 超市 counts within the 民生设施 radius only', () => {
    const fac = {
      pois: [],
      dropped: [],
      rows: [placePoi('s1', '联华超市(川和路店)', '购物;超市', [30, 0], [35, 0])],
      inventory: {},
      queries: [],
      radius_m: 2100,
    };
    const searched = { ...fac, pois: cleanPois(fac.rows.map(toPlaceResult), { project: frame.toXY }).pois };
    const out = withBrowserRows(
      searched,
      [
        placePoi(hex(1), '盒马鲜生(陆悦天地店)', '购物;超市;生鲜超市', [546, 0]),
        placePoi(hex(2), '远处超市', '购物;超市', [1500, 0]),
        placePoi(hex(3), '联华超市(川和路店)', '购物;超市', [32, 0]), // the same shop under another uid
        placePoi(hex(4), '火锅店', '美食;火锅店', [100, 0]),
      ],
      frame,
    );
    const byName = new Map(out.pois.map((p) => [p.name, p]));
    expect(byName.get('盒马鲜生(陆悦天地店)')).toMatchObject({ cat: '生鲜超市', found_by: 'jsapi' });
    expect(byName.get('联华超市(川和路店)')).toMatchObject({ uid: 's1', merged_uids: [hex(3)] });
    expect(byName.get('联华超市(川和路店)')!.found_by).toBeUndefined();
    expect(byName.has('远处超市')).toBe(false);
    expect(byName.has('火锅店')).toBe(false);
    expect(out.rows).toHaveLength(5);
    expect(out.dropped.map((d) => d.reason)).toEqual(
      expect.arrayContaining([`browser:beyond ${LIVELIHOOD_RADIUS_M} m`, 'uncategorized']),
    );
    expect(withBrowserRows(searched, [], frame)).toBe(searched);
  });

  it('explains the residential dedupe in one note', () => {
    expect(residentialNote(null)).toEqual([]);
    const [note] = residentialNote({
      parents_dropped: 1,
      children_merged: 1,
      numeral_merged: 1,
      misplaced_dropped: 1,
      alias_merged: 1,
      items: [
        { rule: 'misplaced_phase', name: '万科翡翠公园-I期', uid: 'w1', points_to: '万科翡翠公园-六期' },
        {
          rule: 'parent_of_phases',
          name: '万科翡翠公园',
          uid: 'w',
          phases: ['万科翡翠公园-I期', '万科翡翠公园-二期'],
        },
        { rule: 'parent_child', name: '张江M TOWN', uid: 'm', into: '绿地MTOWN' },
        { rule: 'phase_numeral', name: '万科翡翠公园-1期', uid: 'w1', into: '万科翡翠公园-I期' },
        { rule: 'alias', name: '益江路286弄小区', uid: 'a', into: '玉兰香苑-一期' },
      ],
    });
    expect(note).toMatch(/^小区去重：/);
    for (const part of [
      '万科翡翠公园下设的各期都在清单里',
      '张江M TOWN并入绿地MTOWN',
      '万科翡翠公园-1期并入万科翡翠公园-I期',
      '益江路286弄小区并入玉兰香苑-一期',
      '万科翡翠公园-I期（地址与位置都指向 万科翡翠公园-六期）',
      'stats.residential_dedupe',
    ]) {
      expect(note).toContain(part);
    }
  });
});

describe('facility search within the place budget', () => {
  const groups: FacilityGroup[] = [
    { key: '小学', keywords: ['小学'] },
    { key: '菜市场', keywords: ['菜市场', '菜场'] },
    { key: '药店', keywords: ['药店', '药房'] },
  ];
  const dist = (p: PlacePoi) => Math.hypot(...frame.toXY(p.location[0], p.location[1]));

  it('trusts group order of a cut-short union only when the rows really came group by group', () => {
    const rows = [
      placePoi('s1', '一小', '教育培训;小学', [100, 0]),
      placePoi('m1', '东菜场', '购物;菜市场', [200, 0]),
      placePoi('m2', '西菜场', '购物;菜市场', [700, 0]),
    ];
    const cut = inventoryOf(groups, { pois: rows, complete: false }, dist, 2600);
    expect(cut.get('小学')).toMatchObject({ complete: true, radius_m: 2600 });
    expect(cut.get('菜市场')).toMatchObject({ complete: false, fetched: 2 });
    expect(cut.get('菜市场')!.radius_m).toBeCloseTo(700, 6);
    expect(cut.get('药店')).toMatchObject({ complete: false, radius_m: 0, fetched: 0 });
    const shuffled = inventoryOf(
      groups,
      { pois: [rows[1]!, rows[0]!, rows[2]!], complete: false },
      dist,
      2600,
    );
    expect(shuffled.get('小学')!.complete).toBe(false);
    const whole = inventoryOf(groups, { pois: rows, complete: true }, dist, 2600);
    expect([...whole.values()].every((g) => g.complete && g.radius_m === 2600)).toBe(true);
  });

  it('gives a group crowded out of a capped union its own query (split keywords)', async () => {
    const schools = Array.from({ length: 10 }, (_, i) =>
      placePoi(`s${i}`, `第${i}小学`, '教育培训;小学', [100 * i, 50]),
    );
    const stalls = Array.from({ length: 50 }, (_, i) =>
      placePoi(`m${i}`, `鲜${i}生鲜市场`, '购物;农贸市场', [30 * i, -50]),
    );
    const pharmacies = Array.from({ length: 20 }, (_, i) =>
      placePoi(`p${i}`, `药房${i}`, '医疗;药店', [60 * i, 120]),
    );
    const asked: { keywords: string[]; maxPages: number }[] = [];
    const client = {
      placeAround: async (
        keywords: string | readonly string[],
        _c: LngLat,
        opts: { maxPages?: number } = {},
      ) => {
        const words = [...keywords];
        const maxPages = opts.maxPages ?? 3;
        asked.push({ keywords: words, maxPages });
        const union = words.includes('小学');
        const pois = union ? [...schools, ...stalls].slice(0, 20 * maxPages) : pharmacies;
        const res: PlaceSearchResult = {
          keywords: words,
          total: union ? 150 : 45,
          capped: union,
          complete: false,
          pages: union ? maxPages : 1,
          apiCalls: union ? maxPages : 1,
          resultType: 'poi_type',
          queryType: null,
          pois,
          via: 'api',
        };
        return res;
      },
    } as unknown as EngineClient;
    const m = meter();
    const found = await searchFacilities({
      meter: m,
      client,
      center: CITY_ORIGIN,
      frame,
      radius_m: 2600,
      warn: () => {},
    });
    expect(asked.map((a) => [a.keywords.join('$'), a.maxPages])).toEqual([
      ['小学$菜市场$菜场$农贸市场$生鲜市场$药店$药房', 3],
      ['药店$药房', 1],
    ]);
    expect(m.byStep.facilities).toBe(4);
    expect(found.inventory['小学']).toMatchObject({ complete: true });
    expect(found.inventory['药店']).toMatchObject({ complete: false, fetched: 20 });
    expect(knownRadius(found.inventory, '小学')).toBe(Infinity);
    expect(knownRadius(found.inventory, '药店')).toBeCloseTo(Math.hypot(1140, 120), 0);
    expect(found.pois.filter((p) => p.cat === '药店')).toHaveLength(20);
  });
});

describe('the 民生设施 union', () => {
  const existing: Poi[] = [
    { uid: 'osm:station', name: '张江路站', cat: '地铁', xy: [-616, 548], navi_xy: null, source: 'osm' },
    {
      uid: 'osm:clinic',
      name: '张江社区卫生服务中心',
      cat: '社区卫生',
      xy: [400, 0],
      navi_xy: null,
      source: 'osm',
    },
    {
      uid: 'hm',
      name: '盒马鲜生超市',
      cat: '超市',
      xy: [0, 300],
      navi_xy: null,
      source: 'baidu',
      merged_uids: ['hm-2'],
    },
  ];

  it('keeps only its own categories and never counts a known facility twice', () => {
    const rows = [
      placePoi('b-station', '张江路', '交通设施;地铁站', [-560, 600]), // OSM's 张江路站, 76 m away
      placePoi('b-exit', '张江路地铁站-2口', '出入口;其他', [-600, 520]),
      placePoi('b-clinic', '上海市浦东新区张江社区卫生服务中心', '医疗;综合医院', [420, 30]),
      placePoi('b-clinic2', '孙桥社区卫生服务站', '医疗;诊所', [-800, -300]),
      placePoi('hm-2', '盒马鲜生超市(张江店)', '购物;超市', [5, 305]), // merged into a known POI
      placePoi('b-shop', '联华超市', '购物;超市', [100, 100]),
      placePoi('b-pharm', '国大药房(社区卫生服务中心店)', '医疗;药店', [410, 10]),
      placePoi('b-canteen', '孙桥社区长者食堂', '美食;中餐厅', [-300, -200]),
      placePoi('b-far', '张江高科', '交通设施;地铁站', [900, 100]),
    ];
    const { pois, dropped } = livelihoodPois(rows, existing, frame);
    expect(pois.map((p) => [p.uid, p.cat])).toEqual([
      ['b-clinic2', '社区卫生'],
      ['b-shop', '超市'],
      ['b-canteen', '养老'],
      ['b-far', '地铁'],
    ]);
    const why = Object.fromEntries(dropped.map((d) => [d.uid, d.reason]));
    expect(why).toMatchObject({
      'b-station': 'duplicate:name osm:station',
      'b-exit': 'uncategorized',
      'b-clinic': 'duplicate:name osm:clinic',
      'hm-2': 'duplicate:known',
      // a pharmacy belongs to the checked inventory, with its own completeness bookkeeping
      'b-pharm': 'category:药店',
    });
  });

  it('runs one union within 1.1 km on its own budget line, and skips without one', async () => {
    const asked: { keywords: string[]; radius?: number; maxPages?: number }[] = [];
    const client = {
      placeAround: async (
        keywords: readonly string[],
        _c: LngLat,
        opts: { radius?: number; maxPages?: number },
      ) => {
        asked.push({ keywords: [...keywords], ...opts });
        return {
          keywords: [...keywords],
          total: 2,
          capped: false,
          complete: true,
          pages: 1,
          apiCalls: 1,
          resultType: 'poi_type',
          queryType: null,
          pois: [
            placePoi('p1', '滨江公园', '旅游景点;公园', [300, 300]),
            placePoi('s1', '罗山路华夏中路', '交通设施;公交车站', [200, 0]),
          ],
          via: 'api',
        } satisfies PlaceSearchResult;
      },
    } as unknown as EngineClient;
    const m = meter();
    const found = await searchLivelihood({
      meter: m,
      client,
      center: CITY_ORIGIN,
      frame,
      existing,
      warn: () => {},
    });
    expect(asked).toEqual([
      { keywords: [...LIVELIHOOD_KEYWORDS], radius: LIVELIHOOD_RADIUS_M, maxPages: 2, pageSize: 20 },
    ]);
    expect(LIVELIHOOD_RADIUS_M).toBe(1100);
    expect(m.byStep).toMatchObject({ livelihood: 1, facilities: 0 });
    expect(found!.pois.map((p) => p.cat)).toEqual(['公园', '公交']);
    expect(found!.inventory['公园']).toMatchObject({ complete: true, radius_m: 1100 });
    expect(found!.query).toMatchObject({
      keywords: LIVELIHOOD_KEYWORDS.join('$'),
      billed: 1,
      complete: true,
    });
    const none = await searchLivelihood({
      meter: meter({ livelihoodPages: 0 }),
      client,
      center: CITY_ORIGIN,
      frame,
      existing,
      warn: () => {},
    });
    expect(none).toBeNull();
    expect(asked).toHaveLength(1);
  });
});

const poi = (uid: string, cat: Poi['cat'], xy: XY): Poi => ({
  uid,
  name: uid,
  cat,
  xy,
  navi_xy: null,
  source: 'baidu',
});

const site = (id: string, xy: XY): DemandSite => ({
  id,
  name: id,
  uid: null,
  xy,
  bd09: frame.toLngLat(xy[0], xy[1]),
  gate: 'navi',
  straight_m: Math.hypot(...xy),
  merged: [],
});

/** A routematrix stand-in: `walk` metres from an origin to a destination (local metres). */
const fakeMatrix =
  (walk: (a: XY, b: XY) => number, asked: number[][] = []): MatrixFn =>
  async (_step, origins, destinations) => {
    const cells = origins.map((o) =>
      destinations.map((d): RouteCell => {
        const m = Math.round(walk(frame.toXY(o[0], o[1]), frame.toXY(d[0], d[1])));
        return { status: 'ok', distanceM: m, durationS: Math.round(m / 1.17), via: 'api' };
      }),
    );
    const n = origins.length * destinations.length;
    asked.push([origins.length, destinations.length]);
    return {
      cells,
      errors: [],
      stats: {
        pairs: n,
        unique: n,
        identity: 0,
        fromCache: 0,
        joined: 0,
        fromApi: n,
        failed: 0,
        requests: 1,
        routesRequested: n,
      },
    } satisfies RouteMatrix;
  };

describe('communities of the coverage check', () => {
  it('walk from the gate (centroid) and sit on the map at the compound POI (label_xy)', async () => {
    // three phases of one estate share a gate; their POIs lie apart
    const gate: XY = [0, 0];
    const phases = [
      { ...site('一期', gate), gate: 'navi' as const, label_xy: [-120, 80] as XY },
      { ...site('二期', gate), gate: 'navi' as const, label_xy: [60, 150] as XY },
      site('三期', [300, 0]),
    ];
    const asked: number[][] = [];
    const out = await runCoverage({
      meter: meter(),
      frame,
      matrix: fakeMatrix((a, b) => 1.2 * Math.hypot(a[0] - b[0], a[1] - b[1]), asked),
      demand: phases,
      set: {
        facilities: { 小学: [poi('s', '小学', [500, 0])], 菜市场: [], 药店: [] },
        rule: { 小学: 1000, 菜市场: 1000, 药店: 1000 },
        knownRadius: { 小学: Infinity, 菜市场: Infinity, 药店: Infinity },
      },
    });
    const by = new Map(out.communities.map((c) => [c.name, c]));
    expect(by.get('一期')).toMatchObject({ centroid: [0, 0], label_xy: [-120, 80], gate: 'navi' });
    expect(by.get('二期')).toMatchObject({ centroid: [0, 0], label_xy: [60, 150] });
    // a site without the compound's point has no label_xy (clients fall back to centroid)
    expect(by.get('三期')!.label_xy).toBeUndefined();
    // the walks start at the gate: both phases walk the same 600 m to the school
    expect(by.get('一期')!.checks['小学']).toMatchObject({ route_m: 600, status: '覆盖' });
    expect(by.get('二期')!.checks['小学'].route_m).toBe(600);
  });
});

describe('coverage with an incomplete facility list', () => {
  it('never claims a gap beyond what the facility list proves, but keeps proven coverage', async () => {
    // routes are 1.2 × straight
    const matrix = fakeMatrix((a, b) => 1.2 * Math.hypot(a[0] - b[0], a[1] - b[1]));
    const out = await runCoverage({
      meter: meter(),
      frame,
      matrix,
      demand: [site('far', [900, 0]), site('near', [100, 0])],
      set: {
        facilities: {
          小学: [poi('s', '小学', [950, 0])],
          菜市场: [poi('m', '菜市场', [960, 0])],
          药店: [poi('p', '药店', [2200, 0])],
        },
        rule: { 小学: 1000, 菜市场: 1000, 药店: 1000 },
        // the pharmacy list was cut short 1.5 km out, the school list 0 m out
        knownRadius: { 小学: 0, 菜市场: Infinity, 药店: 1500 },
      },
    });
    const far = out.communities.find((c) => c.name === 'far')!.checks;
    const near = out.communities.find((c) => c.name === 'near')!.checks;
    expect(far['小学']).toMatchObject({ status_main: '覆盖', verified: true });
    expect(far['药店']).toMatchObject({ status_main: '盲区', verified: false });
    expect(near['药店']).toMatchObject({ status_main: '盲区', verified: true });
    expect(near['小学']).toMatchObject({ status_main: '伪覆盖', verified: false });
    expect(out.unverified_by_inventory).toBe(2);
    // unverified checks never paint a verdict: `far` has only its proven coverage left
    expect(out.communities.find((c) => c.name === 'far')!.worst_status).toBe('覆盖');
  });
});

describe('coverage: the nearest walk, not the first one within the rule', () => {
  // the pharmacy next door (A) sits behind a wall; C is farther by straight line but the nearest walk
  type Key = 'A' | 'B' | 'C' | 'M';
  const WALK: Record<Key, number> = { A: 900, B: 960, C: 430, M: 800 };
  const at: Record<Key, XY> = { A: [100, 0], B: [0, 150], C: [-400, 0], M: [700, 0] };
  const byXY = (b: XY) =>
    (Object.keys(at) as Key[]).find((k) => Math.hypot(at[k][0] - b[0], at[k][1] - b[1]) < 1)!;
  const pharmacies = [poi('A', '药店', at.A), poi('B', '药店', at.B), poi('C', '药店', at.C)];
  const set: CheckSet = {
    rule: { 小学: 1000, 菜市场: 1000, 药店: 1000 },
    facilities: { 小学: [], 菜市场: [poi('M', '菜市场', at.M)], 药店: pharmacies },
    knownRadius: { 小学: Infinity, 菜市场: Infinity, 药店: Infinity },
  };
  const cover = async (coverage: number) => {
    const asked: number[][] = [];
    const nearest: number[] = [];
    const m = meter({ coverage });
    const walk = fakeMatrix((_a, b) => WALK[byXY(b)], asked);
    // metered like analyze()'s matrix
    const matrix: MatrixFn = (step, o, d) =>
      m.run(
        step,
        o.length * d.length,
        () => walk(step, o, d),
        (res) => res.stats.routesRequested,
      );
    const out = await runCoverage({
      meter: m,
      frame,
      matrix,
      demand: [site('home', [0, 0])],
      set,
      onNearest: (routes) => void nearest.push(routes),
    });
    return { ...out, asked, nearest, home: out.communities[0]! };
  };

  it('routes what could beat the best walk once the rounds are done', async () => {
    const out = await cover(400);
    // round 1 proves the pharmacy covered by A and B (the two nearest); only then does C get routed
    expect(out.asked).toEqual([
      [1, 3],
      [1, 1],
    ]);
    expect(out.nearest).toEqual([1]);
    expect(out.home.checks['药店']).toMatchObject({
      via: 'C',
      route_m: 430,
      status: '覆盖',
      verified: true,
      route_upper_bound: false,
    });
    expect(out.home.checks['药店'].unrouted_nearer).toBeUndefined();
    expect(out.home.checks['菜市场']).toMatchObject({ via: 'M', route_m: 800, route_upper_bound: false });
    expect(out.home.checks_gb).toBeUndefined();
    expect(out).toMatchObject({ nearest_routes: 1, budget_limited: false, rounds: 1 });
  });

  it('keeps the flags when the budget cannot cover the top-up, and the verdicts stay what they were', async () => {
    const out = await cover(3);
    expect(out.asked).toEqual([[1, 3]]);
    expect(out.home.checks['药店']).toMatchObject({
      via: 'A',
      route_m: 900,
      status: '覆盖',
      verified: true,
      route_upper_bound: true,
      unrouted_nearer: [{ name: 'C', uid: 'C', straight_m: 400 }],
    });
    expect(out).toMatchObject({ nearest_routes: 0, budget_limited: true, nearest: [] });
  });
});

describe('买菜替代: the nearest shop within the rule on foot that sells vegetables, for 菜市场 gaps', () => {
  // `gap`: its market M is a 1,300 m walk (伪覆盖); the 菜店 next door is behind a wall, the 生鲜超市 S
  // a short walk. `ok` walks to its market. `far` has no shop in range.
  const check = (status_main: FacilityCheck['status_main'], straight_m: number, route_m: number) =>
    ({
      straight_m,
      route_m,
      dur_s: Math.round(route_m / 1.17),
      status: status_main,
      status_main,
      borderline: false,
      route_upper_bound: false,
      verified: true,
    }) satisfies FacilityCheck;
  const covered = () => check('覆盖', 100, 120);
  const community = (name: string, xy: XY, market: FacilityCheck): Community => ({
    name,
    pts: [],
    centroid: xy,
    checks: { 小学: covered(), 菜市场: market, 药店: covered() },
  });
  const shopPoi = (
    uid: string,
    name: string,
    cat: Poi['cat'],
    tag: string,
    xy: XY,
    extra: Partial<Poi> = {},
  ) => ({ ...poi(uid, cat, xy), name, tag, ...extra }) satisfies Poi;
  const pois: Poi[] = [
    shopPoi('M', '测试菜市场', '菜市场', '购物;农贸市场;菜市场', [900, 0]),
    shopPoi('S', '鲜丰生鲜超市', '生鲜超市', '购物;超市;生鲜超市', [0, 300], { navi_xy: [0, 280] }),
    shopPoi('U', '联华超市(东店)', '超市', '购物;超市', [400, 0]),
    shopPoi('V', '全球优品(测试店)', '超市', '购物;超市', [100, 0]),
    shopPoi('T', '优品生鲜(测试菜场店)', '生鲜超市', '购物;超市;生鲜超市', [50, 50], {
      stall_of: '测试菜市场',
    }),
  ];
  // a 水果店 an earlier search returned and dropped (no category of its own)
  const earlier = [placePoi('B', '百姓生鲜蔬果(测试店)', '购物;水果店', [-300, 0])];
  // what the 买菜替代 search adds: a 菜店 (behind a wall), a 前置仓, a convenience store, U again
  const found = [
    placePoi('A', '阿婆菜店', '购物;商铺', [0, -200]),
    placePoi('D', '叮咚买菜(测试站)', '购物;超市;生鲜超市', [0, 100]),
    placePoi('K', '联华快客(测试店)', '购物;便利店', [10, 10]),
    placePoi('U', '联华超市(东店)', '购物;超市', [400, 0]),
  ];
  const exclusions: FacilityExclusion[] = [
    {
      category: ['生鲜超市', '超市', '菜市场'],
      name_pattern: '^叮咚买菜',
      reason: '测试：前置仓',
      source: 'https://example.gov.cn/x',
      date: '2026-09-29',
    },
  ];
  const WALK: Record<string, number> = { A: 1100, S: 360, B: 360, U: 480 };
  const at = new Map<string, XY>([
    ['A', [0, -200]],
    ['S', [0, 280]],
    ['B', [-300, 0]],
    ['U', [400, 0]],
  ]);
  const byXY = (b: XY) => [...at].find(([, xy]) => Math.hypot(xy[0] - b[0], xy[1] - b[1]) < 1)?.[0];
  const set: CheckSet = {
    rule: { 小学: 1000, 菜市场: 1000, 药店: 1000 },
    facilities: { 小学: [], 菜市场: [pois[0]!], 药店: [] },
    knownRadius: { 小学: Infinity, 菜市场: Infinity, 药店: Infinity },
  };

  async function fresh(opts: { coverage?: number; place?: Error; communities?: Community[] } = {}) {
    const communities = opts.communities ?? [
      community('gap', [0, 0], check('伪覆盖', 900, 1300)),
      community('ok', [2000, 0], covered()),
      community('far', [-1500, 0], check('盲区', 2400, 2400)),
    ];
    const demand = communities.map((c) => site(c.name, c.centroid));
    const asked: number[][] = [];
    const searched: { keywords: string[]; radius?: number; maxPages?: number }[] = [];
    const m = meter({ coverage: opts.coverage ?? 400 });
    const walk = fakeMatrix((_a, b) => WALK[byXY(b) ?? ''] ?? 9999, asked);
    const matrix: MatrixFn = (step, o, d) =>
      m.run(
        step,
        o.length * d.length,
        () => walk(step, o, d),
        (res) => res.stats.routesRequested,
      );
    const client = {
      placeAround: async (
        keywords: readonly string[],
        _c: LngLat,
        o: { radius?: number; maxPages?: number },
      ) => {
        searched.push({ keywords: [...keywords], radius: o.radius, maxPages: o.maxPages });
        if (opts.place) throw opts.place;
        return {
          keywords: [...keywords],
          total: found.length,
          capped: false,
          complete: true,
          pages: 1,
          apiCalls: 1,
          resultType: 'poi_type',
          queryType: null,
          pois: found,
          via: 'api',
        } satisfies PlaceSearchResult;
      },
    } as unknown as EngineClient;
    const warnings: string[] = [];
    const out = await runFreshAlternatives({
      meter: m,
      client,
      center: CITY_ORIGIN,
      frame,
      matrix,
      radius_m: 2100,
      demand,
      communities,
      pois,
      rows: earlier,
      set,
      routes: [],
      exclusions,
      warn: (w) => warnings.push(w),
    });
    const alt = (name: string) => communities.find((c) => c.name === name)!.checks['菜市场'].alt;
    return { out, alt, asked, searched, warnings, m, communities };
  }

  it('searches once, routes the two nearest within the rule and keeps the shortest walk', async () => {
    const f = await fresh();
    expect(f.searched).toEqual([{ keywords: [...FRESH_KEYWORDS], radius: 2100, maxPages: 2 }]);
    expect(FRESH_KEYWORDS).toEqual(['蔬菜', '果蔬', '生鲜', '超市']);
    // 1 km: the 菜店 (200 m, a 1,100 m walk) and S (300 m) are the two nearest; S walks 360 m
    expect(f.alt('gap')).toEqual({
      name: '鲜丰生鲜超市',
      uid: 'S',
      kind: '生鲜超市',
      xy: [0, 280],
      straight_m: 280,
      route_m: 360,
      dur_s: 308,
    });
    // nothing within the rule of `far`: looked, none; `ok` is no gap and gets no field
    expect(f.alt('far')).toBeNull();
    expect(f.alt('ok')).toBeUndefined();
    expect(f.out).toMatchObject({
      counts: { gaps: 2, with_alt: 1, none: 1, not_looked: 0 },
      query: { keywords: '蔬菜$果蔬$生鲜$超市', pages: 1, complete: true },
      budget_limited: false,
    });
    // the 菜店 and S
    expect(f.asked).toEqual([[1, 2]]);
    expect(f.out.routes).toBe(2);
    expect((f.m.byStep as Record<string, number>).fresh).toBe(1);
    // the 前置仓, the convenience store, the variety chain and the market's stall never stand in
    expect(f.out.candidates).toBe(4);
    // the verdicts stay
    const gap = f.communities.find((c) => c.name === 'gap')!;
    expect(gap.checks['菜市场']).toMatchObject({ status_main: '伪覆盖', verified: true, route_m: 1300 });
  });

  it('leaves the field out when the budget runs out, and never says none without the search', async () => {
    const tight = await fresh({ coverage: 1 });
    expect(tight.asked).toEqual([]);
    expect(tight.alt('gap')).toBeUndefined();
    expect(tight.alt('far')).toBeNull();
    expect(tight.out).toMatchObject({ budget_limited: true, routes: 0 });
    expect(tight.out.counts).toEqual({ gaps: 2, with_alt: 0, none: 1, not_looked: 1 });
    // a failed search: the shops found before still count, but no gap is declared without one
    const net = new BaiduUpstreamError('网络错误：请求超时（10000 ms）', {
      service: 'place',
      kind: 'network',
    });
    const failed = await fresh({ place: net });
    expect(failed.warnings.join('\n')).toMatch(/买菜替代检索失败/);
    expect(failed.alt('gap')).toMatchObject({ uid: 'S' });
    expect(failed.alt('far')).toBeUndefined();
    expect(failed.out).toMatchObject({ query: null, known_m: 0 });
    // a quota error ends the run
    const quota = new BaiduQuotaError('地点检索失败：status 302 天配额超限', {
      service: 'place',
      status: 302,
      scope: 'daily',
    });
    await expect(fresh({ place: quota })).rejects.toBe(quota);
  });

  it('spends nothing without a 菜市场 gap', async () => {
    const f = await fresh({ communities: [community('ok', [2000, 0], covered())] });
    expect(f.searched).toEqual([]);
    expect(f.asked).toEqual([]);
    expect(f.out).toMatchObject({ counts: { gaps: 0 }, query: null, routes: 0 });
  });
});

describe('budgets and the quota estimate', () => {
  it('applies overrides as non-negative integers and keeps dependent caps consistent', () => {
    const b = resolveBudget('personal', { place: 1, refine: -5, paths: 9.7, coverage: Number.NaN });
    expect(b).toMatchObject({
      place: 1,
      residentialPages: 1,
      livelihoodPages: 0,
      freshPages: 0,
      refine: 0,
      paths: 6,
      coverage: 400,
    });
    expect(stepCaps(b)).toMatchObject({ facilities: 0, livelihood: 0, residential: 1, fresh: 0 });
    // the defaults keep 4 pages for the checked categories, 2 for the 民生设施, 2 for compounds and 2
    // for the 买菜替代 search
    expect(stepCaps(resolveBudget('personal'))).toMatchObject({
      facilities: 4,
      livelihood: 2,
      residential: 2,
      fresh: 2,
    });
    // a smaller place budget gives up the 买菜替代 pages before the checked categories'
    expect(stepCaps(resolveBudget('personal', { place: 5 }))).toMatchObject({
      facilities: 1,
      livelihood: 2,
      residential: 2,
      fresh: 0,
    });
    expect(stepCaps(resolveBudget('personal', { place: 9 }))).toMatchObject({ facilities: 4, fresh: 1 });
    expect(stepCaps(resolveBudget('personal', { place: 12 }))).toMatchObject({ facilities: 6, fresh: 2 });
    expect(stepCaps(resolveBudget('personal', { freshPages: 0 }))).toMatchObject({ facilities: 6, fresh: 0 });
    expect(stepCaps(resolveBudget('enterprise'))).toMatchObject({ facilities: 7, fresh: 3 });
    expect(serviceCaps(resolveBudget('enterprise')).routematrix_walking).toBe(48 + 288 + 900 + 120 + 80);
  });

  it('plans within the caps', () => {
    const task = planQuota({ center_bd09: CITY_ORIGIN });
    for (const s of task.steps) expect(s.expected).toBeLessThanOrEqual(s.max);
    // the coverage check expects about 8 routes per compound
    expect(task.steps.find((s) => s.step === 'coverage')).toMatchObject({ expected: 8 * 30 });
    expect(planQuota({ center_bd09: CITY_ORIGIN }, { tier: 'enterprise' }).max.place).toBe(15);
    expect(task.max.place).toBe(10);
    expect(task.expected.place).toBe(9);
    expect(task.steps.find((s) => s.step === 'livelihood')).toMatchObject({
      stage: 'facilities',
      service: 'place',
      expected: 2,
      max: 2,
    });
    expect(task.steps.find((s) => s.step === 'fresh')).toMatchObject({
      stage: 'coverage',
      service: 'place',
      expected: 2,
      max: 2,
    });
    expect(() => planQuota({ center_bd09: [0, 0] })).toThrow(EngineError);
    expect(task.steps.every((s) => /[一-鿿]/.test(s.note))).toBe(true);
  });
});

describe('meter', () => {
  it('keeps steps inside their lines and reports the ledger after each call', async () => {
    const ledger = new QuotaLedger({ tier: 'personal' });
    const events: QuotaEvent[] = [];
    const b = resolveBudget('personal');
    const m = new Meter(stepCaps(b), serviceCaps(b), { ledger, onQuota: (e) => events.push(e) });
    expect(m.room('seed')).toBe(48);
    await expect(
      m.run(
        'seed',
        49,
        async () => 1,
        () => 49,
      ),
    ).rejects.toThrow(/budget/);
    await m.run(
      'seed',
      48,
      async () => ledger.acquire('routematrix_walking', 48).commit(),
      () => 48,
    );
    expect(m.room('seed')).toBe(0);
    expect(m.room('refine')).toBe(192);
    expect(events).toEqual([{ service: 'routematrix_walking', used: 48, limit: 5000 }]);
    // an unchanged total is not reported twice
    await m.run(
      'refine',
      10,
      async () => 0,
      () => 0,
    );
    expect(events).toHaveLength(1);
  });

  it('rejects with the abort reason while the call is still running', async () => {
    const controller = new AbortController();
    const slow = new Promise<number>((resolve) => setTimeout(() => resolve(1), 1000));
    const p = abortable(slow, controller.signal);
    const reason = new Error('stop');
    controller.abort(reason);
    await expect(p).rejects.toBe(reason);
  });
});

describe('errors', () => {
  it('maps Baidu errors to the four codes with their Chinese fix hints, and leaves bugs alone', () => {
    const q = toEngineError(
      new BaiduQuotaError('地点检索今日配额已用到 90%', {
        service: 'place',
        scope: 'soft',
        hint: '北京时间次日 0 点恢复',
      }),
    );
    expect(q).toMatchObject({
      code: 'quota_exhausted',
      message: '地点检索今日配额已用到 90%；北京时间次日 0 点恢复',
    });
    expect(toEngineError(new BaiduConfigError('SN 校验失败', { status: 211 }))?.code).toBe('auth');
    expect(toEngineError(new BaiduInputError('坐标不对'))?.code).toBe('invalid_input');
    expect(toEngineError(new BaiduUpstreamError('网络错误', { kind: 'network' }))?.code).toBe('upstream');
    const own = new EngineError('invalid_input', '坐标不对');
    expect(toEngineError(own)).toBe(own);
    expect(toEngineError(new TypeError('x is undefined'))).toBeNull();
  });
});

describe('areaName', () => {
  const rev = (over: Partial<ReverseGeocodeResult>): ReverseGeocodeResult =>
    ({ pois: [], regions: [], street: '孙环路', town: '张江镇', ...over }) as unknown as ReverseGeocodeResult;
  const C: LngLat = [121.644195, 31.19007];

  it('names the housing estate the centre lies in', () => {
    const r = rev({ regions: [{ name: '申城佳苑', tag: '房地产;住宅区', uid: 'u', relation: '内' }] });
    expect(areaName(C, '孙环路 × 高木桥路', r)).toBe('申城佳苑片区');
  });
  it('uses a searched estate name with 片区 and any other place with 周边', () => {
    const estate = rev({
      pois: [{ name: '玉兰香苑一期', tag: '房地产;住宅区' }] as ReverseGeocodeResult['pois'],
    });
    expect(areaName(C, '玉兰香苑', estate)).toBe('玉兰香苑片区');
    const office = rev({ regions: [{ name: 'AI应用商店', tag: '公司企业;园区', uid: 'u', relation: '内' }] });
    expect(areaName(C, 'AI小镇服务中心（海科路1650号）', office)).toBe('AI小镇服务中心周边');
  });
  it('falls back from a crossing label to the street', () => {
    expect(areaName(C, '孙环路 × 高木桥路', rev({}))).toBe('张江镇孙环路周边');
  });
});

describe('official list fusion', () => {
  it('reduces market names to their branch and addresses to street and number', () => {
    expect(branchToken('浦商生鲜(申城佳苑店)')).toBe('申城佳苑');
    expect(branchToken('浦商生鲜申城佳苑店')).toBe('申城佳苑');
    expect(branchToken('浦商农产品（紫薇店）')).toBe('紫薇');
    expect(branchToken('浦商生鲜紫薇店')).toBe('紫薇');
    expect(branchToken('浦商邻里荟(孙桥店)')).toBe(branchToken('浦商邻里荟孙桥店'));
    expect(branchToken('北街农贸市场')).toBe('北街');
    expect(branchToken('王记肉铺(临河菜市场店)')).toBe('王记肉铺临河');
    expect(streetAddress('上海市浦东新区孙建路858号')).toBe('孙建路858号');
    expect(streetAddress('孙建路858号(近孙环路)')).toBe('孙建路858号');
    expect(streetAddress('张江镇广兰路1092弄2-6号')).toBe('广兰路1092弄2-6号');
    expect(streetAddress('孙桥路与华夏中路交叉口')).toBeNull();
    expect(streetAddress(null)).toBeNull();
  });

  it('matches by branch or street within 250 m (400 m when both agree), never stalls or other categories', () => {
    const ll = (xy: XY) => frame.toLngLat(xy[0], xy[1]);
    const door = { precise: true, confidence: 80, level: '门址' };
    const row = (uid: string, name: string, tag: string, xy: XY, address: string | null, navi?: XY) => ({
      ...placePoi(uid, name, tag, xy, navi),
      address,
    });
    const pool = [
      row('a', '浦商生鲜(申城佳苑店)', '购物', [320, 10], '上海市浦东新区孙建路858号', [330, 0]),
      row('b', '益丰大药房(孙建路店)', '医疗;药店', [305, 5], '孙建路858号'),
      row('c', '王记肉铺(申城佳苑菜市场店)', '购物;肉店', [310, -5], '孙建路858号'),
      row('d', '浦商生鲜(环西店)', '购物;超市;生鲜超市', [0, 780], '孙环路643号', [0, 790]),
      row('e', '浦商农产品(紫薇店)', '购物;超市;生鲜超市', [-600, 300], '广兰路1100号'),
      row('f', '高木桥菜场', '购物;菜市场', [700, 1150], '高木桥路1号'),
      row('g', '装修菜场', '购物;菜市场', [-300, -290], '装修路9号'),
    ];
    const clean = cleanPois(pool.map(toPlaceResult), { project: frame.toXY });
    expect(clean.dropped.map((d) => d.uid)).toEqual(['a']);
    const list: OfficialList = {
      id: 'pd',
      category: '菜市场',
      title: '菜市场实效测评',
      publisher: '浦东新区商务委员会',
      published: '2023-11-21',
      url: 'https://www.pudong.gov.cn/x.html',
      region: { city: '上海市', district: '浦东新区' },
      entries: [
        {
          name: '浦商生鲜申城佳苑店',
          address: '孙建路858号',
          status: 'active',
          bd09: ll([300, 0]),
          geocode: door,
        },
        {
          name: '浦商生鲜环西店',
          address: '孙环路643号',
          status: 'active',
          bd09: ll([0, 500]),
          geocode: door,
        },
        {
          name: '浦商生鲜紫薇店',
          address: '广兰路1092弄2-6号',
          status: 'active',
          bd09: ll([-600, 0]),
          geocode: door,
        },
        {
          name: '浦商生鲜远方店',
          address: '远方路1号',
          status: 'active',
          bd09: ll([5000, 0]),
          geocode: door,
        },
        {
          name: '浦商生鲜装修店',
          address: '装修路9号',
          status: '装修改造',
          bd09: ll([-300, -300]),
          geocode: door,
        },
        {
          name: '浦商生鲜高木桥店',
          address: '高木桥路1号',
          status: 'active',
          bd09: ll([700, 700]),
          geocode: { precise: false, confidence: 40, level: '道路' },
        },
      ],
    };
    const odd = { ...list, id: 'odd', category: '学校' as never, entries: [] };
    const far = { ...list, id: 'far', entries: [list.entries[3]!] };
    const out = fuseOfficial({
      lists: [list, odd, far],
      pois: clean.pois,
      dropped: clean.dropped,
      pool,
      frame,
      radius_m: 2100,
    });
    const by = (uid: string) => out.pois.find((p) => p.uid === uid);
    // dropped for its plain 购物 tag, found again by branch and street; Baidu's entrance kept
    expect(by('a')).toMatchObject({
      cat: '菜市场',
      source: 'baidu',
      navi_xy: [330, 0],
      official: { list: 'pd', name: '浦商生鲜申城佳苑店', address: '孙建路858号', reclassified_from: '购物' },
    });
    expect(out.dropped).toEqual([]);
    // the pharmacy and the stall share the street address but are not the market
    expect(by('b')).toMatchObject({ cat: '药店' });
    expect(by('b')!.official).toBeUndefined();
    expect(by('c')!.official).toBeUndefined();
    // 280 m apart, but branch and street agree
    expect(by('d')).toMatchObject({ cat: '菜市场', official: { reclassified_from: '生鲜超市' } });
    // only the branch agrees at 300 m, and 450 m is too far even when both agree: added from the list
    expect(by('e')).toMatchObject({ cat: '生鲜超市' });
    expect(by('f')!.official).toBeUndefined();
    expect(by('gov:pd:2')).toMatchObject({
      name: '浦商生鲜紫薇店',
      source: 'gov',
      xy: [-600, 0],
      navi_xy: null,
    });
    expect(by('gov:pd:5')).toMatchObject({ name: '浦商生鲜高木桥店', source: 'gov' });
    // out of range, closed: nothing
    expect(out.pois.some((p) => p.uid === 'gov:pd:3' || p.uid === 'gov:pd:4')).toBe(false);
    expect(by('g')!.official).toBeUndefined();
    // the input is left alone
    expect(clean.pois.find((p) => p.uid === 'd')!.cat).toBe('生鲜超市');
    expect(out.summaries).toEqual([
      {
        list: 'pd',
        category: '菜市场',
        in_range: 4,
        confirmed: 0,
        reclassified: 2,
        added: 2,
        imprecise: 1,
        inactive_in_range: 1,
      },
      {
        list: 'far',
        category: '菜市场',
        in_range: 0,
        confirmed: 0,
        reclassified: 0,
        added: 0,
        imprecise: 0,
        inactive_in_range: 0,
      },
    ]);
    expect(out.notes).toEqual([
      '菜市场名录（浦东新区商务委员会《菜市场实效测评》）：范围内 4 家，与百度 POI 一致 0 家，' +
        '百度标为购物或生鲜超市而改类 2 家，百度检索未返回、按官方地址补充 2 家；另有 1 家装修改造，未计入。',
    ]);
    expect(out.attribution).toEqual([
      '浦东新区商务委员会《菜市场实效测评》（2023-11-21）：https://www.pudong.gov.cn/x.html',
    ]);
    expect(out.warnings).toEqual([
      '菜市场名录：浦商生鲜高木桥店（高木桥路1号）的官方地址只定位到“道路”级（非精确），补充的点位可能有偏差',
      '名录 odd 的类别“学校”无法识别，未使用',
    ]);
  });

  it('matches schools by name and campus (校区 / 分校 / brackets) or by street, and health centres by name', () => {
    const ll = (xy: XY) => frame.toLngLat(xy[0], xy[1]);
    const door = { precise: true, confidence: 80, level: '门址' };
    const row = (uid: string, name: string, tag: string, xy: XY, address: string | null, navi?: XY) => ({
      ...placePoi(uid, name, tag, xy, navi),
      address,
    });
    expect(officialNameKey('上海市浦东新区孙桥小学（张江校区）', '小学')).toBe(
      officialNameKey('孙桥小学(张江校区)', '小学'),
    );
    expect(officialNameKey('浦东新区张江社区卫生服务中心', '社区卫生')).toBe('张江社区卫生服务中心');
    expect(sameStreet('紫薇路686号', '上海市浦东新区紫薇路686弄')).toBe(true);
    expect(sameStreet('孙宇路289号', '上海市浦东新区殷北路468号')).toBe(false);

    const pool = [
      row(
        'zj',
        '孙桥小学(张江校区)',
        '教育培训;小学',
        [0, 0],
        '上海市浦东新区张江镇张江路1615号(张江路地铁站1号口步行350米)',
        [10, 0],
      ),
      row(
        'sj',
        '孙桥小学(申江校区)',
        '教育培训;小学',
        [-150, -1100],
        '上海市浦东新区殷北路468号',
        [-160, -1100],
      ),
      row('zc', '上海市张江中心小学', '教育培训;小学', [100, 1900], '上海市浦东新区紫薇路686弄'),
      row('zq', '筑桥实验小学', '教育培训;小学', [-1500, 0], '上海市浦东新区海科路669弄'),
      row('dx', '上海市实验学校东校', '教育培训;中学', [500, 500], '黑松路251号'),
      row('yh', '上海市浦东新区育华学校(雪英校区)', '教育培训;小学', [1300, 0], '三灶浜路951号-临'),
    ];
    const clean = cleanPois(pool.map(toPlaceResult), { project: frame.toXY });
    const schools: OfficialList = {
      id: 'schools',
      category: '小学',
      title: '2026年浦东新区义务教育阶段学校招生入学信息公示（小学）',
      publisher: '上海市浦东新区教育局',
      published: '2026-04-07',
      url: 'https://www.pudong.gov.cn/s.html',
      region: { city: '上海市', district: '浦东新区' },
      entries: [
        {
          name: '上海市浦东新区孙桥小学（张江校区）',
          address: '张江路1615号',
          status: 'active',
          bd09: ll([30, 20]),
          geocode: door,
        },
        // geocoded 460 m from Baidu's point, other street: the unique name and campus still decide
        {
          name: '上海市浦东新区孙桥小学（申江校区）',
          address: '孙宇路289号',
          status: 'active',
          bd09: ll([-600, -1200]),
          geocode: door,
        },
        // Baidu drops 镇 from the name, but 686号 and 686弄 are one site
        {
          name: '上海市浦东新区张江镇中心小学',
          address: '紫薇路686号',
          status: 'active',
          bd09: ll([120, 1950]),
          geocode: door,
        },
        {
          name: '上海浦东新区民办筑桥实验小学',
          address: '海科路669号',
          status: 'active',
          bd09: ll([-1480, 10]),
          geocode: door,
        },
        // a 九年一贯制 school Baidu files under 中学: back in as a 小学
        {
          name: '上海市实验学校东校',
          address: '黑松路251号',
          status: 'active',
          bd09: ll([510, 490]),
          geocode: door,
        },
        {
          name: '上海市浦东新区辅读学校（陆家嘴校区）',
          address: '崂山路551弄40号',
          status: '特殊教育',
          bd09: ll([200, -300]),
          geocode: door,
        },
        {
          name: '上海市浦东新区观澜小学东校',
          address: '小营房路155号',
          status: 'active',
          bd09: ll([900, -900]),
          geocode: door,
        },
        { name: '上海市浦东新区上南实验小学（三林校区）', address: '三旋路218号', status: 'active' },
      ],
    };
    const health: OfficialList = {
      id: 'health',
      category: '社区卫生',
      title: '上海市社区卫生服务中心信息',
      publisher: '上海市卫生健康委员会',
      published: '2026-03-31',
      url: 'https://wsjkw.sh.gov.cn/h.html',
      region: { city: '上海市', district: '浦东新区' },
      entries: [
        {
          name: '张江社区卫生服务中心',
          address: '益江路458号',
          status: 'active',
          bd09: ll([0, 800]),
          geocode: door,
        },
        {
          name: '孙桥社区卫生服务中心',
          address: '横沔江路274号',
          status: 'active',
          bd09: ll([-400, -900]),
          geocode: door,
        },
      ],
    };
    const out = fuseOfficial({
      lists: [schools],
      pois: clean.pois,
      dropped: clean.dropped,
      pool,
      frame,
      radius_m: 2100,
      district: '浦东新区',
    });
    const by = (uid: string) => out.pois.find((p) => p.uid === uid);
    expect(by('zj')).toMatchObject({
      cat: '小学',
      navi_xy: [10, 0],
      official: { name: '上海市浦东新区孙桥小学（张江校区）' },
    });
    expect(by('zj')!.official!.reclassified_from).toBeUndefined();
    expect(by('sj')).toMatchObject({ official: { name: '上海市浦东新区孙桥小学（申江校区）' } });
    expect(by('zc')).toMatchObject({ official: { name: '上海市浦东新区张江镇中心小学' } });
    expect(by('zq')).toMatchObject({ official: { name: '上海浦东新区民办筑桥实验小学' } });
    expect(by('dx')).toMatchObject({ cat: '小学', official: { reclassified_from: '教育培训' } });
    // Baidu's 小学 that the list does not know stays as Baidu has it (exclusions handle proven errors)
    expect(by('yh')!.official).toBeUndefined();
    expect(by('gov:schools:6')).toMatchObject({ name: '上海市浦东新区观澜小学东校', source: 'gov' });
    expect(out.summaries[0]).toEqual({
      list: 'schools',
      category: '小学',
      in_range: 6,
      confirmed: 4,
      reclassified: 1,
      added: 1,
      imprecise: 0,
      inactive_in_range: 1,
      ungeocoded: 1,
    });
    expect(out.notes[0]).toBe(
      '小学名录（上海市浦东新区教育局《2026年浦东新区义务教育阶段学校招生入学信息公示（小学）》）：范围内 6 所，' +
        '与百度 POI 一致 4 所，百度标为教育培训而改类 1 所，百度检索未返回、按官方地址补充 1 所；另有 1 所特殊教育，未计入。' +
        '名录中另有 1 条尚无坐标，没有参与融合。',
    );
    // a name alone is not enough beyond 800 m
    const far = fuseOfficial({
      lists: [{ ...schools, entries: [{ ...schools.entries[1]!, bd09: ll([-150, -2000]) }] }],
      pois: clean.pois,
      dropped: clean.dropped,
      pool,
      frame,
      radius_m: 2100,
    });
    expect(far.summaries[0]).toMatchObject({ confirmed: 0, added: 1 });

    // health centres: Baidu's garbled address does not matter, the name does
    const livelihood = [
      row(
        'hc',
        '浦东新区张江社区卫生服务中心',
        '医疗;医院;社区卫生服务中心',
        [0, 300],
        '上海市浦东新区益江路店浦东新张江镇区益江路458号',
      ),
      row('st', '申佳社区卫生服务站', '医疗;医院;社区卫生服务中心', [250, -200], '孙建路张江B9-1地块'),
    ];
    const lp = cleanPois(livelihood.map(toPlaceResult), { project: frame.toXY }).pois;
    const h = fuseOfficial({
      lists: [health],
      pois: lp,
      dropped: [],
      pool: livelihood,
      frame,
      radius_m: 1100,
    });
    expect(h.pois.find((p) => p.uid === 'hc')).toMatchObject({
      cat: '社区卫生',
      official: { name: '张江社区卫生服务中心' },
    });
    expect(h.pois.find((p) => p.uid === 'st')!.official).toBeUndefined();
    expect(h.pois.find((p) => p.uid === 'gov:health:1')).toMatchObject({
      name: '孙桥社区卫生服务中心',
      source: 'gov',
    });
    expect(h.summaries[0]).toMatchObject({ confirmed: 1, added: 1 });
    expect(h.notes[0]).toMatch(
      /^社区卫生名录（上海市卫生健康委员会《上海市社区卫生服务中心信息》）：范围内 2 家/,
    );
  });
});
