import { describe, expect, it } from 'vitest';

import {
  BORDERLINE_M,
  GB50180_RADIUS_M,
  GB50180_TIER_M,
  HARD_CATEGORIES,
  TASK_RULE_M,
  acceptedCategories,
  ruleDistance,
} from './standards.js';

describe('thresholds', () => {
  it('uses 1 km for every hard category under the task rule', () => {
    expect(HARD_CATEGORIES).toEqual(['小学', '菜市场', '药店']);
    for (const c of HARD_CATEGORIES) expect(ruleDistance(c)).toBe(1000);
    expect(TASK_RULE_M).toEqual({ 小学: 1000, 菜市场: 1000, 药店: 1000 });
    expect(ruleDistance('幼儿园')).toBeUndefined();
  });

  it('uses the GB 50180-2018 radii and tiers', () => {
    expect(ruleDistance('小学', 'gb50180')).toBe(500);
    expect(ruleDistance('菜市场', 'gb50180')).toBe(500);
    expect(ruleDistance('药店', 'gb50180')).toBe(300);
    expect(ruleDistance('幼儿园', 'gb50180')).toBe(300);
    expect(ruleDistance('公园', 'gb50180')).toBeUndefined();
    expect(GB50180_TIER_M).toEqual({ 5: 300, 10: 500, 15: 1000 });
    expect(GB50180_RADIUS_M.药店).toBe(GB50180_TIER_M[5]);
    expect(BORDERLINE_M).toBe(50);
  });

  it('lets 生鲜超市 stand in for 菜市场 only under GB 50180', () => {
    expect(acceptedCategories('菜市场', 'task')).toEqual(['菜市场']);
    expect(acceptedCategories('菜市场', 'gb50180')).toEqual(['菜市场', '生鲜超市']);
    expect(acceptedCategories('药店', 'gb50180')).toEqual(['药店']);
  });
});
