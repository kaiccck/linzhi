/**
 * Coordinate systems for the 15-minute walking life-circle prototype.
 *
 *   WGS84  - OpenStreetMap, GPS.
 *   GCJ-02 - China's national obfuscated datum (all licensed Chinese web maps start from it).
 *   BD-09  - Baidu's extra offset on top of GCJ-02. Every Baidu Web Service response used here
 *            (routematrix, directionlite, place search, reverse geocoding) is BD-09 ("bd09ll").
 *
 * The WGS84<->GCJ-02 and GCJ-02<->BD-09 formulas are the standard public ones (identical to the
 * widely used "coordtransform" implementations). Against Baidu's own geoconv service they agree to
 * better than 1 m in Shanghai, which build-zj-a.ts re-checks on every run.
 *
 * All analysis happens in a local metric frame (x east, y north, metres) around one BD-09 origin.
 */

export type LngLat = [number, number];
export type XY = [number, number];

const X_PI = (Math.PI * 3000.0) / 180.0;
const KRASOVSKY_A = 6378245.0; // semi-major axis used by the GCJ-02 algorithm
const KRASOVSKY_EE = 0.006693421622965943; // first eccentricity squared (Krasovsky 1940)

function transformLat(x: number, y: number): number {
  let r = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  r += ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) * 2.0) / 3.0;
  r += ((160.0 * Math.sin((y / 12.0) * Math.PI) + 320.0 * Math.sin((y * Math.PI) / 30.0)) * 2.0) / 3.0;
  return r;
}

function transformLng(x: number, y: number): number {
  let r = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  r += ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) * 2.0) / 3.0;
  r += ((150.0 * Math.sin((x / 12.0) * Math.PI) + 300.0 * Math.sin((x / 30.0) * Math.PI)) * 2.0) / 3.0;
  return r;
}

/** The box of the GCJ-02 formulas (degrees); Baidu's BD-09 offset stays inside it too. */
export const CHINA_BOX = { minLng: 72.004, maxLng: 137.8347, minLat: 0.8293, maxLat: 55.8271 } as const;

/** GCJ-02 is only defined inside mainland China; outside it the offset is zero. */
export function outOfChina(lng: number, lat: number): boolean {
  return lng < CHINA_BOX.minLng || lng > CHINA_BOX.maxLng || lat < CHINA_BOX.minLat || lat > CHINA_BOX.maxLat;
}

export interface TypedCoordinates {
  lng: number;
  lat: number;
  /** Written latitude first, e.g. "31.19007, 121.644195". */
  swapped: boolean;
  /** One of the two orders lies in CHINA_BOX; false = two numbers, but not a point in China. */
  inChina: boolean;
}

// at most 3 integer digits: "1650 20" is a house number and a floor, not a point
const NUM = String.raw`[+-]?\d{1,3}(?:\.\d+)?`;
const COORD_RE = new RegExp(String.raw`^(${NUM})\s*(?:[,;、]\s*|\s+)(${NUM})$`);
const BRACKETS = /^[([{【]\s*(.*?)\s*[)\]}】]$/s;

/**
 * Two numbers typed as a point: "121.644195,31.19007", "121.644195 31.19007", full-width commas,
 * digits and spaces, optional brackets. China's longitudes (72–138°) and latitudes (0.8–56°) never
 * overlap, so "31.19007, 121.644195" is read latitude first without ambiguity. null when the text is
 * not exactly two numbers of at most 3 integer digits (an address, a place name, a house number).
 * Same rules as the web's search plate (apps/web/src/data/coords.ts).
 */
export function parseCoordinateText(text: string): TypedCoordinates | null {
  let t = text.normalize('NFKC').trim();
  t = BRACKETS.exec(t)?.[1] ?? t;
  const m = COORD_RE.exec(t);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (!outOfChina(a, b)) return { lng: a, lat: b, swapped: false, inChina: true };
  if (!outOfChina(b, a)) return { lng: b, lat: a, swapped: true, inChina: true };
  return { lng: a, lat: b, swapped: false, inChina: false };
}

export function wgs84ToGcj02(lng: number, lat: number): LngLat {
  if (outOfChina(lng, lat)) return [lng, lat];
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * Math.PI;
  const sinLat = Math.sin(radLat);
  const magic = 1 - KRASOVSKY_EE * sinLat * sinLat;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((KRASOVSKY_A * (1 - KRASOVSKY_EE)) / (magic * sqrtMagic)) * Math.PI);
  dLng = (dLng * 180.0) / ((KRASOVSKY_A / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return [lng + dLng, lat + dLat];
}

/** Inverse of wgs84ToGcj02 by fixed-point iteration (converges to < 1 mm in a few steps). */
export function gcj02ToWgs84(lng: number, lat: number): LngLat {
  let wLng = lng;
  let wLat = lat;
  for (let i = 0; i < 8; i++) {
    const [gLng, gLat] = wgs84ToGcj02(wLng, wLat);
    wLng -= gLng - lng;
    wLat -= gLat - lat;
  }
  return [wLng, wLat];
}

export function gcj02ToBd09(lng: number, lat: number): LngLat {
  const z = Math.sqrt(lng * lng + lat * lat) + 0.00002 * Math.sin(lat * X_PI);
  const theta = Math.atan2(lat, lng) + 0.000003 * Math.cos(lng * X_PI);
  return [z * Math.cos(theta) + 0.0065, z * Math.sin(theta) + 0.006];
}

export function bd09ToGcj02(lng: number, lat: number): LngLat {
  const x = lng - 0.0065;
  const y = lat - 0.006;
  const z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * X_PI);
  const theta = Math.atan2(y, x) - 0.000003 * Math.cos(x * X_PI);
  return [z * Math.cos(theta), z * Math.sin(theta)];
}

export function wgs84ToBd09(lng: number, lat: number): LngLat {
  const [gLng, gLat] = wgs84ToGcj02(lng, lat);
  return gcj02ToBd09(gLng, gLat);
}

export function bd09ToWgs84(lng: number, lat: number): LngLat {
  const [gLng, gLat] = bd09ToGcj02(lng, lat);
  return gcj02ToWgs84(gLng, gLat);
}

/** Great-circle distance in metres (mean Earth radius). */
export function haversine(lng1: number, lat1: number, lng2: number, lat2: number): number {
  const R = 6371008.8;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = p2 - p1;
  const dl = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Local equirectangular frame around (lng0, lat0):
 *   x = (lng - lng0) * 111320 * cos(lat0),  y = (lat - lat0) * 110574   (metres, x east, y north).
 * Over a few km this is accurate to ~0.1-0.3 % (slightly shorter than geodesic distances), which is
 * far below the resolution of any walking-time estimate.
 */
export interface LocalFrame {
  readonly lng0: number;
  readonly lat0: number;
  readonly kx: number; // metres per degree of longitude
  readonly ky: number; // metres per degree of latitude
  toXY(lng: number, lat: number): XY;
  toLngLat(x: number, y: number): LngLat;
}

export function localFrame(lng0: number, lat0: number): LocalFrame {
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110574;
  return {
    lng0,
    lat0,
    kx,
    ky,
    toXY: (lng, lat) => [(lng - lng0) * kx, (lat - lat0) * ky],
    toLngLat: (x, y) => [lng0 + x / kx, lat0 + y / ky],
  };
}

/** Compass bearing of the vector (x, y) in degrees: 0 = north, 90 = east, range [0, 360). */
export function bearingDeg(x: number, y: number): number {
  const b = (Math.atan2(x, y) * 180) / Math.PI;
  return b < 0 ? b + 360 : b;
}

/**
 * Checks the formulas against the published coordtransform reference values for (116.404, 39.915)
 * and verifies the round trips. Throws on failure so a broken port can never produce data.
 */
export function coordsSelfTest(): void {
  const cases: Array<[string, LngLat, LngLat]> = [
    ['wgs84ToGcj02', wgs84ToGcj02(116.404, 39.915), [116.41024449916938, 39.91640428150164]],
    ['gcj02ToBd09', gcj02ToBd09(116.404, 39.915), [116.41036949371029, 39.92133699351021]],
    ['bd09ToGcj02', bd09ToGcj02(116.404, 39.915), [116.39762729119315, 39.90865673957631]],
  ];
  for (const [name, got, want] of cases) {
    if (Math.abs(got[0] - want[0]) > 1e-9 || Math.abs(got[1] - want[1]) > 1e-9) {
      throw new Error(`coords self-test failed: ${name} gave ${got}, expected ${want}`);
    }
  }
  // GCJ-02 inverse is iterative (sub-millimetre); the public BD-09 inverse is a closed-form
  // approximation that is good to ~0.1 m.
  const w: LngLat = [121.6334, 31.1865];
  const g = gcj02ToWgs84(...wgs84ToGcj02(w[0], w[1]));
  const gErr = haversine(w[0], w[1], g[0], g[1]);
  if (gErr > 0.001)
    throw new Error(`coords self-test failed: WGS84->GCJ02->WGS84 round trip error ${gErr} m`);
  const b = bd09ToWgs84(...wgs84ToBd09(w[0], w[1]));
  const bErr = haversine(w[0], w[1], b[0], b[1]);
  if (bErr > 0.2) throw new Error(`coords self-test failed: WGS84->BD09->WGS84 round trip error ${bErr} m`);
}
