/**
 * A check's state as its material shows it — on the map, in the 体检单 grid, on the route card — read
 * off the model's checks (the engine judged each one).
 */
import { schoolNotApplicable, schoolPendingReason, type FacilityCheck } from '@zoudedao/core';

/** A check's state, as its material shows it (DESIGN.md "Verdict cell"). */
/** `na`: a check that does not apply (a 商办 compound has no 对口小学) — no verdict, nothing pending. */
export type CheckState = 'ok' | 'pseudo' | 'blind' | 'edge' | 'pending' | 'none' | 'na';

/** The check's own verdict (the engine judged it). */
export function checkState(s: FacilityCheck): { state: CheckState; over: boolean } {
  if (schoolNotApplicable(s)) return { state: 'na', over: false };
  if (schoolPendingReason(s)) return { state: 'pending', over: false };
  if (s.route_m < 0 || s.route_basis === 'none') return { state: 'none', over: false };
  if (s.verified === false) return { state: 'pending', over: false };
  if (s.status === '临界') return { state: 'edge', over: s.status_main !== '覆盖' };
  if (s.status === '盲区') return { state: 'blind', over: true };
  if (s.status === '伪覆盖') return { state: 'pseudo', over: true };
  return { state: 'ok', over: false };
}
