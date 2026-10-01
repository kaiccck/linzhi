/**
 * 买菜替代 — for a unit whose 菜市场 check is a gap, the nearest shop within the rule on foot where
 * vegetables can be bought (a 生鲜超市, a 果蔬店, a chain supermarket; core freshKind). The engine
 * found and routed it; it is shown beside the verdict, never instead of it: the 菜市场 gap and every
 * count stay as they are.
 */
import type { FreshAlternative, Poi } from '@zoudedao/core';
import { distWords, fmtInt, isWalkGap, poiName, type Model, type Unit } from './derive.js';
import type { FacilityMark } from './facilities.js';

/** The unit's 买菜替代 under the model's rule set: the shop, none found (null), or not looked (undefined). */
export function freshAlt(model: Model, unit: Unit): FreshAlternative | null | undefined {
  const check = unit.checks['菜市场'];
  if (!isWalkGap(check, model.ruleOf['菜市场'])) return undefined;
  return check.alt;
}

/** 菜市场 gaps, how many have a shop to buy vegetables at, how many were looked at and have none. */
export function freshTally(model: Model): { gaps: number; withAlt: number; none: number } {
  let gaps = 0;
  let withAlt = 0;
  let none = 0;
  for (const u of model.units) {
    const check = u.checks['菜市场'];
    if (!isWalkGap(check, model.ruleOf['菜市场'])) continue;
    gaps++;
    if (check.alt) withAlt++;
    else if (check.alt === null) none++;
  }
  return { gaps, withAlt, none };
}

/**
 * The one line under the 菜市场 sheet: of the units without a market, how many can still buy
 * vegetables within the rule. Null with no gap, or when the result never looked (an older analysis).
 */
export function freshLine(model: Model): string | null {
  const { gaps, withAlt, none } = freshTally(model);
  if (!gaps || withAlt + none === 0) return null;
  const rule = distWords(model.ruleOf['菜市场']);
  if (!withAlt) return `缺菜市场的 ${gaps} 个小区，步行 ${rule}内也没有超市或菜店。`;
  return `缺菜市场的 ${gaps} 个小区，${withAlt} 个步行 ${rule}内能买到菜。`;
}

/**
 * The same under the panel's list, whose title already counts the gaps ("走不到菜市场的 10 个小区"):
 * "其中 8 个步行 1 公里内能在超市或菜店买菜".
 */
export function freshNote(model: Model): string | null {
  const { gaps, withAlt, none } = freshTally(model);
  if (!gaps || withAlt + none === 0) return null;
  const rule = distWords(model.ruleOf['菜市场']);
  if (!withAlt) return `步行 ${rule}内也没有超市或菜店`;
  return `其中 ${withAlt} 个步行 ${rule}内能在超市或菜店买菜`;
}

/** "可在 联华超市(申城佳苑店) 买菜 · 步行 358 m" — the route card's and the report's words. */
export const freshText = (alt: FreshAlternative) =>
  `可在 ${poiName(alt.name)} 买菜 · 步行 ${fmtInt(alt.route_m)} m`;

/**
 * The shops as map marks beside the 菜市场 facilities: one per shop (several units can share one),
 * standing where the walk ends (its entrance). Drawn smaller and dashed: they are not markets.
 */
export function freshMarks(model: Model): FacilityMark[] {
  const seen = new Map<string, FacilityMark>();
  for (const u of model.units) {
    const alt = freshAlt(model, u);
    if (!alt || seen.has(alt.uid)) continue;
    const face: Poi = {
      uid: alt.uid,
      name: alt.name,
      cat: alt.kind === '超市' ? '超市' : '生鲜超市',
      xy: alt.xy,
      navi_xy: null,
      source: 'baidu',
    };
    seen.set(alt.uid, {
      key: `fresh:${alt.uid}`,
      cat: face.cat as FacilityMark['cat'],
      face,
      inCircle: false,
      reach: true,
      t: Infinity,
      straight: Math.hypot(alt.xy[0], alt.xy[1]),
      fresh: true,
    });
  }
  return [...seen.values()];
}
