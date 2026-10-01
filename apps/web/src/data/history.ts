/**
 * What the server remembers (docs/api.md): GET /api/history — the recent live checks and the samples,
 * each with its headline numbers, for the area switcher — and GET /api/analysis/:id/branches, the
 * what-if measurements (POST /api/whatif) saved on an analysis, for 规划.
 */
import { HARD_CATEGORIES, type AnalysisResult, type HardCategory } from '@zoudedao/core';
import { ApiError, errorText } from './api.js';
import { isAnalysisResult } from './loadAnalysis.js';
import { parseWhatIf, type WhatIfResult } from './whatif.js';

export interface HistoryHeadline {
  communities: number;
  area_iso15_km2: number | null;
  area_circle15_km2: number | null;
  overstate_x: number | null;
  /** verified gaps on foot: pseudo + blind (pending never counts) */
  walking_gaps: number;
  pseudo: number;
  blind: number;
  pending: number;
}

export interface HistoryItem {
  id: string;
  sample: boolean;
  /** ISO 8601: when a live check was stored (a sample: when it was generated) */
  created_at: string;
  center_bd09: [number, number] | null;
  label: string | null;
  profile: 'adult' | 'elder';
  name: string;
  headline: HistoryHeadline;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

function headlineOf(v: unknown): HistoryHeadline | null {
  if (!v || typeof v !== 'object') return null;
  const h = v as Record<string, unknown>;
  const gaps = num(h.walking_gaps);
  const pseudo = num(h.pseudo);
  const blind = num(h.blind);
  if (gaps === null || pseudo === null || blind === null) return null;
  const out: HistoryHeadline = {
    communities: num(h.communities) ?? 0,
    area_iso15_km2: num(h.area_iso15_km2),
    area_circle15_km2: num(h.area_circle15_km2),
    overstate_x: num(h.overstate_x),
    walking_gaps: gaps,
    pseudo,
    blind,
    pending: num(h.pending) ?? 0,
  };
  return out;
}

/** Shape check of GET /api/history: the entries it can read, or null for a foreign answer. */
export function parseHistory(body: unknown): HistoryItem[] | null {
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return null;
  return items.flatMap((it): HistoryItem[] => {
    if (!it || typeof it !== 'object') return [];
    const o = it as Record<string, unknown>;
    const id = str(o.id);
    const name = str(o.name);
    const headline = headlineOf(o.headline);
    if (!id || !name || !headline) return [];
    const c = o.center_bd09;
    return [
      {
        id,
        sample: o.sample === true,
        created_at: str(o.created_at) ?? '',
        center_bd09:
          Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number' ? [c[0], c[1]] : null,
        label: str(o.label),
        profile: o.profile === 'elder' ? 'elder' : 'adult',
        name,
        headline,
      },
    ];
  });
}

/**
 * The headline as the menu says it, "画圈 x → 走一遍 y": the circle's gaps are the blind ones (beyond
 * the rule even by straight line); the walk's are every verified gap.
 */
export function headlineGaps(h: HistoryHeadline): { circle: number; walk: number } {
  return { circle: h.blind, walk: h.walking_gaps };
}

/** "09-28 12:31" in the viewer's time zone (the history keeps UTC). */
export function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function getJson(url: string, signal: AbortSignal): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { signal, headers: { accept: 'application/json' } });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new ApiError('offline', '无法连接邻至服务端，请确认服务已启动。');
  }
  const json = /json/i.test(res.headers.get('content-type') ?? '');
  const body = (json ? await res.json().catch(() => null) : null) as Record<string, unknown> | null;
  if (!res.ok || !json) {
    const code = typeof body?.error === 'string' ? body.error : `http_${res.status}`;
    throw new ApiError(code, errorText(code, body?.message));
  }
  return body;
}

export async function getHistory(signal: AbortSignal): Promise<HistoryItem[]> {
  const items = parseHistory(await getJson('/api/history', signal));
  if (!items) throw new ApiError('upstream', '体检历史的返回数据不完整。');
  return items;
}

/** A stored live check (GET /api/analysis/live-…), stamped with its id when the result lacks it. */
export async function getLiveAnalysis(id: string, signal: AbortSignal): Promise<AnalysisResult> {
  const data = await getJson(`/api/analysis/${encodeURIComponent(id)}`, signal);
  if (!isAnalysisResult(data)) throw new ApiError('upstream', '体检结果的数据结构不完整。');
  const meta = data.meta as AnalysisResult['meta'] & { analysis_id?: unknown };
  return typeof meta.analysis_id === 'string' && meta.analysis_id
    ? data
    : { ...data, meta: { ...data.meta, analysis_id: id } as AnalysisResult['meta'] };
}

/* ---------------- what-if branches ---------------- */

/** A what-if measurement saved on its analysis: POST /api/whatif's answer, an id and a time. */
export interface WhatIfBranch extends WhatIfResult {
  id: string;
  created_at: string;
  category: HardCategory;
  site_bd09: [number, number];
}

const CATS: readonly string[] = HARD_CATEGORIES;

export function parseBranches(body: unknown): WhatIfBranch[] | null {
  const list = (body as { branches?: unknown } | null)?.branches;
  if (!Array.isArray(list)) return null;
  return list.flatMap((b): WhatIfBranch[] => {
    if (!b || typeof b !== 'object') return [];
    const o = b as Record<string, unknown>;
    const result = parseWhatIf(o);
    const id = str(o.id);
    const cat = str(o.category);
    const site = o.site_bd09;
    if (!result || !id || !cat || !CATS.includes(cat)) return [];
    // measured under GB 50180 (no longer offered): not listed
    if (o.rules !== undefined && o.rules !== 'task') return [];
    if (!Array.isArray(site) || typeof site[0] !== 'number' || typeof site[1] !== 'number') return [];
    return [
      {
        ...result,
        id,
        branch_id: id,
        created_at: str(o.created_at) ?? '',
        category: cat as HardCategory,
        site_bd09: [site[0], site[1]],
      },
    ];
  });
}

export async function getBranches(analysisId: string, signal: AbortSignal): Promise<WhatIfBranch[]> {
  const list = parseBranches(
    await getJson(`/api/analysis/${encodeURIComponent(analysisId)}/branches`, signal),
  );
  if (!list) throw new ApiError('upstream', '实测模拟记录的返回数据不完整。');
  return list;
}
