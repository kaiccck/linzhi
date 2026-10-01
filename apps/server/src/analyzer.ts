/**
 * The seam between the HTTP layer and the analysis engine. POST /api/analyze owns the SSE stream;
 * an Analyzer only computes and reports progress. The engine built on @zoudedao/core and
 * @zoudedao/baidu plugs in here; until then SampleReplayAnalyzer (replay.ts) stands in.
 */
import type { AnalysisResult, LngLat } from '@zoudedao/core';

/** Walking-speed profile (docs/技术设计文档.md §5.7). */
export type Profile = 'adult' | 'elder';

/** One POI the browser's JSAPI LocalSearch found around the centre (no tags). */
export interface BrowserPoi {
  /** Baidu uid, 24 hex characters. */
  uid: string;
  name: string;
  /** The keyword that found it (小学, 菜市场, 超市 …). */
  keyword: string;
  bd09: LngLat;
}

/** Validated body of POST /api/analyze. */
export interface AnalyzeInput {
  center_bd09: LngLat;
  label?: string;
  profile: Profile;
  /**
   * Valid items only (invalid ones are dropped, at most 400 kept); absent when the request had none.
   * The engine details the ones place search did not return (docs/api.md).
   */
  browser_pois?: BrowserPoi[];
}

export type Stage = 'locate' | 'facilities' | 'seed' | 'paths' | 'refine' | 'reach' | 'coverage' | 'report';

export interface StageEvent {
  stage: Stage;
  /** Progress text shown to users, in Chinese. */
  message: string;
  /** Overall progress in [0, 1], non-decreasing. */
  progress: number;
}

/** Ledger update after Baidu calls: today's usage of one service. */
export interface QuotaEvent {
  service: string;
  used: number;
  limit: number;
}

/** Early results. Each field present is that field's complete current value (clients shallow-merge). */
export type PartialResult = Partial<AnalysisResult>;

export interface AnalyzeEvents {
  stage: StageEvent;
  partial: PartialResult;
  quota: QuotaEvent;
}

export type Emit = <E extends keyof AnalyzeEvents>(event: E, data: AnalyzeEvents[E]) => void;

/**
 * Closing `error` codes (docs/api.md「错误码」). `upstream` is reserved for Baidu-side failures;
 * `timeout` = the analysis time budget ran out; `internal` = unexpected exception or server shutdown.
 */
export type AnalyzeErrorCode =
  'quota_exhausted' | 'auth' | 'upstream' | 'invalid_input' | 'timeout' | 'internal';

/** An expected failure. Its message reaches users verbatim, so write it in Chinese and keep secrets out. */
export class AnalyzeError extends Error {
  override name = 'AnalyzeError';
  readonly code: AnalyzeErrorCode;

  constructor(code: AnalyzeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

export interface Analyzer {
  /** Short id reported by /api/health so clients can label replayed results (e.g. "replay"). */
  readonly name?: string;
  /**
   * Runs one health check. Report progress through `emit`; resolve with the full result (sent as
   * the `result` event) or reject (sent as the `error` event, AnalyzeError codes pass through).
   * `signal` aborts when the client disconnects, the server shuts down or the time budget runs out;
   * the stream is closed at that point, so later emits are dropped.
   */
  analyze(input: AnalyzeInput, emit: Emit, signal: AbortSignal): Promise<AnalysisResult>;
}
