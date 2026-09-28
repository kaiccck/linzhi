/**
 * Public types of the engine. Input, events and emit mirror the server's Analyzer seam
 * (apps/server/src/analyzer.ts) structurally, so the server passes its own emit and AbortSignal in.
 */
import type { BaiduClient, BaiduService, BaiduTier, QuotaLedger } from '@zoudedao/baidu';
import type { AnalysisResult, LngLat, RuleSet } from '@zoudedao/core';

import type { OfficialList } from './official.js';

/** Walking-speed profile (技术设计文档 §5.7). */
export type Profile = 'adult' | 'elder';

export interface EngineInput {
  /** Analysis centre, BD-09 [lng, lat]. */
  center_bd09: LngLat;
  /** Label of the centre as the user gave it (address, crossing …). */
  label?: string;
  /** Default adult (Baidu's 1.17 m/s); elder walks at 0.9 m/s on the same routes. */
  profile?: Profile;
  /** Distance rule of the facility checks: task = 1 km (default), gb50180 = GB 50180-2018 radii. */
  rules?: RuleSet;
}

export type Stage = 'locate' | 'facilities' | 'seed' | 'paths' | 'refine' | 'reach' | 'coverage' | 'report';

export const STAGES: readonly Stage[] = [
  'locate',
  'facilities',
  'seed',
  'paths',
  'refine',
  'reach',
  'coverage',
  'report',
];

export interface StageEvent {
  stage: Stage;
  /** Progress text shown to users, in Chinese. */
  message: string;
  /** Overall progress in [0, 1], non-decreasing. */
  progress: number;
}

/** Today's usage of one Baidu service after a call (ledger numbers when the client has a ledger). */
export interface QuotaEvent {
  service: string;
  used: number;
  limit: number;
}

/** Early results; every field present is that field's complete current value (clients shallow-merge). */
export type PartialResult = Partial<AnalysisResult>;

export interface EngineEvents {
  stage: StageEvent;
  partial: PartialResult;
  quota: QuotaEvent;
}

export type Emit = <E extends keyof EngineEvents>(event: E, data: EngineEvents[E]) => void;

/** The Baidu services one analysis calls. */
export type EngineService = Extract<
  BaiduService,
  'reverse_geocoding' | 'place' | 'directionlite_walking' | 'routematrix_walking'
>;

export const ENGINE_SERVICES: readonly EngineService[] = [
  'reverse_geocoding',
  'place',
  'directionlite_walking',
  'routematrix_walking',
];

/** The part of the ledger the engine uses: reserve a run's budget up front, read usage for quota events. */
export type EngineLedger = Pick<QuotaLedger, 'reserve' | 'usage' | 'blockedBy'> & {
  readonly tier?: BaiduTier;
};

/** The BaiduClient methods the engine calls; tests pass a fake with the same shapes. */
export type EngineClient = Pick<
  BaiduClient,
  'reverseGeocode' | 'placeAround' | 'routeMatrixWalking' | 'walkingRoute'
> & { readonly ledger?: EngineLedger };

export interface EngineDeps {
  client: EngineClient;
  /** Clock for meta.generated and the attribution date. */
  now?: () => Date;
  /**
   * Official facility lists (data/official/*.json, read by the caller) fused into the Baidu POIs:
   * they confirm, re-classify or add facilities of their category within the search radius.
   */
  official?: readonly OfficialList[];
}

/**
 * Per-run caps. Requests for place / reverse_geocoding / directionlite, routes (origins × destinations,
 * what Baidu bills) for routematrix. Defaults per tier in TIER_BUDGETS.
 */
export interface EngineBudget {
  /** place/v3 pages for the whole run (facilities + residential). */
  place: number;
  /** Of `place`, pages kept for the residential (demand point) search. */
  residentialPages: number;
  reverse_geocoding: number;
  /** directionlite requests, spares included (a probe without a route is replaced by the next one). */
  directionlite_walking: number;
  /** Walked routes wanted in the paths stage. */
  paths: number;
  seed: number;
  refine: number;
  refineRounds: number;
  coverage: number;
  /** Routes to verify siting suggestions. */
  siting: number;
  /** Demand points (residential compounds) checked. */
  communities: number;
}

/**
 * What one run produces: `full` is the whole health check; `isochrone` stops after the reach stage
 * (no facility search, coverage check or siting, so no place calls and no coverage routes).
 */
export type EngineScope = 'full' | 'isochrone';

/**
 * What the budget lines count: `billed` = units Baidu bills (cache hits are free, so a warm run may
 * refine further than a cold one); `requested` = every unit the run asks for, cached or not, so the run
 * does the same work warm or cold (evaluation: a budget of B routes means at most B routes of samples).
 */
export type BudgetBasis = 'billed' | 'requested';

export interface EngineOptions {
  /** Aborts the run: no further Baidu calls, the promise rejects with the signal's reason. */
  signal?: AbortSignal;
  budget?: Partial<EngineBudget>;
  /** Budget defaults; default the client ledger's tier, else personal. */
  tier?: BaiduTier;
  /** Default `full`. */
  scope?: EngineScope;
  /** Default `billed`. */
  budgetBasis?: BudgetBasis;
  /**
   * Lipschitz barrier detection (§5.3) in refinement and in the fields; false = plain detrended IDW
   * everywhere (the ablation of the accuracy–quota evaluation). Default true.
   */
  barriers?: boolean;
  /**
   * Refinement stops once the 15-minute region changed by less than this share between two rounds
   * (symmetric difference, §5.4). Default CONVERGED_SHARE (0.03); 0 never stops early, i.e. the run
   * spends its whole refinement budget.
   */
  convergeShare?: number;
}
