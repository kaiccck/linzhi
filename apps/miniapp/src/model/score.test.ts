import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AnalysisResult } from '@zoudedao/core';
import { deriveModel } from '@web/model/derive';
import { gradeOf, lifeCircleScore, scoreWith } from './score';

const load = (id: string) =>
  deriveModel(
    JSON.parse(
      readFileSync(fileURLToPath(new URL(`../../../../data/samples/${id}.json`, import.meta.url)), 'utf8'),
    ) as AnalysisResult,
    id,
  );

describe('体检评分', () => {
  it('scores the walk below the circle wherever the circle misses gaps', () => {
    for (const id of ['zj-a', 'zj-b', 'zj-c', 'zj-v']) {
      const s = lifeCircleScore(load(id));
      expect(s.walk).toBeGreaterThanOrEqual(0);
      expect(s.walk).toBeLessThanOrEqual(100);
      expect(s.walk).toBeLessThanOrEqual(s.circle);
      for (const c of s.categories) if (c.walk !== null) expect(c.walk).toBeLessThanOrEqual(c.circle!);
    }
  });

  it('leaves pending checks out of both scores', () => {
    const m = load('zj-a');
    const s = lifeCircleScore(m);
    const school = s.categories.find((c) => c.cat === '小学')!;
    expect(school.pending + school.measured).toBe(m.units.length);
    expect(s.pending).toBe(m.tally.pending);
  });

  it('grades by the walk', () => {
    expect(gradeOf(95).word).toBe('良好');
    expect(gradeOf(80).word).toBe('基本达标');
    expect(gradeOf(65).word).toBe('需关注');
    expect(gradeOf(40).word).toBe('待改善');
  });

  it('lifts the score by the communities a planned site closes', () => {
    const s = lifeCircleScore(load('zj-b'));
    const c = s.categories.find((x) => x.cat === '菜市场')!;
    expect(scoreWith(s, '菜市场', 0)!.after).toBe(s.walk);
    const all = scoreWith(s, '菜市场', c.measured)!;
    expect(all.catAfter).toBe(1);
    expect(all.after).toBeGreaterThan(s.walk);
    // one category of five going from its share to 100%: a fifth of the gap, in points
    expect(Math.abs(all.after - (s.walk + (100 * (1 - c.walk!)) / 5))).toBeLessThanOrEqual(1);
  });
});
