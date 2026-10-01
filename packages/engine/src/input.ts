import { outOfChina, type LngLat } from '@zoudedao/core';

import { EngineError } from './errors.js';
import type { BrowserPoi, EngineInput, Profile } from './types.js';

export interface Job {
  center: LngLat;
  label: string | undefined;
  profile: Profile;
  /** Valid browser POIs, deduplicated by uid (browserPois). */
  browserPois: BrowserPoi[];
}

const MAX_LABEL = 80;

/** Browser POIs one request may bring (JSAPI LocalSearch, 12 keywords within 2.1 km). */
export const BROWSER_POIS_MAX = 400;
const BROWSER_NAME_MAX = 60;
const BROWSER_KEYWORD_MAX = 10;
const UID = /^[0-9a-f]{24}$/;

/**
 * The valid items of a `browser_pois` field, whatever it holds: uid 24 hex characters (lower-cased),
 * name up to 60 and keyword up to 10 characters, bd09 a finite point in China. Invalid items and
 * repeated uids are dropped, not reported; at most BROWSER_POIS_MAX are kept. Anything but an array
 * gives none.
 */
export function browserPois(raw: unknown): BrowserPoi[] {
  if (!Array.isArray(raw)) return [];
  const out: BrowserPoi[] = [];
  const seen = new Set<string>();
  const text = (v: unknown, max: number) => {
    const s = typeof v === 'string' ? v.trim() : '';
    return s && [...s].length <= max ? s : null;
  };
  for (const item of raw as unknown[]) {
    if (out.length >= BROWSER_POIS_MAX) break;
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    const uid = typeof o.uid === 'string' ? o.uid.trim().toLowerCase() : '';
    const name = text(o.name, BROWSER_NAME_MAX);
    const keyword = text(o.keyword, BROWSER_KEYWORD_MAX);
    const p = o.bd09;
    const point =
      Array.isArray(p) &&
      p.length === 2 &&
      p.every((v) => typeof v === 'number' && Number.isFinite(v)) &&
      !outOfChina(p[0] as number, p[1] as number);
    if (!UID.test(uid) || !name || !keyword || !point || seen.has(uid)) continue;
    seen.add(uid);
    out.push({ uid, name, keyword, bd09: [p[0] as number, p[1] as number] });
  }
  return out;
}

/** Checks the input the way the server's JSON schema does, so CLI and MCP callers get the same errors. */
export function validateInput(input: EngineInput): Job {
  const c: unknown = input?.center_bd09;
  const ok =
    Array.isArray(c) &&
    c.length === 2 &&
    c.every((v) => typeof v === 'number' && Number.isFinite(v)) &&
    !outOfChina(c[0] as number, c[1] as number);
  if (!ok) throw new EngineError('invalid_input', 'center_bd09 须为中国境内的 BD-09 坐标 [经度, 纬度]');
  const profile = input.profile ?? 'adult';
  if (profile !== 'adult' && profile !== 'elder') {
    throw new EngineError('invalid_input', 'profile 只能是 adult（成人）或 elder（老年人）');
  }
  if (input.label !== undefined && typeof input.label !== 'string') {
    throw new EngineError('invalid_input', 'label 须为文本');
  }
  const label = input.label?.trim().slice(0, MAX_LABEL) || undefined;
  const [lng, lat] = c as [number, number];
  return { center: [lng, lat], label, profile, browserPois: browserPois(input.browser_pois) };
}
