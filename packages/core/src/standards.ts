/**
 * Distance threshold of the facility checks (赛题口径, 2026 上海开源软件应用创新大赛 百度地图命题): a
 * community lacks a facility when no 小学, 菜市场 or 药店 is within 1 km on foot (赛题任务书,
 * ai_15_nIsJ99EN3y.pdf).
 */
import type { FacilityCategory, HardCategory } from './types.js';

export const HARD_CATEGORIES: readonly HardCategory[] = ['小学', '菜市场', '药店'];

/** Task rule: walking distance, metres. */
export const TASK_RULE_M: Readonly<Record<HardCategory, number>> = { 小学: 1000, 菜市场: 1000, 药店: 1000 };

/** |route − rule| within this many metres flags a check as 临界 (design doc §7.2). */
export const BORDERLINE_M = 50;

/** Rule distance for a category; undefined when the rule says nothing about it. */
export function ruleDistance(category: FacilityCategory): number | undefined {
  return (TASK_RULE_M as Partial<Record<FacilityCategory, number>>)[category];
}
