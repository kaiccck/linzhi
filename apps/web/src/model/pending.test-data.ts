/**
 * zj-a with its pharmacy checks at 川杨新苑四期 and 虹御公寓 as they were before the nearest top-up
 * (apps/server/scripts/augment-zj-a.ts, 2026-09-29): 待核, a nearer pharmacy never routed. The sample
 * has no pending check any more; the panel's pending paths (the 待核 chip, the rows at the foot, the
 * route card's reason) are tested on this copy. Mirrors packages/agent/test/helpers.ts.
 */
import type { AnalysisResult, FacilityCheck } from '@zoudedao/core';

export function withPending(data: AnalysisResult): AnalysisResult {
  const r = structuredClone(data);
  const pharmacy = (name: string): FacilityCheck =>
    r.communities.find((c) => c.name === name)!.checks['药店'];
  const nearer = (list: [string, string, number][]) =>
    list.map(([name, uid, straight_m]) => ({ name, uid, straight_m }));
  Object.assign(pharmacy('川杨新苑四期'), {
    route_m: 1031,
    dur_s: 881,
    via: '益丰大药房(铭康店)',
    status: '临界',
    status_main: '伪覆盖',
    borderline: true,
    route_upper_bound: true,
    verified: false,
    unrouted_nearer: nearer([
      ['益丰大药房(川杨店)', 'cbd273a8c6482fe807026f10', 177.9],
      ['雷允上(川杨新苑三期店)', '202f3669a65b2eeac7f0256f', 341.3],
    ]),
  });
  Object.assign(pharmacy('虹御公寓'), {
    route_m: 1124,
    dur_s: 962,
    via: '益丰大药房(高木桥店)',
    status: '伪覆盖',
    status_main: '伪覆盖',
    route_upper_bound: true,
    verified: false,
    unrouted_nearer: nearer([['益丰大药房(孙桥路店)', '1615ed8d421936b22efaa703', 582.5]]),
  });
  return r;
}
