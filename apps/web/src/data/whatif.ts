/**
 * 实测核验 → POST /api/whatif: measure the walks from a planned site to the units that lack the
 * category (one routematrix call, one route per unit within the rule by straight line), so the
 * estimate on the board becomes a measured answer.
 *
 * Request  { analysis_id, category, site_bd09: [lng, lat] }
 * Response { measured: [{ community, route_m, dur_s, before, after }], newly_covered, quota: { routes } }
 * Errors are the usual `{ error, message }`; 409 live_mode_disabled in sample mode.
 */
import type { HardCategory } from '@zoudedao/core';
import { ApiError, errorText } from './api.js';

export interface WhatIfRequest {
  analysis_id: string;
  category: HardCategory;
  site_bd09: [number, number];
}

export interface WhatIfMeasured {
  community: string;
  /** measured walk from the site, metres; null when Baidu found no route */
  route_m: number | null;
  dur_s: number | null;
  /** the unit's status for the category before and after the site */
  before: string;
  after: string;
}

export interface WhatIfResult {
  measured: WhatIfMeasured[];
  newly_covered: string[];
  /** routes Baidu billed this time, and routes answered from the cache */
  quota: { routes: number; cached?: number };
  /** the analysis branch the measurement was saved as (GET /api/analysis/:id/branches) */
  branch_id?: string;
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Shape check: a partial or foreign answer is an error, never a silent "nothing covered". */
export function parseWhatIf(body: unknown): WhatIfResult | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.measured) || !Array.isArray(b.newly_covered)) return null;
  const measured = b.measured.flatMap((m): WhatIfMeasured[] => {
    if (!m || typeof m !== 'object') return [];
    const r = m as Record<string, unknown>;
    if (!isStr(r.community)) return [];
    return [
      {
        community: r.community,
        route_m: numOrNull(r.route_m),
        dur_s: numOrNull(r.dur_s),
        before: isStr(r.before) ? r.before : '',
        after: isStr(r.after) ? r.after : '',
      },
    ];
  });
  const quota = b.quota as { routes?: unknown; cached?: unknown } | undefined;
  const cached = numOrNull(quota?.cached);
  return {
    measured,
    newly_covered: b.newly_covered.filter(isStr),
    quota: { routes: numOrNull(quota?.routes) ?? measured.length, ...(cached !== null ? { cached } : {}) },
    ...(isStr(b.branch_id) && b.branch_id ? { branch_id: b.branch_id } : {}),
  };
}

export async function postWhatIf(req: WhatIfRequest, signal: AbortSignal): Promise<WhatIfResult> {
  let res: Response;
  try {
    res = await fetch('/api/whatif', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(req),
      signal,
    });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new ApiError('offline', '无法连接邻至服务端，请确认服务已启动');
  }
  const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
  if (!res.ok) {
    const code = body?.error ?? `http_${res.status}`;
    // an older server has no such route: say what is missing rather than a bare 404
    if (res.status === 404 && (!body?.error || body.error === 'not_found'))
      throw new ApiError('not_found', '服务端还没有实测核验接口（POST /api/whatif）');
    throw new ApiError(code, errorText(code, body?.message));
  }
  const parsed = parseWhatIf(body);
  if (!parsed) throw new ApiError('upstream', '实测核验的返回数据不完整');
  return parsed;
}
