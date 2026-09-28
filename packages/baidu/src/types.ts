import type { LngLat } from '@zoudedao/core';
import type { QuotaBudget } from './ledger.js';

export type { LngLat };

/** The six Baidu Web Services 走得到 calls. Each has its own daily quota, QPS lane and cache TTL. */
export type BaiduService =
  'geocoding' | 'reverse_geocoding' | 'geoconv' | 'place' | 'routematrix_walking' | 'directionlite_walking';

export const BAIDU_SERVICES: readonly BaiduService[] = [
  'geocoding',
  'reverse_geocoding',
  'geoconv',
  'place',
  'routematrix_walking',
  'directionlite_walking',
];

export const SERVICE_LABEL: Readonly<Record<BaiduService, string>> = {
  geocoding: '地理编码',
  reverse_geocoding: '逆地理编码',
  geoconv: '坐标转换',
  place: '地点检索',
  routematrix_walking: '批量算路（步行）',
  directionlite_walking: '轻量步行路线',
};

/** Quota tier of the developer account (开发者权益表, 2025-10). */
export type BaiduTier = 'personal' | 'enterprise';

/** `sn` = request signed with the SK; `ip` = AK in IP-whitelist mode, sent unsigned. */
export type AuthMode = 'sn' | 'ip';

/** Where a value came from: a Baidu round trip or the local cache. */
export type Via = 'api' | 'cache';

/** Top level of every Baidu Web Service reply. Errors come back with HTTP 200 and a non-zero status. */
export interface BaiduJson {
  status: number;
  message?: string;
  msg?: string;
  [key: string]: unknown;
}

/** Options every endpoint accepts. */
export interface CallOptions {
  /** Quota reserved for one analysis (see QuotaLedger.reserve); lets its calls run past the 90 % soft limit. */
  budget?: QuotaBudget;
  signal?: AbortSignal;
}
