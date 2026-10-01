/**
 * 步行路线证据 → GET /api/route (docs/api.md): the real Baidu walking route one unit's check was judged
 * on, from the community to the facility the check routed to. Stored routes (every verified 伪覆盖 of
 * the four samples, and any route asked for before) come back without a Baidu call; a route never
 * fetched needs a live server (409 live_mode_disabled in sample mode). A page with no server at all
 * reads the stored routes shipped with the bundled sample.
 */
import type { HardCategory, LngLat, XY } from '@zoudedao/core';
// the bundled sample's stored routes (dev: served from the repo; build: dist/assets/zj-a-*.json)
import bundledRoutesUrl from '../../../../data/samples/routes/zj-a.json?url';
import { ApiError, errorText } from './api.js';
import { BUNDLED_ID } from './loadAnalysis.js';

export interface RouteEvidence {
  analysis_id: string;
  /** the community as the server names it (its map code when the server gives one) */
  community: { name: string; code: string | null; xy: XY | null } | null;
  /** the facility the check routed to: its POI point and the route's end (Baidu's entrance) */
  facility: { name: string; category: string; xy: XY | null; entrance_xy: XY | null } | null;
  /** the route in the analysis' local metres */
  path: XY[];
  /** this route's own length and time (the time counts crossing waits) */
  distance_m: number;
  duration_s: number;
  /** stored: no Baidu call; baidu: fetched now (and kept); bundled: read from the page's own files */
  source: 'stored' | 'baidu' | 'bundled';
  fetched_at: string | null;
}

export interface RouteRequest {
  analysis_id: string;
  /** community name (the server also takes its map code) */
  community: string;
  category: HardCategory;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const pair = (v: unknown): [number, number] | null =>
  Array.isArray(v) && v.length >= 2 && typeof v[0] === 'number' && typeof v[1] === 'number'
    ? [v[0], v[1]]
    : null;
const pairs = (v: unknown): [number, number][] | null => {
  if (!Array.isArray(v)) return null;
  const out = v.map(pair);
  return out.every((p) => p !== null) ? (out as [number, number][]) : null;
};

/**
 * Shape check of a GET /api/route answer. `toXY` turns BD-09 into the local frame of the analysis on
 * screen, for an answer without `path_xy` (a route asked for by coordinates alone).
 */
export function parseRoute(body: unknown, toXY: (lng: number, lat: number) => XY): RouteEvidence | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const distance = num(b.distance_m);
  const bd = pairs(b.path_bd09);
  const xy = pairs(b.path_xy);
  const path = xy?.length ? xy : bd?.length ? bd.map(([lng, lat]) => toXY(lng, lat)) : null;
  if (distance === null || !path || path.length < 2) return null;
  const c = b.community as Record<string, unknown> | null | undefined;
  const f = b.facility as Record<string, unknown> | null | undefined;
  return {
    analysis_id: str(b.analysis_id) ?? '',
    community:
      c && typeof c === 'object' && str(c.name)
        ? { name: str(c.name)!, code: str(c.code), xy: pair(c.xy) }
        : null,
    facility:
      f && typeof f === 'object' && str(f.name)
        ? {
            name: str(f.name)!,
            category: str(f.category) ?? '',
            xy: pair(f.xy),
            entrance_xy: pair(f.entrance_xy) ?? pair(f.xy),
          }
        : null,
    path,
    distance_m: distance,
    duration_s: num(b.duration_s) ?? 0,
    source: b.source === 'baidu' ? 'baidu' : 'stored',
    fetched_at: str(b.fetched_at),
  };
}

export async function getRoute(
  req: RouteRequest,
  toXY: (lng: number, lat: number) => XY,
  signal: AbortSignal,
): Promise<RouteEvidence> {
  const q = new URLSearchParams({
    analysis_id: req.analysis_id,
    community: req.community,
    category: req.category,
  });
  let res: Response;
  try {
    res = await fetch(`/api/route?${q}`, { signal, headers: { accept: 'application/json' } });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new ApiError('offline', '无法连接邻至服务端，请确认服务已启动。');
  }
  const json = /json/i.test(res.headers.get('content-type') ?? '');
  const body = (json ? await res.json().catch(() => null) : null) as Record<string, unknown> | null;
  if (!res.ok) {
    const code = typeof body?.error === 'string' ? body.error : `http_${res.status}`;
    if (code === 'live_mode_disabled')
      throw new ApiError(code, '这条步行路线还没有保存过；查询新的路线需要服务端配置百度 Key（live 模式）。');
    // an older server has no such route: say what is missing rather than a bare 404
    if (res.status === 404 && !body)
      throw new ApiError('not_found', '服务端还没有步行路线接口（GET /api/route）。');
    throw new ApiError(code, errorText(code, body?.message));
  }
  const parsed = parseRoute(body, toXY);
  if (!parsed) throw new ApiError('upstream', '步行路线的返回数据不完整。');
  return parsed;
}

/* ---------------- no server: the bundled sample's stored routes ---------------- */

interface StoredRoute {
  community: string;
  category: string;
  rules: string[];
  facility: string;
  to_bd09: LngLat;
  distance_m: number;
  duration_s: number;
  path_bd09: LngLat[];
}

let bundled: Promise<StoredRoute[]> | null = null;

/** Parses the stored-routes file (data/samples/routes/<id>.json): the routes it can read. */
export function parseStoredRoutes(body: unknown): StoredRoute[] {
  const routes = (body as { routes?: unknown } | null)?.routes;
  if (!Array.isArray(routes)) return [];
  return routes.flatMap((r): StoredRoute[] => {
    if (!r || typeof r !== 'object') return [];
    const o = r as Record<string, unknown>;
    const path = pairs(o.path_bd09);
    const to = pair(o.to_bd09);
    const d = num(o.distance_m);
    if (!str(o.community) || !str(o.category) || !path || path.length < 2 || !to || d === null) return [];
    return [
      {
        community: str(o.community)!,
        category: str(o.category)!,
        rules: Array.isArray(o.rules) ? o.rules.filter((x): x is string => typeof x === 'string') : [],
        facility: str(o.facility) ?? '',
        to_bd09: to,
        distance_m: d,
        duration_s: num(o.duration_s) ?? 0,
        path_bd09: path,
      },
    ];
  });
}

/**
 * The stored route of the bundled sample (a static page has no server to ask). Null when the page
 * shows another analysis, or the route was never stored.
 */
export async function bundledRoute(
  sampleId: string,
  req: Omit<RouteRequest, 'analysis_id'>,
  toXY: (lng: number, lat: number) => XY,
): Promise<RouteEvidence | null> {
  if (sampleId !== BUNDLED_ID) return null;
  bundled ??= fetch(bundledRoutesUrl)
    .then((r) => r.json() as Promise<unknown>)
    .then(parseStoredRoutes)
    .catch(() => {
      bundled = null;
      return [];
    });
  const hit = (await bundled).find(
    // the task rule's route (a stored route lists the rule sets it answered; GB 50180 ones are not read)
    (r) =>
      r.community === req.community &&
      r.category === req.category &&
      (!r.rules.length || r.rules.includes('task')),
  );
  if (!hit) return null;
  return {
    analysis_id: sampleId,
    community: { name: hit.community, code: null, xy: null },
    facility: { name: hit.facility, category: hit.category, xy: null, entrance_xy: toXY(...hit.to_bd09) },
    path: hit.path_bd09.map(([lng, lat]) => toXY(lng, lat)),
    distance_m: hit.distance_m,
    duration_s: hit.duration_s,
    source: 'bundled',
    fetched_at: null,
  };
}
