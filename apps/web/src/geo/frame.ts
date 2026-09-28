/**
 * The sample's local metric frame and its inverse.
 *
 * meta.frame_formula reads, for example:
 *   "x = (lng - 121.644195) * 111320 * cos(31.19007 deg), y = (lat - 31.19007) * 110574, lng/lat in BD-09"
 * so lng = lng0 + x / (111320 · cos lat0) and lat = lat0 + y / 110574. We parse the constants from
 * the formula (it is the contract of the data) and fall back to meta.center_bd09 with the standard
 * constants if a future generator words it differently.
 */
import type { AnalysisMeta, LngLat, XY } from '@zoudedao/core';

export interface Frame {
  lng0: number;
  lat0: number;
  /** metres per degree of longitude */
  kx: number;
  /** metres per degree of latitude */
  ky: number;
  toLngLat(x: number, y: number): LngLat;
  toXY(lng: number, lat: number): XY;
  /** true when the constants came from meta.frame_formula */
  fromFormula: boolean;
}

const NUM = String.raw`(-?\d+(?:\.\d+)?)`;
const X_RE = new RegExp(
  String.raw`x\s*=\s*\(\s*lng\s*-\s*${NUM}\s*\)\s*\*\s*${NUM}\s*\*\s*cos\(\s*${NUM}\s*deg\s*\)`,
  'i',
);
const Y_RE = new RegExp(String.raw`y\s*=\s*\(\s*lat\s*-\s*${NUM}\s*\)\s*\*\s*${NUM}`, 'i');

export function frameFromMeta(meta: Pick<AnalysisMeta, 'center_bd09' | 'frame_formula'>): Frame {
  const [cLng, cLat] = meta.center_bd09;
  let lng0 = cLng;
  let lat0 = cLat;
  let kx = 111320 * Math.cos((cLat * Math.PI) / 180);
  let ky = 110574;
  let fromFormula = false;
  const mx = X_RE.exec(meta.frame_formula ?? '');
  const my = Y_RE.exec(meta.frame_formula ?? '');
  if (mx && my) {
    const [pLng, pKx, pCos] = [Number(mx[1]), Number(mx[2]), Number(mx[3])];
    const [pLat, pKy] = [Number(my[1]), Number(my[2])];
    if ([pLng, pKx, pCos, pLat, pKy].every(Number.isFinite) && pKx > 0 && pKy > 0) {
      lng0 = pLng;
      lat0 = pLat;
      kx = pKx * Math.cos((pCos * Math.PI) / 180);
      ky = pKy;
      fromFormula = true;
    }
  }
  return {
    lng0,
    lat0,
    kx,
    ky,
    fromFormula,
    toLngLat: (x, y) => [lng0 + x / kx, lat0 + y / ky],
    toXY: (lng, lat) => [(lng - lng0) * kx, (lat - lat0) * ky],
  };
}
