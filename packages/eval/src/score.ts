/**
 * `score`: metrics recomputed from the artefacts alone (no network, no cache): reference.json gives the
 * truth points and the reference field; every methods/*.json gives a region and, for the engine, a time
 * field; the straight-line circle needs nothing. Writes results.json, results.md and the two figures.
 */
import { gridFromField, levelContours, sampleGrid, type Grid, type XY } from '@zoudedao/core';

import type { EvalArea } from './areas.js';
import {
  areaPaths,
  readMethods,
  readReference,
  writeJson,
  writeText,
  type AreaInfo,
  type EngineSummary,
  type MethodArtefact,
  type MethodCost,
  type ReferenceArtefact,
  type ReferenceCounts,
} from './artefacts.js';
import { EVAL_GRID, insideRings, maskFromField, maskOf, sameGrid, type Mask } from './lattice.js';
import { CIRCLE, LEVEL_S, methodOrder, R15_M, SPEED_MPS, specOf, type MethodKind } from './methods.js';
import {
  POINT_DEFAULTS,
  pointMetrics,
  regionMetrics,
  type PointEstimator,
  type PointMetrics,
  type RegionMetrics,
  type TruthPoint,
} from './metrics.js';
import { referenceField } from './reference.js';
import { markdownReport } from './report.js';
import { accuracyChart, overlayMap } from './svg.js';

export const RESULTS_VERSION = 1;

/** Nothing to score yet: no reference grid, or points of it still unmeasured. */
export class ScoreNotReady extends Error {
  override name = 'ScoreNotReady';
}

export interface MethodResult {
  id: string;
  kind: MethodKind;
  label: string;
  description: string;
  cost: MethodCost;
  region: RegionMetrics;
  points: PointMetrics;
  engine?: EngineSummary;
}

export interface ReferenceSummary {
  spacing_m: number;
  radius_m: number;
  counts: ReferenceCounts;
  totals: ReferenceArtefact['totals'];
  sessions: number;
  created: string;
  updated: string;
  /** Nodes of the reference field faster than 900 s, km². */
  area_km2: number;
  /** The same region as smoothed contour rings (what a map shows), km². */
  contour_area_km2: number;
  circle_area_km2: number;
  /** Measured points (route or no route) within 1,053 m; of those, faster than 900 s. */
  domain_points: number;
  reachable_points: number;
  /** Leave-one-out error of the reference field on its own samples. */
  loo: { n: number; mae_s: number; p90_s: number } | null;
  barrier_segments: number;
}

export interface Results {
  version: number;
  generated: string;
  area: AreaInfo;
  settings: {
    level_s: number;
    speed_mps: number;
    circle_r_m: number;
    domain_m: number;
    band_s: number;
    used_radius_m: number;
    grid: typeof EVAL_GRID;
  };
  reference: ReferenceSummary;
  methods: MethodResult[];
}

/** Rounds every non-integer number to 4 decimals (JSON stays readable and stable). */
function round4<T>(v: T): T {
  if (typeof v === 'number') return (Number.isInteger(v) ? v : Math.round(v * 1e4) / 1e4) as T;
  if (Array.isArray(v)) return v.map(round4) as T;
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round4(x)])) as T;
  }
  return v;
}

const ZERO_COST: MethodCost = {
  routes: 0,
  routes_billed: 0,
  requests: 0,
  calls: 0,
  walks: 0,
  walks_billed: 0,
  wall_ms: 0,
};

/** What a method says, as a region mask on the evaluation grid and a point estimator. */
export function estimatorOf(m: MethodArtefact | null): { mask: Mask; est: PointEstimator } {
  if (!m) {
    // the straight-line circle: t̂ = r / v
    const time = (xy: XY) => Math.hypot(xy[0], xy[1]) / SPEED_MPS;
    return {
      mask: maskOf(EVAL_GRID, (x, y) => Math.hypot(x, y) / SPEED_MPS < LEVEL_S),
      est: { inside: (xy) => time(xy) < LEVEL_S, time, used: [] },
    };
  }
  const used: XY[] = m.samples.map((s) => [s[0], s[1]]);
  if (m.field) {
    const grid = gridFromField(m.field);
    const time = (xy: XY) => sampleGrid(grid, xy[0], xy[1]);
    const mask = sameGrid(grid, EVAL_GRID)
      ? maskFromField(grid, LEVEL_S)
      : maskOf(EVAL_GRID, (x, y) => sampleGrid(grid, x, y) < LEVEL_S);
    return { mask, est: { inside: (xy) => time(xy) < LEVEL_S, time, used } };
  }
  const inside = insideRings(m.region.rings);
  return { mask: maskOf(EVAL_GRID, inside), est: { inside: (xy) => inside(xy[0], xy[1]), used } };
}

export function truthPoints(ref: ReferenceArtefact): TruthPoint[] {
  return ref.points.flatMap((p): TruthPoint[] => {
    if (p.status === 'ok') return [{ xy: p.xy, t_s: p.dur_s }];
    if (p.status === 'no_route') return [{ xy: p.xy, t_s: null }];
    return [];
  });
}

export interface ScoreOutput {
  results: Results;
  /** Reference field lattice (for figures and tests). */
  referenceGrid: Grid;
  files: string[];
}

/** Scores every method artefact of the area against its reference; writes results and figures. */
export function scoreArea(args: { root: string; area: EvalArea; now: () => Date }): ScoreOutput {
  const paths = areaPaths(args.root, args.area.id);
  const ref = readReference(paths);
  if (!ref)
    throw new ScoreNotReady(`没有参考网格 ${paths.reference}：先运行 run ${args.area.id} --steps reference`);
  if (ref.counts.pending > 0) {
    throw new ScoreNotReady(
      `参考网格还有 ${ref.counts.pending} 点未测：先运行 run ${args.area.id} --steps reference`,
    );
  }
  const rf = referenceField(ref);
  const refGrid = rf.iso.grid;
  const refMask = maskFromField(refGrid, LEVEL_S);
  const truth = truthPoints(ref);

  const artefacts = readMethods(paths);
  const ids = ['circle', ...artefacts.keys()].sort(
    (a, b) => methodOrder(a) - methodOrder(b) || (a < b ? -1 : 1),
  );
  const methods: MethodResult[] = ids.map((id) => {
    const art = id === 'circle' ? null : artefacts.get(id)!;
    const spec = specOf(id) ?? (id === 'circle' ? CIRCLE : null);
    const { mask, est } = estimatorOf(art);
    const out: MethodResult = {
      id,
      kind: art?.method ?? 'circle',
      label: art?.label ?? CIRCLE.label,
      description: spec?.description ?? '',
      cost: art?.cost ?? ZERO_COST,
      region: regionMetrics(mask, refMask, EVAL_GRID),
      points: pointMetrics(truth, est),
    };
    if (art?.engine) out.engine = art.engine;
    return out;
  });

  const domain = truth.filter((p) => Math.hypot(p.xy[0], p.xy[1]) <= POINT_DEFAULTS.domain_m);
  const contour = levelContours(refGrid, LEVEL_S);
  const s = rf.iso.stats;
  const cellKm2 = (EVAL_GRID.cell * EVAL_GRID.cell) / 1e6;
  let refNodes = 0;
  for (const v of refMask) refNodes += v;
  const results: Results = round4({
    version: RESULTS_VERSION,
    generated: args.now().toISOString(),
    area: ref.area,
    settings: {
      level_s: LEVEL_S,
      speed_mps: SPEED_MPS,
      circle_r_m: R15_M,
      domain_m: POINT_DEFAULTS.domain_m,
      band_s: POINT_DEFAULTS.band_s,
      used_radius_m: POINT_DEFAULTS.usedRadius_m,
      grid: EVAL_GRID,
    },
    reference: {
      spacing_m: ref.lattice.spacing_m,
      radius_m: ref.lattice.radius_m,
      counts: ref.counts,
      totals: ref.totals,
      sessions: ref.sessions.length,
      created: ref.created,
      updated: ref.updated,
      area_km2: refNodes * cellKm2,
      contour_area_km2: contour.area_m2 / 1e6,
      circle_area_km2: (Math.PI * R15_M * R15_M) / 1e6,
      domain_points: domain.length,
      reachable_points: domain.filter((p) => p.t_s !== null && p.t_s < LEVEL_S).length,
      loo:
        s.loo_n !== undefined && s.loo_mae_s !== undefined && s.loo_p90_abs_err_s !== undefined
          ? { n: s.loo_n, mae_s: s.loo_mae_s, p90_s: s.loo_p90_abs_err_s }
          : null,
      barrier_segments: rf.barriers.segments.length,
    },
    methods,
  });

  writeJson(paths.results, results);
  const overlayRings = {
    reference: contour.rings,
    methods: new Map([...artefacts].map(([id, a]) => [id, a.region.rings])),
  };
  writeText(paths.chart, accuracyChart(results));
  writeText(paths.overlay, overlayMap(results, overlayRings));
  writeText(paths.resultsMd, markdownReport(results));
  return {
    results,
    referenceGrid: refGrid,
    files: [paths.results, paths.resultsMd, paths.chart, paths.overlay],
  };
}
