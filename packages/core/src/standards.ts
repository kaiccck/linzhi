/**
 * Distance thresholds for facility checks. Two rule sets, reported side by side (design doc §1.3):
 *
 * task — 2026 上海开源软件应用创新大赛 百度地图命题: a community lacks a facility when no 小学, 菜市场
 *   or 药店 is within 1 km on foot (赛题任务书, ai_15_nIsJ99EN3y.pdf).
 *
 * gb50180 — GB 50180-2018《城市居住区规划设计标准》:
 *   表3.0.4 sets the walking distance of the life-circle tiers: 十五分钟 800–1000 m, 十分钟 500 m,
 *   五分钟 300 m.
 *   附录C 表C.0.1 (十五分钟、十分钟生活圈居住区配套设施规划建设控制要求): 小学 and 菜市场或生鲜超市
 *   "服务半径不宜大于500m".
 *   幼儿园 and 社区商业网点 (超市、药店、洗衣店、美发店等, 表B.0.2) are 五分钟生活圈居住区 facilities,
 *   so their radius is that tier's 300 m walking distance.
 *   The standard lets 生鲜超市 stand in for 菜市场 ("菜市场或生鲜超市"); the task rule does not.
 */
import type { FacilityCategory, HardCategory } from './types.js';

export type RuleSet = 'task' | 'gb50180';

export const HARD_CATEGORIES: readonly HardCategory[] = ['小学', '菜市场', '药店'];

/** Task rule: walking distance, metres. */
export const TASK_RULE_M: Readonly<Record<HardCategory, number>> = { 小学: 1000, 菜市场: 1000, 药店: 1000 };

/** GB 50180-2018 life-circle tiers (表3.0.4), walking distance in metres; 15 minutes uses the upper 1000 m. */
export const GB50180_TIER_M = { 5: 300, 10: 500, 15: 1000 } as const;

/** GB 50180-2018 service radii, metres (sources in the header comment). */
export const GB50180_RADIUS_M: Readonly<Partial<Record<FacilityCategory, number>>> = {
  小学: 500,
  菜市场: 500,
  生鲜超市: 500,
  药店: 300,
  幼儿园: 300,
};

/** |route − rule| within this many metres flags a check as 临界 (design doc §7.2). */
export const BORDERLINE_M = 50;

/** Rule distance for a category under a rule set; undefined when the rule set says nothing about it. */
export function ruleDistance(category: FacilityCategory, rules: RuleSet = 'task'): number | undefined {
  if (rules === 'gb50180') return GB50180_RADIUS_M[category];
  return (TASK_RULE_M as Partial<Record<FacilityCategory, number>>)[category];
}

/**
 * POI categories that satisfy a check: under GB 50180 a 生鲜超市 counts as a 菜市场, under the task rule
 * only a 菜市场 does.
 */
export function acceptedCategories(check: FacilityCategory, rules: RuleSet = 'task'): FacilityCategory[] {
  if (check === '菜市场' && rules === 'gb50180') return ['菜市场', '生鲜超市'];
  return [check];
}
