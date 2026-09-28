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
import { cleanPois, localFrame, type LngLat, type Poi, type XY } from '@zoudedao/core';
import { describe, expect, it } from 'vitest';

import type { MatrixFn } from '../src/coverage.js';
import { runCoverage } from '../src/coverage.js';
import { searchFacilities, toPlaceResult } from '../src/facilities.js';
import {
  areaName,
  baseName,
  branchToken,
  EngineError,
  fuseOfficial,
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
    expect(by.get('滨河花园')).toMatchObject({
      uid: 'a',
      xy: [320, 300],
      gate: 'navi',
      merged: ['a2', 'a3', 'a4'],
    });
    expect(by.get('临河小区')).toMatchObject({ gate: 'gate_poi', xy: [-350, 0] });
    expect(by.get('枫林苑')).toMatchObject({ gate: 'location', xy: [0, -500] });
    // a gate alone stands for a compound only when its name says 小区
    expect(by.get('银河小区')).toMatchObject({ gate: 'gate_poi', uid: 'd' });
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
      rules: 'task',
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
    expect(knownRadius(found.inventory, '小学', 'task')).toBe(Infinity);
    expect(knownRadius(found.inventory, '药店', 'task')).toBeCloseTo(Math.hypot(1140, 120), 0);
    expect(found.pois.filter((p) => p.cat === '药店')).toHaveLength(20);
  });
});

describe('coverage with an incomplete facility list', () => {
  it('never claims a gap beyond what the facility list proves, but keeps proven coverage', async () => {
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
    // routes are 1.2 × straight
    const matrix: MatrixFn = async (_step, origins, destinations) => {
      const cells = origins.map((o) =>
        destinations.map((d): RouteCell => {
          const a = frame.toXY(o[0], o[1]);
          const b = frame.toXY(d[0], d[1]);
          const m = Math.round(1.2 * Math.hypot(a[0] - b[0], a[1] - b[1]));
          return { status: 'ok', distanceM: m, durationS: Math.round(m / 1.17), via: 'api' };
        }),
      );
      const n = origins.length * destinations.length;
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
    const out = await runCoverage({
      meter: meter(),
      frame,
      matrix,
      demand: [site('far', [900, 0]), site('near', [100, 0])],
      facilities: {
        小学: [poi('s', '小学', [950, 0])],
        菜市场: [poi('m', '菜市场', [960, 0])],
        药店: [poi('p', '药店', [2200, 0])],
      },
      rule: { 小学: 1000, 菜市场: 1000, 药店: 1000 },
      // the pharmacy list was cut short 1.5 km out, the school list 0 m out
      knownRadius: { 小学: 0, 菜市场: Infinity, 药店: 1500 },
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

describe('budgets and the quota estimate', () => {
  it('applies overrides as non-negative integers and keeps dependent caps consistent', () => {
    const b = resolveBudget('personal', { place: 1, refine: -5, paths: 9.7, coverage: Number.NaN });
    expect(b).toMatchObject({ place: 1, residentialPages: 1, refine: 0, paths: 6, coverage: 400 });
    expect(stepCaps(b)).toMatchObject({ facilities: 0, residential: 1 });
    expect(serviceCaps(resolveBudget('enterprise')).routematrix_walking).toBe(48 + 288 + 900 + 120);
  });

  it('plans within the caps; GB 50180 expects fewer coverage routes', () => {
    const task = planQuota({ center_bd09: CITY_ORIGIN });
    const gb = planQuota({ center_bd09: CITY_ORIGIN, rules: 'gb50180' });
    for (const s of task.steps) expect(s.expected).toBeLessThanOrEqual(s.max);
    expect(gb.expected.routematrix_walking).toBeLessThan(task.expected.routematrix_walking);
    expect(planQuota({ center_bd09: CITY_ORIGIN }, { tier: 'enterprise' }).max.place).toBe(10);
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
});
