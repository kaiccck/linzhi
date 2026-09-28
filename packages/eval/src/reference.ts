/**
 * The dense reference: walking routes from the centre to every lattice point (default 100 m) inside
 * the 1,600 m disc (技术设计文档 §5.9), frozen as research/eval/<area>/reference.json.
 *
 * Resumable: points already measured in the artefact are never asked again; the artefact is saved after
 * every call, so an interrupted run (network, quota, the evaluation's ceiling) loses nothing.
 */
import {
  buildIsochrone,
  detectBarriers,
  localFrame,
  visibilityFilter,
  bearingDeg,
  type Barriers,
  type IsochroneResult,
  type TimeSample,
} from '@zoudedao/core';

import type { EvalArea } from './areas.js';
import {
  ARTEFACT_VERSION,
  areaInfo,
  areaPaths,
  readReference,
  referenceCounts,
  writeJson,
  type ReferenceArtefact,
  type ReferencePoint,
  type ReferenceSession,
} from './artefacts.js';
import { referenceLattice, EVAL_GRID } from './lattice.js';
import { measureFromCenter, type MatrixClient } from './measure.js';
import { SPEED_MPS } from './methods.js';

export const REF_SPACING_M = 100;
export const REF_RADIUS_M = 1600;

export interface ReferenceOptions {
  spacing_m?: number;
  radius_m?: number;
}

const r7 = (v: number) => Math.round(v * 1e7) / 1e7;

/** A fresh artefact: every lattice point pending. */
export function newReference(area: EvalArea, opts: ReferenceOptions, now: Date): ReferenceArtefact {
  const spacing = opts.spacing_m ?? REF_SPACING_M;
  const radius = opts.radius_m ?? REF_RADIUS_M;
  const frame = localFrame(area.center_bd09[0], area.center_bd09[1]);
  const points: ReferencePoint[] = referenceLattice(spacing, radius).map((p) => {
    const [lng, lat] = frame.toLngLat(p.xy[0], p.xy[1]);
    return { ij: p.ij, xy: p.xy, bd09: [r7(lng), r7(lat)], status: 'pending', route_m: null, dur_s: null };
  });
  const stamp = now.toISOString();
  return {
    version: ARTEFACT_VERSION,
    kind: 'reference',
    area: areaInfo(area),
    lattice: { spacing_m: spacing, radius_m: radius, points: points.length },
    speed_mps: SPEED_MPS,
    source:
      'Baidu Maps routematrix/v2/walking (百度地图批量算路·步行)，从中心出发 1 × ≤ 50 条/请求；失败的格子同一次运行内重试 1 次；无路线记为 no_route',
    created: stamp,
    updated: stamp,
    counts: referenceCounts(points),
    totals: { calls: 0, requests: 0, routes: 0, routes_billed: 0 },
    sessions: [],
    points,
  };
}

/** Points still to measure (never measured, or failed last time). */
export function pendingPoints(ref: ReferenceArtefact): ReferencePoint[] {
  return ref.points.filter((p) => p.status === 'pending' || p.status === 'failed');
}

/** The saved artefact of the area, or a fresh one; refuses one measured on a different lattice. */
export function loadOrCreateReference(
  root: string,
  area: EvalArea,
  opts: ReferenceOptions,
  now: Date,
): ReferenceArtefact {
  const existing = readReference(areaPaths(root, area.id));
  if (!existing) return newReference(area, opts, now);
  const spacing = opts.spacing_m ?? existing.lattice.spacing_m;
  const radius = opts.radius_m ?? existing.lattice.radius_m;
  const [lng, lat] = existing.area.center_bd09;
  if (
    spacing !== existing.lattice.spacing_m ||
    radius !== existing.lattice.radius_m ||
    lng !== area.center_bd09[0] ||
    lat !== area.center_bd09[1]
  ) {
    throw new Error(
      `已有的参考网格（间距 ${existing.lattice.spacing_m} m、半径 ${existing.lattice.radius_m} m、中心 ${lng}, ${lat}）与本次参数不同；` +
        '请换一个 --dir，或删除 reference.json 后重测',
    );
  }
  return existing;
}

export interface ReferenceRun {
  artefact: ReferenceArtefact;
  session: ReferenceSession;
  stopped: Error | null;
}

/** Measures the pending points of the area's reference grid and saves after every call. */
export async function runReference(args: {
  client: MatrixClient;
  root: string;
  area: EvalArea;
  opts?: ReferenceOptions;
  now: () => Date;
  signal?: AbortSignal;
  log?: (line: string) => void;
}): Promise<ReferenceRun> {
  const { client, root, area, now } = args;
  const paths = areaPaths(root, area.id);
  const ref = loadOrCreateReference(root, area, args.opts ?? {}, now());
  const todo = pendingPoints(ref);
  const started = now().toISOString();
  const save = () => {
    ref.counts = referenceCounts(ref.points);
    ref.updated = now().toISOString();
    writeJson(paths.reference, ref);
  };
  const frame = localFrame(area.center_bd09[0], area.center_bd09[1]);
  args.log?.(
    `参考网格：共 ${ref.points.length} 点，待测 ${todo.length} 点（${Math.ceil(todo.length / 50)} 次批量算路）`,
  );
  const result = await measureFromCenter(
    client,
    area.center_bd09,
    // full-precision BD-09 from the frame, as every other step sends: identical points hit the cache
    todo.map((p) => frame.toLngLat(p.xy[0], p.xy[1])),
    {
      ...(args.signal ? { signal: args.signal } : {}),
      onChunk: (indices, cells) => {
        indices.forEach((i, k) => Object.assign(todo[i]!, cells[k]!));
        save();
      },
    },
  );
  const s = result.stats;
  const session: ReferenceSession = {
    started,
    finished: now().toISOString(),
    calls: s.calls,
    requests: s.requests,
    routes: s.routes,
    routes_billed: s.routes_billed,
    routes_cached: s.routes_cached,
    retried: s.retried,
    failed: s.failed,
    not_asked: s.not_asked,
    stopped: result.stopped?.message ?? null,
  };
  // cells a stop never asked keep their status (pending, or failed from an earlier session): next run asks
  // them; a run with nothing to ask leaves the artefact untouched
  if (todo.length || !ref.sessions.length) {
    ref.sessions.push(session);
    ref.totals = {
      calls: ref.totals.calls + s.calls,
      requests: ref.totals.requests + s.requests,
      routes: ref.totals.routes + s.routes,
      routes_billed: ref.totals.routes_billed + s.routes_billed,
    };
    save();
  }
  return { artefact: ref, session, stopped: result.stopped };
}

/** Reference points as walking-time samples (src routematrix), the input of the reference field. */
export function referenceSamples(ref: ReferenceArtefact): TimeSample[] {
  return ref.points.flatMap((p): TimeSample[] => {
    if (p.status !== 'ok' || p.dur_s === null || p.route_m === null) return [];
    const straight = Math.hypot(p.xy[0], p.xy[1]);
    return [
      {
        xy: [p.xy[0], p.xy[1]],
        straight_m: straight,
        route_m: p.route_m,
        dur_s: p.dur_s,
        rho: (p.dur_s * SPEED_MPS) / straight,
        bearing_deg: bearingDeg(p.xy[0], p.xy[1]),
        src: 'routematrix',
        set: 'reference',
      },
    ];
  });
}

export interface ReferenceField {
  iso: IsochroneResult;
  barriers: Barriers;
  samples: TimeSample[];
}

/**
 * The reference's own field: the same buildIsochrone machinery as the engine's final field (20 m
 * lattice over ±1,600 m, barrier-aware IDW of ρ), fed with the dense samples. Leave-one-out tells how
 * well the reference interpolates itself.
 */
export function referenceField(ref: ReferenceArtefact): ReferenceField {
  const samples = referenceSamples(ref);
  const barriers = detectBarriers(samples.filter((s) => s.straight_m >= 30));
  const iso = buildIsochrone(samples, {
    extent_m: -EVAL_GRID.x0,
    cell_m: EVAL_GRID.cell,
    loo: true,
    ...(barriers.segments.length ? { field: { visible: visibilityFilter(barriers) } } : {}),
  });
  return { iso, barriers, samples };
}
