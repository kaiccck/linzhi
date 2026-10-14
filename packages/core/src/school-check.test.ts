import { describe, expect, it } from 'vitest';
import { schoolCheck, policyCatchment, schoolPendingReason, withSchoolCheck } from './school-check.js';
import { classifyCheck } from './coverage.js';
import type { CatchmentCheck, Community } from './types.js';

const assigned: CatchmentCheck = {
  school: '对口小学（东校区）',
  school_uid: 'assigned',
  assignment_status: 'confirmed',
  straight_m: 800,
  route_m: 1500,
  dur_s: 1250,
  source: 'official-2026',
  matched_by: 'lane:测试路1弄',
};

describe('policy-only primary school checks', () => {
  it('uses the assigned school even when a different school has a shorter walk', () => {
    const community = {
      name: '测试小区',
      pts: [],
      centroid: [0, 0],
      catchment: assigned,
      checks: {
        小学: {
          straight_m: 100,
          route_m: 120,
          dur_s: 100,
          via: '最近小学',
          via_uid: 'nearest',
          ...classifyCheck({ straight_m: 100, route_m: 120 }),
        },
      },
    } as unknown as Community;
    expect(withSchoolCheck(community).checks.小学).toMatchObject({
      via: assigned.school,
      via_uid: 'assigned',
      route_m: 1500,
      dur_s: 1250,
      straight_m: 800,
      status_main: '伪覆盖',
      verified: true,
      school_assignment: 'confirmed',
    });
    expect(community.checks.小学.via_uid).toBe('nearest');
  });
  it('invalidates the old nearest-campus guess, including its endpoint and time', () => {
    const legacy = {
      ...assigned,
      assignment_status: undefined,
      note: '对口表未写校区，找到 2 个校区，取步行较近的一个',
    };
    const policy = policyCatchment(legacy)!;
    expect(policy).toMatchObject({
      school: '对口小学',
      assignment_status: 'campus_pending',
      route_m: null,
      dur_s: null,
    });
    expect(policy.school_uid).toBeUndefined();
    const check = schoolCheck({ catchment: legacy });
    expect(check).toMatchObject({ verified: false, route_m: -1, dur_s: -1 });
    expect(check.via).toBeUndefined();
    expect(schoolPendingReason(check)).toContain('校区待核实');
  });
  it('leaves unmatched and unmeasured schools pending without substituting a destination', () => {
    expect(schoolCheck({})).toMatchObject({ school_assignment: 'unmatched', verified: false });
    expect(schoolCheck({ catchment: { ...assigned, route_m: null, dur_s: null } })).toMatchObject({
      school_assignment: 'route_pending',
      verified: false,
      route_m: -1,
    });
  });
});
