/**
 * Degrade chain for walking distance (技术设计文档 §4.5):
 *   routematrix → directionlite (separate quota pool) → ρ_local × straight ("估算") → 1.35 × straight ("粗估").
 * Every result says which link produced it, so the UI can mark estimates.
 */
import { haversine } from '@zoudedao/core';
import { BAIDU_WALK_SPEED_MPS, type BaiduClient, type RouteCell } from './client.js';
import { BaiduConfigError, BaiduError, BaiduInputError, BaiduQuotaError } from './errors.js';
import type { CallOptions, LngLat, Via } from './types.js';

export type DistanceSource = 'routematrix' | 'directionlite' | 'estimate' | 'coarse';

export const DISTANCE_SOURCE_LABEL: Readonly<Record<DistanceSource, string>> = {
  routematrix: '实测',
  directionlite: '实测（步行路线）',
  estimate: '估算',
  coarse: '粗估',
};

/** Detour factor when nothing better is known. */
export const COARSE_DETOUR = 1.35;

export interface WalkDistance {
  distanceM: number;
  durationS: number;
  source: DistanceSource;
  straightM: number;
  /** distanceM / straightM; null when the points coincide. */
  rho: number | null;
  /** For measured results: API or cache. */
  via?: Via | 'identity';
  /** Why the better sources were skipped, e.g. the routematrix error. */
  fallbackReason?: string;
}

export interface WalkPair {
  origin: LngLat;
  destination: LngLat;
  destUid?: string | null;
}

export interface DegradeOptions extends CallOptions {
  /** Speed for estimated durations (default 1.17 m/s, the routematrix constant). */
  speedMps?: number;
  /** Local detour ratio ρ̂ from the isochrone field; null/undefined = unknown there. */
  rhoLocal?: (origin: LngLat, destination: LngLat) => number | null | undefined;
  coarseFactor?: number;
  /** directionlite calls allowed for pairs the matrix could not answer (default 10). */
  maxDirectionlite?: number;
  useMatrix?: boolean;
  useDirectionlite?: boolean;
  roadPrefer?: number;
}

export type DistanceClient = Pick<BaiduClient, 'routePairsWalking' | 'walkingRoute'>;

export interface WalkDistancesResult {
  results: WalkDistance[];
  errors: BaiduError[];
  counts: Record<DistanceSource, number>;
}

function straight(o: LngLat, d: LngLat): number {
  return haversine(o[0], o[1], d[0], d[1]);
}

/** ρ̂ × straight distance, never below the straight line. */
export function estimateWalk(
  origin: LngLat,
  destination: LngLat,
  rho: number,
  speedMps = BAIDU_WALK_SPEED_MPS,
): WalkDistance {
  const s = straight(origin, destination);
  const distanceM = Math.max(rho, 1) * s;
  return {
    distanceM,
    durationS: distanceM / speedMps,
    source: 'estimate',
    straightM: s,
    rho: s > 0 ? distanceM / s : null,
  };
}

/** 1.35 × straight distance. */
export function coarseWalk(
  origin: LngLat,
  destination: LngLat,
  factor = COARSE_DETOUR,
  speedMps = BAIDU_WALK_SPEED_MPS,
): WalkDistance {
  const s = straight(origin, destination);
  const distanceM = factor * s;
  return {
    distanceM,
    durationS: distanceM / speedMps,
    source: 'coarse',
    straightM: s,
    rho: s > 0 ? factor : null,
  };
}

function fromCell(p: WalkPair, cell: RouteCell): WalkDistance | null {
  if (cell.status !== 'ok' || cell.distanceM === null || cell.durationS === null) return null;
  const s = straight(p.origin, p.destination);
  return {
    distanceM: cell.distanceM,
    durationS: cell.durationS,
    source: 'routematrix',
    straightM: s,
    rho: s > 0 ? cell.distanceM / s : null,
    via: cell.via,
  };
}

function reasonOf(err: unknown): string {
  return err instanceof BaiduError ? err.message : err instanceof Error ? err.message : String(err);
}

/** Walking distance for every pair, taking each from the best link of the chain that can answer it. */
export async function walkDistances(
  client: DistanceClient,
  pairs: readonly WalkPair[],
  opts: DegradeOptions = {},
): Promise<WalkDistancesResult> {
  const speed = opts.speedMps ?? BAIDU_WALK_SPEED_MPS;
  const call: CallOptions = {
    ...(opts.budget ? { budget: opts.budget } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  };
  const out: (WalkDistance | null)[] = pairs.map(() => null);
  const reasons: string[] = pairs.map(() => '');
  const errors: BaiduError[] = [];
  const noteError = (e: BaiduError) => {
    if (!errors.includes(e)) errors.push(e);
  };

  // 1. routematrix
  if (opts.useMatrix !== false && pairs.length > 0) {
    const r = await client.routePairsWalking(pairs, {
      ...call,
      partial: true,
      ...(opts.roadPrefer ? { roadPrefer: opts.roadPrefer } : {}),
    });
    r.errors.forEach(noteError);
    r.cells.forEach((cell, i) => {
      const p = pairs[i];
      if (!p) return;
      out[i] = fromCell(p, cell);
      if (!out[i]) reasons[i] = cell.error ? `批量算路失败：${cell.error.message}` : '批量算路无结果';
    });
  } else {
    reasons.fill('未使用批量算路');
  }

  // 2. directionlite, for a limited number of the remaining pairs
  if (opts.useDirectionlite !== false) {
    const budget = Math.max(0, opts.maxDirectionlite ?? 10);
    const todo = pairs
      .map((p, i) => ({ p, i }))
      .filter(({ i }) => !out[i])
      .slice(0, budget);
    // Sequential: the lane runs one request at a time anyway, and a config or quota error stops the rest.
    for (const { p, i } of todo) {
      try {
        const route = await client.walkingRoute(p.origin, p.destination, {
          ...call,
          stepsInfo: false,
          ...(p.destUid ? { destinationUid: p.destUid } : {}),
        });
        if (!route || !(route.distanceM > 0)) {
          reasons[i] += '；步行路线无结果';
          continue;
        }
        const s = straight(p.origin, p.destination);
        out[i] = {
          distanceM: route.distanceM,
          durationS: route.durationS,
          source: 'directionlite',
          straightM: s,
          rho: s > 0 ? route.distanceM / s : null,
          via: route.via,
          ...(reasons[i] ? { fallbackReason: reasons[i] } : {}),
        };
      } catch (err) {
        if (err instanceof BaiduInputError || opts.signal?.aborted) throw err;
        reasons[i] += `；步行路线失败：${reasonOf(err)}`;
        if (!(err instanceof BaiduError)) continue;
        noteError(err);
        if (err instanceof BaiduConfigError || err instanceof BaiduQuotaError) break;
      }
    }
  }

  // 3–4. estimates
  const results = pairs.map((p, i): WalkDistance => {
    const measured = out[i];
    if (measured) return measured;
    const rho = opts.rhoLocal?.(p.origin, p.destination);
    const est =
      typeof rho === 'number' && Number.isFinite(rho) && rho > 0
        ? estimateWalk(p.origin, p.destination, rho, speed)
        : coarseWalk(p.origin, p.destination, opts.coarseFactor ?? COARSE_DETOUR, speed);
    const reason = reasons[i]?.replace(/^；/, '');
    return reason ? { ...est, fallbackReason: reason } : est;
  });
  const counts: Record<DistanceSource, number> = { routematrix: 0, directionlite: 0, estimate: 0, coarse: 0 };
  for (const r of results) counts[r.source]++;
  return { results, errors, counts };
}
