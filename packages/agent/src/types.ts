/**
 * Types shared by the backend, the tools, the advisor and the MCP server. Wire objects keep the
 * snake_case of docs/api.md and data/samples/*.json.
 */
import type { AnalysisMeta, AnalysisResult, HardCategory, LngLat } from '@zoudedao/core';

/** Walking profile (技术设计文档 §5.7). Route distances never change with the profile, only times do. */
export type Profile = 'adult' | 'elder';

/** Elderly walking speed: MUTCD 4E.06 suggests 3.0 ft/s (≈ 0.91 m/s) for slow pedestrians. */
export const ELDER_SPEED_MPS = 0.9;

/** One entry of GET /api/samples. */
export interface SampleSummary {
  id: string;
  name: string;
  center_bd09: LngLat;
  center_label?: string;
}

export type PlaceSource = 'geocoding' | 'place_region' | 'sample';

/** A candidate centre point of GET /api/locate. */
export interface PlaceCandidate {
  name: string;
  address?: string;
  center_bd09: LngLat;
  source: PlaceSource | (string & {});
  /** 0–1; ≥ 0.6 can be used without asking. */
  confidence?: number;
  reason?: string;
  distance_to_best_m?: number;
  uid?: string;
  sample_id?: string;
}

export interface LocateResult {
  query: string;
  city?: string;
  best: PlaceCandidate | null;
  /** Best first. */
  candidates: PlaceCandidate[];
  /** Let the user pick before analysing (技术设计文档 §4.6). */
  needs_confirmation: boolean;
  warnings: string[];
}

/** Body of POST /api/analyze. */
export interface AnalyzeInput {
  center_bd09: LngLat;
  label?: string;
  profile?: Profile;
}

/** Progress of a live analysis, relayed from the SSE stream of POST /api/analyze. */
export type AnalyzeEvent =
  | { type: 'stage'; stage: string; message: string; progress: number }
  | { type: 'partial'; data: Partial<AnalysisResult> }
  | { type: 'quota'; service: string; used: number; limit: number };

/**
 * Meta fields beyond core's wire model: written by the live engine (packages/engine LiveMeta) and by
 * deriveProfile. All optional, since samples carry none of them.
 */
export interface ProfileMeta {
  /** 'live' for results of the live engine. */
  mode?: string;
  profile?: Profile;
  /** Walking speed behind field, contours and stats; meta.walk_speed_mps stays Baidu's 1.17. */
  profile_speed_mps?: number;
  /** Rule distance per checked category, metres. */
  rule_m?: Partial<Record<HardCategory, number>>;
  /** Chinese notes and warnings of a live run (samples carry English build notes instead). */
  notes?: string[];
  warnings?: string[];
  /** Analysis id this result was derived from. */
  derived_from?: string;
}

export type ZddMeta = AnalysisMeta & ProfileMeta;
