/**
 * The finding pinned on the map without being asked, on the 圈内设施 page only: one facility the
 * straight circle claims and the 15′ walk does not reach. On the 体检单 the map pins nothing until a
 * community is picked — its route card (evidenceCard.tsx) is the finding. Every number is read from the
 * analysis (and re-read at the elder's speed when that is chosen).
 */
import type { ReactNode } from 'react';
import { stationKey } from '@zoudedao/core';
import { Pg } from '../components/Icons.js';
import { CAT_COLOR, CAT_ICON, fmtInt, poiName, type Model } from '../model/derive.js';
import type { FacilityMark } from '../model/facilities.js';
import type { CardSpec } from './layout.js';

/** A card: its heading carries the status (a small tag, never a label stacked above it) and its number. */
export interface FindingItem {
  spec: CardSpec;
  title: ReactNode;
  body: ReactNode;
  /** quiet lines under the body (provenance, the assigned school, a hint) */
  foot?: ReactNode;
  /** the card does something when clicked (a unit's card draws its walking route) */
  onOpen?(): void;
  /** what clicking it does, for screen readers */
  openLabel?: string;
  /** the card can be closed (the route evidence; Esc too) */
  onClose?(): void;
  /** an extra class (the route evidence is wider) */
  cls?: string;
  /** announce the card's changes (the route arriving) */
  live?: boolean;
}

export const N = ({ children }: { children: ReactNode }) => <span className="num">{children}</span>;
/** number and unit never wrap apart */
export const U = ({ n, unit }: { n: string; unit: string }) => (
  <span className="nw">
    <N>{n}</N> {unit}
  </span>
);

const ONLY: Partial<Record<string, string>> = {
  幼儿园: '所幼儿园',
  小学: '所小学',
  社区卫生: '处社区卫生服务站',
  地铁: '个地铁站',
};

function facilityCard(marks: readonly FacilityMark[]): FindingItem | null {
  for (const cat of ['小学', '幼儿园', '社区卫生', '菜市场', '药店', '地铁'] as const) {
    const inCircle = marks.filter((m) => m.cat === cat && m.inCircle);
    // a walk that rounds to 15′ would read "步行 15′ … 15′ 走不到": pin only clear misses
    const miss = inCircle
      .filter((m) => !m.reach && Number.isFinite(m.t) && Math.round(m.t / 60) > 15)
      .sort((a, b) => a.straight - b.straight)[0];
    if (!miss) continue;
    const only = inCircle.length === 1 ? `；圈里只有这一${ONLY[cat] ?? `处${cat}`}` : '';
    const name = cat === '地铁' ? `${stationKey(miss.face.name)}站` : poiName(miss.face.name);
    const icon = CAT_ICON[cat] ?? 'pg-metro';
    return {
      spec: {
        key: `fac-${cat}`,
        anchor: miss.face.navi_xy ?? miss.face.xy,
        tone: 'ink',
        poi: miss.key,
        prefer: ['up', 'up-left', 'up-right', 'left', 'right', 'down-left'],
      },
      title: (
        <>
          <Pg id={icon} color={CAT_COLOR[cat]} />
          {name}
        </>
      ),
      body: (
        <>
          {cat}，画圈有、<N>15′</N> 走不到：直线 <U n={fmtInt(miss.straight)} unit="m" />
          ，步行要 <N>{Math.round(miss.t / 60)}′</N>
          {only}。
        </>
      ),
    };
  }
  return null;
}

export function findingItems(
  model: Model,
  opts: { view: 'sheet' | 'fac'; marks: readonly FacilityMark[] },
): FindingItem[] {
  const f = opts.view === 'fac' ? facilityCard(opts.marks) : null;
  return f ? [f] : [];
}
