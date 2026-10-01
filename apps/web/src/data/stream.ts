/**
 * A live check as it streams (POST /api/analyze `partial` events, docs/api.md): what the map can draw
 * before the result lands. The engine sends the samples it has measured and the coarse field it built
 * from them after the seed, the paths and every refinement round; this turns the merged partial into
 * something the map paints — the new centre's frame, the reach so far, and the samples by stage, the
 * newest batch marked as the one just measured.
 */
import type { AnalysisResult, IsoLevel, Poi, TimeField, TimeSample, WalkPath, XY } from '@zoudedao/core';
import { frameFromMeta, type Frame } from '../geo/frame.js';
import type { StageEvent } from './api.js';

/** How a sample was measured: the seed rings, a walked path, or a refinement round. */
export type SampleStage = 'seed' | 'path' | 'refine';

export function sampleStage(s: Pick<TimeSample, 'src' | 'set'>): SampleStage {
  if (s.src === 'directionlite_path' || s.set?.startsWith('dl_')) return 'path';
  if (s.set?.startsWith('refine')) return 'refine';
  return 'seed';
}

/** The engine's stages in order (docs/api.md), with the words the stage ladder shows. */
export const STAGES = [
  { id: 'locate', word: '定位' },
  { id: 'facilities', word: '设施' },
  { id: 'seed', word: '粗采样' },
  { id: 'paths', word: '路径' },
  { id: 'refine', word: '加密' },
  { id: 'reach', word: '等时圈' },
  { id: 'coverage', word: '覆盖' },
  { id: 'report', word: '汇总' },
] as const;

export type StageId = (typeof STAGES)[number]['id'];

export const stageIndex = (stage: string | undefined) => STAGES.findIndex((s) => s.id === stage);

export interface StreamDot {
  xy: XY;
  stage: SampleStage;
  /** measured by the latest batch (drawn as the walk being measured now) */
  fresh: boolean;
}

export interface StreamModel {
  frame: Frame;
  center: [number, number];
  field: TimeField | null;
  contours: Partial<Record<IsoLevel, XY[][]>> | null;
  /** radius of the straight 15′ circle, metres */
  r15: number;
  dots: StreamDot[];
  paths: WalkPath[];
  pois: Poi[];
  counts: Record<SampleStage, number>;
  /** walked paths, counted once each */
  pathCount: number;
  /** the 15′ reach so far, km² (from the partial contours), null before the first field */
  areaKm2: number | null;
}

/**
 * The drawable state of a streaming check; null until the stream has named its centre (`meta`).
 * `seen` is how many samples the previous partial carried: those after it are this batch.
 */
export function streamModel(p: Partial<AnalysisResult>, seen = 0): StreamModel | null {
  if (!p.meta?.center_bd09 || !p.meta.frame_formula) return null;
  const samples = p.samples ?? [];
  const dots = samples.map((s, i): StreamDot => ({
    xy: s.xy,
    stage: sampleStage(s),
    fresh: seen > 0 && i >= seen,
  }));
  const counts: Record<SampleStage, number> = { seed: 0, path: 0, refine: 0 };
  for (const d of dots) counts[d.stage]++;
  const speed = p.meta.walk_speed_mps || 1.17;
  const areaKm2 = reachKm2(p);
  return {
    frame: frameFromMeta(p.meta),
    center: p.meta.center_bd09,
    field: p.field ?? null,
    contours: p.contours ?? null,
    r15: p.baseline?.circle_r15_m ?? 900 * speed,
    dots,
    paths: p.paths ?? [],
    pois: p.pois ?? [],
    counts,
    pathCount: (p.paths ?? []).length,
    areaKm2,
  };
}

/** The 15′ reach after one round of measuring: how it tightens as the samples come in. */
export interface AreaStep {
  label: string;
  km2: number;
}

/** A streaming check as the screen holds it: the merged partial, the last stage, the batch mark. */
export interface StreamState {
  partial: Partial<AnalysisResult>;
  stage: StageEvent | null;
  /** samples carried by the partial before the latest one */
  seen: number;
  /** the 15′ reach after each field the stream sent */
  areas: AreaStep[];
  /** the day's quota ledger as the stream last reported it (quota events), by Baidu service */
  quota: Record<string, { used: number; limit?: number }>;
}

export const emptyStream = (): StreamState => ({ partial: {}, stage: null, seen: 0, areas: [], quota: {} });

/** Area of the 15′ rings from their meta (outer rings minus holes), km²; null without it. */
export function reachKm2(p: Partial<AnalysisResult>): number | null {
  const meta = p.contours_meta?.['900'];
  return meta?.length ? meta.reduce((sum, m) => sum + (m.hole ? -m.area_m2 : m.area_m2), 0) / 1e6 : null;
}

/** The round a field belongs to, in the ladder's words (加密 rounds are numbered). */
function roundLabel(stage: StageEvent | null, areas: readonly AreaStep[]): string {
  const i = stageIndex(stage?.stage);
  if (stage?.stage === 'refine') return `加密 ${areas.filter((a) => a.label.startsWith('加密')).length + 1}`;
  return i >= 0 ? STAGES[i]!.word : '粗采样';
}

/**
 * Merge a partial event (`next` may be the stream's merged result so far: every field in it is that
 * field's full current value). A new field adds a step to the reach's history.
 */
export function mergePartial(s: StreamState, next: Partial<AnalysisResult>): StreamState {
  const before = s.partial.samples?.length ?? 0;
  const partial = { ...s.partial, ...next };
  const now = partial.samples?.length ?? 0;
  const km2 = next.contours_meta && next.contours_meta !== s.partial.contours_meta ? reachKm2(partial) : null;
  return {
    ...s,
    partial,
    seen: next.samples && now > before ? before : s.seen,
    areas: km2 === null ? s.areas : [...s.areas, { label: roundLabel(s.stage, s.areas), km2 }],
  };
}
