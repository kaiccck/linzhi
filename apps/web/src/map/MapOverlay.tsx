/**
 * The HTML atoms over the map canvases, placed by layout.ts: unit codes (white pills, their edge in
 * the chosen category's verdict), names beside them, facility marks (white discs ringed in the
 * category's hue), the isochrones' minute tags and the circle's tag, 你在这里, the 规划 pins, a centre
 * being chosen, and the finding cards with their leaders.
 */
import { useEffect, useId, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { HardCategory } from '@zoudedao/core';
import { Pg, Ui } from '../components/Icons.js';
import type { PendingPoint } from '../centre.js';
import type { View } from '../geo/view.js';
import { CAT_COLOR, fmtInt, type Model, type Unit } from '../model/derive.js';
import { catchmentText } from '../model/evidence.js';
import { LOOK_WORD, lookClass, type Look } from '../model/looks.js';
import type { FindingItem } from './findings.js';
import { CONFIRM, codeTicks, placeConfirm, type OverlayLayout, type Rect } from './layout.js';
import { COL } from './paint.js';

export type { PendingPoint };

interface Props {
  model: Model;
  view: View;
  L: OverlayLayout;
  /** how each unit looks (the pill's edge); neutral while 走一遍 plays */
  look(u: Unit): Look;
  narrow: boolean;
  hot: string | null;
  onHot(code: string | null): void;
  /** codes lit beside the one under the pointer: the unit whose route is drawn, a citation's units */
  lit?: ReadonlySet<string>;
  /** the unit whose walking route is on the map (its code reads as pressed) */
  selected?: string | null;
  /** a code clicked: draw that unit's walking route for the chosen category */
  onPick?(code: string): void;
  /** the chosen category (the school category shows a unit's assigned school on hover) */
  cat?: HardCategory;
  /**
   * 走一遍 has just landed: the codes whose verdict is a gap give a small lift, rippling out from the
   * centre as the walk did (once, under a second)
   */
  landed?: boolean;
  /** unit codes a planned site would bring within the rule: their pills carry a teal tick */
  flips?: ReadonlySet<string> | undefined;
  /** 规划: the site under the pointer (lit here and in the panel's list) */
  hotSite?: string | null;
  onHotSite?(key: string | null): void;
  /** false: a printed map (report) — codes are plain marks, nothing takes focus */
  interactive?: boolean;
  /** the flag at the centre: 片区中心 (on screen and on paper) */
  hereLabel?: string;
  /** finding cards: rendered to measure, shown where the layout placed them */
  cards?: FindingItem[];
  onCardSizes?(sizes: Record<string, { w: number; h: number }>): void;
  pending?: PendingPoint | null;
  /** the control bands the plate must stay out of (top: legend/layers, bottom: 走一遍 card) */
  band?: { top: number; bottom: number };
  /** where the plate docks on narrow maps (over the 走一遍 card, outside this layer) */
  dock?: HTMLElement | null;
  onConfirm?(): void;
  onCancel?(): void;
}

const N = ({ children }: { children: ReactNode }) => <span className="num">{children}</span>;

/** Card sizes in the layout's terms; unchanged sizes are not reported again. */
function useCardSizes(items: FindingItem[], onSizes?: Props['onCardSizes']) {
  const refs = useRef(new Map<string, HTMLDivElement>());
  const last = useRef('');
  useLayoutEffect(() => {
    if (!onSizes) return;
    const measure = () => {
      const next: Record<string, { w: number; h: number }> = {};
      refs.current.forEach((el, k) => {
        next[k] = { w: el.offsetWidth, h: el.offsetHeight };
      });
      const key = JSON.stringify(next);
      if (key === last.current) return;
      last.current = key;
      onSizes(next);
    };
    measure();
    const ro = new ResizeObserver(measure);
    refs.current.forEach((el) => ro.observe(el));
    return () => ro.disconnect();
  }, [items, onSizes]);
  return refs;
}

/** A card's inside: the heading (and a close button), the body, the quiet foot. */
export function CardContent({ item }: { item: FindingItem }) {
  return (
    <>
      <strong>{item.title}</strong>
      {item.onClose ? (
        <button type="button" className="x" aria-label="关闭步行路线（Esc）" onClick={item.onClose}>
          <Ui id="ui-close" />
        </button>
      ) : null}
      <p aria-live={item.live ? 'polite' : undefined}>{item.body}</p>
      {item.foot ? <p className="foot">{item.foot}</p> : null}
    </>
  );
}

/** Props that make a card act on a click (and on Enter or Space when focused). */
export function openProps(item: FindingItem) {
  const open = item.onOpen;
  if (!open) return {};
  return {
    role: 'button' as const,
    tabIndex: 0,
    'aria-label': item.openLabel,
    onClick: open,
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      open();
    },
  };
}

export const cardClass = (item: FindingItem) =>
  'callout' +
  (item.spec.tone === 'ink' ? '' : ` s-${item.spec.tone}`) +
  (item.cls ? ` ${item.cls}` : '') +
  (item.onOpen ? ' opens' : '');

function Cards({
  items,
  L,
  onSizes,
}: {
  items: FindingItem[];
  L: OverlayLayout;
  onSizes?: Props['onCardSizes'];
}) {
  const refs = useCardSizes(items, onSizes);
  const byKey = new Map(L.cards.map((c) => [c.key, c]));
  return (
    <>
      {items.map((item) => {
        const { spec } = item;
        const p = byKey.get(spec.key);
        return (
          <div
            key={spec.key}
            ref={(el) => {
              if (el) refs.current.set(spec.key, el);
              else refs.current.delete(spec.key);
            }}
            className={cardClass(item)}
            style={p ? { left: p.left, top: p.top } : { left: 0, top: 0, visibility: 'hidden' }}
            aria-hidden={p ? undefined : true}
            {...(p ? openProps(item) : {})}
          >
            <CardContent item={item} />
          </div>
        );
      })}
    </>
  );
}

/**
 * The pending centre: a cobalt target (the centre you are choosing) and, in live mode, a card asking
 * to check from it. The card never covers a unit code; it takes focus when it opens so the keyboard
 * and screen readers land on the question, and Esc cancels (centre.tsx).
 */
function Pending({
  p,
  view,
  narrow,
  blockers,
  band,
  dock,
  onConfirm,
  onCancel,
}: {
  p: PendingPoint;
  view: View;
  narrow: boolean;
  blockers: Rect[];
  band: { top: number; bottom: number };
  dock?: HTMLElement | null;
  onConfirm?(): void;
  onCancel?(): void;
}) {
  const x = view.x(p.xy[0]);
  const y = view.y(p.xy[1]);
  const goRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  const inView = x > -20 && y > -20 && x < view.width + 20 && y < view.height + 20;
  const plan =
    p.ask && inView && !narrow ? placeConfirm(x, y, view.width, view.height, blockers, band) : null;
  const docked = p.ask && !plan && !!dock;
  useEffect(() => {
    if (p.ask) goRef.current?.focus({ preventScroll: true });
  }, [p.ask, p.bd09, docked]);
  const plate = p.ask ? (
    <div
      className={'confirm' + (docked ? ' docked' : '')}
      role="dialog"
      aria-labelledby={`${id}-t`}
      aria-describedby={`${id}-d`}
      style={plan ? { left: plan.left, top: plan.top, width: CONFIRM.w } : undefined}
    >
      <p className="confirm-what" id={`${id}-d`}>
        {p.what} <span className="num">{p.coords}</span>
      </p>
      <div className="confirm-acts">
        <button type="button" className="play" ref={goRef} onClick={onConfirm}>
          <Pg id="pg-walk" />
          <span id={`${id}-t`}>以此为中心体检</span>
        </button>
        <button type="button" className="btn" onClick={onCancel} aria-keyshortcuts="Escape">
          取消
        </button>
      </div>
    </div>
  ) : null;
  return (
    <>
      <div className="pin passive" style={{ left: x, top: y }} aria-hidden="true" hidden={!inView}>
        {plan?.stem && (
          <svg className="stem" aria-hidden="true">
            <line
              x1={plan.stem[0]}
              y1={plan.stem[1]}
              x2={plan.stem[2]}
              y2={plan.stem[3]}
              stroke="#fff"
              strokeWidth={4}
              strokeLinecap="round"
            />
            <line
              x1={plan.stem[0]}
              y1={plan.stem[1]}
              x2={plan.stem[2]}
              y2={plan.stem[3]}
              stroke={COL.cobalt}
              strokeWidth={1.6}
              strokeLinecap="round"
            />
          </svg>
        )}
        <span className="ring" />
      </div>
      {plan ? plate : docked && dock ? createPortal(plate, dock) : null}
    </>
  );
}

export function MapOverlay(props: Props) {
  const { view, L, look, narrow, hot, onHot } = props;
  const interactive = props.interactive !== false;
  const flips = props.flips;
  const lit = props.lit;
  const school = props.cat === '小学';
  const named = new Set(L.names.filter((n) => n.kind === 'unit').map((n) => n.key.slice(2)));

  const ticks = [
    ...codeTicks(L.units, view),
    // a pin moved off a code keeps a tick back to the point it names
    ...L.sites
      .filter((p) => Math.hypot(p.x - p.px, p.y - p.py) > 9)
      .map((p) => {
        const d = Math.hypot(p.x - p.px, p.y - p.py);
        const k = Math.max(0, (d - 16) / d);
        return { code: p.key, x1: p.px, y1: p.py, x2: p.px + (p.x - p.px) * k, y2: p.py + (p.y - p.py) * k };
      }),
  ];
  const hotUnit = hot ? L.units.find((u) => u.unit.code === hot) : undefined;

  return (
    <>
      {ticks.length ? (
        <svg className="layer ticks" viewBox={`0 0 ${view.width} ${view.height}`} aria-hidden="true">
          {ticks.map((t) => (
            <g key={t.code}>
              <line
                x1={t.x1}
                y1={t.y1}
                x2={t.x2}
                y2={t.y2}
                stroke="#fff"
                strokeWidth={3}
                strokeLinecap="round"
              />
              <line
                x1={t.x1}
                y1={t.y1}
                x2={t.x2}
                y2={t.y2}
                stroke={COL.ink2}
                strokeWidth={1.1}
                strokeLinecap="round"
              />
              <circle cx={t.x1} cy={t.y1} r={2.4} fill={COL.ink2} stroke="#fff" strokeWidth={1.3} />
            </g>
          ))}
        </svg>
      ) : null}
      {L.cards.length ? (
        <svg className="layer leaders" viewBox={`0 0 ${view.width} ${view.height}`} aria-hidden="true">
          {L.cards.map((p) => {
            const ink = p.tone === 'pseudo' ? COL.pseudo : p.tone === 'blind' ? COL.blind : COL.ink2;
            return (
              <g key={p.key}>
                <line
                  x1={p.ax}
                  y1={p.ay}
                  x2={p.lx}
                  y2={p.ly}
                  stroke="#fff"
                  strokeWidth={3.5}
                  strokeLinecap="round"
                />
                <line
                  x1={p.ax}
                  y1={p.ay}
                  x2={p.lx}
                  y2={p.ly}
                  stroke={ink}
                  strokeWidth={1.3}
                  strokeLinecap="round"
                />
                <circle cx={p.ax} cy={p.ay} r={4} fill={ink} stroke="#fff" strokeWidth={2} />
              </g>
            );
          })}
        </svg>
      ) : null}
      <div className="layer overlay" data-landed={props.landed || undefined}>
        {L.names.map((n) => (
          <div
            key={n.key}
            className={`m-label passive n-${n.kind}`}
            style={{ transform: `translate(${n.x}px, ${n.y}px) translateY(-50%)` }}
            aria-hidden="true"
          >
            {n.text}
          </div>
        ))}

        {L.sites.map((p) => (
          <div
            key={p.key}
            className={
              'site' +
              (p.kind === 'whatif' ? ` whatif ${p.verified ? 'ok' : 'est'}` : '') +
              (props.hotSite === p.key ? ' hot' : '')
            }
            style={{ left: p.x, top: p.y, ['--c' as string]: CAT_COLOR[p.cat] }}
            role="img"
            aria-label={p.aria}
            onMouseEnter={() => props.onHotSite?.(p.key)}
            onMouseLeave={() => props.onHotSite?.(null)}
          >
            <Pg id={p.icon} />
            {p.kind === 'whatif' ? (
              <span className="site-plus" aria-hidden="true">
                <Pg id="pg-plus" />
              </span>
            ) : (
              <span className="site-rank num" aria-hidden="true">
                {p.rank}
              </span>
            )}
          </div>
        ))}
        {L.sites.map((p) =>
          p.lx === null ? null : (
            <div
              key={`${p.key}:label`}
              className="site-label passive"
              style={{ left: p.lx, top: p.ly }}
              aria-hidden="true"
            >
              {p.label}
              <span className={'badge' + (p.verified ? ' ok' : ' est')}>
                {p.verified ? '已核验' : '估算'}
              </span>
            </div>
          ),
        )}

        {L.pois.map((p) => {
          const when = Number.isFinite(p.t) ? `，步行约 ${Math.round(p.t / 60)} 分钟` : '';
          const label = p.fresh
            ? `${p.text}（能买菜的店，不是菜市场）`
            : `${p.text}（${p.cat}${when}${p.far ? '，画在直线圈里，15 分钟走不到' : ''}）`;
          return (
            <div
              key={p.key}
              className={
                'poi' + (p.far ? ' far' : '') + (p.small ? ' small' : '') + (p.fresh ? ' fresh' : '')
              }
              style={{ left: p.x, top: p.y, ['--c' as string]: p.fresh ? 'var(--ok)' : CAT_COLOR[p.cat] }}
              role="img"
              aria-label={label}
              title={label}
            >
              <Pg id={p.icon} />
            </div>
          );
        })}
        {L.pois.map((p) =>
          p.label ? (
            <div
              key={`${p.key}:l`}
              className={'poi-label passive' + (p.label === 'left' ? ' flip' : '')}
              style={{ left: p.label === 'left' ? p.x - 15 : p.x + 15, top: p.y }}
              aria-hidden="true"
            >
              {p.text}
            </div>
          ) : null,
        )}

        {L.minuteTags.map((t) => (
          <div key={t.L} className="mtag passive num" style={{ left: t.x, top: t.y }}>
            {t.L / 60}′
          </div>
        ))}
        {L.circleTag && (
          <div className="ctag passive" style={{ left: L.circleTag.x, top: L.circleTag.y }}>
            {L.circleTag.text.split(/(15′|\d[\d,]*)/).map((s, i) => (i % 2 ? <N key={i}>{s}</N> : s))}
          </div>
        )}

        {L.units.map(({ unit, x, y }) => {
          const l = look(unit);
          const on = hot === unit.code || !!lit?.has(unit.code);
          const cls = `code m-code ${lookClass(l)}${unit.outlined ? '' : ' solo'}${on ? ' hot' : ''}${flips?.has(unit.code) ? ' flip' : ''}${props.selected === unit.code ? ' sel' : ''}`;
          const word = LOOK_WORD[l];
          const detail = unit.catchment && props.cat === '小学' ? `\n${catchmentText(unit.catchment)}` : '';
          if (!interactive) {
            return (
              <span key={unit.code} className={cls + ' passive'} style={{ left: x, top: y }}>
                {unit.code}
              </span>
            );
          }
          return (
            <button
              key={unit.code}
              type="button"
              className={cls}
              style={{
                left: x,
                top: y,
                // the landing ripple reaches a code as far behind the centre's as the walk did
                ['--land' as string]: `${Math.round(Math.min(420, Math.hypot(x - L.here.x, y - L.here.y) * 0.9))}ms`,
              }}
              title={unit.name + detail}
              aria-label={`${unit.code} ${unit.name}${word ? `（${word}）` : ''}${props.onPick ? '，画出步行路线' : ''}`}
              aria-pressed={props.onPick ? props.selected === unit.code : undefined}
              onClick={props.onPick ? () => props.onPick!(unit.code) : undefined}
              onMouseEnter={() => onHot(unit.code)}
              onMouseLeave={() => onHot(null)}
              onFocus={() => onHot(unit.code)}
              onBlur={() => onHot(null)}
            >
              {unit.code}
            </button>
          );
        })}

        {hotUnit && interactive && (!named.has(hotUnit.unit.code) || (school && hotUnit.unit.catchment)) ? (
          // the compound's full name beside its code while it is lit (when the map had no room for it),
          // and for the school category its assigned school (对口小学), which is not always the nearest
          <div
            className={'m-name passive' + (hotUnit.x > view.width - 260 ? ' flip' : '')}
            style={{
              left: hotUnit.x > view.width - 260 ? hotUnit.rect.x - 6 : hotUnit.rect.x + hotUnit.rect.w + 6,
              top: hotUnit.y,
            }}
          >
            {named.has(hotUnit.unit.code) ? null : <span className="nm">{hotUnit.unit.name}</span>}
            {school && hotUnit.unit.catchment ? (
              <span className="catch">{catchmentText(hotUnit.unit.catchment)}</span>
            ) : null}
          </div>
        ) : null}

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
                strokeWidth={4}
                strokeLinecap="round"
              />
              <line
                x1={L.here.stem[0]}
                y1={L.here.stem[1]}
                x2={L.here.stem[2]}
                y2={L.here.stem[3]}
                stroke={COL.cobalt}
                strokeWidth={1.6}
                strokeLinecap="round"
              />
            </svg>
          )}
          {L.here.side === 'none' ? (
            <span className="sr-only">{props.hereLabel ?? '片区中心'}</span>
          ) : (
            <span className="tag">{props.hereLabel ?? '片区中心'}</span>
          )}
          <span className="dot">
            <Pg id="pg-walk" />
          </span>
        </div>

        {props.pending ? (
          <Pending
            p={props.pending}
            view={view}
            narrow={narrow}
            blockers={L.blockers}
            band={props.band ?? { top: 72, bottom: 104 }}
            dock={props.dock}
            onConfirm={props.onConfirm}
            onCancel={props.onCancel}
          />
        ) : null}

        {props.cards?.length ? <Cards items={props.cards} L={L} onSizes={props.onCardSizes} /> : null}
      </div>
    </>
  );
}

/** "1,053 m" (the circle's radius) as the tag spells it — exported for the report's key. */
export const radiusText = (m: number) => `${fmtInt(m)} m`;
