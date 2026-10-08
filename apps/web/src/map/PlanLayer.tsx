/**
 * 规划 on the map. Siting suggestions are numbered white pins ringed in their category's hue; a site
 * the planner places (假如在这里开一家…) is a pin with a dashed ring while it is an estimate, a solid
 * one once measured. Both carry their words beside them ("新增后可覆盖 6 个小区" + 估算 / 已核验) and
 * are placed by the layout like everything else: codes win, a pin moves off them with a tick back to
 * its point. From the planner's site, a thin link runs to every unit it would bring within the rule
 * (dashed while estimated, teal once measured), and those units' codes carry a teal tick.
 */
import type { HardCategory } from '@zoudedao/core';
import type { View } from '../geo/view.js';
import { CAT_ICON } from '../model/derive.js';
import type { SitePin, WhatIfEstimate } from '../model/siting.js';
import type { SiteInput } from './layout.js';
import { COL } from './paint.js';

/** The 规划 view's pins: the planner's site first (it wins any contest for room), then the suggestions. */
export function siteInputs(
  cat: HardCategory,
  pins: readonly SitePin[],
  estimate: WhatIfEstimate | null,
  measured: string[] | null,
): SiteInput[] {
  const icon = CAT_ICON[cat]!;
  const out: SiteInput[] = [];
  if (estimate) {
    const n = measured ? measured.length : estimate.flips.length;
    out.push({
      key: 'whatif',
      xy: estimate.xy,
      kind: 'whatif',
      cat,
      icon,
      label: `新增${cat}：${n} 个小区走得到`,
      verified: !!measured,
      aria: `假如在这里开一家${cat}：${measured ? '实测' : '估算'} ${n} 个小区因此步行规则距离内走得到`,
    });
  }
  for (const p of pins) {
    if (p.cat !== cat) continue;
    out.push({
      key: p.key,
      xy: p.xy,
      kind: 'site',
      cat,
      icon,
      rank: p.rank,
      label: `新增后可覆盖 ${p.covers.length} 个小区`,
      verified: p.verified,
      aria: `建议选址 ${p.rank}：新增${cat}，可覆盖 ${p.covers.length} 个小区（${p.verified ? '已核验' : '估算'}）`,
    });
  }
  return out;
}

/** Links from the planner's site to the units it would bring within the rule (under the pins). */
export function PlanLines({
  view,
  estimate,
  measured,
}: {
  view: View;
  estimate: WhatIfEstimate | null;
  measured: string[] | null;
}) {
  if (!estimate) return null;
  const units = measured
    ? estimate.demand.filter((u) => measured.includes(u.name))
    : estimate.flips.map((f) => f.unit);
  if (!units.length) return null;
  const x1 = view.x(estimate.xy[0]);
  const y1 = view.y(estimate.xy[1]);
  return (
    <svg className="layer plan-lines" viewBox={`0 0 ${view.width} ${view.height}`} aria-hidden="true">
      {units.map((u) => {
        const x2 = view.x(u.centroid[0]);
        const y2 = view.y(u.centroid[1]);
        return (
          <g key={u.code}>
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#fff" strokeWidth={3.4} strokeLinecap="round" />
            <line
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke={measured ? COL.ok : COL.ink2}
              strokeOpacity={measured ? 0.95 : 0.7}
              strokeWidth={measured ? 1.5 : 1.2}
              strokeDasharray={measured ? undefined : '4 3'}
              strokeLinecap="round"
            />
          </g>
        );
      })}
    </svg>
  );
}
