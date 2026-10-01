import { describe, expect, it } from 'vitest';

import { BORDERLINE_M, HARD_CATEGORIES, TASK_RULE_M, ruleDistance } from './standards.js';

describe('thresholds', () => {
  it('uses 1 km for every hard category under the task rule', () => {
    expect(HARD_CATEGORIES).toEqual(['小学', '菜市场', '药店']);
    for (const c of HARD_CATEGORIES) expect(ruleDistance(c)).toBe(1000);
    expect(TASK_RULE_M).toEqual({ 小学: 1000, 菜市场: 1000, 药店: 1000 });
    expect(ruleDistance('幼儿园')).toBeUndefined();
    expect(BORDERLINE_M).toBe(50);
  });
});
