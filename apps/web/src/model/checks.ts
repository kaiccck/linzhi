/**
 * A check's state as its material shows it — on the map, in the 体检单 grid, on the route card — read
 * off the model's checks (the engine judged each one).
 */
import type { FacilityCheck } from '@zoudedao/core';

/** A check's state, as its material shows it (DESIGN.md "Verdict cell"). */
export type CheckState = 'ok' | 'pseudo' | 'blind' | 'edge' | 'pending' | 'none';

/** The check's own verdict (the engine judged it). */
export function checkState(s: FacilityCheck): { state: CheckState; over: boolean } {
  if (s.route_m < 0 || s.route_basis === 'none') return { state: 'none', over: false };
  if (s.verified === false) return { state: 'pending', over: false };
  if (s.status === '临界') return { state: 'edge', over: s.status_main !== '覆盖' };
  if (s.status === '盲区') return { state: 'blind', over: true };
  if (s.status === '伪覆盖') return { state: 'pseudo', over: true };
  return { state: 'ok', over: false };
}
