/**
 * Loads one AnalysisResult: from the API server first (docs/api.md), otherwise from the sample file
 * shipped with the app, so the page also works as a static build with no server at all.
 */
import type { AnalysisResult } from '@zoudedao/core';
// emitted as a static asset (dev: served from the repo; build: dist/assets/zj-a-*.json)
import bundledSampleUrl from '../../../../data/samples/zj-a.json?url';

export const BUNDLED_ID = 'zj-a';

/** api = GET /api/analysis/:id · bundled = shipped sample file · live / replay = POST /api/analyze */
export type DataSource = 'api' | 'bundled' | 'live' | 'replay';

export interface SampleInfo {
  id: string;
  name: string;
  center_bd09?: [number, number];
  center_label?: string;
}

export interface Loaded {
  id: string;
  data: AnalysisResult;
  source: DataSource;
  /** why the API was not used (only when source = bundled) */
  apiError?: string;
  samples: SampleInfo[];
}

async function getJson(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
  strictType = true,
): Promise<unknown> {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = window.setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    const type = res.headers.get('content-type') ?? '';
    // an SPA fallback page is not JSON: treat it as "no API here"
    if (strictType && !/json/i.test(type)) throw new Error(`${url} → 非 JSON 响应`);
    return (await res.json()) as unknown;
  } finally {
    window.clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

const isNumPair = (v: unknown) => Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number');

/** Shape check of the fields the screen relies on; a partial or foreign payload falls back. */
export function isAnalysisResult(v: unknown): v is AnalysisResult {
  if (!v || typeof v !== 'object') return false;
  const r = v as Partial<AnalysisResult>;
  return (
    !!r.meta &&
    isNumPair(r.meta.center_bd09) &&
    typeof r.meta.frame_formula === 'string' &&
    Array.isArray(r.communities) &&
    Array.isArray(r.pois) &&
    Array.isArray(r.paths) &&
    !!r.field &&
    Array.isArray(r.field.t_s) &&
    !!r.contours &&
    Array.isArray(r.contours['900']) &&
    !!r.baseline &&
    typeof r.baseline.circle_r15_m === 'number' &&
    !!r.stats &&
    Array.isArray(r.stats.reach_by_bearing)
  );
}

function toSamples(v: unknown): SampleInfo[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (s): s is SampleInfo => !!s && typeof s === 'object' && typeof (s as SampleInfo).id === 'string',
  );
}

export async function loadAnalysis(requestedId: string | null, signal?: AbortSignal): Promise<Loaded> {
  let samples: SampleInfo[] = [];
  let apiError: string;
  try {
    samples = toSamples(await getJson('/api/samples', 4000, signal));
    const id =
      (requestedId && samples.some((s) => s.id === requestedId) ? requestedId : null) ??
      samples.find((s) => s.id === BUNDLED_ID)?.id ??
      samples[0]?.id ??
      requestedId ??
      BUNDLED_ID;
    const data = await getJson(`/api/analysis/${encodeURIComponent(id)}`, 10000, signal);
    if (!isAnalysisResult(data)) throw new Error(`/api/analysis/${id} → 数据结构不完整`);
    return { id, data, source: 'api', samples };
  } catch (err) {
    if (signal?.aborted) throw err;
    apiError = err instanceof Error ? err.message : String(err);
  }
  const data = await getJson(bundledSampleUrl, 15000, signal, false);
  if (!isAnalysisResult(data)) throw new Error('内置样例数据不完整');
  return { id: BUNDLED_ID, data, source: 'bundled', apiError, samples };
}
