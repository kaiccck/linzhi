/**
 * Coordinates typed into the search plate (输入中心点坐标).
 *
 * People paste coordinates from wherever they found them: Baidu (BD-09), Amap or Tencent (GCJ-02),
 * a GPS log or OpenStreetMap (WGS-84). The plate recognises the text as coordinates, asks which frame
 * it is in (BD-09 by default), and GET /api/locate?crs=… converts it to BD-09 — with Baidu's own
 * geoconv in live mode. `toBd09` is the local fallback (the standard public formulas, < 1 m against
 * geoconv in Shanghai) for a server that cannot convert, or no server at all.
 */
import { gcj02ToBd09, wgs84ToBd09, type LngLat } from '@zoudedao/core';

export type Crs = 'bd09' | 'gcj02' | 'wgs84';

/** The choice shown in the plate: who uses the frame, then its code. BD-09 first (the default). */
export const CRS_OPTIONS: readonly { id: Crs; source: string; code: string }[] = [
  { id: 'bd09', source: '百度', code: 'BD-09' },
  { id: 'gcj02', source: '高德·腾讯', code: 'GCJ-02' },
  { id: 'wgs84', source: 'GPS', code: 'WGS-84' },
];

export const crsCode = (crs: Crs) => CRS_OPTIONS.find((o) => o.id === crs)!.code;

export type ParsedCoords =
  | {
      ok: true;
      lng: number;
      lat: number;
      /** typed latitude first ("31.19, 121.64"): read back as longitude, latitude */
      swapped: boolean;
    }
  /** two numbers, but not a longitude/latitude pair in China (every frame here is China-only) */
  | { ok: false; reason: 'range' };

// Baidu's service area; also where GCJ-02 is defined (outOfChina in @zoudedao/core)
const LNG = [72.004, 137.8347] as const;
const LAT = [0.8293, 55.8271] as const;
const inLng = (v: number) => v >= LNG[0] && v <= LNG[1];
const inLat = (v: number) => v >= LAT[0] && v <= LAT[1];

const NUM = String.raw`([+-]?\d{1,3}(?:\.\d+)?)`;
// "121.64,31.19" · "121.64 31.19" · "121.64、31.19" · "121.64；31.19" (full-width forms are folded first)
const PAIR = new RegExp(String.raw`^${NUM}\s*(?:[,;、]\s*|\s+)${NUM}$`);

/**
 * Reads the search text as a coordinate pair, or returns null when it is not one (an address).
 * Full-width digits, commas and brackets typed with a Chinese IME are folded to ASCII first.
 */
export function parseCoords(text: string): ParsedCoords | null {
  const t = text
    .normalize('NFKC')
    .trim()
    .replace(/^[[(（【]\s*/, '')
    .replace(/\s*[\])）】]$/, '');
  const m = PAIR.exec(t);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (inLng(a) && inLat(b)) return { ok: true, lng: a, lat: b, swapped: false };
  if (inLat(a) && inLng(b)) return { ok: true, lng: b, lat: a, swapped: true };
  return { ok: false, reason: 'range' };
}

/** Local conversion to BD-09 (the fallback when the server does not convert). */
export function toBd09(lng: number, lat: number, crs: Crs): LngLat {
  if (crs === 'gcj02') return gcj02ToBd09(lng, lat);
  if (crs === 'wgs84') return wgs84ToBd09(lng, lat);
  return [lng, lat];
}

/** "121.644195, 31.190070": a typed or converted point, six decimals (about 0.1 m). */
export const fmtLngLat = ([lng, lat]: readonly [number, number], digits = 6) =>
  `${lng.toFixed(digits)}, ${lat.toFixed(digits)}`;
