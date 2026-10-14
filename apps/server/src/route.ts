/**
 * Walking-route evidence (GET /api/route): the real walk behind a check — from the community (its
 * gate in live results, its outline centroid in zj-a) to the facility the check routed to (`via`,
 * at its entrance: the point the routematrix call used) — as Baidu's walking route (directionlite,
 * steps with paths) through the cached client. A route is kept forever per OD pair (1e-5°): first
 * the routes prefetched for the samples (data/samples/routes/*.json, committed, so the demo and the
 * sample mode never wait), then the history's route table, and only then Baidu (live mode).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { communityCodes, frameOf, normName, ruleOf } from '@zoudedao/agent';
import { roundCoord, type BaiduClient, type WalkingRoute } from '@zoudedao/baidu';
import {
  checkedCategories,
  haversine,
  routingPoint,
  schoolCheck,
  type AnalysisResult,
  type CheckStatus,
  type FacilityCategory,
  type FacilityCheck,
  type HardCategory,
  type LngLat,
  type MainStatus,
  type Poi,
  type XY,
} from '@zoudedao/core';
import type { HistoryStore, StoredRoute } from './history.js';

/** The one Baidu call a route needs. */
export type RouteWalker = Pick<BaiduClient, 'walkingRoute'>;

/** Longest straight line between the two ends: a 15-minute walk is about 1 km; this is generous. */
export const ROUTE_MAX_STRAIGHT_M = 3000;

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const r1 = (v: number) => Math.round(v * 10) / 10;
const bd = (p: LngLat): LngLat => [r6(p[0]), r6(p[1])];

/** Store key of an OD pair: both ends to 1e-5° (≈ 1 m), as the Baidu cache rounds them. */
export function routeKey(from: LngLat, to: LngLat): string {
  return `${roundCoord(from[0])},${roundCoord(from[1])}|${roundCoord(to[0])},${roundCoord(to[1])}`;
}

/** Straight line between two BD-09 points, metres (one decimal). */
export const straightM = (a: LngLat, b: LngLat): number => r1(haversine(a[0], a[1], b[0], b[1]));

// ------------------------------------------------------------------------ resolving a check

export interface RouteCommunity {
  name: string;
  /** The web's map code (A-01 …). */
  code: string;
  xy: XY;
  bd09: LngLat;
}

export interface RouteFacility {
  name: string;
  uid: string;
  category: FacilityCategory;
  /** The POI's display point. */
  xy: XY;
  bd09: LngLat;
  /** Where the route ends: the entrance (navi point) when Baidu gave one, else the POI point. */
  entrance_xy: XY;
}

export interface RouteCheck {
  status: CheckStatus;
  status_main: MainStatus;
  verified: boolean;
  /** The check's own walk (routematrix), metres. */
  route_m: number;
  /** Straight line to the nearest facility of the category (not necessarily `via`). */
  straight_m: number;
  rule_m: number;
  via: string;
}

/** What a check routed: from the community to the facility the shortest walk reached. */
export interface CheckPair {
  community: RouteCommunity;
  facility: RouteFacility;
  check: RouteCheck;
  from: LngLat;
  to: LngLat;
}

export type PairFailure =
  | { kind: 'no_community'; names: string[] }
  /** `checked`: the categories the analysis was checked for (older analyses: the task's three). */
  | { kind: 'no_check'; checked: HardCategory[] }
  | { kind: 'not_routed'; status: CheckStatus }
  | { kind: 'no_facility'; via: string };

/** A community by exact name, else by normalised name, else by map code (A-01). */
export function findRouteCommunity(result: AnalysisResult, id: string, ref: string): number {
  const list = result.communities;
  let i = list.findIndex((c) => c.name === ref);
  if (i < 0) i = list.findIndex((c) => normName(c.name) === normName(ref));
  if (i < 0) i = communityCodes(result, id).indexOf(ref.trim().toUpperCase());
  return i;
}

/** The facility a check routed to: by via_uid (merged duplicates included), else by name. */
function viaPoi(pois: readonly Poi[], check: FacilityCheck): Poi | undefined {
  const uid = check.via_uid;
  if (uid) {
    const hit = pois.find((p) => p.uid === uid || p.merged_uids?.includes(uid));
    if (hit) return hit;
  }
  return check.via ? pois.find((p) => p.name === check.via) : undefined;
}

/** The OD pair behind a community's check of one category, or why there is none. */
export function checkPair(
  result: AnalysisResult,
  id: string,
  input: { community: string; category: HardCategory },
): CheckPair | PairFailure {
  const index = findRouteCommunity(result, id, input.community);
  if (index < 0) return { kind: 'no_community', names: result.communities.map((c) => c.name) };
  const c = result.communities[index]!;
  const check =
    input.category === '小学' ? schoolCheck(c, ruleOf(result, '小学')) : c.checks?.[input.category];
  if (!check) return { kind: 'no_check', checked: checkedCategories(result) };
  const basis = check.route_basis ?? 'routed';
  if (basis !== 'routed' || !check.via || !(check.route_m > 0)) {
    return { kind: 'not_routed', status: check.status };
  }
  const poi =
    viaPoi(result.pois ?? [], check) ??
    (input.category === '小学' && c.catchment?.school_xy
      ? {
          uid: c.catchment.school_uid ?? `school:${c.catchment.school_xy.join(',')}`,
          name: c.catchment.school,
          cat: '小学' as const,
          xy: c.catchment.school_xy,
          navi_xy: c.catchment.school_xy,
          source: 'gov' as const,
        }
      : undefined);
  if (!poi) return { kind: 'no_facility', via: check.via };
  const frame = frameOf(result.meta);
  const entrance =
    input.category === '小学' ? (c.catchment?.school_xy ?? routingPoint(poi)) : routingPoint(poi);
  const from = bd(frame.toLngLat(c.centroid[0], c.centroid[1]));
  const to = bd(frame.toLngLat(entrance[0], entrance[1]));
  return {
    community: {
      name: c.name,
      code: communityCodes(result, id)[index] ?? '',
      xy: [r1(c.centroid[0]), r1(c.centroid[1])],
      bd09: from,
    },
    facility: {
      name: poi.name,
      uid: poi.uid,
      category: poi.cat,
      xy: [r1(poi.xy[0]), r1(poi.xy[1])],
      bd09: bd(frame.toLngLat(poi.xy[0], poi.xy[1])),
      entrance_xy: [r1(entrance[0]), r1(entrance[1])],
    },
    check: {
      status: check.status,
      status_main: check.status_main,
      verified: check.verified,
      route_m: check.route_m,
      straight_m: check.straight_m,
      rule_m: ruleOf(result, input.category),
      via: check.via,
    },
    from,
    to,
  };
}

// ------------------------------------------------------------------------------ the store

interface RouteFileEntry extends StoredRoute {
  community?: string;
  category?: string;
  facility?: string;
}

/**
 * The routes prefetched for the samples (apps/server/scripts/prefetch-routes.ts):
 * <samplesDir>/routes/<sample id>.json, `{ routes: StoredRoute[] }`. Broken files are skipped.
 */
export function loadSampleRoutes(
  dir: string,
  warn: (message: string) => void = () => {},
): Map<string, StoredRoute> {
  const out = new Map<string, StoredRoute>();
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return out;
  }
  for (const file of files.sort()) {
    try {
      const data = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { routes?: RouteFileEntry[] };
      for (const r of data.routes ?? []) {
        if (!Array.isArray(r.from_bd09) || !Array.isArray(r.to_bd09) || !Array.isArray(r.path_bd09)) continue;
        out.set(routeKey(r.from_bd09, r.to_bd09), {
          from_bd09: r.from_bd09,
          to_bd09: r.to_bd09,
          distance_m: r.distance_m,
          duration_s: r.duration_s,
          path_bd09: r.path_bd09,
          fetched_at: r.fetched_at,
        });
      }
    } catch (err) {
      warn(`样例路线 ${file} 无法读取，已跳过：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

/** A Baidu walking route as it is kept: BD-09 path to 1e-6°, the whole route's distance and time. */
export function toStoredRoute(from: LngLat, to: LngLat, route: WalkingRoute, now: Date): StoredRoute {
  const path = route.path.length ? route.path : [from, to];
  return {
    from_bd09: bd(from),
    to_bd09: bd(to),
    distance_m: route.distanceM,
    duration_s: route.durationS,
    path_bd09: path.map(bd),
    fetched_at: now.toISOString(),
  };
}

export type RouteSource = 'stored' | 'baidu';

/** Stored routes first (samples, then the history), then Baidu when a walker is given. */
export class RouteBook {
  readonly #samples: Map<string, StoredRoute>;
  readonly #history: HistoryStore | undefined;
  readonly #warn: (message: string, err: unknown) => void;

  constructor(
    samples: Map<string, StoredRoute>,
    history?: HistoryStore,
    warn: (message: string, err: unknown) => void = () => {},
  ) {
    this.#samples = samples;
    this.#history = history;
    this.#warn = warn;
  }

  stored(from: LngLat, to: LngLat): StoredRoute | undefined {
    const key = routeKey(from, to);
    return this.#samples.get(key) ?? this.#history?.getRoute(key);
  }

  /**
   * The stored route, or Baidu's (then kept forever); null when Baidu has no walking route between
   * them. Baidu errors and the signal's reason propagate.
   */
  async walk(
    from: LngLat,
    to: LngLat,
    walker: RouteWalker | undefined,
    signal: AbortSignal,
  ): Promise<{ route: StoredRoute; source: RouteSource } | { route: null; source: 'baidu' } | undefined> {
    const hit = this.stored(from, to);
    if (hit) return { route: hit, source: 'stored' };
    if (!walker) return undefined;
    const r = await walker.walkingRoute(from, to, { stepsInfo: true, signal });
    if (!r || !(r.distanceM > 0)) return { route: null, source: 'baidu' };
    const route = toStoredRoute(from, to, r, new Date());
    try {
      this.#history?.putRoute(routeKey(from, to), route);
    } catch (err) {
      // not kept this time: the next request asks again (the Baidu cache still answers it)
      this.#warn('步行路线未能写入历史记录', err);
    }
    return { route, source: 'baidu' };
  }
}

/** The path in an analysis' local frame (metres, one decimal). */
export function pathXY(result: AnalysisResult, path: readonly LngLat[]): XY[] {
  const frame = frameOf(result.meta);
  return path.map(([lng, lat]) => {
    const [x, y] = frame.toXY(lng, lat);
    return [r1(x), r1(y)];
  });
}
