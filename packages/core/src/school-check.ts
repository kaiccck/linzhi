import { classifyCheck } from './coverage.js';
import type { CatchmentCheck, Community, FacilityCheck } from './types.js';

/** Older snapshots selected a nearby campus without policy evidence. Do not reuse that destination. */
export function policyCatchment(c: CatchmentCheck | undefined): CatchmentCheck | undefined {
  if (!c || c.assignment_status) return c;
  if (/对口表未写校区/.test(c.note ?? '')) {
    const rest = { ...c };
    delete rest.school_uid;
    delete rest.school_xy;
    return {
      ...rest,
      school: c.school.replace(/[（(][^）)]*校区[）)]/g, ''),
      assignment_status: 'campus_pending',
      route_m: null,
      dur_s: null,
      straight_m: -1,
      note: '招生地段只明确到学校，具体校区待核实',
    };
  }
  return { ...c, assignment_status: c.straight_m < 0 ? 'location_pending' : 'confirmed' };
}

export function schoolCheck(community: Pick<Community, 'catchment'>, rule = 1000): FacilityCheck {
  const c = policyCatchment(community.catchment);
  if (c?.assignment_status === 'not_applicable') {
    return {
      school_assignment: 'not_applicable',
      straight_m: -1,
      route_m: -1,
      dur_s: -1,
      status: '盲区', // wire-model placeholder; verified=false keeps it out of every verdict
      status_main: '盲区',
      borderline: false,
      route_upper_bound: false,
      verified: false,
      route_basis: 'estimated',
    };
  }
  const assignment = !c ? 'unmatched' : (c.assignment_status ?? 'confirmed');
  const routed =
    c &&
    assignment === 'confirmed' &&
    c.route_m !== null &&
    c.route_m >= 0 &&
    c.dur_s !== null &&
    c.dur_s >= 0;
  const state = assignment === 'confirmed' && !routed ? 'route_pending' : assignment;
  if (!routed) {
    return {
      school_assignment: state,
      straight_m: assignment === 'confirmed' ? c!.straight_m : -1,
      route_m: -1,
      dur_s: -1,
      status: '盲区', // wire-model placeholder; verified=false means no verdict
      status_main: '盲区',
      borderline: false,
      route_upper_bound: false,
      verified: false,
      route_basis: 'estimated',
    };
  }
  return {
    school_assignment: 'confirmed',
    straight_m: c!.straight_m,
    nearest_straight: c!.school,
    route_m: c!.route_m!,
    dur_s: c!.dur_s!,
    via: c!.school,
    ...(c!.school_uid ? { via_uid: c!.school_uid } : {}),
    via_straight_m: c!.straight_m,
    route_basis: 'routed',
    ...classifyCheck({ straight_m: c!.straight_m, route_m: c!.route_m!, rule_m: rule }),
  };
}

export function schoolPendingReason(check: Pick<FacilityCheck, 'school_assignment'>): string | null {
  switch (check.school_assignment) {
    case 'unmatched':
      return '对口小学待核实，暂不计算步行时间';
    case 'campus_pending':
      return '对口校区待核实，暂不计算步行时间';
    case 'location_pending':
      return '对口学校位置待核实，暂不计算步行时间';
    case 'route_pending':
      return '到对口小学的步行路线尚未测得';
    default:
      return null;
  }
}

/** A compound with no 对口小学 by law (商办产权): why, else null. Not pending — there is nothing to wait for. */
export function schoolNotApplicable(check: Pick<FacilityCheck, 'school_assignment'>): string | null {
  return check.school_assignment === 'not_applicable' ? '商办产权，没有对口小学' : null;
}

/** Why a school check carries no verdict (pending, or not applicable), else null. */
export function schoolUnjudged(check: Pick<FacilityCheck, 'school_assignment'>): string | null {
  return schoolPendingReason(check) ?? schoolNotApplicable(check);
}

/**
 * A check still waiting for its verdict (待核实): not measured for this community on its own yet. A school
 * check that does not apply (商办产权) is no verdict either, but nothing is pending on it.
 */
export const isPendingCheck = (check: Pick<FacilityCheck, 'verified' | 'school_assignment'>): boolean =>
  check.verified === false && check.school_assignment !== 'not_applicable';

export function withSchoolCheck<T extends Community>(community: T, rule = 1000): T {
  return {
    ...community,
    ...(community.catchment ? { catchment: policyCatchment(community.catchment) } : {}),
    checks: { ...community.checks, 小学: schoolCheck(community, rule) },
  };
}
