/**
 * The categories checked per community and the distance they are checked at. The competition task
 * (2026 上海开源软件应用创新大赛 百度地图命题, 赛题任务书 ai_15_nIsJ99EN3y.pdf) names 小学, 菜市场 and
 * 药店 within 1 km on foot; 幼儿园 and 社区卫生 (服务中心与服务站) are checked beside them on the same
 * 1 km walk, so the five daily services of a 15-minute life circle stand side by side — education,
 * groceries, medicine.
 */
import type { AnalysisResult, FacilityCategory, HardCategory } from './types.js';

/** Every category a community can be checked for, in display order. */
export const HARD_CATEGORIES: readonly HardCategory[] = ['幼儿园', '小学', '菜市场', '药店', '社区卫生'];

/** The three the task itself names (older analyses carry these alone). */
export const TASK_CATEGORIES: readonly HardCategory[] = ['小学', '菜市场', '药店'];

/** The rule: walking distance, metres — 1 km for every checked category. */
export const TASK_RULE_M: Readonly<Record<HardCategory, number>> = {
  幼儿园: 1000,
  小学: 1000,
  菜市场: 1000,
  药店: 1000,
  社区卫生: 1000,
};

/**
 * The categories an analysis was checked for, in display order: those its communities carry a check
 * of (an analysis made before 幼儿园 and 社区卫生 were checked has the task's three).
 */
export function checkedCategories(result: Pick<AnalysisResult, 'communities'>): HardCategory[] {
  const first = result.communities[0];
  if (!first) return [...TASK_CATEGORIES];
  return HARD_CATEGORIES.filter((c) => first.checks[c] !== undefined);
}

/** |route − rule| within this many metres flags a check as 临界 (design doc §7.2). */
export const BORDERLINE_M = 50;

/** Rule distance for a category; undefined when the rule says nothing about it. */
export function ruleDistance(category: FacilityCategory): number | undefined {
  return (TASK_RULE_M as Partial<Record<FacilityCategory, number>>)[category];
}
