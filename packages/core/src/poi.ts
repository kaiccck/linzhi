/**
 * POI cleaning for Baidu place search results (design doc §6.3):
 *
 *   1. uid dedupe across queries and pages (v2 and v3 return the same uids)
 *   2. category from classified_poi_tag / tag, then a name whitelist for generic tags — never for a
 *      facility's gate or car park (出入口 / 停车场 tags or names: …幼儿园(北门), …服务中心停车场)
 *   3. per-category name blacklist (小学 ≠ 培训/辅导/托管/兴趣/英语; 幼儿园 ≠ 早教/托育/托儿所/亲子/
 *      培训 …, unless the name is a kindergarten's own; 药店 ≠ 兽药/宠物/医疗器械)
 *   4. stall merge: "英英肉店(孙桥菜市场店)", or a 肉店/水产-type shop within 60 m of a market, or a
 *      POI whose parent_id is a market, belongs to that market and never counts on its own
 *   5. 生鲜超市 stays its own category (the task rule does not accept it for 菜市场)
 *   6. dedupe by parent_id (a same-category child of a kept POI) and by normalised name within 30 m
 *   7. routing point = navi_location (the entrance) when Baidu gives one
 */
import type { XY } from './coords.js';
import type { FacilityCategory, Poi } from './types.js';

/** The subset of a Baidu place v2/v3 result this module reads. */
export interface BaiduPlaceResult {
  uid?: string;
  name: string;
  location?: { lat: number; lng: number };
  address?: string;
  parent_id?: string;
  detail_info?: {
    classified_poi_tag?: string;
    tag?: string;
    navi_location?: { lat: number; lng: number };
    parent_id?: string;
    label?: string;
  };
}

export interface CleanOptions {
  /** BD-09 lng/lat → local metres. */
  project: (lng: number, lat: number) => XY;
  /** Keep POIs that match no facility category (as 其他); dropped by default. */
  keepOther?: boolean;
  /** A 肉店/水产-type shop this close to a market is one of its stalls. */
  stallRadius_m?: number;
  /** Same normalised name within this distance is one place. */
  dedupeRadius_m?: number;
}

export interface DroppedPoi {
  uid: string;
  name: string;
  reason: string;
}

export interface CleanResult {
  pois: Poi[];
  dropped: DroppedPoi[];
}

interface CategoryRule {
  cat: FacilityCategory;
  tag: RegExp;
  name?: RegExp;
  exclude?: RegExp;
  /** A name this matches is never excluded: the facility's own name (whatever business words it holds). */
  keep?: RegExp;
}

/**
 * A kindergarten's own name: …幼儿园, or one of its campuses (东方德尚幼儿园(申江部), 东方德尚幼儿园孙环部,
 * 周浦幼儿园-秀康部, 南门幼儿园(张江分园)) — as opposed to a business next to or named after one
 * (金宝贝早教(幼儿园店), 某某艺术培训(北苑幼儿园旁)).
 */
const KINDERGARTEN_NAME =
  /幼儿园(?:[-－—]?[^()（）\-－—]{0,8}(?:部|分园|园区|校区)|[(（][^()（）]{0,12}[)）])?$/;

// Order matters: the first rule whose tag pattern matches wins.
const RULES: readonly CategoryRule[] = [
  { cat: '小学', tag: /小学/, name: /小学/, exclude: /培训|辅导|托管|兴趣|英语/ },
  // 幼儿园 is checked per community (ages 3–6): early education, childcare for the under-3s (托育,
  // 托儿所 — a facility of its own in GB 50180-2018 and Shanghai's life-circle guide), after-school
  // care, training and shops are no kindergarten, even where Baidu tags them 幼儿园 — unless the name
  // is a kindergarten's own (某某艺术幼儿园, 某某幼儿园(托育部) stay)
  {
    cat: '幼儿园',
    tag: /幼儿园/,
    name: /幼儿园/,
    exclude: /早教|托育|托儿所|托管|亲子|培训|辅导|衔接|兴趣|艺术|舞蹈|美术|英语|用品|玩具/,
    keep: KINDERGARTEN_NAME,
  },
  { cat: '菜市场', tag: /菜市场|农贸市场/, name: /菜市场|菜场|农贸市场|生鲜市场/ },
  { cat: '生鲜超市', tag: /生鲜超市/, name: /生鲜超市/ },
  { cat: '药店', tag: /药店|药房/, name: /药店|药房/, exclude: /兽药|宠物|医疗器械/ },
  // Baidu tags community health centres as plain 医疗;综合医院 / 诊所: the name decides
  { cat: '社区卫生', tag: /社区医疗|社区卫生/, name: /社区卫生服务|卫生服务(?:中心|站)|卫生院/ },
  { cat: '超市', tag: /超市/ },
  { cat: '地铁', tag: /地铁站/ },
  { cat: '公交', tag: /公交车站/ },
  // Shanghai's elderly services: care homes, day care, 长者照护之家, each town's 综合为老服务中心 and the
  // meal points (长者食堂, 社区食堂, 助餐点), which Baidu files under 美食. Not "自助餐".
  {
    cat: '养老',
    tag: /养老|敬老/,
    name: /养老院|敬老院|日间照料|长者照护|为老服务|长者食堂|老年食堂|社区食堂|老年助餐|助餐点|助餐服务/,
  },
  { cat: '公园', tag: /公园/ },
];

/** "(孙桥菜市场店)" / "（孙桥菜场店）": a shop named after the market it sits in. */
const STALL_NAME_RE = /[（(]([^（()）]*?(?:菜市场|菜场))店[）)]/;
/** Shop types that live inside wet markets. */
const STALL_TAG_RE = /肉店|水产|海鲜|蔬菜|禽|蛋品|豆制品/;
/** Only market-like POIs can be stalls. */
const STALL_CATEGORIES: ReadonlySet<FacilityCategory> = new Set<FacilityCategory>([
  '菜市场',
  '生鲜超市',
  '其他',
]);

/** Market name a stall's name refers to, with 菜场 spelled 菜市场: "英英肉店(孙桥菜市场店)" → "孙桥菜市场". */
export function stallMarketName(name: string): string | null {
  const m = STALL_NAME_RE.exec(name);
  return m ? m[1]!.replace(/菜场$/, '菜市场') : null;
}

export interface Categorized {
  cat: FacilityCategory;
  /** Blacklisted word when the POI must be dropped. */
  excluded?: string;
}

/** Tags of a facility's gates and car parks: they carry its name, never its function. */
const ACCESS_TAG_RE = /出入口|停车场|停车库/;
/** The same by name, for rows whose tag says nothing: …小学-2号门, …幼儿园(北门), …服务中心停车场. */
const ACCESS_NAME_RE =
  /(?:[东南西北]{1,2}\d*[侧大小]?门|\d+号门|[侧正后大校园]门|出入口|停车场|停车库)[)）]?$/;

/**
 * Category of a POI from its tags, falling back to name keywords when the tag is generic — but never
 * for a gate or a car park, which carries the facility's name without being it.
 */
export function categorize(name: string, tag: string): Categorized {
  const byTag = RULES.find((r) => r.tag.test(tag));
  if (!byTag && (ACCESS_TAG_RE.test(tag) || ACCESS_NAME_RE.test(name))) return { cat: '其他' };
  const rule = byTag ?? RULES.find((r) => r.name?.test(name));
  if (!rule) return { cat: stallMarketName(name) ? '菜市场' : '其他' };
  const hit = rule.keep?.test(name) ? null : rule.exclude?.exec(name);
  return hit ? { cat: rule.cat, excluded: hit[0] } : { cat: rule.cat };
}

/** Name key for duplicate detection: full-width folded, brackets unified, spaces and dots removed. */
export function normalizeName(name: string): string {
  return name
    .normalize('NFKC')
    .replace(/[【[{]/g, '(')
    .replace(/[】\]}]/g, ')')
    .replace(/[\s·・.。]/g, '')
    .toLowerCase();
}

/** Where to route to: the entrance when Baidu knows it, otherwise the POI point. */
export function routingPoint(p: Pick<Poi, 'xy' | 'navi_xy'>): XY {
  return p.navi_xy ?? p.xy;
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const dist = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]);

interface Work {
  poi: Poi;
  parent?: string;
  hasNavi: boolean;
}

/** Cleans Baidu place results (any mix of v2/v3 pages and queries) into facility POIs. */
export function cleanPois(results: readonly BaiduPlaceResult[], opts: CleanOptions): CleanResult {
  const stallRadius = opts.stallRadius_m ?? 60;
  const dedupeRadius = opts.dedupeRadius_m ?? 30;
  const dropped: DroppedPoi[] = [];

  // 1. uid dedupe; later copies only fill in what the first one lacked
  const byUid = new Map<string, BaiduPlaceResult>();
  const order: string[] = [];
  for (const r of results) {
    const uid = r.uid ?? '';
    if (!uid || !r.location) {
      dropped.push({ uid, name: r.name, reason: !uid ? 'no uid' : 'no location' });
      continue;
    }
    const prev = byUid.get(uid);
    if (!prev) {
      byUid.set(uid, r);
      order.push(uid);
    } else if (!prev.detail_info?.navi_location && r.detail_info?.navi_location) {
      byUid.set(uid, {
        ...prev,
        detail_info: { ...r.detail_info, ...prev.detail_info, navi_location: r.detail_info.navi_location },
      });
    }
  }

  // 2–3. categorise and blacklist
  const work: Work[] = [];
  for (const uid of order) {
    const r = byUid.get(uid)!;
    const det = r.detail_info ?? {};
    const tag = det.classified_poi_tag || det.tag || '';
    const c = categorize(r.name, tag);
    if (c.excluded) {
      dropped.push({ uid, name: r.name, reason: `blacklist:${c.excluded}` });
      continue;
    }
    if (c.cat === '其他' && !opts.keepOther && !STALL_TAG_RE.test(tag)) {
      dropped.push({ uid, name: r.name, reason: 'uncategorized' });
      continue;
    }
    const loc = r.location!;
    const navi = det.navi_location;
    const xy = opts.project(loc.lng, loc.lat);
    const naviXY =
      navi && Number.isFinite(navi.lng) && Number.isFinite(navi.lat)
        ? opts.project(navi.lng, navi.lat)
        : null;
    const poi: Poi = {
      uid,
      name: r.name,
      cat: c.cat,
      tag,
      xy: [r1(xy[0]), r1(xy[1])],
      navi_xy: naviXY ? [r1(naviXY[0]), r1(naviXY[1])] : null,
      source: 'baidu',
    };
    const parent = det.parent_id ?? r.parent_id;
    if (parent) poi.parent_uid = parent;
    poi.straight_m = r1(Math.hypot(xy[0], xy[1]));
    work.push({ poi, hasNavi: !!naviXY, ...(parent ? { parent } : {}) });
  }

  // 4. stalls: by name, by parent market, or by stall-type tag near a market
  const markets = work.filter((w) => w.poi.cat === '菜市场' && !stallMarketName(w.poi.name));
  const marketByUid = new Map(markets.map((m) => [m.poi.uid, m]));
  for (const w of work) {
    // a pharmacy or supermarket inside a market building is still a facility of its own
    if (!STALL_CATEGORIES.has(w.poi.cat)) continue;
    const byName = stallMarketName(w.poi.name);
    const parentMarket = w.parent ? marketByUid.get(w.parent) : undefined;
    const tagStall = STALL_TAG_RE.test(w.poi.tag ?? '');
    if (!byName && !parentMarket && !tagStall) continue;
    if (marketByUid.has(w.poi.uid)) continue;
    let market = parentMarket;
    if (!market) {
      let best = stallRadius;
      for (const m of markets) {
        const d = dist(m.poi.xy, w.poi.xy);
        if (d <= best) {
          best = d;
          market = m;
        }
      }
    }
    // a butcher or fishmonger that belongs to no known market is not a facility of any category
    if (!byName && !market) continue;
    w.poi.stall_of = byName ?? market!.poi.name;
    if (market) {
      w.poi.stall_of_uid = market.poi.uid;
      if (byName && !market.poi.market_name) market.poi.market_name = byName;
    }
    if (w.poi.cat === '其他') w.poi.cat = '菜市场';
  }
  const kept = work.filter((w) => {
    if (w.poi.cat !== '其他' || opts.keepOther) return true;
    dropped.push({ uid: w.poi.uid, name: w.poi.name, reason: 'uncategorized' });
    return false;
  });

  // 6. parent_id dedupe, then normalised name within dedupeRadius
  const alive = new Map(kept.map((w) => [w.poi.uid, w]));
  const absorb = (into: Work, w: Work, reason: string) => {
    alive.delete(w.poi.uid);
    (into.poi.merged_uids ??= []).push(w.poi.uid);
    if (!into.poi.navi_xy && w.poi.navi_xy) into.poi.navi_xy = w.poi.navi_xy;
    into.hasNavi ||= w.hasNavi;
    dropped.push({ uid: w.poi.uid, name: w.poi.name, reason });
  };
  for (const w of kept) {
    if (!w.parent || w.poi.stall_of || !alive.has(w.poi.uid)) continue;
    const parent = alive.get(w.parent);
    if (parent && parent.poi.cat === w.poi.cat) absorb(parent, w, `duplicate:parent ${parent.poi.uid}`);
  }
  const survivors = kept.filter((w) => alive.has(w.poi.uid));
  for (let i = 0; i < survivors.length; i++) {
    const a = survivors[i]!;
    if (!alive.has(a.poi.uid)) continue;
    const key = normalizeName(a.poi.name);
    for (let j = i + 1; j < survivors.length; j++) {
      const b = survivors[j]!;
      if (!alive.has(b.poi.uid) || b.poi.cat !== a.poi.cat || normalizeName(b.poi.name) !== key) continue;
      if (dist(a.poi.xy, b.poi.xy) > dedupeRadius) continue;
      // keep the record that knows its entrance
      if (!a.hasNavi && b.hasNavi) {
        absorb(b, a, `duplicate:name ${b.poi.uid}`);
        break;
      }
      absorb(a, b, `duplicate:name ${a.poi.uid}`);
    }
  }
  return { pois: kept.filter((w) => alive.has(w.poi.uid)).map((w) => w.poi), dropped };
}

/**
 * Facilities that answer a check for `category`: POIs of the accepted categories, plus market stalls,
 * which serve as extra entrances of their market (they are never counted as markets of their own).
 */
export function facilitiesFor(pois: readonly Poi[], categories: readonly FacilityCategory[]): Poi[] {
  const wantsMarket = categories.includes('菜市场');
  return pois.filter((p) => categories.includes(p.cat) || (!!p.stall_of && wantsMarket));
}

/** Distinct facilities for counting: market stalls fold into their market. */
export function countFacilities(pois: readonly Poi[], category: FacilityCategory): number {
  return pois.filter((p) => p.cat === category && !p.stall_of).length;
}
