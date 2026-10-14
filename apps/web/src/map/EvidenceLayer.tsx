/**
 * Two quiet SVG layers over the canvases and under the codes (The Codes Win Rule):
 *  - 步行路线证据: the straight line from the community to the facility its check routed to (thin,
 *    dashed), the real Baidu walking route (a solid ink line on a subtle white casing, drawn on in
 *    600 ms), and both ends marked.
 *  - a citation's places (问询): gray areas outlined, facilities ringed, a simulated site pinned; the
 *    communities light through their own codes and plates.
 */
import type { XY } from '@zoudedao/core';
import { Pg } from '../components/Icons.js';
import type { View } from '../geo/view.js';
import { catColor, STAT_ICON, type Model } from '../model/derive.js';
import type { MapSpot } from '../model/spots.js';
import { textWidth } from './layout.js';
import { COL } from './paint.js';

const d = (v: View, pts: readonly XY[]) =>
  pts.map((p, i) => `${i ? 'L' : 'M'}${v.x(p[0]).toFixed(1)} ${v.y(p[1]).toFixed(1)}`).join('');

export function EvidenceLayer({
  view,
  from,
  to,
  path,
  routeKey,
  ruleM,
  tone = 'pseudo',
}: {
  view: View;
  /** the community's point */
  from: XY;
  /**
   * the rule's distance: the community's own straight circle is drawn around it (what 画圈 claims for
   * this community), so a facility inside it reached only by a longer walk reads as 伪覆盖 at a glance
   */
  ruleM?: number;
  /** the check's verdict colours the circle (伪覆盖 red, 盲区 slate, else ink) */
  tone?: 'pseudo' | 'blind' | 'ink';
  /** the facility's POI point (the straight line's end), when known */
  to: XY | null;
  /** the walking route, once it has arrived */
  path: readonly XY[] | null;
  /** a new route draws on again */
  routeKey: string;
}) {
  const [fx, fy] = [view.x(from[0]), view.y(from[1])];
  const end = path?.length ? path[path.length - 1]! : null;
  const start = path?.length ? path[0]! : null;
  return (
    <svg
      className="layer evidence"
      viewBox={`0 0 ${view.width} ${view.height}`}
      aria-hidden="true"
      data-state={path ? 'route' : 'straight'}
    >
      {ruleM ? (
        // this community's own straight 1 km: a pale disc in its verdict colour, unlike the centre's
        // dashed 15′ circle (which steps aside while a route is shown); its tag ("A-11 · 直线 1 公里")
        // is placed with the other labels (layout.ts), clear of codes, names and cards
        <circle className={`ev-ring t-${tone}`} cx={fx} cy={fy} r={ruleM * view.s} strokeWidth={1.2} />
      ) : null}
      {to ? (
        <g className="ev-straight">
          <line x1={fx} y1={fy} x2={view.x(to[0])} y2={view.y(to[1])} stroke="#fff" strokeWidth={3.2} />
          <line
            x1={fx}
            y1={fy}
            x2={view.x(to[0])}
            y2={view.y(to[1])}
            stroke={COL.ink2}
            strokeWidth={1.3}
            strokeDasharray="5 4"
          />
        </g>
      ) : null}
      {path && path.length > 1 ? (
        <g key={routeKey} className="ev-route">
          <path
            className="ev-draw"
            d={d(view, path)}
            pathLength={1}
            stroke="#fff"
            strokeWidth={6}
            opacity={0.92}
          />
          <path className="ev-draw" d={d(view, path)} pathLength={1} stroke={COL.ink} strokeWidth={2.4} />
          {start ? (
            <circle
              cx={view.x(start[0])}
              cy={view.y(start[1])}
              r={4}
              fill={COL.ink}
              stroke="#fff"
              strokeWidth={1.8}
            />
          ) : null}
          {end ? (
            <circle
              className="ev-end"
              cx={view.x(end[0])}
              cy={view.y(end[1])}
              r={4.6}
              fill="#fff"
              stroke={COL.ink}
              strokeWidth={2.2}
            />
          ) : null}
        </g>
      ) : null}
      {to ? (
        // the straight line's end: the facility's own point (its mark stands at its entrance)
        <circle
          cx={view.x(to[0])}
          cy={view.y(to[1])}
          r={3.2}
          fill={COL.ink2}
          stroke="#fff"
          strokeWidth={1.4}
        />
      ) : null}
    </svg>
  );
}

export function SpotLayer({ view, model, spot }: { view: View; model: Model; spot: MapSpot }) {
  const areas = model.data.gray_areas ?? [];
  return (
    <svg className="layer spot" viewBox={`0 0 ${view.width} ${view.height}`} aria-hidden="true">
      {spot.gray.map((i) => {
        const g = areas[i];
        if (!g) return null;
        const path = g.rings.map((r) => d(view, r) + 'Z').join('');
        return (
          <path
            key={`g${i}`}
            d={path}
            fillRule="evenodd"
            fill="rgba(63,74,90,0.07)"
            stroke={COL.blind}
            strokeWidth={1.4}
            strokeDasharray="5 3"
          />
        );
      })}
      {spot.sites.map((s) => (
        <g key={s.key}>
          <circle
            cx={view.x(s.xy[0])}
            cy={view.y(s.xy[1])}
            r={11}
            fill="#fff"
            stroke={COL.ink}
            strokeWidth={1.8}
            strokeDasharray="3 2.4"
          />
          <path
            d={`M${view.x(s.xy[0]) - 4.5} ${view.y(s.xy[1])}h9M${view.x(s.xy[0])} ${view.y(s.xy[1]) - 4.5}v9`}
            stroke={COL.ink}
            strokeWidth={1.8}
            strokeLinecap="round"
          />
        </g>
      ))}
    </svg>
  );
}

type Box = { x: number; y: number; w: number; h: number };
const meets = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * A citation's facilities as marks ringed in cobalt, with their names (the map may be showing another
 * category's marks). Codes win: a mark that would cover a code pill is nudged a few pixels off it, as
 * the layout nudges every facility mark; a name takes the side that keeps clear of codes, the other
 * cited marks and names, or is left out.
 */
export function SpotMarks({ view, spot, avoid }: { view: View; spot: MapSpot; avoid: readonly Box[] }) {
  const marks = spot.pois.map((p) => {
    let x = view.x(p.xy[0]);
    let y = view.y(p.xy[1]);
    const box = (cx: number, cy: number): Box => ({ x: cx - 16, y: cy - 16, w: 32, h: 32 });
    if (avoid.some((b) => meets(box(x, y), b))) {
      search: for (const r of [10, 14, 18, 24, 30, 38, 46]) {
        for (let k = 0; k < 12; k++) {
          const a = (k * Math.PI) / 6;
          const nx = x + Math.cos(a) * r;
          const ny = y + Math.sin(a) * r;
          if (!avoid.some((b) => meets(box(nx, ny), b))) {
            x = nx;
            y = ny;
            break search;
          }
        }
      }
    }
    return { p, x, y };
  });
  // names keep off the codes, the cited marks and each other; one that finds no room is left out
  const placed: Box[] = marks.map((m) => ({ x: m.x - 16, y: m.y - 16, w: 32, h: 32 }));
  const hit = (a: Box) => avoid.some((b) => meets(a, b)) || placed.some((b) => meets(a, b));
  return (
    <div className="layer spot-marks" aria-hidden="true">
      {marks.map(({ p, x, y }) => {
        const cat = (p.category in STAT_ICON ? p.category : '超市') as keyof typeof STAT_ICON;
        const w = textWidth(p.name, 12) + 14;
        const right = { x: x + 21, y: y - 10, w, h: 20 };
        const left = { x: x - 21 - w, y: y - 10, w, h: 20 };
        const side =
          !hit(right) && right.x + w < view.width - 8 ? 'right' : !hit(left) && left.x > 8 ? 'left' : null;
        if (side) placed.push(side === 'right' ? right : left);
        return (
          <div key={p.key}>
            <span className="poi spot-poi" style={{ left: x, top: y, ['--c' as string]: catColor(cat) }}>
              <Pg id={STAT_ICON[cat]} />
            </span>
            {side ? (
              <span
                className={'spot-name' + (side === 'left' ? ' flip' : '')}
                style={{ left: side === 'right' ? x + 21 : x - 21, top: y }}
              >
                {p.name}
              </span>
            ) : null}
          </div>
        );
      })}
      {spot.sites.map((s) =>
        s.label ? (
          <span
            key={s.key}
            className="spot-name"
            style={{ left: view.x(s.xy[0]) + 16, top: view.y(s.xy[1]) }}
          >
            {s.label}
          </span>
        ) : null,
      )}
    </div>
  );
}
