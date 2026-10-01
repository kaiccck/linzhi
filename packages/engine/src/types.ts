/**
 * Public types of the engine. Input, events and emit mirror the server's Analyzer seam
 * (apps/server/src/analyzer.ts) structurally, so the server passes its own emit and AbortSignal in.
 */
import type { BaiduClient, BaiduService, BaiduTier, QuotaLedger } from '@zoudedao/baidu';
import type { AnalysisResult, CatchmentList, FacilityExclusion, LngLat } from '@zoudedao/core';

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
  /**
   * POIs the browser's JSAPI LocalSearch found around the centre, which place/v3/around may omit
   * (POST /api/analyze). Invalid items are dropped, at most BROWSER_POIS_MAX are kept (input.ts); new
   * ones within the facility radius are read with place/v3/detail and cleaned like search rows.
   */
  browser_pois?: readonly BrowserPoi[];
}

/** One POI of the browser's JSAPI LocalSearch.searchNearby: no tags, only what the map shows. */
export interface BrowserPoi {
  /** Baidu uid, 24 hex characters. */
  uid: string;
  name: string;
  /** The keyword that found it (小学, 菜市场, 超市 …). */
  keyword: string;
  bd09: LngLat;
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
> &
  /** Needed only for `browser_pois`: a client without it leaves them out. */
  Partial<Pick<BaiduClient, 'placeDetail'>> & { readonly ledger?: EngineLedger };

export interface EngineDeps {
  client: EngineClient;
  /** Clock for meta.generated and the attribution date. */
  now?: () => Date;
  /**
   * Official facility lists (data/official/*.json, read by the caller) fused into the Baidu POIs:
   * they confirm, re-classify or add facilities of their category within the search radius.
   */
  official?: readonly OfficialList[];
  /**
   * Primary-school catchment tables (对口地段, data/official/*.json kind 'catchment'). When the centre's
   * reverse-geocoded district and town are covered, compounds are matched to their assigned school and
   * routed to its gate (communities[].catchment).
   */
  catchment?: readonly CatchmentList[];
  /** Curated exclusions (data/official/exclusions.json), applied after cleaning and fusion. */
  exclusions?: readonly FacilityExclusion[];
}

/**
 * Per-run caps. Requests for place / reverse_geocoding / directionlite, routes (origins × destinations,
 * what Baidu bills) for routematrix. Defaults per tier in TIER_BUDGETS.
 */
export interface EngineBudget {
  /** place/v3 pages for the whole run (facilities + 民生设施 + residential + 买菜替代). */
  place: number;
  /** Of `place`, pages kept for the residential (demand point) search. */
  residentialPages: number;
  /**
   * Of `place`, pages kept for the 民生设施 union (社区卫生, 养老, 地铁, 公园, 超市, 公交) behind
   * stats.facility_stats; 0 skips it. The hard-category search gets the rest.
   */
  livelihoodPages: number;
  /**
   * Of `place`, pages kept for the 买菜替代 search (shops that sell vegetables, for 菜市场 checks that are
   * a gap), spent only when a 菜市场 check is one; 0 skips it. It only gets what `place` leaves beyond
   * the hard-category search's share of the tier (resolveBudget).
   */
  freshPages: number;
  /**
   * place/v3/detail requests (10 uids each) for the browser's POIs that the searches did not return,
   * on top of `place`; spent only when the input has `browser_pois` with new ones, and the first thing
   * given up when the day's place quota is short.
   */
  detailCalls: number;
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
  /** Routes from compounds to their assigned school (对口小学) that the coverage check did not already measure. */
  catchment: number;
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
