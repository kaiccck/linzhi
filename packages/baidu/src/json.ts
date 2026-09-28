/** Defensive readers for Baidu JSON, which mixes numbers and numeric strings freely. */
import { BaiduInputError } from './errors.js';
import type { LngLat } from './types.js';

export type Obj = Record<string, unknown>;

export function obj(v: unknown): Obj | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : null;
}

export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function str(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() === '' ? null : v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

export function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** `{lng, lat}` or `{x, y}` (geoconv, reverse-geocoding POIs) → [lng, lat]. */
export function toLngLat(v: unknown): LngLat | null {
  const o = obj(v);
  if (!o) return null;
  const lng = num(o.lng ?? o.x);
  const lat = num(o.lat ?? o.y);
  return lng === null || lat === null ? null : [lng, lat];
}

/** directionlite step path "lng,lat;lng,lat;…" → [lng, lat][]. */
export function parsePath(v: unknown): LngLat[] {
  if (typeof v !== 'string') return [];
  const out: LngLat[] = [];
  for (const part of v.split(';')) {
    const [a, b] = part.split(',');
    const lng = num(a);
    const lat = num(b);
    if (lng !== null && lat !== null) out.push([lng, lat]);
  }
  return out;
}

export function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

/** Throws BaiduInputError unless `p` is a finite [lng, lat] pair. Catches the classic [lat, lng] swap. */
export function assertLngLat(p: unknown, what: string): asserts p is LngLat {
  const ok =
    Array.isArray(p) && p.length === 2 && p.every((x) => typeof x === 'number' && Number.isFinite(x));
  if (!ok) {
    throw new BaiduInputError(`${what} 必须是 [lng, lat] 数字对`, { hint: '坐标一律为 BD-09 [经度, 纬度]' });
  }
  const [lng, lat] = p as LngLat;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new BaiduInputError(`${what} 超出经纬度范围：[${lng}, ${lat}]`, {
      hint: '坐标顺序应为 [经度, 纬度]（BD-09），不是 [纬度, 经度]',
    });
  }
}

/** Baidu's "lat,lng" query order, 6 decimals (≈ 0.1 m) as in the recorded requests. */
export function latLngParam(p: LngLat): string {
  return `${p[1].toFixed(6)},${p[0].toFixed(6)}`;
}
