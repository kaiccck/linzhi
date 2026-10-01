/**
 * Brings the curated sample data/samples/zj-a.json (申城佳苑片区, built from OpenStreetMap and the
 * 2026-09-26/28 Baidu research calls) up to what live results carry. Every Baidu answer comes through
 * the shared cache and ledger, so a rerun costs nothing and rewrites the same file (idempotent).
 *
 *   1. meta.notes in Chinese: the English notes of the build script (design/mockups/data-build) are
 *      rewritten with the same facts.
 *   2. 排除清单 (data/official/exclusions.json): excluded POIs (上海市浦东新区育华学校(雪英校区), not an
 *      enrolling primary school in 2026; by name pattern the 前置仓 叮咚买菜(孙桥站), tagged 生鲜超市)
 *      leave `pois`; the task-rule checks are recomputed with core mergeMatrixResults from the research
 *      routes (research/zhangjiang/raw), so straight_m and nearest_straight follow. The research routed
 *      the 3–4 facilities nearest the centre, not each community's own, so a check's best walk could pass
 *      a nearer facility never routed (unrouted_nearer): those are routed from the centroid as well (core
 *      planNearestTopUp, routematrix walking), so via / route_m are the nearest walk; the answers are kept
 *      in research/zhangjiang/raw/bv_nearest_A.json (rewritten only when they change). Any status change
 *      is printed.
 *   3. 生鲜超市 from the live engine's own 生鲜超市$幼儿园 query at this centre (radius 2100 m, cached),
 *      for the 买菜替代 candidates and the 圈内设施统计 (the exclusions apply to these too).
 *   4. The GB 50180-2018 fields older versions wrote (communities[].checks_gb,
 *      stats.community_status_counts_gb, stats.fresh_alternatives_gb and their note) are removed: only
 *      the task rule (1 km) is checked.
 *   5. communities[].catchment: 对口小学 from the 2025 浦东 table (data/official, 张江镇 rows) with the
 *      engine's runCatchment; the research routes to both 孙桥小学 campuses are reused.
 *   6. 灰色区域 from the checks, with the OSM outlines (a status point on every lattice node inside an
 *      outline, the land within GRAY_HALO_M of an outline taking the nearest outline's status).
 *   7. The 民生设施 union (the engine's keywords, radius and page limit; one cached place query), merged
 *      with the engine's livelihoodPois(); stats.facility_inventory as in live results.
 *   8. 买菜替代 (checks.菜市场.alt, stats.fresh_alternatives): for every
 *      菜市场 check that is a gap, the nearest shop within the rule on foot that sells vegetables — the
 *      live engine's own 蔬菜$果蔬$超市 search at this centre (radius 2100 m, cached), core freshKind
 *      and the engine's freshPool, then routematrix walks from the centroid to the two nearest
 *      candidates within the rule (core planFreshAlternatives, research routes reused) and core
 *      mergeFreshAlternatives. The candidates beyond the sample's own POIs and every route the pick
 *      reads are kept in research/zhangjiang/raw/bv_fresh_A.json (rewritten only when they change).
 *      Informational: no verdict, gray area or count changes.
 *   9. stats.facility_stats = core facilityStats(result); stats.community_status_counts from the checks.
 *  10. barriers from the sample's own walking times, by the live engine's rule (SampleSet dedupe and
 *      timed(), core detectBarriers): the 方法 layer draws them. The field is not recomputed.
 *
 *   cd apps/server
 *   node --env-file=../../.env.local --conditions=source --import tsx scripts/augment-zj-a.ts [--dry-run | --offline]
 *
 * --offline never calls Baidu (steps 3–5 and 7 keep what the file has; step 2 reads the top-up's answers
 * from bv_nearest_A.json, step 8 the search and routes from bv_fresh_A.json); --dry-run answers from a
 * copy of the cache only and writes nothing. A live run stops before spending more than 4 place pages or
 * 100 routematrix routes and prints the ledger before and after.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PlacePoi } from '@zoudedao/baidu';
import {
  barrierPieces,
  cleanPois,
  detectBarriers,
  facilitiesFor,
  facilityStats,
  freshCandidates,
  gapCount,
  grayAreaPolygons,
  HARD_CATEGORIES,
  localFrame,
  mergeFreshAlternatives,
  mergeMatrixResults,
  planFreshAlternatives,
  planMatrixBatches,
  planNearestTopUp,
  pointInRing,
  routingPoint,
  ruleDistance,
  statusRaster,
  applyExclusions,
  type AnalysisResult,
  type Community,
  type DemandPoint,
  type ExcludedPoi,
  type FacilityCheck,
  type HardCategory,
  type LngLat,
  type OdDestination,
  type Poi,
  type RoutedPair,
  type StatusPoint,
  type XY,
} from '@zoudedao/core';
import {
  exclusionNote,
  facilityGroups,
  FRESH_GROUPS,
  FRESH_KEYWORDS,
  freshNote,
  freshPool,
  inventoryOf,
  LIVELIHOOD_CATEGORIES,
  LIVELIHOOD_GROUPS,
  LIVELIHOOD_KEYWORDS,
  LIVELIHOOD_PAGES,
  LIVELIHOOD_RADIUS_M,
  livelihoodPois,
  Meter,
  PLACE_PAGE_SIZE,
  resolveBudget,
  runCatchment,
  SampleSet,
  serviceCaps,
  statusCounts,
  stepCaps,
  toPlaceResult,
  type DemandSite,
  type EngineClient,
  type FreshCounts,
  type Inventory,
  type LiveCommunity,
  type MatrixFn,
} from '@zoudedao/engine';
import { loadOfficialData } from '../src/official.js';
import { missCost, openScriptClient, printLedger, REPO_ROOT, spendGuard, usage } from './script-client.js';

/** Finer than the engine's 50 m: the outlines are real, and small compounds span only a few cells. */
const GRAY_CELL_M = 25;
/**
 * How far past an outline the gray reaches. The outlines are drawn as hatched blocks above the gray
 * layer, so without a halo the gray areas would sit entirely under them and never show on the map.
 */
const GRAY_HALO_M = 120;
/** The live engine's facility radius: the 生鲜超市$幼儿园 query at this centre is cached with it. */
const ENGINE_FACILITY_RADIUS_M = 2100;
const NOTE_PREFIX = '民生设施（社区卫生、养老、地铁、公园、超市、公交）';
const GRAY_NOTE_PREFIX = '灰色区域（gray_areas）';
/** The note older versions wrote for checks_gb (GB 50180-2018), removed in step 4. */
const GB_NOTE_PREFIX = '国标口径（checks_gb';
const CHECKS_NOTE_PREFIX = '小区判定（checks';
const BARRIER_NOTE_PREFIX = '阻隔（barriers）';
const ATTRIBUTION_PREFIX = '民生设施 POIs: Baidu Maps Web Service place search v3';
const FRESH_ATTRIBUTION_PREFIX = '生鲜超市 POIs: Baidu Maps Web Service place search v3';
const ALT_NOTE_PREFIX = '买菜替代（';
const ALT_ATTRIBUTION_PREFIX = '买菜替代 POIs: Baidu Maps Web Service place search v3';

const args = process.argv.slice(2);
const offline = args.includes('--offline');
const dryRun = args.includes('--dry-run');
const file = join(REPO_ROOT, 'data/samples/zj-a.json');
const result = JSON.parse(readFileSync(file, 'utf8')) as AnalysisResult;
const meta = result.meta as AnalysisResult['meta'] & { notes?: string[]; sources?: string[] };
const [lng, lat] = meta.center_bd09;
const frame = localFrame(lng, lat);
const today = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10); // Beijing date
const official = loadOfficialData(join(REPO_ROOT, 'data/official'), (m) => console.warn(m));

/** Replaces the note starting with `prefix` where it stands, or appends it: reruns keep the order. */
function setNote(prefix: string, text: string, after?: string): void {
  const notes = (meta.notes ??= []);
  const at = notes.findIndex((n) => n.startsWith(prefix));
  if (at >= 0) {
    notes[at] = text;
    return;
  }
  const anchor = after ? notes.findIndex((n) => n.startsWith(after)) : -1;
  if (anchor >= 0) notes.splice(anchor + 1, 0, text);
  else notes.push(text);
}

function addSource(path: string): void {
  const sources = (meta.sources ??= []);
  if (!sources.includes(path)) sources.push(path);
}

function addAttribution(prefix: string, line: string): void {
  // before the routes' line: the web dates the walking measurements (2026-09-26) from the last Baidu line
  const rest = meta.attribution.filter((a) => !a.startsWith(prefix));
  const at = rest.findIndex((a) => /^Routes and POIs: Baidu/.test(a));
  meta.attribution = at < 0 ? [...rest, line] : [...rest.slice(0, at), line, ...rest.slice(at)];
}

// ------------------------------------------------------------------ 1. meta.notes in Chinese

/** English notes of design/mockups/data-build/build-zj-a.ts → the same facts in Chinese. */
const CHINESE_NOTES: { en: string; zh: string; text: string }[] = [
  {
    en: 'All layers share BD-09 before projection',
    zh: '所有图层在投影前统一为 BD-09',
    text: '所有图层在投影前统一为 BD-09：OSM 的 WGS84 坐标按公开公式转为 GCJ-02 再转 BD-09（与百度坐标转换服务最大相差 0.7 米）。BD-09 相对 WGS84 在本地约有 1.3° 的剪切，所以本坐标系里的方位角与真实罗盘方位相差约 1°；距离不受影响（误差 < 0.3%）。',
  },
  {
    en: 'Polygon rings (landuse, water, communities, contours) are closed',
    zh: '多边形环（用地、水面、小区、等时圈）都是闭合的',
    text: '多边形环（用地、水面、小区、等时圈）都是闭合的：首点在末尾重复一次。',
  },
  {
    en: 'contours[level] are closed rings from marching squares',
    zh: 'contours[level] 是对 field.t_s 做 marching squares',
    text: 'contours[level] 是对 field.t_s 做 marching squares（再做两次 Chaikin 平滑）得到的闭合环。外环逆时针、孔洞顺时针；contours_meta[level][i] 说明哪个环是孔洞及其所属外环。同一级别的所有环请放在一条路径里按 even-odd 规则填充。',
  },
  {
    en: 'Walking time model: Baidu routematrix duration',
    zh: '步行耗时模型：百度批量算路的耗时',
    text: '步行耗时模型：百度批量算路的耗时恰好等于 route_m / 1.17 米/秒。轻量步行路线的分段耗时慢 3–7%（计入了过街等待），所以 paths[].pts 为 [x, y, t_s, d_m]：t_s 是按距离分摊到折点上的轻量步行路线分段耗时，d_m 是累计路线米数；samples 与耗时场一律用 d_m / 1.17，与批量算路一致。',
  },
  {
    en: 'field.t_s: seconds from the center',
    zh: 'field.t_s：从中心出发的秒数',
    text: 'field.t_s：从中心出发的秒数。由样本对绕行系数 rho = t × 1.17 / 直线距离 做反距离加权插值（k = 10，权重 1 / (d² × (1 + Δθ))），再取 t = max(rho, 1) × 直线距离 / 1.17；中心 40 米内 t = 1.25 × 直线距离 / 1.17；1600 米圆以外为 -1。',
  },
  {
    en: 'samples: every usable Baidu walking answer from the center',
    zh: 'samples：从中心出发的所有可用百度步行应答',
    text: 'samples：从中心出发的所有可用百度步行应答（批量算路射线、到设施的路线、探测点集）加上轻量步行路线的折点，5 米内去重（先出现的来源优先）。rho = dur_s × 1.17 / straight_m。',
  },
  {
    en: 'Community checks: Baidu routematrix walking routes from each OSM polygon centroid',
    zh: '小区判定（checks，赛题口径 1 公里）',
    text: '小区判定（checks，赛题口径 1 公里）：从每个 OSM 小区轮廓的几何中心，用百度批量算路（步行）算到离片区中心最近的 3–4 家候选设施，再补算入口直线距离比其中最短步行更近、却还没从该小区算过路的设施（research/zhangjiang/raw/bv_nearest_A.json），所以 route_m 是到已知设施中实际最近一处的步行距离，via 是那一处。straight_m 是到该类最近的已知百度设施的直线距离。状态：route ≤ 1000 → 覆盖；route > 1000 且 straight ≤ 1000 → 伪覆盖；straight > 1000 → 盲区；|route − 1000| ≤ 50 时 status 为临界（status_main 保留三态）。补算后仍有这样的设施没有路线时 route_upper_bound = true（列在 unrouted_nearer），真实最短步行可能更短；若这可能改变结论（route_m > 1000 而有未算路的设施直线在 1000 米内），verified = false。设施按排除清单剔除后，判定用 core mergeMatrixResults 从这些路线重算（apps/server/scripts/augment-zj-a.ts）。',
  },
  {
    en: 'Facility inventory: Baidu place search',
    zh: '设施清单：以片区中心为圆心',
    text: '设施清单：以片区中心为圆心 1500 米内的百度地点检索（菜市场、菜场、农贸市场、药店、药房、小学，共 18 个 POI，一页取全），加上逆地理编码结果中的设施 POI；生鲜超市另取实时引擎在同一中心的“生鲜超市$幼儿园”检索（半径 2100 米，结果取全）。离中心 1500 米以外的小学、菜市场、药店不在清单中，外围小区因此可能显得更差。',
  },
  {
    en: 'Market stalls: POIs with stall_of',
    zh: '菜场摊位：带 stall_of 的 POI',
    text: '菜场摊位：带 stall_of 的 POI 是孙桥菜市场里的商铺（市场本身的 POI 带 market_name），菜市场只计一次；摊位只作为该市场的另一个入口参与判定。',
  },
  {
    en: 'POIs with source "osm" only fill categories',
    zh: 'source 为 osm 的 POI',
    text: 'source 为 osm 的 POI 只补充百度检索没有覆盖的类别（地铁、幼儿园、社区卫生、检索半径外的菜市场），不参与小区判定。',
  },
  {
    en: 'OSM barrier coverage here is minimal',
    zh: '这里 OSM 的障碍物数据很少',
    text: '这里 OSM 的障碍物数据很少（4 段围栏、十几个门），小区围墙不在数据中，其影响只体现在百度路线长度上。',
  },
];
{
  const notes = (meta.notes ??= []);
  for (let i = 0; i < notes.length; i++) {
    const hit = CHINESE_NOTES.find((n) => notes[i]!.startsWith(n.en) || notes[i]!.startsWith(n.zh));
    if (hit) notes[i] = hit.text;
  }
  const english = notes.filter((n) => !/[一-鿿]/.test(n));
  if (english.length) throw new Error(`notes still in English: ${english.join(' | ')}`);
}

// ----------------------------------------------------------------- the research route book

const demand: DemandPoint[] = result.communities.map((c) => ({ id: c.name, name: c.name, xy: c.centroid }));
const near = (a: XY, b: XY, tol: number) => Math.hypot(a[0] - b[0], a[1] - b[1]) < tol;
const allPoisAtStart = result.pois.slice();

interface RawMatrix {
  _meta: { request: string };
  response: { status: number; result: { distance?: { value?: number }; duration?: { value?: number } }[] };
}

/** "lat,lng|lat,lng" → [lng, lat][]. */
const latLngList = (s: string | null): LngLat[] =>
  (s ?? '')
    .split('|')
    .filter(Boolean)
    .map((tok) => {
      const [la, ln] = tok.split(';')[0]!.split(',').map(Number);
      return [ln!, la!];
    });

function researchRoutes(cat: HardCategory, known: readonly Poi[]): RoutedPair[] {
  const raw = JSON.parse(
    readFileSync(join(REPO_ROOT, `research/zhangjiang/raw/bv_blind_A_${cat}_000.json`), 'utf8'),
  ) as RawMatrix;
  const url = new URL(raw._meta.request);
  const origins = latLngList(url.searchParams.get('origins')).map(([ln, la]) => {
    const xy = frame.toXY(ln, la);
    const d = demand.find((p) => near(p.xy, xy, 0.2));
    if (!d) throw new Error(`research origin ${ln},${la} is no zj-a community`);
    return d.id;
  });
  const dests = latLngList(url.searchParams.get('destinations')).map(([ln, la], j) => {
    const xy = frame.toXY(ln, la);
    // a facility excluded since keeps a key of its own and simply never counts
    return (
      known.find((p) => p.source === 'baidu' && near(routingPoint(p), xy, 1.5))?.uid ?? `gone:${cat}:${j}`
    );
  });
  const out: RoutedPair[] = [];
  origins.forEach((o, i) =>
    dests.forEach((d, j) => {
      const el = raw.response.result[i * dests.length + j];
      const m = el?.distance?.value ?? 0;
      const s = el?.duration?.value ?? 0;
      const ok = m > 0 && s > 0;
      out.push({ origin_id: o, dest_id: d, route_m: ok ? m : null, dur_s: ok ? s : null });
    }),
  );
  return out;
}

function officialMarketRoutes(): RoutedPair[] {
  const raw = JSON.parse(
    readFileSync(join(REPO_ROOT, 'research/zhangjiang/raw/bv_official_markets_A.json'), 'utf8'),
  ) as {
    markets: { uid: string; name: string }[];
    routes: {
      community: string;
      to: { market: string; status: string; distance_m: number; duration_s: number }[];
    }[];
  };
  const uid = new Map(raw.markets.map((m) => [m.name, m.uid]));
  return raw.routes.flatMap((r) =>
    r.to.map((t) => ({
      origin_id: r.community,
      dest_id: uid.get(t.market)!,
      route_m: t.status === 'ok' ? t.distance_m : null,
      dur_s: t.status === 'ok' ? t.duration_s : null,
    })),
  );
}

const routes: RoutedPair[] = [
  ...HARD_CATEGORIES.flatMap((cat) => researchRoutes(cat, allPoisAtStart)),
  ...officialMarketRoutes(),
];
for (const f of [
  'research/zhangjiang/raw/bv_blind_A_小学_000.json',
  'research/zhangjiang/raw/bv_blind_A_药店_000.json',
  'research/zhangjiang/raw/bv_blind_A_菜市场_000.json',
  'research/zhangjiang/raw/bv_official_markets_A.json',
]) {
  addSource(f);
}

/** Step 2's nearest top-up: its answers, so --offline and the core tests rebuild the checks without Baidu. */
const NEAREST_BOOK = 'research/zhangjiang/raw/bv_nearest_A.json';

interface NearestBook {
  _about: string;
  date: string;
  routes: {
    community: string;
    to: {
      uid: string;
      name: string;
      category: string;
      status: 'ok' | 'no_route';
      distance_m: number | null;
      duration_s: number | null;
    }[];
  }[];
}

function readNearestBook(): NearestBook | null {
  const path = join(REPO_ROOT, NEAREST_BOOK);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as NearestBook) : null;
}

const nearestPairs = (book: NearestBook | null): RoutedPair[] =>
  (book?.routes ?? []).flatMap((r) =>
    r.to.map((t) => ({ origin_id: r.community, dest_id: t.uid, route_m: t.distance_m, dur_s: t.duration_s })),
  );

/** Step 2's top-up answers of a run with a client; written with zj-a.json. */
let nearestAnswers: RoutedPair[] | null = null;

/** Writes the top-up's answers when they differ from the book's (a rerun keeps the file and its date). */
function writeNearestBook(pairs: readonly RoutedPair[]): void {
  const poi = new Map(result.pois.map((p) => [p.uid, p]));
  const routes: NearestBook['routes'] = demand.flatMap((d) => {
    const to = pairs
      .filter((p) => p.origin_id === d.id)
      .map((p) => ({
        uid: p.dest_id,
        name: poi.get(p.dest_id)!.name,
        category: poi.get(p.dest_id)!.cat,
        status: p.route_m === null ? ('no_route' as const) : ('ok' as const),
        distance_m: p.route_m,
        duration_s: p.dur_s,
      }));
    return to.length ? [{ community: d.id, to }] : [];
  });
  if (JSON.stringify(readNearestBook()?.routes) === JSON.stringify(routes)) return;
  const book: NearestBook = {
    _about:
      '百度地图 Web 服务步行批量算路（routematrix/v2/walking），经 @zoudedao/baidu 客户端的缓存与配额账本调用，不含任何 Key。' +
      '样例 zj-a 赛题口径判定的最近设施补算：研究阶段只从各小区算到离片区中心最近的 3–4 家候选设施（bv_blind_A_*.json），' +
      '这里补算每个判定中入口直线距离比已算最短步行更近、却从未算过路的设施（core planNearestTopUp），' +
      '起点同为 OSM 小区轮廓几何中心，终点为设施出入口（navi_location）；距离 m，耗时 s = 距离 / 1.17。' +
      '由 apps/server/scripts/augment-zj-a.ts 写入（答案变化时才重写），--offline 时读取。',
    date: today,
    routes,
  };
  writeFileSync(join(REPO_ROOT, NEAREST_BOOK), `${JSON.stringify(book, null, 1)}\n`);
  console.log(`wrote ${NEAREST_BOOK}`);
}

/** Step 8's 买菜替代: the search, the shops beyond the sample's POIs and every route the pick reads. */
const FRESH_BOOK = 'research/zhangjiang/raw/bv_fresh_A.json';

interface FreshBook {
  _about: string;
  date: string;
  query: {
    keywords: string;
    radius_m: number;
    max_pages: number;
    pages: number;
    total: number;
    complete: boolean;
    /** How far from the centre the candidate list is complete, metres; null = everywhere. */
    known_m: number | null;
  };
  /** Candidate shops the sample's own POIs lack (local frame, as core cleanPois made them). */
  candidates: Pick<Poi, 'uid' | 'name' | 'cat' | 'tag' | 'xy' | 'navi_xy'>[];
  /** Every route from a 菜市场 gap to a candidate (research and 买菜替代 routes alike). */
  routes: {
    community: string;
    to: {
      uid: string;
      name: string;
      status: 'ok' | 'no_route';
      distance_m: number | null;
      duration_s: number | null;
    }[];
  }[];
}

type FreshBookBody = Omit<FreshBook, '_about' | 'date'>;

function readFreshBook(): FreshBook | null {
  const path = join(REPO_ROOT, FRESH_BOOK);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as FreshBook) : null;
}

/** Step 8's book of a run with a client; written with zj-a.json. */
let freshAnswers: FreshBookBody | null = null;

const freshKey = (b: FreshBookBody) => JSON.stringify([b.query, b.candidates, b.routes]);

/** The date the book carries once written: its own while the content stays, else today. */
function freshBookDate(body: FreshBookBody): string {
  const old = readFreshBook();
  return old && freshKey(old) === freshKey(body) ? old.date : today;
}

/** Writes the book when its search, candidates or routes change (a rerun keeps the file and its date). */
function writeFreshBook(body: FreshBookBody): void {
  const old = readFreshBook();
  if (old && freshKey(old) === freshKey(body)) return;
  const book: FreshBook = {
    _about:
      '百度地图 Web 服务地点检索（place/v3/around）与步行批量算路（routematrix/v2/walking），经 @zoudedao/baidu 客户端的缓存与配额账本调用，不含任何 Key。' +
      '样例 zj-a 的买菜替代：实时引擎在同一中心的“蔬菜$果蔬$超市”检索，candidates 是样例自己的 POI 之外、按 core freshKind 算作能买菜的店（局部坐标，米），' +
      'routes 是菜市场判定为缺口的小区到候选的全部步行路线，起点为 OSM 小区轮廓几何中心，终点为店的出入口（navi_location）；距离 m，耗时 s = 距离 / 1.17。' +
      '由 apps/server/scripts/augment-zj-a.ts 写入（内容变化时才重写），--offline 时读取。',
    date: today,
    ...body,
  };
  writeFileSync(join(REPO_ROOT, FRESH_BOOK), `${JSON.stringify(book, null, 1)}\n`);
  console.log(`wrote ${FRESH_BOOK}`);
}

/** Communities whose 菜市场 check is a verified 伪覆盖 or 盲区. */
const freshGaps = (): DemandPoint[] =>
  demand.filter((d) => {
    const k = result.communities.find((c) => c.name === d.id)?.checks['菜市场'];
    return !!k && k.verified !== false && k.status_main !== '覆盖';
  });

/** Sets checks.菜市场.alt from a book (and the routes of this run). */
function applyFreshBook(book: FreshBookBody): FreshCounts {
  const pool: Poi[] = [...result.pois, ...book.candidates.map((c) => ({ ...c, source: 'baidu' as const }))];
  const all: RoutedPair[] = [
    ...routes,
    ...book.routes.flatMap((r) =>
      r.to.map((t) => ({
        origin_id: r.community,
        dest_id: t.uid,
        route_m: t.distance_m,
        dur_s: t.duration_s,
      })),
    ),
  ];
  const gaps = freshGaps();
  const alts = mergeFreshAlternatives(gaps, freshCandidates(pool, { exclusions: official.exclusions }), all, {
    rule_m: ruleDistance('菜市场')!,
    known_m: book.query.known_m ?? Infinity,
  });
  const counts: FreshCounts = { gaps: 0, with_alt: 0, none: 0, not_looked: 0 };
  for (const c of result.communities) {
    const k = c.checks['菜市场'];
    delete k.alt;
    if (!gaps.some((g) => g.id === c.name)) continue;
    counts.gaps++;
    const alt = alts.get(c.name);
    if (alt === undefined) counts.not_looked++;
    else {
      k.alt = alt;
      if (alt) counts.with_alt++;
      else counts.none++;
    }
    console.log(
      `买菜替代 ${c.name}（${k.status_main} ${k.route_m} m）: ` +
        (alt === undefined ? '-' : alt === null ? 'none' : `${alt.name} ${alt.kind} ${alt.route_m} m`),
    );
  }
  return counts;
}

// ------------------------------------------------------------ Baidu client (cached, guarded)

const sc = offline ? null : openScriptClient(dryRun);
const ledgerBefore = sc ? usage(sc.client) : null;
if (sc && !dryRun) printLedger('ledger before', sc.client);
const client: EngineClient | null = sc
  ? dryRun
    ? sc.client
    : spendGuard(sc.client, { place: 4, routematrix_walking: 100 })
  : null;
const budget = resolveBudget('personal', { coverage: 100, catchment: 50 });
const meter = new Meter(stepCaps(budget), serviceCaps(budget), { onQuota: () => {} });
const matrix: MatrixFn = async (step, origins, destinations) =>
  meter.run(
    step,
    origins.length * destinations.length,
    (o) => client!.routeMatrixWalking(origins, destinations, { ...o, partial: true }),
    (res) => res.stats.routesRequested,
  );

/** Routes every wanted pair not in the book (one routematrix batch per destination set), cached. */
async function routeMissing(want: Map<string, OdDestination[]>): Promise<number> {
  let asked = 0;
  const bd = new Map(result.communities.map((c) => [c.name, frame.toLngLat(c.centroid[0], c.centroid[1])]));
  for (const b of planMatrixBatches(demand, want)) {
    const m = await matrix(
      'coverage',
      b.origins.map((o) => bd.get(o.id)!),
      b.destinations.map((d) => frame.toLngLat(d.xy[0], d.xy[1])),
    );
    asked += b.routes;
    b.origins.forEach((o, i) =>
      b.destinations.forEach((d, j) => {
        const cell = m.cells[i]?.[j];
        if (!cell || cell.status === 'failed') return;
        const ok = cell.status === 'ok';
        routes.push({
          origin_id: o.id,
          dest_id: d.id,
          route_m: ok ? cell.distanceM : null,
          dur_s: ok ? cell.durationS : null,
        });
      }),
    );
  }
  return asked;
}

/** Rows of the searches of steps 3 and 7: step 8 cleans them again with its own, as the engine does. */
const earlierRows: PlacePoi[] = [];

try {
  // ------------------------------------------------------------------------- 2. exclusions
  const previous = (result.stats.excluded as ExcludedPoi[] | undefined) ?? [];
  const x = applyExclusions(result.pois, official.exclusions);
  result.pois = x.pois;
  const excluded = [...previous.filter((p) => !x.excluded.some((e) => e.uid === p.uid)), ...x.excluded];
  /** Records POIs excluded by a later step (the 生鲜超市 and 民生设施 searches) with the same note. */
  function noteExcluded(more: readonly ExcludedPoi[]): void {
    for (const e of more) {
      console.log(`excluded ${e.category} ${e.name}: ${e.reason}`);
      const at = excluded.findIndex((p) => p.uid === e.uid);
      if (at >= 0) excluded[at] = e;
      else excluded.push(e);
    }
    result.stats.excluded = excluded;
    if (excluded.length) {
      const [note] = exclusionNote(excluded);
      setNote('排除清单（', note!, '菜市场按官方名录校正');
      addSource('data/official/exclusions.json');
    }
  }
  noteExcluded(x.excluded);

  // task-rule checks, recomputed from the research routes over the facilities that remain
  const checked = (p: Poi) => p.source === 'baidu' || p.source === 'gov';
  const taskFacilities = (cat: HardCategory) => facilitiesFor(result.pois.filter(checked), [cat]);
  // the nearest top-up: every candidate nearer by straight line than a check's best walk, through the
  // cached client (offline: the answers the last run wrote to the book)
  const byCategory = Object.fromEntries(HARD_CATEGORIES.map((cat) => [cat, taskFacilities(cat)]));
  if (client) {
    const from = routes.length;
    const asked = await routeMissing(planNearestTopUp(demand, byCategory, routes));
    nearestAnswers = routes.slice(from);
    console.log(`nearest top-up: ${asked} routes asked beyond the research book`);
  } else {
    routes.push(...nearestPairs(readNearestBook()));
  }
  addSource(NEAREST_BOOK);
  const FIELDS = [
    'straight_m',
    'nearest_straight',
    'route_m',
    'dur_s',
    'via',
    'via_uid',
    'via_straight_m',
    'via_stall_of',
    'status',
    'status_main',
    'borderline',
    'route_upper_bound',
    'verified',
    'unrouted_nearer',
  ] as const;
  for (const cat of HARD_CATEGORIES) {
    const merged = mergeMatrixResults(demand, taskFacilities(cat), routes);
    for (const c of result.communities) {
      const got = merged.get(c.name)!;
      const stored = c.checks[cat] as FacilityCheck & Record<string, unknown>;
      for (const k of FIELDS) {
        const a = JSON.stringify(stored[k]);
        const b = JSON.stringify(got[k]);
        if (a === b) continue;
        if (k === 'straight_m' || k === 'via_straight_m') {
          if (Math.abs((stored[k] as number) - (got[k] as number)) <= 0.15) continue;
        }
        console.log(`check ${c.name} ${cat} ${k}: ${a} → ${b}`);
        if (k === 'status' || k === 'status_main' || k === 'verified') {
          console.log(`  STATUS CHANGE ${c.name} ${cat}`);
        }
        if (got[k] === undefined) delete stored[k];
        else (stored as Record<string, unknown>)[k] = got[k];
      }
    }
  }

  // --------------------------------------------------------------------- 3. 生鲜超市 inventory
  if (client) {
    const optional = facilityGroups().optional;
    const r = await client.placeAround(
      optional.flatMap((g) => g.keywords),
      [lng, lat],
      { radius: ENGINE_FACILITY_RADIUS_M, maxPages: 2, pageSize: PLACE_PAGE_SIZE },
    );
    earlierRows.push(...r.pois);
    const distOf = (q: { location: [number, number] }) =>
      Math.hypot(...frame.toXY(q.location[0], q.location[1]));
    const inv = Object.fromEntries(inventoryOf(optional, r, distOf, ENGINE_FACILITY_RADIUS_M));
    const known = new Set(result.pois.flatMap((p) => [p.uid, ...(p.merged_uids ?? [])]));
    const excludedUids = new Set(excluded.map((e) => e.uid));
    // the exclusions again: a delivery warehouse Baidu tags 生鲜超市 (叮咚买菜(孙桥站)) never comes back
    const fx = applyExclusions(
      cleanPois(r.pois.map(toPlaceResult), { project: frame.toXY }).pois.filter(
        (p) => p.cat === '生鲜超市' && !p.stall_of && !known.has(p.uid) && !excludedUids.has(p.uid),
      ),
      official.exclusions,
    );
    const fresh = fx.pois;
    noteExcluded(fx.excluded);
    for (const p of fresh)
      console.log(`+ 生鲜超市 ${p.name} ${JSON.stringify(p.xy)} (${Math.round(p.straight_m ?? 0)} m)`);
    result.pois.push(...fresh);
    const inventory = (result.stats.facility_inventory ??= {}) as Inventory;
    if (inv['生鲜超市']) inventory['生鲜超市'] = inv['生鲜超市'];
    if (fresh.length || !meta.attribution.some((a) => a.startsWith(FRESH_ATTRIBUTION_PREFIX))) {
      addAttribution(
        FRESH_ATTRIBUTION_PREFIX,
        `${FRESH_ATTRIBUTION_PREFIX} (生鲜超市$幼儿园, radius ${ENGINE_FACILITY_RADIUS_M} m, the live engine's query at this centre), called 2026-09-28`,
      );
    }
  }

  // ------------------------------------------------------------- 4. the retired GB 50180 fields
  for (const c of result.communities) delete (c as { checks_gb?: unknown }).checks_gb;
  delete result.stats.community_status_counts_gb;
  delete result.stats.fresh_alternatives_gb;
  meta.notes = (meta.notes ?? []).filter((n) => !n.startsWith(GB_NOTE_PREFIX));

  // ------------------------------------------------------------------------- 5. 对口小学
  if (client && official.catchments.length) {
    const sites: DemandSite[] = result.communities.map((c) => ({
      id: c.name,
      name: c.name,
      uid: null,
      address: null,
      xy: c.centroid,
      bd09: frame.toLngLat(c.centroid[0], c.centroid[1]),
      gate: 'location',
      straight_m: Math.hypot(c.centroid[0], c.centroid[1]),
      merged: [],
    }));
    const out = await runCatchment({
      meter,
      frame,
      matrix,
      lists: official.catchments,
      region: meta.region,
      demand: sites,
      communities: result.communities as unknown as LiveCommunity[],
      pois: result.pois,
      official: official.lists,
      routes,
      warn: (m) => console.warn(m),
    });
    if (out.stats) {
      result.stats.catchment = out.stats;
      console.log(`catchment ${JSON.stringify(out.stats)}`);
      for (const c of result.communities) {
        if (c.catchment)
          console.log(
            `  ${c.name}: ${c.catchment.school} ${c.catchment.route_m ?? '-'} m (${c.catchment.matched_by})`,
          );
      }
    }
    for (const n of out.notes) setNote('对口小学（', n, CHECKS_NOTE_PREFIX);
    const list = official.catchments[0]!;
    addSource(`data/official/${list.id}.json`);
    addAttribution(
      '对口地段：',
      `对口地段：${list.publisher}《${list.title}》（${list.published}）：${list.url}`,
    );
    const schools = official.lists.find((l) => l.category === '小学');
    if (schools) {
      addAttribution(
        '小学名录：',
        `小学名录：${schools.publisher}《${schools.title}》（${schools.published}）：${schools.url}`,
      );
    }
  }

  // ------------------------------------------------------------------------ 6. 灰色区域
  const points: StatusPoint[] = [];
  for (const c of result.communities) {
    const status = gapCount(c.checks);
    points.push({ xy: c.centroid, ...status });
    if (c.pts.length < 3) continue;
    const xs = c.pts.map((p) => p[0]);
    const ys = c.pts.map((p) => p[1]);
    for (
      let gx = Math.ceil(Math.min(...xs) / GRAY_CELL_M) * GRAY_CELL_M;
      gx <= Math.max(...xs);
      gx += GRAY_CELL_M
    ) {
      for (
        let gy = Math.ceil(Math.min(...ys) / GRAY_CELL_M) * GRAY_CELL_M;
        gy <= Math.max(...ys);
        gy += GRAY_CELL_M
      ) {
        if (pointInRing(gx, gy, c.pts)) points.push({ xy: [gx, gy], ...status });
      }
    }
  }
  const water = (result.base?.water_areas ?? []).map((w) => w.pts).filter((ring) => ring.length >= 3);
  const raster = statusRaster(points, {
    cell_m: GRAY_CELL_M,
    maxDist_m: GRAY_HALO_M,
    inside: (gx, gy) => !water.some((ring) => pointInRing(gx, gy, ring)),
  });
  result.gray_areas = grayAreaPolygons(raster);
  for (const g of result.gray_areas) {
    const outer = g.meta.filter((m) => !m.hole).length;
    console.log(`gray ${g.kind} ≥${g.min_missing}: ${outer} polygons, ${g.area_m2} m²`);
  }
  setNote(
    GRAY_NOTE_PREFIX,
    `${GRAY_NOTE_PREFIX}：由 ${result.communities.length} 个小区的已核实判定生成（core gapCount / statusRaster / grayAreaPolygons，` +
      `${GRAY_CELL_M} 米栅格：OSM 小区轮廓内的格点取所在小区的状态，轮廓外 ${GRAY_HALO_M} 米内取最近轮廓的状态，水面不计；apps/server/scripts/augment-zj-a.ts）。` +
      'gap 层为缺少至少 n 类必需设施，pseudo 层为有伪覆盖；未核实的判定不计入。',
  );

  // --------------------------------------------------------------------- 7. 民生设施 union
  if (client) {
    const r = await client.placeAround(LIVELIHOOD_KEYWORDS, [lng, lat], {
      radius: LIVELIHOOD_RADIUS_M,
      maxPages: LIVELIHOOD_PAGES,
      pageSize: PLACE_PAGE_SIZE,
    });
    earlierRows.push(...r.pois);
    const union = livelihoodPois(r.pois, result.pois, frame);
    const lx = applyExclusions(union.pois, official.exclusions);
    noteExcluded(lx.excluded);
    const { pois } = lx;
    const dropped = [...union.dropped, ...lx.excluded];
    console.log(
      `union: ${r.pois.length} rows (total ${r.total}, ${r.pages} pages, ${r.apiCalls} billed, complete ${r.complete}); ` +
        `+${pois.length} POIs, dropped ${dropped.length}`,
    );
    for (const p of pois) console.log(`  + ${p.cat} ${p.name} ${JSON.stringify(p.xy)}`);
    result.pois.push(...pois);
    const distOf = (q: { location: [number, number] }) =>
      Math.hypot(...frame.toXY(q.location[0], q.location[1]));
    const inventory = Object.fromEntries(
      inventoryOf(LIVELIHOOD_GROUPS, r, distOf, LIVELIHOOD_RADIUS_M),
    ) as Inventory;
    const inv = result.stats.facility_inventory as Inventory | undefined;
    result.stats.facility_inventory = { ...inv, ...inventory };
    // no date in the note: a rerun from the cache rewrites the same text
    const count = result.pois.filter((p) => LIVELIHOOD_CATEGORIES.includes(p.cat)).length;
    const cut = Object.entries(inventory)
      .filter(([, i]) => i && !i.complete)
      .map(([cat, i]) => `${cat}只取到离中心 ${Math.round(i!.radius_m)} 米（${i!.fetched} 条结果）`);
    setNote(
      NOTE_PREFIX,
      `${NOTE_PREFIX}：用百度地点检索补充（与实时引擎同一组关键词 ${LIVELIHOOD_KEYWORDS.join('$')}，` +
        `半径 ${LIVELIHOOD_RADIUS_M} 米、最多 ${LIVELIHOOD_PAGES} 页，apps/server/scripts/augment-zj-a.ts），` +
        `与已有 POI 重复的未计入，现共 ${count} 处；地铁站的各出入口算一个站。` +
        (cut.length
          ? `检索页数用完：${cut.join('，')}，更远的没有统计（stats.facility_inventory）。百度把不少酒店、商铺命名为“××地铁站店”，占用了地铁一组的结果。`
          : '') +
        'stats.facility_stats 是 core facilityStats 的成人步速统计，老年人视图由前端换算。',
    );
    if (pois.length || !meta.attribution.some((a) => a.startsWith(ATTRIBUTION_PREFIX))) {
      addAttribution(
        ATTRIBUTION_PREFIX,
        `${ATTRIBUTION_PREFIX} (社区卫生、养老、地铁、公园、超市、公交), called ${today}`,
      );
    }
  }

  // ------------------------------------------------------------------------ 8. 买菜替代
  // what the pick reads comes from the book (offline) or is put into one first (online), so both
  // modes decide from the same candidates and routes
  let fresh: FreshBookBody | null = readFreshBook();
  if (client && freshGaps().length) {
    const r = await client.placeAround(FRESH_KEYWORDS, [lng, lat], {
      radius: ENGINE_FACILITY_RADIUS_M,
      maxPages: budget.freshPages,
      pageSize: PLACE_PAGE_SIZE,
    });
    const distOf = (q: { location: [number, number] }) =>
      Math.hypot(...frame.toXY(q.location[0], q.location[1]));
    let known = Infinity;
    for (const info of inventoryOf(FRESH_GROUPS, r, distOf, ENGINE_FACILITY_RADIUS_M).values()) {
      known = Math.min(known, info.complete ? Infinity : info.radius_m);
    }
    const pool = freshPool(result.pois, [...earlierRows, ...r.pois], frame);
    const list = freshCandidates(pool, { exclusions: official.exclusions });
    const candidates = new Map<string, Poi>(list.map((c) => [c.poi.uid, c.poi]));
    const asked = await routeMissing(
      planFreshAlternatives(freshGaps(), list, routes, { rule_m: ruleDistance('菜市场')! }),
    );
    console.log(
      `买菜替代: search ${r.pages} pages (${r.apiCalls} billed, total ${r.total}, complete ${r.complete}), ` +
        `${candidates.size} candidates, ${asked} routes asked`,
    );
    // the book: the shops the sample's POIs lack, and every route from a gap to a candidate
    const own = new Set(result.pois.map((p) => p.uid));
    const gapIds = new Set(freshGaps().map((d) => d.id));
    const pairs = new Map<string, RoutedPair>();
    for (const p of routes) {
      if (!gapIds.has(p.origin_id) || !candidates.has(p.dest_id)) continue;
      const key = `${p.origin_id}\n${p.dest_id}`;
      const prev = pairs.get(key);
      if (!prev || (prev.route_m === null && p.route_m !== null)) pairs.set(key, p);
    }
    const byUid = (a: { uid: string }, b: { uid: string }) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0);
    fresh = {
      query: {
        keywords: FRESH_KEYWORDS.join('$'),
        radius_m: ENGINE_FACILITY_RADIUS_M,
        max_pages: budget.freshPages,
        pages: r.pages,
        total: r.total,
        complete: r.complete,
        known_m: Number.isFinite(known) ? known : null,
      },
      candidates: [...candidates.values()]
        .filter((p) => !own.has(p.uid))
        .sort(byUid)
        .map((p) => ({
          uid: p.uid,
          name: p.name,
          cat: p.cat,
          ...(p.tag !== undefined ? { tag: p.tag } : {}),
          xy: p.xy,
          navi_xy: p.navi_xy,
        })),
      routes: demand.flatMap((d) => {
        const to = [...pairs.values()]
          .filter((p) => p.origin_id === d.id)
          .map((p) => ({
            uid: p.dest_id,
            name: candidates.get(p.dest_id)!.name,
            status: p.route_m === null ? ('no_route' as const) : ('ok' as const),
            distance_m: p.route_m,
            duration_s: p.dur_s,
          }))
          .sort(byUid);
        return to.length ? [{ community: d.id, to }] : [];
      }),
    };
    freshAnswers = fresh;
  }
  if (fresh) {
    const counts = applyFreshBook(fresh);
    result.stats.fresh_alternatives = counts;
    console.log(`fresh alternatives ${JSON.stringify(counts)}`);
    const q = fresh.query;
    const [note] = freshNote(
      {
        counts,
        query: {
          keywords: q.keywords,
          max_pages: q.max_pages,
          pages: q.pages,
          billed: 0,
          total: q.total,
          complete: q.complete,
          capped: false,
        },
        known_m: q.known_m ?? q.radius_m,
      },
      { radius_m: q.radius_m },
    );
    if (note) {
      setNote(
        ALT_NOTE_PREFIX,
        `${note}样例 zj-a 的起点是 OSM 小区轮廓的几何中心；检索与算路经缓存，答案存入 ${FRESH_BOOK}（apps/server/scripts/augment-zj-a.ts）。`,
        CHECKS_NOTE_PREFIX,
      );
    }
    addSource(FRESH_BOOK);
    addAttribution(
      ALT_ATTRIBUTION_PREFIX,
      `${ALT_ATTRIBUTION_PREFIX} (${q.keywords}, radius ${q.radius_m} m, the live engine's query at this centre), called ${freshBookDate(fresh)}`,
    );
  }
} catch (err) {
  console.error(`augment-zj-a stopped: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  if (sc) {
    if (dryRun) console.log(`dry run: a live run would request ${JSON.stringify(missCost(sc.misses()))}`);
    else printLedger('ledger after', sc.client, ledgerBefore ?? undefined);
    sc.close();
  }
}

// --------------------------------------------------------------- 9. statistics over the result
result.stats.community_status_counts = statusCounts(result.communities);
result.stats.facility_stats = facilityStats(result);
for (const f of result.stats.facility_stats) {
  const nearest = f.nearest_s === null ? '—' : `${(f.nearest_s / 60).toFixed(1)} min ${f.nearest ?? ''}`;
  console.log(`${f.category}\tfound ${f.found}\twalk ${f.walk}\tcircle ${f.circle}\tnearest ${nearest}`);
}
console.log(`task counts ${JSON.stringify(result.stats.community_status_counts)}`);

// -------------------------------------------------------------------------------- 10. 阻隔
// Display only: the field was interpolated from all samples before barrier detection existed, so it
// keeps its values (no visibility filter). Routematrix answers go in first, as in the engine.
{
  const set = new SampleSet();
  for (const src of ['routematrix', 'directionlite_path'] as const) {
    for (const s of result.samples) if (s.src === src) set.add(s);
  }
  result.barriers = barrierPieces(detectBarriers(set.timed()));
  console.log(
    `barriers: ${result.barriers.length} segments from ${set.size} of ${result.samples.length} samples`,
  );
  setNote(
    BARRIER_NOTE_PREFIX,
    `${BARRIER_NOTE_PREFIX}：用实时引擎的同一规则（engine SampleSet 去重、core detectBarriers，κ* = 2.5）从本样例 ` +
      `${set.size} 个样本的步行时间推断，共 ${result.barriers.length} 段（apps/server/scripts/augment-zj-a.ts）。` +
      '本样例的耗时场是研究阶段用全部样本插值得到的，没有用阻隔做可见性过滤；这里的阻隔只用于显示。',
  );
}

// communities keep their fields in a stable order: name … checks, worst_status, catchment
result.communities = result.communities.map((c): Community => {
  const {
    name,
    osm_id,
    pts,
    centroid,
    area_m2,
    checks,
    checks_gb: _gb,
    worst_status,
    catchment,
    ...rest
  } = c;
  return {
    name,
    ...(osm_id !== undefined ? { osm_id } : {}),
    pts,
    centroid,
    ...(area_m2 !== undefined ? { area_m2 } : {}),
    checks,
    ...(worst_status ? { worst_status } : {}),
    ...(catchment ? { catchment } : {}),
    ...rest,
  };
});

if (dryRun || process.exitCode) console.log('zj-a.json not written');
else {
  if (nearestAnswers) writeNearestBook(nearestAnswers);
  if (freshAnswers) writeFreshBook(freshAnswers);
  writeFileSync(file, `${JSON.stringify(result)}\n`);
  console.log(`wrote ${file}`);
}
