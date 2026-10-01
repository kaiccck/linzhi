/**
 * 灰色区域 (技术设计文档 §7.4): where the nearest community is missing facilities on foot. The engine
 * writes nested levels — at least 1, 2 or 3 of 小学 / 菜市场 / 药店 not walkable within the rule
 * (kind 'gap') — plus the part caused by 伪覆盖 (kind 'pseudo'). Rings hold holes; fill even-odd.
 */
import type { GrayArea, XY } from '@zoudedao/core';
import { CATS, type Model, type Unit } from './derive.js';

export interface GrayLevel {
  kind: GrayArea['kind'];
  /** missing hard categories, at least */
  min: number;
  areaKm2: number;
  /** separate patches (outer rings) */
  patches: number;
  /** communities whose point lies inside, worst first as on the board */
  units: Unit[];
  rings: XY[][];
}

/** Even-odd point-in-polygon over every ring of an area (holes included). */
export function insideRings(rings: readonly (readonly XY[])[], x: number, y: number): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]!;
      const [xj, yj] = ring[j]!;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** The gray levels of an analysis, 'gap' levels by rising severity, then 'pseudo'. Empty when none. */
export function grayLevels(model: Model): GrayLevel[] {
  const areas = (model.data.gray_areas ?? []).filter((g) => g.rings.length > 0);
  const order = (g: GrayArea) => (g.kind === 'gap' ? 0 : 10) + g.min_missing;
  return [...areas]
    .sort((a, b) => order(a) - order(b))
    .map((g) => ({
      kind: g.kind,
      min: g.min_missing,
      areaKm2: g.area_m2 / 1e6,
      patches: g.meta?.length ? g.meta.filter((m) => !m.hole).length : g.rings.length,
      units: model.boardOrder.filter((u) => insideRings(g.rings, u.centroid[0], u.centroid[1])),
      rings: g.rings,
    }));
}

/** The legend's words: "步行 1 公里内缺少小学、菜市场或药店" from the rule and the hard categories. */
export function grayRuleText(ruleM: number): string {
  const km = ruleM % 1000 === 0 ? `${ruleM / 1000} 公里` : `${Math.round(ruleM)} 米`;
  const cats = CATS.length > 1 ? `${CATS.slice(0, -1).join('、')}或${CATS.at(-1)}` : CATS[0]!;
  return `步行 ${km}内缺少${cats}`;
}

export const hasGray = (model: Model) => (model.data.gray_areas ?? []).some((g) => g.rings.length > 0);
