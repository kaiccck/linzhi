/**
 * Synthetic city for the engine tests: a 100 m street grid, a straight river at x = 450 m that only one
 * bridge crosses (at y = −300 m), walking = shortest path on the grid (Dijkstra) at Baidu's 1.17 m/s.
 * Some compounds on one bank have their nearest school or market on the other bank.
 */
import { localFrame, type LngLat, type LocalFrame, type XY } from '@zoudedao/core';

import type { OfficialList } from '../src/index.js';

export const CITY_ORIGIN: LngLat = [121.5, 31.2];
export const SPEED = 1.17;

export interface CityPoi {
  uid: string;
  name: string;
  /** Baidu classified tag, e.g. 教育培训;小学. */
  tag: string;
  xy: XY;
  navi?: XY;
  parent?: string;
  /** In Baidu's database but never returned by place search (only the browser JSAPI and detail know it). */
  hidden?: boolean;
}

interface Snap {
  /** Edge end nodes, a < b. */
  a: number;
  b: number;
  /** Position along a → b, 0..1. */
  t: number;
  point: XY;
  /** Straight walk from the point to the street. */
  access: number;
}

class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];
  get size() {
    return this.keys.length;
  }
  push(key: number, val: number) {
    this.keys.push(key);
    this.vals.push(val);
    let i = this.keys.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p]! <= this.keys[i]!) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): [number, number] {
    const top: [number, number] = [this.keys[0]!, this.vals[0]!];
    const k = this.keys.pop()!;
    const v = this.vals.pop()!;
    if (this.keys.length) {
      this.keys[0] = k;
      this.vals[0] = v;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.keys.length && this.keys[l]! < this.keys[m]!) m = l;
        if (r < this.keys.length && this.keys[r]! < this.keys[m]!) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
  private swap(i: number, j: number) {
    [this.keys[i], this.keys[j]] = [this.keys[j]!, this.keys[i]!];
    [this.vals[i], this.vals[j]] = [this.vals[j]!, this.vals[i]!];
  }
}

export interface CityRoute {
  /** Network metres from the street point next to `from` to the one next to `to`. */
  distance: number;
  /** Street points: snapped start, intersections, snapped end. */
  points: XY[];
}

export class City {
  readonly frame: LocalFrame = localFrame(CITY_ORIGIN[0], CITY_ORIGIN[1]);
  readonly spacing = 100;
  readonly half = 3000;
  readonly riverX = 450;
  readonly bridgeY = -300;
  readonly pois: CityPoi[];
  private readonly N: number;
  private readonly n: number;
  private readonly adj: number[][];
  private readonly trees = new Map<string, { dist: Float64Array; prev: Int32Array }>();

  constructor(pois: CityPoi[] = cityPois()) {
    this.N = Math.round(this.half / this.spacing);
    this.n = 2 * this.N + 1;
    this.adj = Array.from({ length: this.n * this.n }, () => []);
    for (let j = -this.N; j <= this.N; j++) {
      for (let i = -this.N; i <= this.N; i++) {
        const id = this.id(i, j);
        if (i < this.N && this.eastLinkOpen(i, j)) this.link(id, this.id(i + 1, j));
        if (j < this.N) this.link(id, this.id(i, j + 1));
      }
    }
    this.pois = pois;
  }

  /** The street between column i and i + 1 exists unless the river runs between them (bridge excepted). */
  private eastLinkOpen(i: number, j: number): boolean {
    const x0 = i * this.spacing;
    const x1 = x0 + this.spacing;
    const crosses = x0 < this.riverX && this.riverX < x1;
    return !crosses || j * this.spacing === this.bridgeY;
  }

  private id(i: number, j: number): number {
    return (j + this.N) * this.n + (i + this.N);
  }

  nodeXY(id: number): XY {
    return [((id % this.n) - this.N) * this.spacing, (Math.floor(id / this.n) - this.N) * this.spacing];
  }

  private link(a: number, b: number) {
    this.adj[a]!.push(b);
    this.adj[b]!.push(a);
  }

  /** Nearest point on an existing street of the grid cell the point lies in. */
  snap(p: XY): Snap {
    const s = this.spacing;
    const clamp = (v: number) => Math.max(-this.half, Math.min(this.half, v));
    const x = clamp(p[0]);
    const y = clamp(p[1]);
    const i0 = Math.max(-this.N, Math.min(this.N - 1, Math.floor(x / s)));
    const j0 = Math.max(-this.N, Math.min(this.N - 1, Math.floor(y / s)));
    const edges: [number, number][] = [
      [this.id(i0, j0), this.id(i0 + 1, j0)],
      [this.id(i0, j0 + 1), this.id(i0 + 1, j0 + 1)],
      [this.id(i0, j0), this.id(i0, j0 + 1)],
      [this.id(i0 + 1, j0), this.id(i0 + 1, j0 + 1)],
    ];
    let best: Snap | null = null;
    for (const [a, b] of edges) {
      if (!this.adj[a]!.includes(b)) continue;
      const pa = this.nodeXY(a);
      const pb = this.nodeXY(b);
      const dx = pb[0] - pa[0];
      const dy = pb[1] - pa[1];
      const t = Math.max(0, Math.min(1, ((p[0] - pa[0]) * dx + (p[1] - pa[1]) * dy) / (dx * dx + dy * dy)));
      const point: XY = [pa[0] + t * dx, pa[1] + t * dy];
      const access = Math.hypot(p[0] - point[0], p[1] - point[1]);
      if (!best || access < best.access - 1e-9) best = { a, b, t, point, access };
    }
    return best!;
  }

  private tree(sn: Snap) {
    const key = `${sn.a},${sn.b},${sn.t.toFixed(6)}`;
    const hit = this.trees.get(key);
    if (hit) return hit;
    const L = this.spacing;
    const dist = new Float64Array(this.adj.length).fill(Infinity);
    const prev = new Int32Array(this.adj.length).fill(-1);
    const heap = new MinHeap();
    dist[sn.a] = sn.t * L;
    dist[sn.b] = (1 - sn.t) * L;
    prev[sn.a] = prev[sn.b] = -2;
    heap.push(dist[sn.a]!, sn.a);
    heap.push(dist[sn.b]!, sn.b);
    while (heap.size) {
      const [d, u] = heap.pop();
      if (d > dist[u]!) continue;
      for (const v of this.adj[u]!) {
        const nd = d + L;
        if (nd < dist[v]!) {
          dist[v] = nd;
          prev[v] = u;
          heap.push(nd, v);
        }
      }
    }
    const out = { dist, prev };
    this.trees.set(key, out);
    return out;
  }

  /** Shortest street route between the street points next to `from` and `to`. */
  route(from: XY, to: XY): CityRoute {
    const sa = this.snap(from);
    const sb = this.snap(to);
    const L = this.spacing;
    const { dist, prev } = this.tree(sa);
    const viaA = dist[sb.a]! + sb.t * L;
    const viaB = dist[sb.b]! + (1 - sb.t) * L;
    const sameEdge = sa.a === sb.a && sa.b === sb.b;
    const direct = sameEdge ? Math.abs(sa.t - sb.t) * L : Infinity;
    if (direct <= Math.min(viaA, viaB)) return { distance: direct, points: dedupe([sa.point, sb.point]) };
    const end = viaA <= viaB ? sb.a : sb.b;
    const nodes: number[] = [];
    for (let u = end; u >= 0; u = prev[u]!) nodes.push(u);
    nodes.reverse();
    return {
      distance: Math.min(viaA, viaB),
      points: dedupe([sa.point, ...nodes.map((u) => this.nodeXY(u)), sb.point]),
    };
  }

  /** What routematrix answers: the street route plus the short walks to and from the street. */
  walk(from: XY, to: XY): number {
    const r = this.route(from, to);
    return r.distance + this.snap(from).access + this.snap(to).access;
  }

  /** place/v3 around: keyword by keyword (a POI stays in the first group it matched), each group nearest first. */
  place(keywords: readonly string[], center: XY, radius: number): CityPoi[] {
    const seen = new Set<string>();
    const out: CityPoi[] = [];
    const d = (p: CityPoi) => Math.hypot(p.xy[0] - center[0], p.xy[1] - center[1]);
    for (const k of keywords) {
      const group = this.pois
        .filter(
          (p) => !p.hidden && !seen.has(p.uid) && (p.name.includes(k) || p.tag.includes(k)) && d(p) <= radius,
        )
        .sort((p, q) => d(p) - d(q));
      for (const p of group) seen.add(p.uid);
      out.push(...group);
    }
    return out;
  }

  toLngLat(xy: XY): LngLat {
    return this.frame.toLngLat(xy[0], xy[1]);
  }

  toXY(p: LngLat): XY {
    return this.frame.toXY(p[0], p[1]);
  }

  /** Walking-time truth at a point from the city origin (seconds). */
  timeFromOrigin(xy: XY): number {
    return this.walk([0, 0], xy) / SPEED;
  }
}

function dedupe(pts: XY[]): XY[] {
  return pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1]![0], p[1] - pts[i - 1]![1]) > 1e-6);
}

/** Straight runs of a street route (a new step at every turn), each densified to ≤ 25 m vertices. */
export function routeSteps(points: readonly XY[]): { distance: number; points: XY[] }[] {
  const steps: { distance: number; points: XY[] }[] = [];
  let cur: XY[] = [];
  let dir: XY | null = null;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const d: XY = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    if (dir && Math.abs(d[0] - dir[0]) + Math.abs(d[1] - dir[1]) > 1e-6) {
      steps.push(finish(cur));
      cur = [];
    }
    if (!cur.length) cur.push(a);
    const k = Math.max(1, Math.ceil(len / 25));
    for (let s = 1; s <= k; s++) cur.push([a[0] + ((b[0] - a[0]) * s) / k, a[1] + ((b[1] - a[1]) * s) / k]);
    dir = d;
  }
  if (cur.length > 1) steps.push(finish(cur));
  return steps;
}

function finish(pts: XY[]): { distance: number; points: XY[] } {
  let d = 0;
  for (let i = 1; i < pts.length; i++)
    d += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
  return { distance: d, points: pts };
}

// ------------------------------------------------------------------------------------------ POIs

const COMPOUND_NAMES = [
  '枫林苑',
  '桂花园',
  '梧桐里',
  '银杏苑',
  '紫藤小区',
  '海棠苑',
  '樱花园',
  '翠竹苑',
  '松风里',
  '柳岸花园',
  '兰亭苑',
  '梅园新村',
  '杏林苑',
  '芙蓉里',
  '丁香小区',
  '青枫苑',
  '玉兰花园',
  '碧水苑',
  '金桂里',
  '银河小区',
  '春晓苑',
  '秋实花园',
  '云锦苑',
  '星河湾',
  '阳光里',
  '和平新村',
  '幸福小区',
  '康乐苑',
  '安居里',
  '明珠苑',
  '华庭小区',
  '书香苑',
  '静安里',
  '朝阳新村',
  '望江苑',
];

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Street point a gate would sit on: the nearest grid line of the block. */
function gateOf(xy: XY): XY {
  const s = 100;
  const gx = Math.round(xy[0] / s) * s;
  const gy = Math.round(xy[1] / s) * s;
  return Math.abs(xy[0] - gx) < Math.abs(xy[1] - gy) ? [gx, xy[1]] : [xy[0], gy];
}

const HOME = '房地产;住宅区';
const GATE = '出入口;门';

/** Facilities and compounds of the synthetic city (local metres around CITY_ORIGIN). */
export function cityPois(): CityPoi[] {
  const pois: CityPoi[] = [
    // schools: 河东实验小学 is the nearest school of 滨河花园 across the river; a copy of it and a tutoring
    // centre with 小学 in its name must not count
    { uid: 's1', name: '临河第一小学', tag: '教育培训;小学', xy: [-760, 330], navi: [-700, 330] },
    { uid: 's2', name: '河东实验小学', tag: '教育培训;小学', xy: [760, 330], navi: [700, 330] },
    { uid: 's2b', name: '河东实验小学', tag: '教育培训;小学', xy: [765, 338] },
    { uid: 's3', name: '南苑小学', tag: '教育培训;小学', xy: [-130, -1060], navi: [-100, -1060] },
    { uid: 's4', name: '北城小学', tag: '教育培训;小学', xy: [-560, 1240], navi: [-500, 1240] },
    { uid: 's5', name: '河东第二小学', tag: '教育培训;小学', xy: [1480, -900], navi: [1500, -900] },
    { uid: 's6', name: '启明英语小学辅导中心', tag: '教育培训;培训机构', xy: [-300, 210] },
    // markets: two stalls of 临河菜市场; 河西生鲜市场 is the nearest market of 东岸新村 across the river
    { uid: 'm1', name: '临河菜市场', tag: '购物;农贸市场;菜市场', xy: [-260, -360], navi: [-200, -360] },
    { uid: 'm1a', name: '王记肉铺(临河菜市场店)', tag: '购物;肉店', xy: [-250, -345], navi: [-200, -345] },
    {
      uid: 'm1b',
      name: '鲜丰生鲜(临河菜场店)',
      tag: '购物;超市;生鲜超市',
      xy: [-272, -378],
      navi: [-200, -378],
    },
    { uid: 'm2', name: '北街农贸市场', tag: '购物;农贸市场', xy: [-640, 860], navi: [-600, 860] },
    { uid: 'm3', name: '河东菜场', tag: '购物;菜市场', xy: [1550, 560], navi: [1500, 560] },
    { uid: 'm4', name: '河西生鲜市场', tag: '购物;农贸市场', xy: [330, 700], navi: [300, 700] },
    // standardized markets Baidu mis-tags (as found in 申城佳苑): one as 生鲜超市, one as plain 购物, which
    // none of the searches returns
    { uid: 'm5', name: '浦商生鲜(河东店)', tag: '购物;超市;生鲜超市', xy: [760, -640], navi: [800, -640] },
    { uid: 'm6', name: '浦商生鲜(东岸店)', tag: '购物', xy: [570, 610], navi: [560, 600] },
    // pharmacies: plenty on the west bank, two on the east bank, one for pets, one child of a pharmacy
    { uid: 'p1', name: '益民大药房(河西店)', tag: '医疗;药店', xy: [120, 80], navi: [100, 80] },
    { uid: 'p1c', name: '益民大药房医保服务点', tag: '医疗;药店', xy: [124, 86], parent: 'p1' },
    { uid: 'p2', name: '同仁药房', tag: '医疗;药店', xy: [-320, -150], navi: [-300, -150] },
    { uid: 'p3', name: '康健药店(北街店)', tag: '医疗;药店', xy: [-450, 560], navi: [-400, 560] },
    { uid: 'p4', name: '平安大药房', tag: '医疗;药店', xy: [260, -620], navi: [300, -620] },
    { uid: 'p5', name: '百姓药店', tag: '医疗;药店', xy: [-930, -330], navi: [-900, -330] },
    { uid: 'p6', name: '民生药房', tag: '医疗;药店', xy: [-1150, 480], navi: [-1100, 480] },
    { uid: 'p7', name: '惠民药店', tag: '医疗;药店', xy: [-640, -930], navi: [-600, -930] },
    { uid: 'p8', name: '仁心大药房', tag: '医疗;药店', xy: [230, 690], navi: [200, 690] },
    { uid: 'p9', name: '河东大药房', tag: '医疗;药店', xy: [1240, 1180], navi: [1200, 1180] },
    { uid: 'p10', name: '东岸药店', tag: '医疗;药店', xy: [1040, -520], navi: [1000, -520] },
    { uid: 'p11', name: '爱宠宠物药店', tag: '医疗;药店', xy: [-80, -520] },
    // 生鲜超市 and 幼儿园 (optional groups)
    {
      uid: 'f1',
      name: '钱大妈生鲜超市(河西店)',
      tag: '购物;超市;生鲜超市',
      xy: [-150, 420],
      navi: [-100, 420],
    },
    { uid: 'f2', name: '叮咚生鲜超市', tag: '购物;超市;生鲜超市', xy: [640, -160], navi: [600, -160] },
    { uid: 'k1', name: '临河幼儿园', tag: '教育培训;幼儿园', xy: [60, -240] },
    { uid: 'k2', name: '河东幼儿园', tag: '教育培训;幼儿园', xy: [900, 200] },
    { uid: 'k3', name: '北苑幼儿园', tag: '教育培训;幼儿园', xy: [-350, 950] },
    // compounds placed on purpose, gates well inside the 1100 m demand radius (so the cap of 30 cuts
    // generated ones) except 远郊花园's: 滨河花园 (west bank) has its nearest school across the river,
    // 东岸新村 (east bank) its nearest market (河东菜场 is a 1090 m walk); two different 锦绣苑 lie 781 m
    // apart; 远郊花园 is found (POI 1098 m out) but its gate is 1138 m out
    { uid: 'h-binhe', name: '滨河花园', tag: HOME, xy: [360, 470], navi: [400, 470] },
    { uid: 'h-binhe2', name: '滨河花园', tag: HOME, xy: [372, 480] },
    { uid: 'h-binhe-3', name: '滨河花园-3号楼', tag: HOME, xy: [350, 500] },
    { uid: 'h-dongan', name: '东岸新村', tag: HOME, xy: [560, 650], navi: [500, 650] },
    { uid: 'h-linhe', name: '临河小区', tag: HOME, xy: [-250, 250] },
    { uid: 'g-linhe-e', name: '临河小区东门', tag: GATE, xy: [-200, 250] },
    { uid: 'g-linhe-2', name: '临河小区-2号门', tag: GATE, xy: [-250, 180] },
    { uid: 'h-jx1', name: '锦绣苑', tag: HOME, xy: [-730, -300], navi: [-700, -300] },
    { uid: 'h-jx2', name: '锦绣苑', tag: HOME, xy: [-130, -800], navi: [-100, -800] },
    { uid: 'h-edge', name: '远郊花园', tag: HOME, xy: [1080, -200], navi: [1120, -200] },
    // noise the 小区 keyword brings along
    { uid: 'x-jwh', name: '河西小区居委会', tag: '政府机构;居民委员会', xy: [-60, 300] },
    { uid: 'x-park', name: '北苑小区停车场', tag: '交通设施;停车场', xy: [-420, 880] },
    // the other 民生设施 (counted for the circle, never checked): 河东社区卫生服务站 lies just outside the
    // straight circle, 东岸路 station inside it but a 1,980 m walk away (the bridge); the metro exits
    // and a lift are no facilities of their own; a 生鲜超市-named 超市 is already found by the
    // 生鲜超市 group
    {
      uid: 'c1',
      name: '临河社区卫生服务中心',
      tag: '医疗;综合医院',
      xy: [-420, -80],
      navi: [-400, -80],
    },
    { uid: 'c2', name: '河东社区卫生服务站', tag: '医疗;诊所', xy: [980, 420], navi: [1000, 420] },
    { uid: 'e1', name: '滨河养老院', tag: '生活服务;养老院', xy: [250, -250] },
    { uid: 'e2', name: '临河街道长者食堂', tag: '美食;中餐厅', xy: [-180, 380] },
    { uid: 't1', name: '河西路', tag: '交通设施;地铁站', xy: [-520, 300], navi: [-500, 300] },
    { uid: 't1a', name: '河西路地铁站-1口', tag: '出入口;其他', xy: [-500, 290] },
    { uid: 't1b', name: '无障碍电梯(河西路地铁站2号口)', tag: '生活服务;其他', xy: [-540, 310] },
    { uid: 't2', name: '东岸路', tag: '交通设施;地铁站', xy: [620, 760] },
    { uid: 'g1', name: '滨河公园', tag: '旅游景点;公园', xy: [380, 120] },
    { uid: 'u1', name: '联华超市(河西店)', tag: '购物;超市', xy: [100, 200], navi: [100, 180] },
    { uid: 'u2', name: '家乐福超市', tag: '购物;超市', xy: [-800, -500] },
    { uid: 'u3', name: '盒马生鲜超市', tag: '购物;超市', xy: [-300, 600] },
    // one stop per direction: the same name twice, 85 m apart
    { uid: 'b1', name: '河西路滨河路', tag: '交通设施;公交车站', xy: [0, 60] },
    { uid: 'b2', name: '河西路滨河路', tag: '交通设施;公交车站', xy: [60, 0] },
  ];
  // bus stops at the street corners of a 300 m lattice: more than the 民生设施 union's two pages hold,
  // so the page limit trims their far tail
  for (let gy = -900; gy <= 900; gy += 300) {
    for (let gx = -900; gx <= 900; gx += 300) {
      const xy: XY = [gx + 50, gy + 50];
      if (Math.hypot(xy[0], xy[1]) > 1050 || Math.abs(xy[0] - 450) < 60) continue;
      pois.push({
        uid: `bus${gx}_${gy}`,
        name: `横${gx / 300 + 4}路纵${gy / 300 + 4}路`,
        tag: '交通设施;公交车站',
        xy,
      });
    }
  }
  // the other compounds on a jittered 270 m lattice inside the demand radius, clear of the ones above
  // and of the river. The nearest 28 are kept: with the placed ones, 33 gates lie within 1100 m, so
  // the cap of 30 bites, and the 住宅区 group fills 36 of the two residential pages' 40 rows, leaving
  // room for the nearest 小区 gates
  const rand = rng(11);
  const taken = pois.filter((p) => p.tag === HOME).map((p) => p.xy);
  const spots: XY[] = [];
  for (let gy = -1080; gy <= 1080; gy += 270) {
    for (let gx = -1080; gx <= 1080; gx += 270) {
      const xy: XY = [gx + (rand() - 0.5) * 100, gy + (rand() - 0.5) * 100];
      const r = Math.hypot(xy[0], xy[1]);
      if (r > 1040 || r < 120 || Math.abs(xy[0] - 450) < 60) continue;
      if (taken.some((t) => Math.hypot(t[0] - xy[0], t[1] - xy[1]) < 180)) continue;
      spots.push(xy);
      taken.push(xy);
    }
  }
  spots.sort((a, b) => Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1]));
  if (spots.length < 28) throw new Error(`synthetic city: only ${spots.length} compound spots`);
  spots.slice(0, 28).forEach((xy, k) => {
    const name = COMPOUND_NAMES[k]!;
    const uid = `h${k}`;
    const withNavi = k % 4 !== 3;
    pois.push({ uid, name, tag: HOME, xy, ...(withNavi ? { navi: gateOf(xy) } : {}) });
    if (name.endsWith('小区')) pois.push({ uid: `${uid}-g`, name: `${name}北门`, tag: GATE, xy: gateOf(xy) });
  });
  return pois;
}

/**
 * A synthetic official market list in the shape of data/official/pudong-markets-2023q4.json: one market
 * Baidu has right (临河菜市场), one it tags 生鲜超市, one its search never returns (geocoded only to road
 * level), one closed for renovation, one outside the search radius.
 */
export function officialMarkets(city: City): OfficialList {
  const ll = (xy: XY) => city.toLngLat(xy).map((v) => Number(v.toFixed(6))) as LngLat;
  const door = { precise: true, confidence: 80, level: '门址' };
  return {
    id: 'linhe-markets-2026q1',
    category: '菜市场',
    title: '2026年一季度临河区菜市场实效测评得分及排名',
    publisher: '测试市临河区商务委员会',
    published: '2026-03-20',
    url: 'https://www.linhe.example.gov.cn/markets/2026q1.html',
    region: { city: '测试市', district: '临河区' },
    counts: { listed: 5, active: 4 },
    entries: [
      {
        rank: 1,
        name: '浦商菜市场临河店',
        address: '临河路88号',
        score: 990,
        status: 'active',
        bd09: ll([-240, -350]),
        geocode: door,
      },
      {
        rank: 2,
        name: '浦商生鲜河东店',
        address: '河东路16号',
        score: 985,
        status: 'active',
        bd09: ll([780, -600]),
        geocode: door,
      },
      {
        rank: 3,
        name: '浦商生鲜东岸店',
        address: '东岸路200号',
        score: 980,
        status: 'active',
        bd09: ll([560, 600]),
        geocode: { precise: false, confidence: 50, level: '道路' },
      },
      {
        rank: 4,
        name: '北街农贸市场',
        address: '北街1号',
        score: 0,
        status: '装修改造',
        bd09: ll([-630, 850]),
        geocode: door,
      },
      {
        rank: 5,
        name: '浦商生鲜远郊店',
        address: '远郊路1号',
        score: 970,
        status: 'active',
        bd09: ll([2600, 0]),
        geocode: door,
      },
    ],
  };
}
