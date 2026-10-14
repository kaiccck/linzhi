/**
 * How a unit looks on the map and in the lists: the verdict of the category chosen in the panel
 * (体检 and 规划), the worst of the three (the printed report), or no verdict at all (圈内设施, and
 * while 走一遍 plays — The Verdict Waits).
 */
import type { FacilityCheck, HardCategory } from '@zoudedao/core';
import { checkState } from './checks.js';
import { type Unit } from './derive.js';

/** `edge-over`: borderline and past the line (tinted as 伪覆盖, ringed as 临界). */
export type Look = 'ok' | 'pseudo' | 'blind' | 'edge' | 'edge-over' | 'pending' | 'none' | 'na' | 'neutral';

export function checkLook(s: FacilityCheck): Look {
  const { state, over } = checkState(s);
  return state === 'edge' && over ? 'edge-over' : state;
}

export const categoryLook = (cat: HardCategory) => (u: Unit) => checkLook(u.checks[cat]);

/** The worst of a unit's three checks (the report's map shows them all at once). */
export function worstLook(u: Unit): Look {
  const looks = Object.values(u.checks).map(checkLook);
  for (const l of ['blind', 'none', 'pseudo', 'edge-over', 'pending', 'edge'] as const)
    if (looks.includes(l)) return l === 'none' ? 'blind' : l;
  return 'ok';
}

export const neutralLook = () => 'neutral' as const;

/** The class a unit code (on the map or in a list) wears for a look. */
export function lookClass(l: Look): string {
  switch (l) {
    case 'none':
      return 's-blind';
    case 'edge':
      return 's-edge';
    case 'edge-over':
      return 's-edge over';
    case 'neutral':
    case 'na':
      return 's-quiet';
    default:
      return 's-' + l;
  }
}

/** What a look is called (spoken labels, titles). */
export const LOOK_WORD: Record<Look, string> = {
  ok: '走得到',
  pseudo: '伪覆盖',
  blind: '盲区',
  edge: '临界',
  'edge-over': '临界（已超出）',
  pending: '待核',
  none: '清单里没有',
  na: '无对口小学',
  neutral: '',
};
