/**
 * The common competitor method ("16 方位射线法"): walking times from the centre to 16 bearings × 3
 * radii; along each ray the 15-minute reach is where the linearly interpolated time first reaches 900 s;
 * the 16 reach points make the region's polygon. The points are the engine's seed pattern (347 / 705 /
 * 1,053 m), so the comparison with seed48 is the same 48 routes read by two estimators.
 */
import { localFrame, polarSeed, type XY } from '@zoudedao/core';

import type { EvalArea } from './areas.js';
import {
  ARTEFACT_VERSION,
  areaInfo,
  type MethodArtefact,
  type StarRay,
  type StarRayPoint,
} from './artefacts.js';
import { measureFromCenter, type MatrixClient } from './measure.js';
import { LEVEL_S, R15_M, STAR16, STAR_BEARINGS, STAR_RINGS } from './methods.js';

export interface StarPoint {
  bearing_deg: number;
  r_m: number;
  xy: XY;
}

/** The 48 points, bearing-major (the engine's polarSeed with its default pattern). */
export function starPoints(): StarPoint[] {
  return polarSeed({ radius: R15_M, bearings: STAR_BEARINGS, rings: STAR_RINGS }).map((p) => ({
    bearing_deg: p.bearing_deg,
    r_m: p.r_m,
    xy: p.xy,
  }));
}

/**
 * Where the time along a ray first reaches `level`: the profile starts at (0 m, 0 s), measured points
 * follow by distance, a point without a route counts as unreachable (the reach stops at the point
 * before it) and a failed point is skipped. If even the last point is faster than `level`, the last
 * segment is extended, capped at `maxR` (nothing beyond v·T is reachable). null without any usable point.
 */
export function rayReach(
  points: readonly Pick<StarRayPoint, 'r_m' | 'status' | 'dur_s'>[],
  level = LEVEL_S,
  maxR = R15_M,
): number | null {
  const prof: [number, number][] = [[0, 0]];
  for (const p of [...points].sort((a, b) => a.r_m - b.r_m)) {
    if (p.status === 'ok' && p.dur_s !== null) prof.push([p.r_m, p.dur_s]);
    else if (p.status === 'no_route') prof.push([p.r_m, Infinity]);
  }
  if (prof.length < 2) return null;
  for (let k = 1; k < prof.length; k++) {
    const [r0, t0] = prof[k - 1]!;
    const [r1, t1] = prof[k]!;
    if (t1 < level) continue;
    if (!Number.isFinite(t1)) return r0;
    return r0 + ((level - t0) / (t1 - t0)) * (r1 - r0);
  }
  const [ra, ta] = prof[prof.length - 2]!;
  const [rb, tb] = prof[prof.length - 1]!;
  const slope = (tb - ta) / (rb - ra);
  return Math.min(maxR, slope > 0 ? rb + (level - tb) / slope : maxR);
}

/** The reach points as one closed counter-clockwise ring (bearings without a reach are skipped). */
export function starPolygon(rays: readonly StarRay[]): XY[] {
  const pts: XY[] = rays
    .filter((r) => r.reach_m !== null)
    .sort((a, b) => a.bearing_deg - b.bearing_deg)
    .map((r) => {
      const rad = (r.bearing_deg * Math.PI) / 180;
      return [r.reach_m! * Math.sin(rad), r.reach_m! * Math.cos(rad)];
    });
  // bearings run clockwise; the core convention is counter-clockwise outer rings
  pts.reverse();
  if (pts.length) pts.push([pts[0]![0], pts[0]![1]]);
  return pts;
}

/** Rays from the 48 measured cells (in starPoints order). */
export function starRays(
  points: readonly StarPoint[],
  cells: readonly Pick<StarRayPoint, 'status' | 'route_m' | 'dur_s'>[],
): StarRay[] {
  const byBearing = new Map<number, StarRayPoint[]>();
  points.forEach((p, k) => {
    const c = cells[k]!;
    const list = byBearing.get(p.bearing_deg) ?? [];
    list.push({ r_m: p.r_m, xy: p.xy, status: c.status, route_m: c.route_m, dur_s: c.dur_s });
    byBearing.set(p.bearing_deg, list);
  });
  return [...byBearing.entries()]
    .sort(([a], [b]) => a - b)
    .map(([bearing_deg, pts]) => ({ bearing_deg, points: pts, reach_m: rayReach(pts) }));
}

export interface Star16Run {
  artefact: MethodArtefact | null;
  stopped: Error | null;
}

/** Measures the 48 points and builds the method's artefact (none when a fatal error stopped it). */
export async function runStar16(args: {
  client: MatrixClient;
  area: EvalArea;
  now: () => Date;
  signal?: AbortSignal;
}): Promise<Star16Run> {
  const { area } = args;
  const frame = localFrame(area.center_bd09[0], area.center_bd09[1]);
  const points = starPoints();
  const t0 = performance.now();
  const m = await measureFromCenter(
    args.client,
    area.center_bd09,
    points.map((p) => frame.toLngLat(p.xy[0], p.xy[1])),
    args.signal ? { signal: args.signal } : {},
  );
  if (m.stopped) return { artefact: null, stopped: m.stopped };
  const cells = m.cells.map((c) => c ?? { status: 'failed' as const, route_m: null, dur_s: null });
  const rays = starRays(points, cells);
  const ring = starPolygon(rays);
  const artefact: MethodArtefact = {
    version: ARTEFACT_VERSION,
    kind: 'method',
    id: STAR16.id,
    method: 'star16',
    label: STAR16.label,
    area: areaInfo(area),
    created: args.now().toISOString(),
    params: {
      bearings: STAR_BEARINGS,
      radii_m: STAR_RINGS.map((f) => Math.round(f * R15_M * 10) / 10),
      level_s: LEVEL_S,
      reach: '沿射线对耗时线性插值，取首次达到 900 秒处；无路线的点视为不可达，失败的点跳过',
    },
    cost: {
      // the method's own cost is its 48 points; a transient failure asked again is noted separately
      routes: points.length,
      routes_billed: m.stats.routes_billed,
      requests: m.stats.requests,
      calls: m.stats.calls,
      walks: 0,
      walks_billed: 0,
      wall_ms: Math.round(performance.now() - t0),
      retried: m.stats.retried,
    },
    region: { rings: ring.length >= 4 ? [ring] : [] },
    field: null,
    samples: points.flatMap((p, k): [number, number, number][] => {
      const c = cells[k]!;
      return c.status === 'failed' ? [] : [[p.xy[0], p.xy[1], c.dur_s ?? -1]];
    }),
    star16: { rays },
  };
  return { artefact, stopped: null };
}
