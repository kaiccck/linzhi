/**
 * Typed Baidu Web Service endpoints. Coordinates are BD-09 [lng, lat] in and out; the client converts
 * to Baidu's "lat,lng" query order. Every call goes cache → singleflight → ledger → scheduler →
 * transport, so a repeated request never costs quota twice.
 */
import { BaiduCache, cacheKey, EMPTY_TTL_MS, roundCoord } from './cache.js';
import {
  authModes,
  loadBaiduConfig,
  replayConfig,
  requireAuth,
  type BaiduConfig,
  type ConfigIssue,
} from './config.js';
import {
  BaiduError,
  BaiduInputError,
  BaiduQuotaError,
  BaiduUpstreamError,
  BaiduConfigError,
} from './errors.js';
import { arr, assertLngLat, latLngParam, num, obj, parsePath, str, stripTags, toLngLat } from './json.js';
import { QuotaLedger, type QuotaSnapshot, type ServiceQuota } from './ledger.js';
import { Scheduler, type LaneStats, type SchedulerEvent } from './scheduler.js';
import { buildRequest, maskUrl, type QueryParams, type QueryValue } from './sign.js';
import { MemoryStore, openStore, type KvStore } from './store.js';
import { createFetchTransport, ReplayTransport, type Transport } from './transport.js';
import type { AuthMode, BaiduJson, BaiduService, BaiduTier, CallOptions, LngLat, Via } from './types.js';
import { BAIDU_SERVICES } from './types.js';

export const DEFAULT_HOST = 'https://api.map.baidu.com';
/** Measured: 1×50 walking routes per request works on the personal tier; Baidu caps origins × destinations at 50. */
export const MAX_ROUTES_PER_REQUEST = 50;
/** place/v3 never reports more than 150 hits for one query. */
export const PLACE_TOTAL_CAP = 150;
export const PLACE_MAX_KEYWORDS = 10;
export const PLACE_MAX_PAGE_SIZE = 20;
/** place/v3/detail takes up to 10 comma-separated uids per request (measured 2026-09-29). */
export const PLACE_DETAIL_MAX_UIDS = 10;
export const GEOCONV_MAX_POINTS = 100;
/** Measured: routematrix walking duration is exactly distance / 1.17 m/s (300+ routes, 2026-09-26). */
export const BAIDU_WALK_SPEED_MPS = 1.17;

/** geoconv/v2 `model` values. */
export const GEOCONV_MODEL = {
  GCJ02_TO_BD09: 1,
  WGS84_TO_BD09: 2,
  BD09_TO_BD09MC: 3,
  BD09MC_TO_BD09: 4,
  BD09_TO_GCJ02: 5,
  BD09MC_TO_GCJ02: 6,
} as const;

// ---------------------------------------------------------------- result types

export interface GeocodeResult {
  location: LngLat;
  /** Baidu `precise`: true = exact match; false = fuzzy placement (can be kilometres off). */
  precise: boolean;
  /** Claimed absolute accuracy 0–100 (unreliable when precise is false). */
  confidence: number;
  /** How well Baidu understood the address, 0–100. */
  comprehension: number;
  level: string;
  via: Via;
}

export interface ReverseGeocodePoi {
  uid: string | null;
  name: string;
  tag: string | null;
  location: LngLat | null;
  distanceM: number | null;
  direction: string | null;
  address: string | null;
}

export interface ReverseGeocodeResult {
  location: LngLat;
  formattedAddress: string;
  semanticDescription: string | null;
  business: string | null;
  province: string | null;
  city: string | null;
  district: string | null;
  /** 街道 / 镇, e.g. 张江镇. */
  town: string | null;
  townCode: string | null;
  adcode: string | null;
  street: string | null;
  streetNumber: string | null;
  pois: ReverseGeocodePoi[];
  /** Areas the point lies in or near (poiRegions), e.g. 申城佳苑 内. */
  regions: { name: string; tag: string | null; uid: string | null; relation: string | null }[];
  via: Via;
}

export interface PlaceChild {
  uid: string | null;
  name: string;
  showName: string | null;
  tag: string | null;
  location: LngLat | null;
}

export interface PlacePoi {
  /** Missing for address-type results of place/v3/region. */
  uid: string | null;
  name: string;
  location: LngLat;
  /** Entrance / navigation point; route to this for area facilities (schools, markets). */
  naviLocation: LngLat | null;
  address: string | null;
  province: string | null;
  city: string | null;
  area: string | null;
  town: string | null;
  townCode: string | null;
  telephone: string | null;
  tag: string | null;
  classifiedTag: string | null;
  type: string | null;
  label: string | null;
  brand: string | null;
  /** Straight distance from the search centre (around searches only). */
  distanceM: number | null;
  parentId: string | null;
  children: PlaceChild[];
  /** Other detail_info fields (shop_hours, overall_rating …) as Baidu sent them. */
  extra: Record<string, unknown>;
}

export interface PlaceSearchResult {
  keywords: string[];
  /** Baidu's `total` (summed over keyword groups); capped at 150 per query. */
  total: number;
  /** `total` hit the 150 cap: there may be more results; split keywords or the area. */
  capped: boolean;
  /** Every reported result was fetched (not stopped by the page budget, not capped). */
  complete: boolean;
  pages: number;
  /** Pages that cost a Baidu call (others came from the cache). */
  apiCalls: number;
  resultType: string | null;
  queryType: string | null;
  pois: PlacePoi[];
  via: Via;
}

export interface PlaceDetailResult {
  /** The uids asked for (trimmed, deduplicated, in order). */
  uids: string[];
  /** Full records in request order; the same fields as a place search row (scope 2). */
  pois: PlacePoi[];
  /** Uids Baidu returned nothing for. */
  missing: string[];
  /** Requests made, cached or not (PLACE_DETAIL_MAX_UIDS uids each). */
  requests: number;
  /** Requests that cost a Baidu call (others came from the cache). */
  apiCalls: number;
  via: Via;
}

export type RouteCellStatus = 'ok' | 'no_route' | 'failed';

export interface RouteCell {
  /** `no_route`: Baidu returned 0 (documented as "no result") — missing, not zero metres. */
  status: RouteCellStatus;
  distanceM: number | null;
  durationS: number | null;
  /** `identity`: origin equals destination, answered without a call. */
  via: Via | 'identity';
  /** Undocumented routematrix fields, kept for analysis. */
  restrictionsStatus?: number;
  retrogradeDist?: number;
  extra?: Record<string, unknown>;
  error?: BaiduError;
}

export interface RouteMatrixStats {
  pairs: number;
  unique: number;
  identity: number;
  fromCache: number;
  /** Pairs another in-flight call was already fetching. */
  joined: number;
  fromApi: number;
  failed: number;
  requests: number;
  routesRequested: number;
}

export interface RouteMatrix {
  /** cells[originIndex][destinationIndex]. */
  cells: RouteCell[][];
  errors: BaiduError[];
  stats: RouteMatrixStats;
}

export interface RoutePair {
  origin: LngLat;
  destination: LngLat;
  /** Bind the destination to a POI uid ("lat,lng;uid"). */
  destUid?: string | null | undefined;
}

export interface RoutePairsResult {
  cells: RouteCell[];
  errors: BaiduError[];
  stats: RouteMatrixStats;
}

export interface RouteMatrixOptions extends CallOptions {
  /** routematrix `road_prefer`; 3 = avoid stairs (no measured effect in Zhangjiang). */
  roadPrefer?: number;
  /** POI uid per destination (same length as destinations). */
  destUids?: ReadonlyArray<string | null | undefined>;
  /** Return failed cells instead of throwing the first error. */
  partial?: boolean;
}

export interface WalkingStep {
  distanceM: number;
  durationS: number;
  instruction: string;
  instructionHtml: string;
  turnType: string | null;
  turnTypeId: number | null;
  direction: number | null;
  start: LngLat | null;
  end: LngLat | null;
  path: LngLat[];
}

export interface WalkingRoute {
  distanceM: number;
  durationS: number;
  origin: LngLat | null;
  destination: LngLat | null;
  steps: WalkingStep[];
  /** All step paths joined, consecutive duplicates removed. */
  path: LngLat[];
  via: Via;
}

export type BaiduEvent =
  | SchedulerEvent
  | { type: 'request'; service: BaiduService; attempt: number; units: number; url: string }
  | { type: 'quota'; service: BaiduService; quota: ServiceQuota };

export interface BaiduHealth {
  mode: 'live' | 'replay';
  live: boolean;
  tier: BaiduTier;
  auth: Record<BaiduService, AuthMode | null>;
  store: 'sqlite' | 'memory';
  quota: QuotaSnapshot;
  cache: ReturnType<BaiduCache['stats']>;
  lanes: Record<BaiduService, LaneStats>;
  issues: readonly ConfigIssue[];
}

export interface BaiduClientOptions {
  /** Default: loadBaiduConfig(env ?? process.env). */
  config?: BaiduConfig;
  env?: Readonly<Record<string, string | undefined>>;
  /** Default: fetch with a timeout. */
  transport?: Transport;
  /** Shared by cache and ledger. Default: openStore(config.cachePath). */
  store?: KvStore;
  cache?: BaiduCache | false;
  ledger?: QuotaLedger;
  scheduler?: Scheduler;
  host?: string;
  /** Per HTTP attempt. Default 10 s. */
  timeoutMs?: number;
  now?: () => number;
  onEvent?: (event: BaiduEvent) => void;
  onWarning?: (message: string) => void;
  mode?: 'live' | 'replay';
}

interface RequestSpec {
  service: BaiduService;
  path: string;
  params: QueryParams;
  units?: number;
  escape?: string;
}

/** One side of an OD pair; `key` is the 1e-5° rounded point (+ ";uid" for bound destinations). */
export interface MatrixEndpoint {
  key: string;
  point: LngLat;
  uid: string | null;
}

export interface MatrixPair {
  origin: MatrixEndpoint;
  dest: MatrixEndpoint;
}

interface UniquePair extends MatrixPair {
  key: string;
}

/** Origins × destinations sent in one request (≤ 50 routes after tiling). */
export interface MatrixBlock {
  origins: MatrixEndpoint[];
  dests: MatrixEndpoint[];
}

type CachedCell = Pick<
  RouteCell,
  'status' | 'distanceM' | 'durationS' | 'restrictionsStatus' | 'retrogradeDist' | 'extra'
>;

const KNOWN_CELL_KEYS = new Set(['distance', 'duration', 'restrictions_status', 'retrograde_dist']);

export class BaiduClient {
  readonly config: BaiduConfig;
  readonly store: KvStore;
  readonly cache: BaiduCache;
  readonly ledger: QuotaLedger;
  readonly scheduler: Scheduler;
  readonly mode: 'live' | 'replay';
  private readonly transport: Transport;
  private readonly host: string;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly onEvent: ((event: BaiduEvent) => void) | undefined;

  constructor(opts: BaiduClientOptions = {}) {
    this.config = opts.config ?? loadBaiduConfig(opts.env ?? process.env);
    this.now = opts.now ?? Date.now;
    this.onEvent = opts.onEvent;
    this.mode = opts.mode ?? 'live';
    this.host = opts.host ?? DEFAULT_HOST;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.transport = opts.transport ?? createFetchTransport();
    this.store =
      opts.store ??
      (opts.cache instanceof BaiduCache
        ? opts.cache.store
        : openStore(this.config.cachePath, {
            onWarning: opts.onWarning ?? ((m) => process.emitWarning(m, 'ZoudedaoBaiduWarning')),
          }));
    this.cache =
      opts.cache instanceof BaiduCache
        ? opts.cache
        : new BaiduCache({ store: this.store, now: this.now, enabled: opts.cache !== false });
    this.ledger =
      opts.ledger ??
      new QuotaLedger({
        tier: this.config.tier,
        store: this.store,
        now: this.now,
        limits: this.config.limits,
      });
    this.scheduler =
      opts.scheduler ??
      new Scheduler({
        tier: this.config.tier,
        now: this.now,
        ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
      });
    if (this.onEvent) {
      const emit = this.onEvent;
      this.ledger.onChange((service, quota) => emit({ type: 'quota', service, quota }));
    }
  }

  // ---------------------------------------------------------------- geocoding

  /** geocoding/v3. null when Baidu finds nothing. Check `precise` (see locate()). */
  async geocode(address: string, opts: CallOptions & { city?: string } = {}): Promise<GeocodeResult | null> {
    const text = address.trim();
    if (!text) throw new BaiduInputError('地址不能为空');
    const params: [string, QueryValue][] = [['address', text]];
    if (opts.city) params.push(['city', opts.city]);
    params.push(['output', 'json']);
    const { json, via } = await this.request({ service: 'geocoding', path: '/geocoding/v3/', params }, opts);
    if (json.status !== 0) return null;
    const r = obj(json.result);
    const location = toLngLat(r?.location);
    if (!r || !location) return null;
    return {
      location,
      precise: num(r.precise) === 1,
      confidence: num(r.confidence) ?? 0,
      comprehension: num(r.comprehension) ?? 0,
      level: str(r.level) ?? '',
      via,
    };
  }

  /** reverse_geocoding/v3 with town (街道/镇) info; `pois: true` also lists nearby POIs. */
  async reverseGeocode(
    location: LngLat,
    opts: CallOptions & { pois?: boolean; radius?: number } = {},
  ): Promise<ReverseGeocodeResult | null> {
    assertLngLat(location, 'location');
    const params: [string, QueryValue][] = [
      ['location', latLngParam(location)],
      ['coordtype', 'bd09ll'],
      ['extensions_town', 'true'],
      ['extensions_poi', opts.pois ? 1 : 0],
    ];
    if (opts.pois) params.push(['radius', opts.radius ?? 300]);
    params.push(['output', 'json']);
    const { json, via } = await this.request(
      { service: 'reverse_geocoding', path: '/reverse_geocoding/v3/', params },
      opts,
    );
    const r = obj(json.result);
    if (json.status !== 0 || !r) return null;
    const ac = obj(r.addressComponent) ?? {};
    return {
      location: toLngLat(r.location) ?? location,
      formattedAddress: str(r.formatted_address) ?? '',
      semanticDescription: str(r.sematic_description),
      business: str(r.business),
      province: str(ac.province),
      city: str(ac.city),
      district: str(ac.district),
      town: str(ac.town),
      townCode: str(ac.town_code),
      adcode: str(ac.adcode),
      street: str(ac.street),
      streetNumber: str(ac.street_number),
      pois: arr(r.pois).flatMap((p) => {
        const o = obj(p);
        if (!o) return [];
        return [
          {
            uid: str(o.uid),
            name: str(o.name) ?? '',
            tag: str(o.tag),
            location: toLngLat(o.point),
            distanceM: num(o.distance),
            direction: str(o.direction),
            address: str(o.addr),
          },
        ];
      }),
      regions: arr(r.poiRegions).flatMap((p) => {
        const o = obj(p);
        return o
          ? [{ name: str(o.name) ?? '', tag: str(o.tag), uid: str(o.uid), relation: str(o.direction_desc) }]
          : [];
      }),
      via,
    };
  }

  /**
   * geoconv/v2. `model` picks the conversion (GEOCONV_MODEL; 2 = WGS84 → BD-09). Batches of 100.
   * Returns [x, y] per input: [lng, lat] for bd09ll/gcj02 output, metres for bd09mc.
   */
  async geoconv(points: readonly LngLat[], opts: CallOptions & { model: number }): Promise<LngLat[]> {
    const mercatorIn =
      opts.model === GEOCONV_MODEL.BD09MC_TO_BD09 || opts.model === GEOCONV_MODEL.BD09MC_TO_GCJ02;
    points.forEach((p, i) => {
      if (mercatorIn) {
        if (!Array.isArray(p) || !p.every(Number.isFinite))
          throw new BaiduInputError(`points[${i}] 不是有效坐标`);
      } else assertLngLat(p, `points[${i}]`);
    });
    const batches: LngLat[][] = [];
    for (let i = 0; i < points.length; i += GEOCONV_MAX_POINTS)
      batches.push(points.slice(i, i + GEOCONV_MAX_POINTS));
    const results = await Promise.all(
      batches.map(async (batch) => {
        const coords = batch.map((p) => `${Number(p[0].toFixed(7))},${Number(p[1].toFixed(7))}`).join(';');
        const params: QueryParams = [
          ['coords', coords],
          ['model', opts.model],
          ['output', 'json'],
        ];
        const { json } = await this.request({ service: 'geoconv', path: '/geoconv/v2/', params }, opts);
        const out = arr(json.result).map(toLngLat);
        if (out.length !== batch.length || out.some((p) => p === null)) {
          throw new BaiduUpstreamError(`坐标转换返回 ${out.length} 个点，应为 ${batch.length} 个`, {
            service: 'geoconv',
            kind: 'bad_response',
          });
        }
        return out as LngLat[];
      }),
    );
    return results.flat();
  }

  // ---------------------------------------------------------------- place search

  /**
   * place/v3/around. Keywords are joined with "$" (10 per query; more are split into several queries and
   * merged by uid). Pages through results until `total` or `maxPages` (default 3) is reached.
   */
  async placeAround(
    keywords: string | readonly string[],
    center: LngLat,
    opts: CallOptions & {
      radius?: number;
      pageSize?: number;
      maxPages?: number;
      scope?: 1 | 2;
      radiusLimit?: boolean;
      tag?: string;
    } = {},
  ): Promise<PlaceSearchResult> {
    assertLngLat(center, 'center');
    const words = splitKeywords(keywords);
    const groups: string[][] = [];
    for (let i = 0; i < words.length; i += PLACE_MAX_KEYWORDS)
      groups.push(words.slice(i, i + PLACE_MAX_KEYWORDS));
    const parts: PlaceSearchResult[] = [];
    for (const group of groups) {
      const base: [string, QueryValue][] = [
        ['query', group.join('$')],
        ['location', latLngParam(center)],
        ['radius', Math.round(opts.radius ?? 1000)],
        ['radius_limit', opts.radiusLimit === false ? 'false' : 'true'],
        ['scope', opts.scope ?? 2],
      ];
      if (opts.tag) base.push(['tag', opts.tag]);
      parts.push(await this.placePaged('/place/v3/around', base, group, opts));
    }
    return mergePlaceResults(words, parts);
  }

  /**
   * place/v3/region. With an address as the query Baidu may answer `result_type: address_type` — the
   * measured fix for addresses geocoding misplaces (§4.6).
   */
  async placeRegion(
    query: string,
    region: string,
    opts: CallOptions & { regionLimit?: boolean; pageSize?: number; maxPages?: number; scope?: 1 | 2 } = {},
  ): Promise<PlaceSearchResult> {
    const q = query.trim();
    if (!q) throw new BaiduInputError('检索词不能为空');
    if (!region.trim()) throw new BaiduInputError('region 不能为空');
    const base: [string, QueryValue][] = [
      ['query', q],
      ['region', region.trim()],
      ['region_limit', opts.regionLimit === false ? 'false' : 'true'],
      ['scope', opts.scope ?? 2],
    ];
    return this.placePaged('/place/v3/region', base, [q], { pageSize: 10, maxPages: 1, ...opts });
  }

  /**
   * place/v3/detail with scope 2 (tags, navi_location, parent_id): the full record of POIs known by uid,
   * e.g. ones the browser JSAPI found and place/v3/around omits. PLACE_DETAIL_MAX_UIDS uids per request
   * (one unit of the `place` quota each), in the order given, each request cached on its own. Uids are
   * trimmed and deduplicated; one Baidu does not know is listed in `missing`.
   */
  async placeDetail(uids: readonly string[], opts: CallOptions = {}): Promise<PlaceDetailResult> {
    const list = [...new Set(uids.map((u) => (typeof u === 'string' ? u.trim() : '')))];
    if (list.some((u) => !u || /[,;|\s]/.test(u))) throw new BaiduInputError('uid 不能为空或包含分隔符');
    const pois: PlacePoi[] = [];
    let requests = 0;
    let apiCalls = 0;
    for (let i = 0; i < list.length; i += PLACE_DETAIL_MAX_UIDS) {
      const batch = list.slice(i, i + PLACE_DETAIL_MAX_UIDS);
      const params: QueryParams = [
        ['uids', batch.join(',')],
        ['scope', 2],
        ['output', 'json'],
      ];
      const { json, via } = await this.request({ service: 'place', path: '/place/v3/detail', params }, opts);
      requests++;
      if (via === 'api') apiCalls++;
      // several uids answer with `results`; v2 and single uids with `result` (an object)
      const raw = json.results ?? json.result;
      for (const row of Array.isArray(raw) ? raw : raw ? [raw] : []) {
        const poi = parsePoi(row);
        if (poi?.uid && batch.includes(poi.uid) && !pois.some((p) => p.uid === poi.uid)) pois.push(poi);
      }
    }
    const order = new Map(list.map((u, i) => [u, i]));
    pois.sort((a, b) => order.get(a.uid!)! - order.get(b.uid!)!);
    const found = new Set(pois.map((p) => p.uid));
    return {
      uids: list,
      pois,
      missing: list.filter((u) => !found.has(u)),
      requests,
      apiCalls,
      via: apiCalls > 0 ? 'api' : 'cache',
    };
  }

  private async placePaged(
    path: string,
    base: QueryParams,
    keywords: string[],
    opts: CallOptions & { pageSize?: number; maxPages?: number },
  ): Promise<PlaceSearchResult> {
    const pageSize = Math.max(
      1,
      Math.min(PLACE_MAX_PAGE_SIZE, Math.round(opts.pageSize ?? PLACE_MAX_PAGE_SIZE)),
    );
    const maxPages = Math.max(1, Math.round(opts.maxPages ?? 3));
    const pois: PlacePoi[] = [];
    const seen = new Set<string>();
    let total = 0;
    let pages = 0;
    let apiCalls = 0;
    let exhausted = false;
    let resultType: string | null = null;
    let queryType: string | null = null;
    for (let page = 0; page < maxPages; page++) {
      const params: QueryParams = [...base, ['page_size', pageSize], ['page_num', page], ['output', 'json']];
      const { json, via } = await this.request({ service: 'place', path, params }, opts);
      pages++;
      if (via === 'api') apiCalls++;
      total = Math.max(total, num(json.total) ?? 0);
      resultType ??= str(json.result_type);
      queryType ??= str(json.query_type);
      const rows = arr(json.results ?? json.result);
      for (const row of rows) {
        const poi = parsePoi(row);
        if (!poi) continue;
        const id = poi.uid ?? `${poi.name}@${poi.location.join(',')}`;
        if (seen.has(id)) continue;
        seen.add(id);
        pois.push(poi);
      }
      if (rows.length < pageSize || (page + 1) * pageSize >= Math.min(total, PLACE_TOTAL_CAP)) {
        exhausted = true;
        break;
      }
    }
    const capped = total >= PLACE_TOTAL_CAP;
    return {
      keywords,
      total,
      capped,
      complete: exhausted && !capped,
      pages,
      apiCalls,
      resultType,
      queryType,
      pois,
      via: apiCalls > 0 ? 'api' : 'cache',
    };
  }

  // ---------------------------------------------------------------- routing

  /**
   * routematrix/v2/walking over every origin × destination. Pairs are deduplicated (1e-5°), served from
   * cache where possible, packed into ≤ 50-route requests and mapped back origin-major. A 0 distance or
   * duration becomes a `no_route` cell with nulls. Uses BAIDU_MATRIX_AK when configured.
   */
  async routeMatrixWalking(
    origins: readonly LngLat[],
    destinations: readonly LngLat[],
    opts: RouteMatrixOptions = {},
  ): Promise<RouteMatrix> {
    if (opts.destUids && opts.destUids.length !== destinations.length) {
      throw new BaiduInputError('destUids 的长度必须与 destinations 相同');
    }
    const pairs: RoutePair[] = [];
    for (const origin of origins) {
      destinations.forEach((destination, j) =>
        pairs.push({ origin, destination, destUid: opts.destUids?.[j] }),
      );
    }
    const r = await this.routePairsWalking(pairs, opts);
    const n = destinations.length;
    return {
      cells: origins.map((_, i) => r.cells.slice(i * n, (i + 1) * n)),
      errors: r.errors,
      stats: r.stats,
    };
  }

  /**
   * Arbitrary OD pairs (e.g. each community to its own candidate facilities). Pairs are grouped into
   * exact origin × destination blocks so no request computes a route nobody asked for.
   */
  async routePairsWalking(
    pairs: readonly RoutePair[],
    opts: RouteMatrixOptions = {},
  ): Promise<RoutePairsResult> {
    const service = 'routematrix_walking';
    const roadPrefer = opts.roadPrefer ? Math.round(opts.roadPrefer) : 0;
    const stats: RouteMatrixStats = {
      pairs: pairs.length,
      unique: 0,
      identity: 0,
      fromCache: 0,
      joined: 0,
      fromApi: 0,
      failed: 0,
      requests: 0,
      routesRequested: 0,
    };
    const unique = new Map<string, UniquePair>();
    const keys = pairs.map((p, i) => {
      assertLngLat(p.origin, `pairs[${i}].origin`);
      assertLngLat(p.destination, `pairs[${i}].destination`);
      const uid = p.destUid?.trim() || null;
      const origin: MatrixEndpoint = { key: pointKey(p.origin), point: p.origin, uid: null };
      const dest: MatrixEndpoint = {
        key: pointKey(p.destination) + (uid ? `;${uid}` : ''),
        point: p.destination,
        uid,
      };
      const key = pairKey(origin, dest, roadPrefer);
      if (!unique.has(key)) unique.set(key, { key, origin, dest });
      return key;
    });
    stats.unique = unique.size;

    const resolved = new Map<string, RouteCell>();
    const errors: BaiduError[] = [];
    const noteError = (e: BaiduError) => {
      if (!errors.includes(e)) errors.push(e);
    };
    const joins: Promise<void>[] = [];
    const todo: UniquePair[] = [];
    for (const u of unique.values()) {
      if (!u.dest.uid && u.origin.key === u.dest.key) {
        resolved.set(u.key, { status: 'ok', distanceM: 0, durationS: 0, via: 'identity' });
        stats.identity++;
        continue;
      }
      const cached = this.cache.get<CachedCell>(service, u.key);
      if (cached) {
        resolved.set(u.key, { ...cached, via: 'cache' });
        stats.fromCache++;
        continue;
      }
      const pending = this.cache.pending<RouteCell>(u.key);
      if (pending) {
        this.cache.noteJoined(service);
        stats.joined++;
        joins.push(
          pending.then((cell) => {
            resolved.set(u.key, { ...cell });
            if (cell.error) noteError(cell.error);
          }),
        );
        continue;
      }
      todo.push(u);
    }

    // Register every pair we are about to fetch, so concurrent callers join instead of re-requesting.
    const settle = new Map<string, (cell: RouteCell) => void>();
    for (const u of todo) {
      const d = deferred<RouteCell>();
      this.cache.track(u.key, d.promise);
      settle.set(u.key, (cell) => {
        resolved.set(u.key, cell);
        d.resolve(cell);
      });
    }

    const tiles = planRequests(todo, MAX_ROUTES_PER_REQUEST);
    const stop = new AbortController();
    const signal = opts.signal ? AbortSignal.any([opts.signal, stop.signal]) : stop.signal;
    let fatal: BaiduError | null = null;
    const runTile = async (tile: MatrixBlock): Promise<void> => {
      const nd = tile.dests.length;
      const units = tile.origins.length * nd;
      const keyAt = (i: number, j: number) =>
        pairKey(tile.origins[i] as MatrixEndpoint, tile.dests[j] as MatrixEndpoint, roadPrefer);
      try {
        if (fatal) throw fatal;
        const params: [string, QueryValue][] = [
          ['origins', tile.origins.map((e) => latLngParam(e.point)).join('|')],
          [
            'destinations',
            tile.dests.map((e) => latLngParam(e.point) + (e.uid ? `;${e.uid}` : '')).join('|'),
          ],
          ['coord_type', 'bd09ll'],
        ];
        if (roadPrefer) params.push(['road_prefer', roadPrefer]);
        params.push(['output', 'json']);
        // ';' must be sent as %3B, otherwise "lat,lng;uid" destinations come back as status 2 (measured).
        const { json } = await this.fetchJson(
          { service, path: '/routematrix/v2/walking', params, units, escape: ';' },
          { ...opts, signal },
        );
        stats.requests++;
        stats.routesRequested += units;
        const rows = arr(json.result);
        if (rows.length !== units) {
          throw new BaiduUpstreamError(`批量算路返回 ${rows.length} 条结果，应为 ${units} 条`, {
            service,
            kind: 'bad_response',
          });
        }
        tile.origins.forEach((_, i) => {
          for (let j = 0; j < nd; j++) {
            const cell = parseMatrixCell(rows[i * nd + j]);
            const key = keyAt(i, j);
            this.cache.set(
              service,
              key,
              cell,
              cell.status === 'ok' ? this.cache.ttlFor(service) : EMPTY_TTL_MS,
            );
            settle.get(key)?.({ ...cell, via: 'api' });
          }
        });
      } catch (err) {
        const e = asBaiduError(err, fatal);
        if (!fatal && (e instanceof BaiduConfigError || e instanceof BaiduQuotaError)) {
          fatal = e;
          stop.abort(e);
        }
        noteError(e);
        tile.origins.forEach((_, i) => {
          for (let j = 0; j < nd; j++) {
            settle.get(keyAt(i, j))?.({
              status: 'failed',
              distanceM: null,
              durationS: null,
              via: 'api',
              error: e,
            });
          }
        });
      }
    };
    // The first request goes alone: a key or quota problem then costs one call, not one per batch.
    const [head, ...rest] = tiles;
    if (head) await runTile(head);
    await Promise.all(rest.map(runTile));
    await Promise.all(joins);
    if (opts.signal?.aborted) throw opts.signal.reason;

    for (const u of todo) {
      const cell = resolved.get(u.key);
      if (cell?.status === 'failed') stats.failed++;
      else if (cell) stats.fromApi++;
    }
    const cells = keys.map((k): RouteCell => {
      const c = resolved.get(k);
      return c ? { ...c } : { status: 'failed', distanceM: null, durationS: null, via: 'api' };
    });
    const first = errors[0];
    if (first && !opts.partial) throw first;
    return { cells, errors, stats };
  }

  /**
   * directionlite/v1/walking with steps (distance, duration, path per step). null when Baidu has no
   * route (status 7). Its durations run 3.5–6.6 % above distance / 1.17 (measured).
   */
  async walkingRoute(
    origin: LngLat,
    destination: LngLat,
    opts: CallOptions & { stepsInfo?: boolean; originUid?: string; destinationUid?: string } = {},
  ): Promise<WalkingRoute | null> {
    assertLngLat(origin, 'origin');
    assertLngLat(destination, 'destination');
    const params: [string, QueryValue][] = [
      ['origin', latLngParam(origin)],
      ['destination', latLngParam(destination)],
    ];
    if (opts.originUid) params.push(['origin_uid', opts.originUid]);
    if (opts.destinationUid) params.push(['destination_uid', opts.destinationUid]);
    if (opts.stepsInfo !== false) params.push(['steps_info', 1]);
    const { json, via } = await this.request(
      { service: 'directionlite_walking', path: '/directionlite/v1/walking', params },
      opts,
    );
    if (json.status !== 0) return null;
    const result = obj(json.result);
    const route = obj(arr(result?.routes)[0]);
    if (!route) return null;
    const steps = arr(route.steps).flatMap((s): WalkingStep[] => {
      const o = obj(s);
      if (!o) return [];
      const html = str(o.instruction) ?? '';
      return [
        {
          distanceM: num(o.distance) ?? 0,
          durationS: num(o.duration) ?? 0,
          instruction: stripTags(html),
          instructionHtml: html,
          turnType: str(o.turn_type),
          turnTypeId: num(o.turn_type_id),
          direction: num(o.direction),
          start: toLngLat(o.start_location),
          end: toLngLat(o.end_location),
          path: parsePath(o.path),
        },
      ];
    });
    const path: LngLat[] = [];
    for (const p of steps.flatMap((s) => s.path)) {
      const last = path[path.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) path.push(p);
    }
    return {
      distanceM: num(route.distance) ?? steps.reduce((a, s) => a + s.distanceM, 0),
      durationS: num(route.duration) ?? steps.reduce((a, s) => a + s.durationS, 0),
      origin: toLngLat(result?.origin),
      destination: toLngLat(result?.destination),
      steps,
      path,
      via,
    };
  }

  // ---------------------------------------------------------------- status

  /** Everything /api/health needs; contains no key material. */
  health(): BaiduHealth {
    return {
      mode: this.mode,
      live: this.config.live,
      tier: this.config.tier,
      auth: authModes(this.config),
      store: this.store.kind,
      quota: this.ledger.snapshot(),
      cache: this.cache.stats(),
      lanes: this.scheduler.stats(),
      issues: this.config.issues,
    };
  }

  close(): void {
    this.store.close();
  }

  // ---------------------------------------------------------------- plumbing

  /** Cache → singleflight → fetch. Cache hits need no key, so pre-cached places work in sample mode. */
  private async request(spec: RequestSpec, opts: CallOptions): Promise<{ json: BaiduJson; via: Via }> {
    const key = cacheKey(`${spec.service}:${spec.path}`, spec.params);
    const ttlOk = this.cache.ttlFor(spec.service);
    const { value, via } = await this.cache.getOrLoad(
      spec.service,
      key,
      () => this.fetchJson(spec, opts).then((r) => r.json),
      (json) => (json.status === 0 ? ttlOk : EMPTY_TTL_MS),
    );
    return { json: value, via };
  }

  /** Ledger → scheduler → transport, uncached. Returns only status 0 or "no result" replies. */
  private async fetchJson(
    spec: RequestSpec,
    opts: CallOptions,
  ): Promise<{ json: BaiduJson; empty: boolean }> {
    const auth = requireAuth(this.config, spec.service);
    const units = spec.units ?? 1;
    const ticket = this.ledger.acquire(spec.service, units, opts.budget);
    try {
      const res = await this.scheduler.execute({
        service: spec.service,
        units,
        signal: opts.signal,
        akVar: auth.akVar,
        send: (attempt) => {
          const built = buildRequest({
            host: this.host,
            path: spec.path,
            params: spec.params,
            auth,
            service: spec.service,
            now: this.now(),
            ...(spec.escape ? { escape: spec.escape } : {}),
          });
          this.onEvent?.({ type: 'request', service: spec.service, attempt, units, url: maskUrl(built.url) });
          return this.transport({ url: built.url, timeoutMs: this.timeoutMs, signal: opts.signal });
        },
      });
      ticket.commit();
      return { json: res.json, empty: res.empty };
    } catch (err) {
      if (opts.signal?.aborted) ticket.release();
      else ticket.fail();
      if (err instanceof BaiduQuotaError && err.scope === 'daily')
        this.ledger.markExhausted(spec.service, err.message);
      throw err;
    }
  }
}

export function createBaiduClient(opts: BaiduClientOptions = {}): BaiduClient {
  return new BaiduClient(opts);
}

export interface ReplayClientOptions {
  /** Directories of recordings in the research/*\/raw format. */
  dirs: readonly string[];
  tier?: BaiduTier;
  /** Default: an in-memory store, so replays never touch the real cache or ledger. */
  store?: KvStore;
  onEvent?: (event: BaiduEvent) => void;
}

/** Offline client answering from recorded responses; no network, no real quota, no waiting. */
export async function createReplayClient(opts: ReplayClientOptions): Promise<BaiduClient> {
  const replay = await ReplayTransport.fromDirs(opts.dirs);
  const tier = opts.tier ?? 'personal';
  const store = opts.store ?? new MemoryStore();
  const unlimited = Object.fromEntries(BAIDU_SERVICES.map((s) => [s, 1e9]));
  return new BaiduClient({
    config: replayConfig(tier),
    transport: replay.send,
    store,
    ledger: new QuotaLedger({ tier, store, limits: unlimited }),
    scheduler: new Scheduler({
      tier,
      sleep: () => Promise.resolve(),
      ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
    }),
    mode: 'replay',
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
  });
}

// ---------------------------------------------------------------- helpers

function pointKey(p: LngLat): string {
  return `${roundCoord(p[0])},${roundCoord(p[1])}`;
}

function pairKey(origin: MatrixEndpoint, dest: MatrixEndpoint, roadPrefer: number): string {
  return cacheKey('routematrix_walking', {
    o: origin.key,
    d: dest.key,
    road_prefer: roadPrefer || undefined,
  });
}

function parseMatrixCell(raw: unknown): CachedCell {
  const o = obj(raw) ?? {};
  const distance = num(obj(o.distance)?.value);
  const duration = num(obj(o.duration)?.value);
  const ok = distance !== null && duration !== null && distance > 0 && duration > 0;
  const cell: CachedCell = ok
    ? { status: 'ok', distanceM: distance, durationS: duration }
    : { status: 'no_route', distanceM: null, durationS: null };
  const rs = num(o.restrictions_status);
  if (rs !== null) cell.restrictionsStatus = rs;
  const rd = num(o.retrograde_dist);
  if (rd !== null) cell.retrogradeDist = rd;
  const extra = Object.entries(o).filter(([k]) => !KNOWN_CELL_KEYS.has(k));
  if (extra.length) cell.extra = Object.fromEntries(extra);
  return cell;
}

/** Best (originChunk × destChunk ≤ maxRoutes) tiling of one block: fewest requests, larger origin chunks on ties. */
export function planTiles(
  nOrigins: number,
  nDests: number,
  maxRoutes = MAX_ROUTES_PER_REQUEST,
): { originChunk: number; destChunk: number; requests: number } {
  let best = { originChunk: 1, destChunk: Math.min(nDests, maxRoutes), requests: Infinity };
  for (let a = Math.min(nOrigins, maxRoutes); a >= 1; a--) {
    const b = Math.min(nDests, Math.floor(maxRoutes / a));
    if (b < 1) continue;
    const requests = Math.ceil(nOrigins / a) * Math.ceil(nDests / b);
    if (requests < best.requests) best = { originChunk: a, destChunk: b, requests };
  }
  return nOrigins === 0 || nDests === 0 ? { ...best, requests: 0 } : best;
}

/** Groups pairs into exact bicliques (by origin or by destination, whichever needs fewer requests), then tiles them. */
export function planRequests(
  pairs: readonly MatrixPair[],
  maxRoutes = MAX_ROUTES_PER_REQUEST,
): MatrixBlock[] {
  const byOrigin = bicliques(pairs, 'origin');
  const byDest = bicliques(pairs, 'dest');
  const cost = (blocks: MatrixBlock[]) =>
    blocks.reduce((n, b) => n + planTiles(b.origins.length, b.dests.length, maxRoutes).requests, 0);
  const blocks = cost(byDest) < cost(byOrigin) ? byDest : byOrigin;
  return blocks.flatMap((b) => {
    const { originChunk, destChunk } = planTiles(b.origins.length, b.dests.length, maxRoutes);
    const tiles: MatrixBlock[] = [];
    for (let i = 0; i < b.origins.length; i += originChunk) {
      for (let j = 0; j < b.dests.length; j += destChunk) {
        tiles.push({ origins: b.origins.slice(i, i + originChunk), dests: b.dests.slice(j, j + destChunk) });
      }
    }
    return tiles;
  });
}

function bicliques(pairs: readonly MatrixPair[], by: 'origin' | 'dest'): MatrixBlock[] {
  const partners = new Map<string, { self: MatrixEndpoint; others: Map<string, MatrixEndpoint> }>();
  for (const p of pairs) {
    const [self, other] = by === 'origin' ? [p.origin, p.dest] : [p.dest, p.origin];
    let entry = partners.get(self.key);
    if (!entry) {
      entry = { self, others: new Map() };
      partners.set(self.key, entry);
    }
    if (!entry.others.has(other.key)) entry.others.set(other.key, other);
  }
  const groups = new Map<string, { selves: MatrixEndpoint[]; others: MatrixEndpoint[] }>();
  for (const { self, others } of partners.values()) {
    const signature = [...others.keys()].sort().join('\n');
    let g = groups.get(signature);
    if (!g) {
      g = { selves: [], others: [...others.values()] };
      groups.set(signature, g);
    }
    g.selves.push(self);
  }
  return [...groups.values()].map((g) =>
    by === 'origin' ? { origins: g.selves, dests: g.others } : { origins: g.others, dests: g.selves },
  );
}

function splitKeywords(keywords: string | readonly string[]): string[] {
  const list = typeof keywords === 'string' ? [keywords] : [...keywords];
  const words = [
    ...new Set(
      list
        .flatMap((k) => k.split('$'))
        .map((k) => k.trim())
        .filter(Boolean),
    ),
  ];
  if (words.length === 0) throw new BaiduInputError('检索关键词不能为空');
  return words;
}

function mergePlaceResults(keywords: string[], parts: PlaceSearchResult[]): PlaceSearchResult {
  const only = parts[0];
  if (parts.length === 1 && only) return { ...only, keywords };
  const seen = new Set<string>();
  const pois: PlacePoi[] = [];
  for (const p of parts.flatMap((r) => r.pois)) {
    const id = p.uid ?? `${p.name}@${p.location.join(',')}`;
    if (!seen.has(id)) {
      seen.add(id);
      pois.push(p);
    }
  }
  const apiCalls = parts.reduce((n, r) => n + r.apiCalls, 0);
  return {
    keywords,
    total: parts.reduce((n, r) => n + r.total, 0),
    capped: parts.some((r) => r.capped),
    complete: parts.every((r) => r.complete),
    pages: parts.reduce((n, r) => n + r.pages, 0),
    apiCalls,
    resultType: only?.resultType ?? null,
    queryType: only?.queryType ?? null,
    pois,
    via: apiCalls > 0 ? 'api' : 'cache',
  };
}

const KNOWN_DETAIL_KEYS = new Set([
  'classified_poi_tag',
  'tag',
  'navi_location',
  'type',
  'label',
  'brand',
  'distance',
  'parent_id',
  'children',
]);

function parsePoi(raw: unknown): PlacePoi | null {
  const o = obj(raw);
  const location = toLngLat(o?.location);
  if (!o || !location) return null;
  const detail = obj(o.detail_info) ?? {};
  const pick = (k: string) => detail[k] ?? o[k];
  return {
    uid: str(o.uid),
    name: str(o.name) ?? '',
    location,
    naviLocation: toLngLat(pick('navi_location')),
    address: str(o.address),
    province: str(o.province),
    city: str(o.city),
    area: str(o.area),
    town: str(o.town),
    townCode: str(o.town_code),
    telephone: str(o.telephone),
    tag: str(pick('tag')),
    classifiedTag: str(pick('classified_poi_tag')),
    type: str(pick('type')),
    label: str(pick('label')),
    brand: str(pick('brand')),
    distanceM: num(pick('distance')),
    parentId: str(pick('parent_id')),
    children: arr(pick('children')).flatMap((c) => {
      const co = obj(c);
      if (!co) return [];
      return [
        {
          uid: str(co.uid),
          name: str(co.name) ?? '',
          showName: str(co.show_name),
          tag: str(co.classified_poi_tag ?? co.tag),
          location: toLngLat(co.location),
        },
      ];
    }),
    extra: Object.fromEntries(Object.entries(detail).filter(([k]) => !KNOWN_DETAIL_KEYS.has(k))),
  };
}

function asBaiduError(err: unknown, fatal: BaiduError | null): BaiduError {
  if (err instanceof BaiduError) return err;
  // Aborted because another tile hit a fatal error: report that error.
  if (fatal) return fatal;
  return new BaiduUpstreamError(`批量算路失败：${err instanceof Error ? err.message : String(err)}`, {
    service: 'routematrix_walking',
    kind: 'network',
    cause: err,
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve: (v: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
