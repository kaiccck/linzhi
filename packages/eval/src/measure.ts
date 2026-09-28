/**
 * Walking routes from the centre to many points: routematrix 1 × ≤ 50 per call (one request each, so a
 * run can be checkpointed after every call), failed cells retried once, and a clean stop at the first
 * error that more calls cannot fix (key, permission, Baidu's daily quota, the evaluation's ceiling).
 */
import {
  BaiduConfigError,
  BaiduQuotaError,
  type BaiduClient,
  type BaiduError,
  type RouteCell,
} from '@zoudedao/baidu';
import type { LngLat } from '@zoudedao/core';

export type CellStatus = 'ok' | 'no_route' | 'failed';

export interface MeasuredCell {
  status: CellStatus;
  route_m: number | null;
  dur_s: number | null;
}

export const MATRIX_CHUNK = 50;

export interface MeasureStats {
  /** Routematrix calls made (1 × ≤ 50 each). */
  calls: number;
  /** HTTP requests sent (cache hits need none). */
  requests: number;
  /** Routes asked for, cached or not (a retried cell counts again). */
  routes: number;
  /** Routes Baidu billed (not from the cache). */
  routes_billed: number;
  routes_cached: number;
  /** Cells asked again after failing once. */
  retried: number;
  /** Cells still failed after the retry. */
  failed: number;
  /** Cells never asked because a fatal error stopped the run first. */
  not_asked: number;
}

export type MatrixClient = Pick<BaiduClient, 'routeMatrixWalking'>;

export function cellOf(c: RouteCell | undefined): MeasuredCell {
  if (!c || c.status === 'failed') return { status: 'failed', route_m: null, dur_s: null };
  if (c.status === 'no_route' || !((c.distanceM ?? 0) > 0) || !((c.durationS ?? 0) > 0)) {
    return { status: 'no_route', route_m: null, dur_s: null };
  }
  return { status: 'ok', route_m: c.distanceM, dur_s: c.durationS };
}

/** Errors that end a measurement: retrying or the next call cannot succeed. */
export function isFatal(e: unknown): e is BaiduError {
  return e instanceof BaiduQuotaError || e instanceof BaiduConfigError;
}

export interface MeasureResult {
  /** Per destination; `null` = never asked (a fatal error stopped the run before or at its call). */
  cells: (MeasuredCell | null)[];
  stats: MeasureStats;
  /** The error that stopped the measurement early, or null. */
  stopped: BaiduError | null;
}

/**
 * Measures centre → dests[k]. `onChunk` sees the cells of each finished call (indices into dests),
 * e.g. to save a checkpoint; cells a fatal error refused are left out. Cells that failed are asked
 * once more at the end, unless a fatal error stopped the run.
 */
export async function measureFromCenter(
  client: MatrixClient,
  center: LngLat,
  dests: readonly LngLat[],
  opts: {
    chunk?: number;
    signal?: AbortSignal;
    onChunk?: (indices: number[], cells: MeasuredCell[]) => void;
  } = {},
): Promise<MeasureResult> {
  const chunk = Math.max(1, Math.min(MATRIX_CHUNK, Math.floor(opts.chunk ?? MATRIX_CHUNK)));
  const cells: (MeasuredCell | null)[] = dests.map(() => null);
  const stats: MeasureStats = {
    calls: 0,
    requests: 0,
    routes: 0,
    routes_billed: 0,
    routes_cached: 0,
    retried: 0,
    failed: 0,
    not_asked: 0,
  };
  let stopped: BaiduError | null = null;

  const pass = async (indices: number[]) => {
    for (let k = 0; k < indices.length && !stopped; k += chunk) {
      opts.signal?.throwIfAborted();
      const part = indices.slice(k, k + chunk);
      const m = await client.routeMatrixWalking(
        [center],
        part.map((i) => dests[i]!),
        { partial: true, ...(opts.signal ? { signal: opts.signal } : {}) },
      );
      stats.calls++;
      stats.requests += m.stats.requests;
      stats.routes += part.length;
      stats.routes_billed += m.stats.routesRequested;
      stats.routes_cached += m.stats.fromCache;
      const fatal = m.errors.find(isFatal) ?? null;
      const answered: number[] = [];
      part.forEach((i, j) => {
        const cell = cellOf(m.cells[0]?.[j]);
        // refused before it was sent: not a failure of the point, just not asked
        if (fatal && cell.status === 'failed') return;
        cells[i] = cell;
        answered.push(i);
      });
      if (answered.length) {
        opts.onChunk?.(
          answered,
          answered.map((i) => cells[i]!),
        );
      }
      stopped = fatal;
    }
  };

  await pass(dests.map((_, i) => i));
  if (!stopped) {
    const again = cells.flatMap((c, i) => (c?.status === 'failed' ? [i] : []));
    stats.retried = again.length;
    if (again.length) await pass(again);
  }
  stats.failed = cells.filter((c) => c?.status === 'failed').length;
  stats.not_asked = cells.filter((c) => c === null).length;
  return { cells, stats, stopped };
}
