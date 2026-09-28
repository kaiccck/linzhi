import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { View } from '../geo/view.js';
import { Pg } from '../components/Icons.js';
import { fmtInt, reachAlong, reachArea, V_ELDER, type Finding, type Model } from '../model/derive.js';
import { CARD_W, layoutOverlay, planCallouts, type LayoutInput } from './layout.js';
import { INK, RED } from './paint.js';

interface Props extends Omit<LayoutInput, 'view'> {
  view: View;
  hot: string | null;
  onHot(code: string | null): void;
}

const N = ({ children }: { children: ReactNode }) => <span className="num">{children}</span>;
const U = ({ n, unit }: { n: string; unit: string }) => (
  <span className="u">
    <N>{n}</N> {unit}
  </span>
);

/** Compass word for a bearing (8 points). */
function compass(b: number): string {
  const words = ['正北', '东北', '正东', '东南', '正南', '西南', '正西', '西北'];
  return words[Math.round((((b % 360) + 360) % 360) / 45) % 8]!;
}

function findingContent(
  f: Finding,
  model: Model,
  scale: number,
): { title: ReactNode; body: ReactNode } | null {
  const { stats } = model.data;
  // measured adult facts come straight from the data; the elder profile re-reads the field (× v₁/v₂)
  const elder = scale !== 1;
  const kmh = (V_ELDER * 3.6).toFixed(1);
  if (f.key === 'hatch') {
    const area = elder ? reachArea(model.raster, 900, scale) : stats.area_iso15_km2;
    const share = elder ? area / stats.area_circle15_km2 : stats.reach_share;
    return {
      title: (
        <>
          圈里 <N>{Math.round((1 - share) * 100)}%</N> 的地方，<N>15′</N> 走不到
        </>
      ),
      body: (
        <>
          {elder ? (
            <>
              按老人步速 <N>{kmh}</N> km/h 估算：
            </>
          ) : (
            '真实'
          )}
          可达 <U n={area.toFixed(2)} unit="km²" />
          ，直线圈 <U n={stats.area_circle15_km2.toFixed(2)} unit="km²" />。
        </>
      ),
    };
  }
  if (f.key === 'east' && model.eastPath) {
    const end = model.eastPath.pts[model.eastPath.pts.length - 1]!;
    const straight = Math.hypot(end[0], end[1]);
    // named only when the data names it; 挡路 stays on one line (never 挡 / 路)
    const names = model.barrierNames;
    const barrier = names.length ? (
      <>
        {spaceCjkLatin(names.length > 1 ? `${names.slice(0, -1).join('、')}和${names.at(-1)}` : names[0]!)}
        <span className="nw">挡路</span>
      </>
    ) : (
      '路网绕行'
    );
    const reach = elder ? reachAlong(model, [70, 75, 80, 85, 90], 900, scale) : model.eastReach15;
    const minutes = Math.round(end[2] / 60);
    return {
      title: (
        <>
          {compass(model.eastPath.bearing_deg)} <N>{fmtInt(straight)}</N> 米，要走 <N>{fmtInt(end[3])}</N> 米
        </>
      ),
      body: (
        <>
          百度实测步行 <N>{minutes}′</N>
          {elder ? (
            <>
              ，老人约 <N>{Math.round(minutes * scale)}′</N>
            </>
          ) : null}
          。{barrier}
          {reach !== null ? (
            <>
              ，<N>15′</N> 向东只走得到 <U n={String(Math.round(reach / 10) * 10)} unit="米" />。
            </>
          ) : (
            '。'
          )}
        </>
      ),
    };
  }
  if (f.key === 'school' && model.worstSchool) {
    const { unit, check } = model.worstSchool;
    return {
      title: (
        <>
          {unit.code} {unit.nameSub || unit.nameMain} → 小学
        </>
      ),
      body: (
        <>
          直线最近 <U n={fmtInt(check.straight_m)} unit="m" />
          ，实际最近要走 <U n={fmtInt(check.route_m)} unit="m" />，{elder ? '老人' : ''}约{' '}
          <N>{Math.round((check.dur_s * scale) / 60)}′</N>。
        </>
      ),
    };
  }
  return null;
}

function Callouts({
  model,
  view,
  scale,
  blockers,
}: {
  model: Model;
  view: View;
  scale: number;
  blockers: ReturnType<typeof layoutOverlay>['blockers'];
}) {
  const refs = useRef(new Map<string, HTMLDivElement>());
  const [heights, setHeights] = useState<Record<string, number>>({});
  const items = useMemo(
    () =>
      model.findings.flatMap((f) => {
        const c = findingContent(f, model, scale);
        return c ? [{ f, ...c }] : [];
      }),
    [model, scale],
  );

  // card heights depend on the text wrap (and on the web font arriving): measure, then plan
  useLayoutEffect(() => {
    const measure = () => {
      const next: Record<string, number> = {};
      refs.current.forEach((el, k) => {
        next[k] = el.offsetHeight;
      });
      setHeights((prev) =>
        Object.keys(next).every((k) => prev[k] === next[k]) &&
        Object.keys(prev).length === Object.keys(next).length
          ? prev
          : next,
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    refs.current.forEach((el) => ro.observe(el));
    return () => ro.disconnect();
  }, [items]);

  const plans = planCallouts(
    items.map((i) => i.f),
    heights,
    view,
    blockers,
  );
  const byKey = new Map(plans.map((p) => [p.key, p]));

  return (
    <>
      <svg className="layer leaders" viewBox={`0 0 ${view.width} ${view.height}`} aria-hidden="true">
        {plans.map((p) => {
          const ink = p.tone === 'red' ? RED : INK;
          return (
            <g key={p.key}>
              <line
                x1={p.ax}
                y1={p.ay}
                x2={p.lx}
                y2={p.ly}
                stroke="#fff"
                strokeWidth={4.5}
                strokeLinecap="round"
              />
              <line
                x1={p.ax}
                y1={p.ay}
                x2={p.lx}
                y2={p.ly}
                stroke={ink}
                strokeWidth={1.8}
                strokeLinecap="round"
              />
              <circle cx={p.ax} cy={p.ay} r={5.5} fill={ink} stroke="#fff" strokeWidth={2.5} />
            </g>
          );
        })}
      </svg>
      {items.map(({ f, title, body }) => {
        const p = byKey.get(f.key);
        return (
          <div
            key={f.key}
            ref={(el) => {
              if (el) refs.current.set(f.key, el);
              else refs.current.delete(f.key);
            }}
            className={'callout passive' + (f.tone === 'red' ? ' red' : '')}
            style={
              p && heights[f.key]
                ? { left: p.left, top: p.top, width: CARD_W }
                : { left: view.width - CARD_W - 22, top: 0, width: CARD_W, visibility: 'hidden' }
            }
          >
            <strong>{title}</strong>
            <span>{body}</span>
          </div>
        );
      })}
    </>
  );
}

export function MapOverlay(props: Props) {
  const { model, view, narrow, offline, playing, T, scale, circle, rail, hot, onHot } = props;
  const L = layoutOverlay({ model, view, narrow, offline, playing, T, scale, circle, rail });
  const verdictShown = !playing;

  return (
    <>
      <div className="layer overlay">
        {L.roadLabels.map((r) => (
          <div
            key={r.key}
            className={'rlabel passive' + (r.cls ? ' ' + r.cls : '')}
            style={{ transform: `translate(${r.x}px, ${r.y}px) rotate(${r.deg}deg) translate(-50%, -50%)` }}
          >
            {r.text}
          </div>
        ))}

        {L.pois.map((p) => (
          <div
            key={p.key}
            className={'poi' + (p.minor ? ' minor' : '') + (p.show ? ' show' : '') + (p.flip ? ' flip' : '')}
            style={{ left: p.x, top: p.y }}
            role="img"
            aria-label={p.name}
          >
            <Pg id={p.icon} />
            <span className="label" aria-hidden="true">
              {p.label}
            </span>
          </div>
        ))}

        {L.units.map(({ unit, x, y }) => {
          const tone = !verdictShown ? '' : unit.blind ? ' blind' : unit.bad ? ' bad' : '';
          const state = unit.blind ? '盲区' : unit.bad ? '伪覆盖' : '无缺口';
          return (
            <button
              key={unit.code}
              type="button"
              className={'unit' + tone + (hot === unit.code ? ' hot' : '')}
              style={{ left: x, top: y }}
              title={unit.name}
              aria-label={`${unit.code} ${unit.name}${verdictShown ? `（${state}）` : ''}`}
              onMouseEnter={() => onHot(unit.code)}
              onMouseLeave={() => onHot(null)}
              onFocus={() => onHot(unit.code)}
              onBlur={() => onHot(null)}
            >
              {unit.code}
            </button>
          );
        })}

        <div
          className={`here passive tag-${L.here.side}`}
          style={{
            left: L.here.x,
            top: L.here.y,
            ['--dx' as string]: `${L.here.dx}px`,
            ['--dy' as string]: `${L.here.dy}px`,
          }}
        >
          {L.here.stem && (
            <svg className="stem" aria-hidden="true">
              <line
                x1={L.here.stem[0]}
                y1={L.here.stem[1]}
                x2={L.here.stem[2]}
                y2={L.here.stem[3]}
                stroke="#fff"
                strokeWidth={5}
                strokeLinecap="round"
              />
              <line
                x1={L.here.stem[0]}
                y1={L.here.stem[1]}
                x2={L.here.stem[2]}
                y2={L.here.stem[3]}
                stroke="var(--cobalt)"
                strokeWidth={2.2}
                strokeLinecap="round"
              />
            </svg>
          )}
          {L.here.side === 'none' ? (
            <span className="sr-only">你在这里</span>
          ) : (
            <span className="tag">你在这里</span>
          )}
          <span className="dot">
            <Pg id="pg-walk" />
          </span>
        </div>

        {L.minuteTags.map((t) => (
          <div key={t.L} className="mtag passive" style={{ left: t.x, top: t.y }}>
            {t.L / 60}′
          </div>
        ))}

        {L.circleTag && (
          <div className="ctag passive" style={{ left: L.circleTag.x, top: L.circleTag.y }}>
            直线画的 <span className="num">15′</span> 圈 · 半径{' '}
            <span className="num">{fmtInt(model.r15)}</span> m
          </div>
        )}
      </div>
      {rail && <Callouts model={model} view={view} scale={scale} blockers={L.blockers} />}
    </>
  );
}

/** Chinese copy puts a space between Han characters and Latin letters or digits (河道和 S20 外环). */
function spaceCjkLatin(text: string): string {
  return text
    .replace(/([\u4e00-\u9fff])([A-Za-z0-9])/g, '$1 $2')
    .replace(/([A-Za-z0-9])([\u4e00-\u9fff])/g, '$1 $2');
}
