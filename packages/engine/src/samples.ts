/**
 * Walking-time samples from the centre: routematrix answers and walked-route vertices in the wire
 * format of data/samples/zj-a.json (0.1 m, 0.1 s, ρ to 3 decimals). The field is always rebuilt from
 * these rounded samples, so a stored result reproduces its own field.
 */
import type { RouteCell, WalkingRoute } from '@zoudedao/baidu';
import {
  bearingDeg,
  pathPrefixSamples,
  pathSamples,
  type DirectionStep,
  type LocalFrame,
  type PathPoint,
  type TimedPoint,
  type TimeSample,
  type WalkPath,
  type XY,
} from '@zoudedao/core';

import { PATH_SAMPLE_SPACING_M, SAMPLE_DEDUPE_M, WALK_SPEED } from './constants.js';
import { r1, r3 } from './round.js';

/** Samples with a first-wins dedupe radius (a routematrix answer beats a later path vertex). */
export class SampleSet {
  readonly list: TimeSample[] = [];
  private readonly cells = new Map<string, TimeSample[]>();

  constructor(private readonly minGap = SAMPLE_DEDUPE_M) {}

  get size(): number {
    return this.list.length;
  }

  add(s: TimeSample): boolean {
    const g = this.minGap;
    const cx = Math.floor(s.xy[0] / g);
    const cy = Math.floor(s.xy[1] / g);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const q of this.cells.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (Math.hypot(q.xy[0] - s.xy[0], q.xy[1] - s.xy[1]) < g) return false;
        }
      }
    }
    const key = `${cx},${cy}`;
    this.cells.set(key, [...(this.cells.get(key) ?? []), s]);
    this.list.push(s);
    return true;
  }

  /** Points for barrier detection: near-centre samples carry no usable detour. */
  timed(minStraight = 30): TimedPoint[] {
    return this.list.filter((s) => s.straight_m >= minStraight);
  }

  /** Current value for a partial event (a copy, so later additions do not leak into it). */
  snapshot(): TimeSample[] {
    return this.list.slice();
  }
}

/** One routematrix answer from the centre to `xy`; null when Baidu had no route (0) or the call failed. */
export function matrixSample(xy: XY, cell: RouteCell | undefined, set: string): TimeSample | null {
  if (!cell || cell.status !== 'ok') return null;
  const route = cell.distanceM ?? 0;
  const dur = cell.durationS ?? 0;
  const straight = Math.hypot(xy[0], xy[1]);
  if (!(route > 0) || !(dur > 0) || !(straight > 0)) return null;
  return {
    xy: [r1(xy[0]), r1(xy[1])],
    straight_m: r1(straight),
    route_m: route,
    dur_s: dur,
    rho: r3((dur * WALK_SPEED) / straight),
    bearing_deg: r1(bearingDeg(xy[0], xy[1])),
    src: 'routematrix',
    set,
  };
}

/** A walked route in the zj-a wire form, plus the fields that say where it went. */
export interface LiveWalkPath extends WalkPath {
  label: string;
  dest_xy: XY;
  route_m: number;
  /** directionlite's own duration (3–7 % slower than route_m / 1.17). */
  dur_s: number;
  /** route_m / 1.17: the routematrix-consistent duration. */
  dur_route_s: number;
  instructions: string[];
}

export const pathLabel = (bearing: number) => `b${String(Math.round(bearing) % 360).padStart(3, '0')}`;

/** directionlite steps with their paths projected to the local frame. */
export function projectSteps(route: WalkingRoute, frame: LocalFrame): DirectionStep[] {
  return route.steps.map((st) => ({
    distance: st.distanceM,
    duration: st.durationS,
    path: st.path.map(([lng, lat]) => frame.toXY(lng, lat)),
  }));
}

/**
 * A walked route → its WalkPath (every vertex, [x, y, cumulative directionlite s, cumulative m]) and
 * routematrix-consistent samples every ~20 m of route (dur_s = route_m / 1.17; prefixes of a shortest
 * path are shortest paths).
 */
export function walkedRoute(
  route: WalkingRoute,
  frame: LocalFrame,
  probe: { bearing_deg: number; xy: XY },
  index: number,
  maxStraight_m: number,
): { path: LiveWalkPath; samples: TimeSample[] } {
  const steps = projectSteps(route, frame);
  const points: PathPoint[] = pathPrefixSamples(steps);
  const label = pathLabel(probe.bearing_deg);
  const path: LiveWalkPath = {
    label,
    bearing_deg: r1(probe.bearing_deg),
    dest_xy: [r1(probe.xy[0]), r1(probe.xy[1])],
    route_m: route.distanceM,
    dur_s: route.durationS,
    dur_route_s: r1(route.distanceM / WALK_SPEED),
    instructions: route.steps.map((s) => s.instruction).filter(Boolean),
    pts: points.map((p) => [r1(p.xy[0]), r1(p.xy[1]), r1(p.t_s), r1(p.route_m)]),
  };
  const thin = pathPrefixSamples(steps, { spacing_m: PATH_SAMPLE_SPACING_M });
  const samples = pathSamples(thin, {
    speed: WALK_SPEED,
    set: `dl_${label}`,
    path: index,
    maxStraight_m,
  }).map((s): TimeSample => ({
    ...s,
    xy: [r1(s.xy[0]), r1(s.xy[1])],
    straight_m: r1(s.straight_m),
    route_m: r1(s.route_m),
    dur_s: r1(s.dur_s),
    rho: r3(s.rho),
    bearing_deg: r1(s.bearing_deg),
    ...(s.dur_dl_s !== undefined ? { dur_dl_s: r1(s.dur_dl_s) } : {}),
  }));
  return { path, samples };
}
