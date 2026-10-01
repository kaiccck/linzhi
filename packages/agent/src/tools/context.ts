/**
 * Looking up analyses by id for the tools: the in-memory store first, then derived profiles
 * ("<id>~elder" is recomputed from "<id>" on demand), then the backend's samples.
 */
import { haversine, type AnalysisResult, type HardCategory, type LngLat } from '@zoudedao/core';
import { HARD_CATEGORIES, checkedCategories, deriveProfile, profileOf } from '../analysis.js';
import { BackendError, type StoredAnalysis } from '../backend.js';
import { ToolError, type ToolContext } from './types.js';

export const ELDER_SUFFIX = '~elder';

/**
 * Passes when the analysis checked `category` per community; otherwise a not_checked error that says
 * so (an older analysis checked the task's 小学、菜市场、药店 only): a category never checked has no
 * gaps to report, and saying "none" would be wrong. `consequence` says what cannot be answered.
 */
export function assertChecked(
  result: AnalysisResult,
  id: string,
  category: HardCategory,
  consequence: string,
): void {
  const checked = checkedCategories(result);
  if (checked.includes(category)) return;
  throw new ToolError(
    'not_checked',
    `${result.meta.name}（analysis_id: ${id}）没有逐小区检查${category}：这份分析只逐小区检查了${checked.join('、')}，${consequence}。` +
      `从分析中心出发能走到几处${category}，见 analyze_life_circle 的圈内设施统计（facilities）；` +
      `要逐小区检查${category}，需要重新体检该地点（新的体检逐小区检查${HARD_CATEGORIES.join('、')}）。`,
  );
}

/** "可用的分析：zj-a（申城佳苑片区）；…" for error messages and prompts. */
export async function availableText(ctx: ToolContext): Promise<string> {
  const samples = await ctx.backend.listSamples(ctx.signal).catch(() => []);
  const live = ctx.store.list().filter((s) => s.source === 'live');
  const parts: string[] = [];
  if (samples.length) parts.push(`样例：${samples.map((s) => `${s.id}（${s.name}）`).join('、')}`);
  if (live.length) parts.push(`实时结果：${live.map((s) => `${s.id}（${s.result.meta.name}）`).join('、')}`);
  return parts.length ? `可用的分析——${parts.join('；')}。` : '当前没有可用的分析。';
}

export async function resolveAnalysis(ctx: ToolContext, id: string): Promise<StoredAnalysis> {
  const key = id.trim();
  const hit = ctx.store.get(key);
  if (hit) return hit;
  if (key.endsWith(ELDER_SUFFIX)) {
    const base = await resolveAnalysis(ctx, key.slice(0, -ELDER_SUFFIX.length));
    const result =
      profileOf(base.result) === 'elder'
        ? base.result
        : deriveProfile(base.result, 'elder', { baseId: base.id });
    ctx.store.put(result, { id: key, source: 'derived' });
    return ctx.store.get(key)!;
  }
  if (key.startsWith('live-')) {
    throw new ToolError(
      'not_found',
      `分析 ${key} 已不在内存中（只保留最近 ${ctx.store.maxEntries} 个结果），请重新体检。${await availableText(ctx)}`,
    );
  }
  try {
    const result = await ctx.backend.getAnalysis(key, ctx.signal);
    ctx.store.put(result, { id: key, source: 'sample' });
    return ctx.store.get(key)!;
  } catch (err) {
    if (err instanceof BackendError && (err.code === 'not_found' || err.status === 404)) {
      throw new ToolError('not_found', `找不到分析 ${key}。${await availableText(ctx)}`, { cause: err });
    }
    throw err;
  }
}

/** A sample whose centre is within `within_m` of the point: reusing it costs no quota. */
export async function sampleNear(
  ctx: ToolContext,
  center: LngLat,
  within_m = 100,
): Promise<{ id: string; name: string } | undefined> {
  const samples = await ctx.backend.listSamples(ctx.signal).catch(() => []);
  return samples.find((s) => haversine(s.center_bd09[0], s.center_bd09[1], center[0], center[1]) <= within_m);
}
