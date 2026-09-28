/**
 * Validated geocoding (技术设计文档 §4.6).
 *
 * Measured 2026-09-26: geocoding put "上海市浦东新区海科路1650号" 3.5 km away in 北蔡镇 with precise=0,
 * confidence=80, comprehension=99 — and the reverse-geocoded district (浦东新区) and street (海科路)
 * still matched the input. So a district check can reject a result but never confirm a precise=0 one;
 * those are always cross-checked with place/v3/region, which returned the right `address_type` hit.
 */
import { haversine } from '@zoudedao/core';
import type { BaiduClient, GeocodeResult, PlaceSearchResult, ReverseGeocodeResult } from './client.js';
import { BaiduError, BaiduInputError } from './errors.js';
import type { CallOptions, LngLat } from './types.js';

export type LocateSource = 'geocoding' | 'place_region';

export interface LocateCandidate {
  location: LngLat;
  label: string;
  source: LocateSource;
  /** 0–1: ≥ 0.6 can be used directly, below that ask the user. */
  confidence: number;
  /** How the confidence was reached, in Chinese (shown next to the candidate). */
  reason: string;
  district: string | null;
  town: string | null;
  uid: string | null;
}

export interface LocateResult {
  query: string;
  best: LocateCandidate | null;
  /** Sorted by confidence, best first. */
  candidates: LocateCandidate[];
  /** List the candidates on the map and let the user pick (§4.6 step 4). */
  needsConfirmation: boolean;
  /** Lookups made per service (cache hits included). */
  calls: { geocoding: number; reverse_geocoding: number; place: number };
  geocode: GeocodeResult | null;
  reverse: ReverseGeocodeResult | null;
  /** Secondary lookups that failed (quota, permissions …); the result is still usable. */
  warnings: string[];
}

export type LocateClient = Pick<BaiduClient, 'geocode' | 'reverseGeocode' | 'placeRegion'>;

export interface LocateOptions extends CallOptions {
  /** City for geocoding; default: parsed from the query (e.g. 上海市). */
  city?: string;
  /** place/v3/region `region`; default: the city without 市 (e.g. 上海), else 全国. */
  region?: string;
  /** Geocoding and place search within this distance agree. Default 300 m. */
  agreeWithinM?: number;
}

export interface ParsedAddress {
  province: string | null;
  city: string | null;
  district: string | null;
  town: string | null;
  /** The address without the leading administrative units, e.g. 海科路1650号. */
  core: string;
}

const PROVINCE = /^(.{2,7}?(?:省|自治区|特别行政区))/;
const CITY = /^(.{2,7}?市)/;
const DISTRICT = /^(.{1,6}?(?:新区|区|县|旗))/;
const NOT_DISTRICT = /(?:小|园|社|校|景|厂|街|城|营|矿|港|保税)区$/;
const TOWN = /^(.{2,6}?(?:街道|镇|乡))/;

/** Peels province / city / district / town off the front of a Chinese address. */
export function parseAddress(text: string): ParsedAddress {
  let rest = text.trim().replace(/\s+/g, '');
  const take = (re: RegExp, reject?: RegExp): string | null => {
    const m = re.exec(rest)?.[1];
    if (!m || m.length === rest.length || (reject && reject.test(m))) return null;
    rest = rest.slice(m.length);
    return m;
  };
  const province = take(PROVINCE);
  const city = take(CITY);
  const district = take(DISTRICT, NOT_DISTRICT);
  const town = take(TOWN);
  return { province, city, district, town, core: rest };
}

const ADMIN_SUFFIX = /(特别行政区|自治区|新区|街道|省|市|区|县|镇|乡|旗)$/;

function sameAdmin(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const x = a.replace(ADMIN_SUFFIX, '');
  const y = b.replace(ADMIN_SUFFIX, '');
  return x.length > 0 && y.length > 0 && (x.includes(y) || y.includes(x));
}

function fmtDistance(m: number): string {
  return m < 1000 ? `${Math.round(m)} 米` : `${(m / 1000).toFixed(1)} 公里`;
}

function distance(a: LngLat, b: LngLat): number {
  return haversine(a[0], a[1], b[0], b[1]);
}

type Check = { status: 'match' | 'mismatch' | 'unknown'; detail: string };

function adminCheck(addr: ParsedAddress, rev: ReverseGeocodeResult | null): Check {
  if (!rev) return { status: 'unknown', detail: '逆地理编码不可用，无法核对区县' };
  const where = [rev.district, rev.town, rev.street].filter(Boolean).join('') || rev.formattedAddress;
  const pairs: [string | null, string | null][] = [
    [addr.city, rev.city],
    [addr.district, rev.district],
    [addr.town, rev.town],
  ];
  const mismatch = pairs.filter(([want, got]) => want && got && !sameAdmin(want, got)).map(([w]) => w);
  const match = pairs.filter(([want, got]) => want && sameAdmin(want, got)).map(([w]) => w);
  if (mismatch.length)
    return { status: 'mismatch', detail: `逆地理编码落在${where}，与输入的“${mismatch.join('、')}”不一致` };
  if (match.length)
    return { status: 'match', detail: `逆地理编码落在${where}，与输入的“${match.join('、')}”一致` };
  return { status: 'unknown', detail: `逆地理编码落在${where}，输入里没有可核对的区县或街道` };
}

function nameMatches(name: string, core: string): boolean {
  const n = name.replace(/[\s()（）]/g, '');
  const c = core.replace(/[\s()（）]/g, '');
  return n.length > 0 && c.length > 0 && (n.includes(c) || c.includes(n));
}

function describeError(err: unknown): string {
  if (err instanceof BaiduError) return err.hint ? `${err.message}；${err.hint}` : err.message;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Geocode `query`, validate the hit, fall back to place search, and return ranked candidates.
 * Costs 1 call when geocoding is precise, at most 3 (geocoding + reverse + place) otherwise.
 */
export async function locate(
  client: LocateClient,
  query: string,
  opts: LocateOptions = {},
): Promise<LocateResult> {
  const q = query.trim();
  if (!q) throw new BaiduInputError('地址不能为空');
  const addr = parseAddress(q);
  const city = opts.city ?? addr.city ?? undefined;
  const agreeM = opts.agreeWithinM ?? 300;
  const callOpts: CallOptions = {
    ...(opts.budget ? { budget: opts.budget } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  };
  const calls = { geocoding: 0, reverse_geocoding: 0, place: 0 };
  const warnings: string[] = [];
  const result = (
    candidates: LocateCandidate[],
    geocode: GeocodeResult | null,
    reverse: ReverseGeocodeResult | null,
  ) => {
    candidates.sort((a, b) => b.confidence - a.confidence);
    const [best, second] = candidates;
    const needsConfirmation =
      !best ||
      best.confidence < 0.6 ||
      (!!second &&
        best.confidence - second.confidence < 0.15 &&
        distance(best.location, second.location) > agreeM);
    return { query: q, best: best ?? null, candidates, needsConfirmation, calls, geocode, reverse, warnings };
  };

  // 1. Geocoding.
  calls.geocoding++;
  const geo = await client.geocode(q, { ...callOpts, ...(city ? { city } : {}) });
  if (geo?.precise && geo.comprehension >= 80) {
    return result(
      [
        {
          location: geo.location,
          label: q,
          source: 'geocoding',
          confidence: 0.9,
          reason: `地理编码精确匹配（precise=1，理解度 ${geo.comprehension}，${geo.level || '未知级别'}）`,
          district: null,
          town: null,
          uid: null,
        },
      ],
      geo,
      null,
    );
  }

  // 2. Reverse-geocode the hit and compare its district / town with the input.
  let reverse: ReverseGeocodeResult | null = null;
  let geoCandidate: LocateCandidate | null = null;
  if (geo) {
    calls.reverse_geocoding++;
    try {
      reverse = await client.reverseGeocode(geo.location, callOpts);
    } catch (err) {
      warnings.push(`逆地理编码失败：${describeError(err)}`);
    }
    const check = adminCheck(addr, reverse);
    let confidence = geo.precise ? 0.7 : 0.45;
    if (geo.comprehension < 80) confidence -= 0.1;
    if (check.status === 'mismatch') confidence = 0.1;
    const why = geo.precise
      ? `地理编码理解度偏低（comprehension=${geo.comprehension}）`
      : `地理编码为模糊打点（precise=0，${geo.level || '未知级别'}）`;
    geoCandidate = {
      location: geo.location,
      label: reverse?.formattedAddress || q,
      source: 'geocoding',
      confidence,
      reason: `${why}；${check.detail}`,
      district: reverse?.district ?? null,
      town: reverse?.town ?? null,
      uid: null,
    };
    // A precise hit whose district checks out is good enough; precise=0 never is (see header).
    if (geo.precise && check.status === 'match') {
      geoCandidate.confidence = 0.75;
      return result([geoCandidate], geo, reverse);
    }
  }

  // 3. place/v3/region with the address itself.
  const candidates: LocateCandidate[] = geoCandidate ? [geoCandidate] : [];
  const region = opts.region ?? (city ? city.replace(/市$/, '') : '全国');
  let place: PlaceSearchResult | null = null;
  calls.place++;
  try {
    place = await client.placeRegion(addr.core || q, region, { ...callOpts, pageSize: 10, maxPages: 1 });
  } catch (err) {
    warnings.push(`地点检索失败：${describeError(err)}`);
  }
  const placeCandidates: LocateCandidate[] = (place?.pois ?? []).slice(0, 5).map((poi, rank) => {
    let confidence: number;
    let reason: string;
    if (place?.resultType === 'address_type') {
      confidence = rank === 0 ? 0.85 : 0.6;
      reason = '地点检索按地址精确命中（address_type）';
    } else if (nameMatches(poi.name, addr.core || q)) {
      confidence = 0.75 - rank * 0.05;
      reason = `地点检索命中同名地点“${poi.name}”`;
    } else {
      confidence = Math.max(0.1, 0.35 - rank * 0.05);
      reason = `地点检索候选“${poi.name}”，名称与输入不完全一致`;
    }
    if (addr.district && poi.area && !sameAdmin(addr.district, poi.area)) {
      confidence *= 0.5;
      reason += `，但位于${poi.area}`;
    }
    return {
      location: poi.location,
      label: poi.address && poi.address !== poi.name ? `${poi.name}（${poi.address}）` : poi.name,
      source: 'place_region',
      confidence,
      reason,
      district: poi.area,
      town: poi.town,
      uid: poi.uid,
    };
  });
  candidates.push(...placeCandidates);

  // 4. Cross-check geocoding against the best place hit.
  const top = [...placeCandidates].sort((a, b) => b.confidence - a.confidence)[0];
  if (geoCandidate && top) {
    const d = distance(geoCandidate.location, top.location);
    if (d <= agreeM) {
      geoCandidate.confidence = Math.max(geoCandidate.confidence, 0.7);
      geoCandidate.reason += `；与地点检索结果相距 ${fmtDistance(d)}，二者一致`;
      top.confidence = Math.min(0.95, top.confidence + 0.05);
      top.reason += '，与地理编码一致';
    } else {
      geoCandidate.confidence = Math.min(geoCandidate.confidence, 0.2);
      geoCandidate.reason += `；与地点检索结果相距 ${fmtDistance(d)}，判定地理编码错位`;
      top.reason += `；地理编码结果在 ${fmtDistance(d)} 之外，已弃用`;
    }
  }
  return result(candidates, geo, reverse);
}
