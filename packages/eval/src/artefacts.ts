/**
 * Artefacts of one evaluated area, under research/eval/<area-id>/:
 *
 *   reference.json          the dense reference grid (every measured point, with provenance)
 *   methods/<method>.json   what each measured method produced (region, field, samples, cost)
 *   results.json / .md      metrics recomputed from the files above (`score`, no network)
 *   accuracy-quota.svg      IoU and time error against routes
 *   overlay.svg             reference region vs star16 vs engine@400 vs circle
 *
 * Writes go to a temporary file first and are renamed into place, so an interrupted run never leaves a
 * half-written artefact behind.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LngLat, TimeField, XY } from '@zoudedao/core';

import type { EvalArea } from './areas.js';
import type { CellStatus } from './measure.js';
import type { MethodKind } from './methods.js';

export const ARTEFACT_VERSION = 1;

export interface AreaInfo {
  id: string;
  name: string;
  label: string;
  center_bd09: LngLat;
  /** How XY relates to BD-09 (the engine's localFrame). */
  frame_formula: string;
}

export function areaInfo(area: EvalArea): AreaInfo {
  const [lng, lat] = area.center_bd09;
  return {
    id: area.id,
    name: area.name,
    label: area.label,
    center_bd09: [lng, lat],
    frame_formula: `x = (lng - ${lng}) * 111320 * cos(${lat} deg), y = (lat - ${lat}) * 110574, lng/lat in BD-09`,
  };
}

export type PointStatus = CellStatus | 'pending';

export interface ReferencePoint {
  ij: [number, number];
  xy: XY;
  bd09: LngLat;
  status: PointStatus;
  route_m: number | null;
  dur_s: number | null;
}

/** One `run` of the reference step. */
export interface ReferenceSession {
  started: string;
  finished: string;
  calls: number;
  requests: number;
  routes: number;
  routes_billed: number;
  routes_cached: number;
  retried: number;
  failed: number;
  /** Points a stop left unasked (still pending). */
  not_asked: number;
  /** Why the session ended early (quota, ceiling, key), or null. */
  stopped: string | null;
}

export interface ReferenceCounts {
  points: number;
  ok: number;
  no_route: number;
  failed: number;
  pending: number;
}

export interface ReferenceArtefact {
  version: number;
  kind: 'reference';
  area: AreaInfo;
  lattice: { spacing_m: number; radius_m: number; points: number };
  speed_mps: number;
  source: string;
  created: string;
  updated: string;
  counts: ReferenceCounts;
  /** Over all sessions. */
  totals: { calls: number; requests: number; routes: number; routes_billed: number };
  sessions: ReferenceSession[];
  points: ReferencePoint[];
}

export function referenceCounts(points: readonly ReferencePoint[]): ReferenceCounts {
  const c: ReferenceCounts = { points: points.length, ok: 0, no_route: 0, failed: 0, pending: 0 };
  for (const p of points) c[p.status]++;
  return c;
}

export interface MethodCost {
  /** Routematrix routes asked for, cached or not: the method's own cost. */
  routes: number;
  /** Of those, billed by Baidu in the run that produced the artefact (the rest came from the cache). */
  routes_billed: number;
  /** HTTP routematrix requests made in that run. */
  requests: number;
  /** Routematrix calls (1 × ≤ 50 each). */
  calls: number;
  /** directionlite walks asked for / billed. */
  walks: number;
  walks_billed: number;
  wall_ms: number;
  /** Cells asked again after a transient failure (not part of the method's own cost). */
  retried?: number;
}

export interface StarRayPoint {
  r_m: number;
  xy: XY;
  status: CellStatus;
  route_m: number | null;
  dur_s: number | null;
}

export interface StarRay {
  bearing_deg: number;
  points: StarRayPoint[];
  /** Straight distance at which the ray's interpolated time reaches 900 s; null without usable points. */
  reach_m: number | null;
}

export interface EngineSummary {
  refine_rounds: number;
  refine_converged: boolean;
  refine_last_change: number | null;
  barrier_segments: number;
  n_samples: number;
  n_samples_by_src: Record<string, number>;
  loo_mae_s: number | null;
  loo_p90_abs_err_s: number | null;
  /** The engine's own 15-minute area (smoothed contour). */
  area_iso15_km2: number;
  quota_requested_by_step: Record<string, number> | null;
  warnings: string[];
}

export interface MethodArtefact {
  version: number;
  kind: 'method';
  id: string;
  method: MethodKind;
  label: string;
  area: AreaInfo;
  created: string;
  params: Record<string, unknown>;
  cost: MethodCost;
  /** The 15-minute region as closed rings (even-odd: outer rings and their holes). */
  region: { rings: XY[][] };
  /** Walking-time field (engine); null for methods that only draw a region. */
  field: TimeField | null;
  /** Positions the method measured itself: routematrix points and walked-route vertices, [x, y, dur_s]. */
  samples: [number, number, number][];
  star16?: { rays: StarRay[] };
  engine?: EngineSummary;
}

// ---------------------------------------------------------------------------------------- paths

export interface AreaPaths {
  dir: string;
  reference: string;
  methods: string;
  results: string;
  resultsMd: string;
  chart: string;
  overlay: string;
}

export function areaPaths(root: string, areaId: string): AreaPaths {
  const dir = join(root, areaId);
  return {
    dir,
    reference: join(dir, 'reference.json'),
    methods: join(dir, 'methods'),
    results: join(dir, 'results.json'),
    resultsMd: join(dir, 'results.md'),
    chart: join(dir, 'accuracy-quota.svg'),
    overlay: join(dir, 'overlay.svg'),
  };
}

export const methodFile = (paths: AreaPaths, id: string) => join(paths.methods, `${id}.json`);

// ------------------------------------------------------------------------------------------ I/O

/**
 * Pretty JSON that stays readable for large arrays: one space of indent, and arrays holding only
 * numbers, strings or null on one line (coordinates, field values).
 */
export function stringify(value: unknown): string {
  const text = JSON.stringify(value, null, 1);
  // a scalar: number, null, true/false or a JSON string (escapes included); arrays of scalars go on one line
  const scalar = String.raw`-?[\d.eE+-]+|null|true|false|"(?:[^"\\\n]|\\.)*"`;
  const flat = new RegExp(String.raw`\[\s*((?:${scalar})(?:,\s*(?:${scalar}))*)\s*\]`, 'g');
  const item = new RegExp(scalar, 'g');
  // rebuild from the matched elements, so text inside strings is never touched
  return text.replace(flat, (_m, inner: string) => `[${(inner.match(item) ?? []).join(',')}]`);
}

export function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

export function writeJson(path: string, value: unknown): void {
  writeText(path, `${stringify(value)}\n`);
}

export function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function readReference(paths: AreaPaths): ReferenceArtefact | null {
  const ref = readJson<ReferenceArtefact>(paths.reference);
  if (ref && (ref.kind !== 'reference' || ref.version !== ARTEFACT_VERSION)) {
    throw new Error(`${paths.reference} 不是第 ${ARTEFACT_VERSION} 版参考网格文件`);
  }
  return ref;
}

export function readMethod(paths: AreaPaths, id: string): MethodArtefact | null {
  return readJson<MethodArtefact>(methodFile(paths, id));
}

/** Every method artefact of the area, by id. */
export function readMethods(paths: AreaPaths): Map<string, MethodArtefact> {
  const out = new Map<string, MethodArtefact>();
  if (!existsSync(paths.methods)) return out;
  for (const f of readdirSync(paths.methods).sort()) {
    if (!f.endsWith('.json')) continue;
    const m = readJson<MethodArtefact>(join(paths.methods, f));
    if (m?.kind === 'method' && m.version === ARTEFACT_VERSION) out.set(m.id, m);
  }
  return out;
}
