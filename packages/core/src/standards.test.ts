import { describe, expect, it } from 'vitest';

import {
  BORDERLINE_M,
  checkedCategories,
  HARD_CATEGORIES,
  ruleDistance,
  TASK_CATEGORIES,
  TASK_RULE_M,
} from './standards.js';
import type { Community, FacilityCheck } from './types.js';

describe('thresholds', () => {
  it('checks five categories, the task’s three among them, all on a 1 km walk', () => {
    expect(HARD_CATEGORIES).toEqual(['幼儿园', '小学', '菜市场', '药店', '社区卫生']);
    expect(TASK_CATEGORIES).toEqual(['小学', '菜市场', '药店']);
    for (const c of TASK_CATEGORIES) expect(HARD_CATEGORIES).toContain(c);
    for (const c of HARD_CATEGORIES) expect(ruleDistance(c)).toBe(1000);
    expect(TASK_RULE_M).toEqual({ 幼儿园: 1000, 小学: 1000, 菜市场: 1000, 药店: 1000, 社区卫生: 1000 });
    // the counted 民生设施 have no rule
    expect(ruleDistance('养老')).toBeUndefined();
    expect(ruleDistance('生鲜超市')).toBeUndefined();
    expect(BORDERLINE_M).toBe(50);
  });

  it('tells the categories an analysis was checked for from its communities', () => {
    const check = { status_main: '覆盖', verified: true } as FacilityCheck;
    const community = (cats: readonly string[]): Community =>
      ({
        name: 'x',
        pts: [],
        centroid: [0, 0],
        checks: Object.fromEntries(cats.map((c) => [c, check])),
      }) as unknown as Community;
    // older analyses carry the task's three, newer ones all five, in display order either way
    expect(checkedCategories({ communities: [community(['药店', '小学', '菜市场'])] })).toEqual([
      '小学',
      '菜市场',
      '药店',
    ]);
    expect(checkedCategories({ communities: [community([...HARD_CATEGORIES].reverse())] })).toEqual([
      ...HARD_CATEGORIES,
    ]);
    // without communities nothing says otherwise: the task's three
    expect(checkedCategories({ communities: [] })).toEqual([...TASK_CATEGORIES]);
  });
});
