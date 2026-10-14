/**
 * 体检评分: one number for a 15-minute life circle, and the number the circle method would give.
 *
 * For each checked category, the share of the communities that can walk to one within the rule
 * (实测得分) and the share a straight-line circle of the same radius would count as covered (画圈得分);
 * pending checks count in neither. The score is the mean share × 100. Same data, same rule, one
 * difference — how the distance was measured — so the gap between the two scores is the overstatement
 * of drawing circles, in points.
 */
import type { HardCategory } from '@zoudedao/core';
import { isPendingCheck } from '@zoudedao/core';
import { isCircleGap, isWalkGap, type Model } from '@web/model/derive';

export interface CategoryScore {
  cat: HardCategory;
  /** communities whose check is measured (pending ones left out) */
  measured: number;
  /** share walking to one within the rule, 0–1 (null: none measured) */
  walk: number | null;
  /** share a straight circle of the rule's radius covers, 0–1 */
  circle: number | null;
  pending: number;
}

export interface LifeCircleScore {
  /** 0–100, mean over the categories with measured checks */
  walk: number;
  circle: number;
  categories: CategoryScore[];
  /** checks not counted (待核) */
  pending: number;
  grade: Grade;
}

export type Grade = {
  word: '良好' | '基本达标' | '需关注' | '待改善';
  tone: 'ok' | 'edge' | 'pseudo' | 'blind';
};

export function gradeOf(score: number): Grade {
  if (score >= 90) return { word: '良好', tone: 'ok' };
  if (score >= 75) return { word: '基本达标', tone: 'edge' };
  if (score >= 60) return { word: '需关注', tone: 'pseudo' };
  return { word: '待改善', tone: 'blind' };
}

export function lifeCircleScore(model: Model): LifeCircleScore {
  const categories = model.cats.map((cat): CategoryScore => {
    const rule = model.ruleOf[cat];
    const measured = model.units.map((u) => u.checks[cat]).filter((s) => s.verified !== false);
    // a 商办 compound's 小学 is no verdict and nothing pending: it counts in neither
    const pending = model.units.filter((u) => isPendingCheck(u.checks[cat])).length;
    if (!measured.length) return { cat, measured: 0, walk: null, circle: null, pending };
    const walkOk = measured.filter((s) => !isWalkGap(s, rule)).length;
    const circleOk = measured.filter((s) => !isCircleGap(s, rule)).length;
    return {
      cat,
      measured: measured.length,
      walk: walkOk / measured.length,
      circle: circleOk / measured.length,
      pending,
    };
  });
  const scored = categories.filter((c) => c.walk !== null);
  const mean = (f: (c: CategoryScore) => number) =>
    scored.length ? Math.round((100 * scored.reduce((s, c) => s + f(c), 0)) / scored.length) : 0;
  const walk = mean((c) => c.walk!);
  return {
    walk,
    circle: mean((c) => c.circle!),
    categories,
    pending: categories.reduce((s, c) => s + c.pending, 0),
    grade: gradeOf(walk),
  };
}

export interface ScoreShift {
  /** the score now, and with the site */
  before: number;
  after: number;
  /** the category's coverage now and with the site, 0–1 */
  catBefore: number;
  catAfter: number;
}

/**
 * 规划补点 in the checkup's own terms: `n` more communities walking to `cat` within the rule (the
 * gaps a planned site closes — measured ones, never pending) lift the category's coverage and so the
 * score. Null when the category has nothing measured.
 */
export function scoreWith(score: LifeCircleScore, cat: HardCategory, n: number): ScoreShift | null {
  const c = score.categories.find((x) => x.cat === cat);
  if (!c || c.walk === null || !c.measured) return null;
  const catAfter = Math.min(1, c.walk + n / c.measured);
  const scored = score.categories.filter((x) => x.walk !== null);
  const after = Math.round(
    (100 * scored.reduce((s, x) => s + (x.cat === cat ? catAfter : x.walk!), 0)) / scored.length,
  );
  return { before: score.walk, after, catBefore: c.walk, catAfter };
}
