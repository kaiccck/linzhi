/**
 * Official data under data/official/*.json, fused into live results by the engine:
 *   - facility lists (no `kind`, or kind 'facilities'): 浦东新区商务委's standardized markets, 浦东教育局's
 *     2026 primary schools, 市卫健委's community health centres — confirm, re-classify or add POIs;
 *   - catchment tables (kind 'catchment'): 对口小学 by 地段, e.g. 浦东 2025 (张江镇 rows);
 *   - exclusions (kind 'exclusions'): Baidu POIs an official source shows are not what Baidu says, by
 *     uid, name, or a name pattern per category (the 前置仓 of online grocers Baidu tags 生鲜超市);
 *   - the community review (kind 'community_review'): Baidu 住宅区 that are not a compound (committee
 *     offices, gates, offices, duplicates), compounds with no 对口小学 by law, addresses as tables write them.
 * A broken or missing file only costs its own part, never the server: it is skipped with a Chinese warning.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  communityReviewProblem,
  exclusionProblem,
  type CatchmentList,
  type CommunityReview,
  type FacilityExclusion,
} from '@zoudedao/core';
import type { OfficialList } from '@zoudedao/engine';

export interface OfficialData {
  lists: OfficialList[];
  catchments: CatchmentList[];
  exclusions: FacilityExclusion[];
  communityReviews: CommunityReview[];
}

type Raw = Record<string, unknown>;

export function loadOfficialData(dir: string, warn: (message: string) => void = () => {}): OfficialData {
  const out: OfficialData = { lists: [], catchments: [], exclusions: [], communityReviews: [] };
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return out;
  }
  for (const file of files.sort()) {
    let data: Raw;
    try {
      data = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Raw;
    } catch (err) {
      warn(`官方名录 ${file} 无法读取，已跳过：${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const kind = data.kind ?? 'facilities';
    if (kind === 'catchment') {
      if (typeof data.id !== 'string' || !Array.isArray(data.schools)) {
        warn(`对口地段表 ${file} 缺少 id 或 schools，已跳过`);
        continue;
      }
      out.catchments.push(data as unknown as CatchmentList);
    } else if (kind === 'exclusions') {
      const entries = Array.isArray(data.entries) ? (data.entries as Raw[]) : null;
      if (!entries) {
        warn(`排除清单 ${file} 缺少 entries，已跳过`);
        continue;
      }
      for (const [i, e] of entries.entries()) {
        const problem = exclusionProblem(e);
        if (problem) {
          warn(`排除清单 ${file} 第 ${i + 1} 条：${problem}，已跳过该条`);
          continue;
        }
        out.exclusions.push(e as unknown as FacilityExclusion);
      }
    } else if (kind === 'community_review') {
      const entries = Array.isArray(data.entries) ? (data.entries as Raw[]) : null;
      if (!entries) {
        warn(`小区核实清单 ${file} 缺少 entries，已跳过`);
        continue;
      }
      for (const [i, e] of entries.entries()) {
        const problem = communityReviewProblem(e);
        if (problem) {
          warn(`小区核实清单 ${file} 第 ${i + 1} 条：${problem}，已跳过该条`);
          continue;
        }
        out.communityReviews.push(e as unknown as CommunityReview);
      }
    } else if (kind === 'facilities') {
      if (typeof data.id !== 'string' || typeof data.category !== 'string' || !Array.isArray(data.entries)) {
        warn(`官方名录 ${file} 缺少 id、category 或 entries，已跳过`);
        continue;
      }
      out.lists.push(data as unknown as OfficialList);
    } else {
      warn(`官方数据 ${file} 的 kind “${String(kind)}” 无法识别，已跳过`);
    }
  }
  return out;
}

/** The facility lists only (kept for callers that only fuse lists). */
export function loadOfficialLists(dir: string, warn: (message: string) => void = () => {}): OfficialList[] {
  return loadOfficialData(dir, warn).lists;
}
