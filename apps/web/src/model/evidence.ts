/**
 * 步行路线证据: what the map and its card say about one unit's check once its real walking route is
 * on screen — the straight line from the community to the facility the check routed to, the route's
 * own length, and the minutes at the walker's speed. Every number is read from the analysis and the
 * route; nothing is typed in.
 */
import type { CatchmentCheck, FacilityCheck, HardCategory, XY } from '@zoudedao/core';
import { viaName } from '@zoudedao/core';
import type { RouteEvidence } from '../data/route.js';
import { distWords, fmtInt, poiName, type Model, type Unit } from './derive.js';
import { checkLook, type Look } from './looks.js';

/**
 * 含过街等待: a sensitivity estimate of the time lost at crossings. Baidu's walking-route times, which
 * count crossing waits, run 3–7 % over distance ÷ speed; the toggle adds 5 % to walking time. It moves
 * the time field and the readouts, never a verdict (the checks are distances).
 */
export const CROSSING = 1.05;

export interface EvidenceBase {
  unit: Unit;
  check: FacilityCheck;
  cat: HardCategory;
  look: Look;
  /** the facility the check routed to (its short name) */
  facility: string;
  /** the community's point (where the check's route starts) */
  from: XY;
  /** the facility's POI point: the straight line's end */
  facilityXY: XY | null;
  /** community → facility, straight, metres */
  straightM: number;
}

/** The facility a check names, found among the analysis' POIs of the category (by name). */
function facilityPoint(model: Model, cat: HardCategory, name: string | undefined): XY | null {
  if (!name) return null;
  const kin: Record<HardCategory, string[]> = {
    幼儿园: ['幼儿园'],
    小学: ['小学'],
    菜市场: ['菜市场', '生鲜超市'],
    药店: ['药店'],
    社区卫生: ['社区卫生'],
  };
  const hit =
    model.data.pois.find((p) => p.name === name && kin[cat].includes(p.cat)) ??
    model.data.pois.find((p) => p.name === name);
  return hit ? hit.xy : null;
}

/** What is known before the route arrives: the unit, its check, and the straight line. */
export function evidenceBase(model: Model, code: string, cat: HardCategory): EvidenceBase | null {
  const unit = model.units.find((u) => u.code === code);
  if (!unit) return null;
  const check = unit.checks[cat];
  const facilityXY = facilityPoint(model, cat, check.via);
  const straightM = facilityXY
    ? Math.hypot(facilityXY[0] - unit.centroid[0], facilityXY[1] - unit.centroid[1])
    : (check.via_straight_m ?? check.straight_m);
  return {
    unit,
    check,
    cat,
    look: checkLook(check),
    facility: poiName(viaName(check) ?? check.nearest_straight ?? ''),
    from: unit.centroid,
    facilityXY,
    straightM,
  };
}

/**
 * Why a check has no route to draw (asked before any request): nothing of the category in the
 * inventory, nothing within the rule by straight line (a proven lower bound, never routed), or not
 * routed for this unit on its own yet (待核). Null when the check was routed.
 */
export function noRouteReason(check: FacilityCheck, cat: HardCategory, rule: number): string | null {
  const basis = check.route_basis ?? 'routed';
  if (basis === 'none' || check.straight_m < 0) return `设施清单里没有${cat}，没有可画的步行路线。`;
  if (basis === 'lower_bound')
    return `直线 ${distWords(rule)}内没有${cat}，这一项不需要算路：步行至少 ${fmtInt(check.route_m)} m。`;
  if (basis === 'estimated' || check.verified === false)
    return '这一项还没有对这个小区单独算路（待核），没有可画的实测路线。';
  return null;
}

export interface EvidenceFacts extends EvidenceBase {
  path: XY[];
  /** the route's own length, metres */
  routeM: number;
  /** walking minutes at the profile's speed (with 含过街等待, 5 % more) */
  minutes: number;
  /** the check's own route (batch routing) when it differs from this route by more than 20 m */
  checkRouteM: number | null;
  source: RouteEvidence['source'];
}

export function evidenceFacts(
  model: Model,
  base: EvidenceBase,
  route: RouteEvidence,
  opts: { scale: number; crossing: boolean },
): EvidenceFacts {
  const facilityXY =
    base.facilityXY ??
    route.facility?.xy ??
    facilityPoint(model, base.cat, route.facility?.name) ??
    route.path[route.path.length - 1]!;
  const straightM = base.facilityXY
    ? base.straightM
    : Math.hypot(facilityXY[0] - base.from[0], facilityXY[1] - base.from[1]);
  const seconds = (route.distance_m / model.vAdult) * opts.scale * (opts.crossing ? CROSSING : 1);
  const own = base.check.route_m;
  return {
    ...base,
    facility: base.facility || poiName(route.facility?.name ?? ''),
    facilityXY,
    straightM,
    path: route.path,
    routeM: route.distance_m,
    minutes: Math.round(seconds / 60),
    checkRouteM: own > 0 && Math.abs(own - route.distance_m) > 20 ? own : null,
    source: route.source,
  };
}

/** "对口：孙桥小学（申江校区）· 步行 1,676 m" — the assigned school, which is not always the nearest. */
export function catchmentText(c: CatchmentCheck): string {
  return `对口：${poiName(c.school)} · ${c.route_m !== null ? `步行 ${fmtInt(c.route_m)} m` : '步行未测'}`;
}
