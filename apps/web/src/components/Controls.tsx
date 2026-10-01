/**
 * The map's floating controls, white cards on hairlines: the legend (top left), 图层 (top right — the
 * layers and the walker open under it), the 走一遍 card with the time scrubber and its readout (bottom
 * left — the one primary action), and the scale bar with the provenance (bottom right). While a live
 * check streams, the stage card takes the 走一遍 card's place.
 */
import { Fragment, useEffect, useRef, useState, type Ref } from 'react';
import type { HardCategory } from '@zoudedao/core';
import type { StageEvent } from '../data/api.js';
import { distWords, fmtInt } from '../model/derive.js';
import type { Look } from '../model/looks.js';
import type { Profile } from '../state.js';
import { Pg, Ui } from './Icons.js';
import { arrowSelect } from './TopBar.js';

/* ---------------- legend ---------------- */

export type LegendKind =
  | {
      kind: 'category';
      cat: HardCategory;
      rule: number;
      looks: ReadonlySet<Look>;
      sites: boolean;
      /** 菜市场: the shops the gaps can buy vegetables at are marked */
      fresh?: boolean;
    }
  | { kind: 'facilities' }
  | { kind: 'walking' };

/** What the 方法 layer draws, counted (the legend says it in numbers). */
export interface MethodCounts {
  matrix: number;
  vertex: number;
  barriers: number;
}

export function MapLegend({
  ref,
  legend,
  gray,
  grayRule,
  method,
}: {
  ref?: Ref<HTMLDivElement>;
  legend: LegendKind;
  /** the 灰色区域 layer is on: its swatch joins, its rule in the title */
  gray: boolean;
  grayRule: string;
  /** the 方法 layer is on: its samples and barriers join, counted */
  method?: MethodCounts | null;
}) {
  const grayItem = gray ? (
    <span className="lg" title={`灰色区域：${grayRule}`}>
      <i className="sw s-gray" />
      灰色区域
      <span className="sr-only">：{grayRule}</span>
    </span>
  ) : null;
  const methodItems = method ? (
    <>
      <span className="sep" aria-hidden="true" />
      <span className="lg" title="百度批量算路的采样点：从中心到每个点的实测步行时间">
        <i className="dot-k m-matrix" />
        批量算路 <span className="num">{method.matrix}</span>
      </span>
      <span className="lg" title="百度步行路线的折点与路线：沿路线逐段的实测时间">
        <i className="dot-k m-vertex" />
        步行路线 <span className="num">{method.vertex}</span>
      </span>
      <span className="lg" title="从样本之间矛盾的步行时间推断出的阻隔（河道、高架等），每段约 40–60 m">
        <i className="bar-k" />
        {method.barriers ? (
          <>
            阻隔 <span className="num">{method.barriers}</span> 段
          </>
        ) : (
          '未检出阻隔'
        )}
      </span>
    </>
  ) : null;
  if (legend.kind === 'facilities') {
    return (
      <div className="float legend" ref={ref} aria-label="图例" role="group">
        <b>设施</b>
        <span className="lg">
          <i className="poi-k" />
          <span>
            <span className="num">15′</span> 走得到
          </span>
        </span>
        <span className="lg">
          <i className="poi-k far" />
          画圈有，走不到
        </span>
        {grayItem}
        {methodItems}
      </div>
    );
  }
  if (legend.kind === 'walking') {
    return (
      <div className="float legend" ref={ref} aria-label="图例" role="group">
        <b>走一遍</b>
        <span className="lg">
          <i className="sw s-front" />
          正在走到的边
        </span>
        <span className="lg">
          <span>
            判定在 <span className="num">15′</span> 时落下
          </span>
        </span>
      </div>
    );
  }
  const { cat, rule, looks } = legend;
  return (
    <div className="float legend" ref={ref} aria-label="图例" role="group">
      <b>
        {cat} · 步行{' '}
        {rule % 1000 === 0 ? (
          <>
            <span className="num">{rule / 1000}</span> 公里
          </>
        ) : (
          <>
            <span className="num">{fmtInt(rule)}</span> 米
          </>
        )}
      </b>
      <span className="sep" aria-hidden="true" />
      <span className="lg">
        <i className="sw s-ok" />
        走得到
      </span>
      {looks.has('pseudo') || looks.has('edge-over') ? (
        <span className="lg">
          <i className="sw s-pseudo" />
          伪覆盖
        </span>
      ) : null}
      {looks.has('blind') || looks.has('none') ? (
        <span className="lg">
          <i className="sw s-blind" />
          盲区
        </span>
      ) : null}
      {looks.has('edge') || looks.has('edge-over') ? (
        <span className="lg">
          <i className="sw s-edge" />
          临界
        </span>
      ) : null}
      {looks.has('pending') ? (
        <span className="lg">
          <i className="sw s-pending" />
          待核
        </span>
      ) : null}
      {legend.sites ? (
        <span className="lg" title={`新增${cat}的建议位置；数字为名次`}>
          <i className="site-k" aria-hidden="true">
            1
          </i>
          建议选址
        </span>
      ) : null}
      {legend.fresh ? (
        <span
          className="lg"
          title="缺菜市场的小区在规则距离内步行能到、能买菜的超市或菜店；只作参考，不改变判定"
        >
          <i className="poi-k fresh" />
          能买菜的店
        </span>
      ) : null}
      {grayItem}
      {methodItems}
      <span className="sr-only">规则：{`${cat}步行 ${distWords(rule)}内`}</span>
    </div>
  );
}

/* ---------------- layers ---------------- */

export interface LayerProps {
  circle: boolean;
  onCircle(on: boolean): void;
  heat: boolean;
  onHeat(on: boolean): void;
  /** 灰色区域 toggle; null when the analysis has no gray areas */
  gray: boolean | null;
  onGray(on: boolean): void;
  /** 方法 layer: the samples by source, the walking paths and the detected barriers */
  method: boolean;
  onMethod(on: boolean): void;
  profile: Profile;
  onProfile(p: Profile): void;
  vAdult: number;
  vElder: number;
  /** 含过街等待: +5 % walking time on the field and the readouts (a sensitivity estimate) */
  crossing: boolean;
  onCrossing(on: boolean): void;
}

/**
 * What the map can add, and who walks: the four layers (each with a line on what it draws), then the
 * walker and 含过街等待. The body of the 图层 menu; laid flat, without the lines, in a phone's strip.
 */
export function LayerOptions({ flat = false, ...p }: LayerProps & { flat?: boolean }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const items: { id: string; label: string; on: boolean; set(on: boolean): void; note: string }[] = [
    { id: 'circle', label: '直线圈', on: p.circle, set: p.onCircle, note: '直线画的 15′ 圈，按所选步速' },
    { id: 'heat', label: '耗时色阶', on: p.heat, set: p.onHeat, note: '步行耗时由浓到淡；关掉只留 15′ 范围' },
  ];
  if (p.gray !== null)
    items.push({
      id: 'gray',
      label: '灰色区域',
      on: p.gray,
      set: p.onGray,
      note: '步行 1 公里内缺小学、菜市场或药店的地方',
    });
  items.push({
    id: 'method',
    label: '采样点与阻隔',
    on: p.method,
    set: p.onMethod,
    note: '百度实测的采样点和路线，以及由此推断的阻隔',
  });
  const options: { id: Profile; label: string; kmh: string }[] = [
    { id: 'adult', label: '成人', kmh: (p.vAdult * 3.6).toFixed(1) },
    { id: 'elder', label: '老人', kmh: (p.vElder * 3.6).toFixed(1) },
  ];
  return (
    <>
      <div className="lo-layers" role="group" aria-label="图层">
        {items.map((it) => (
          <button
            key={it.id}
            type="button"
            className={`layer-btn l-${it.id}`}
            aria-pressed={it.on}
            title={flat ? it.note : undefined}
            onClick={() => it.set(!it.on)}
          >
            <span className="box" aria-hidden="true">
              <Ui id="ui-check" />
            </span>
            <span className="lb-t">
              {it.label}
              {flat ? null : <small>{it.note}</small>}
            </span>
          </button>
        ))}
      </div>
      <div className="lo-walker">
        <span className="lo-k" aria-hidden="true">
          步速
        </span>
        <div
          className="profile"
          role="radiogroup"
          aria-label="步行人群"
          onKeyDown={(e) =>
            arrowSelect(
              e,
              options.map((o) => o.id),
              p.profile,
              (next, k) => {
                p.onProfile(next);
                refs.current[k]?.focus();
              },
            )
          }
        >
          {options.map((o, i) => (
            <button
              key={o.id}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={p.profile === o.id}
              tabIndex={p.profile === o.id ? 0 : -1}
              onClick={() => p.onProfile(o.id)}
            >
              {o.label} <span className="num">{o.kmh}</span>
              <small>km/h</small>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="crossing"
          aria-pressed={p.crossing}
          title="敏感性估算：步行时间加 5%（红绿灯与过街等候；百度步行路线的用时比按距离算的长约 3–7%）。只改变耗时色阶、等时线和读数，不改变任何判定。"
          onClick={() => p.onCrossing(!p.crossing)}
        >
          <span className="box" aria-hidden="true">
            <Ui id="ui-check" />
          </span>
          含过街等待 <span className="num">+5%</span>
          <span className="est">估算</span>
        </button>
      </div>
    </>
  );
}

/**
 * The map's one control at its top right: 图层, which opens the layers and the walker under it (the
 * map stays as it is until something is ticked). Esc or a click elsewhere closes it.
 */
export function LayerMenu({ ref, ...p }: LayerProps & { ref?: Ref<HTMLDivElement> }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);
  const btn = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    // before the page's own Esc (which closes a route): one Esc, one thing closed
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      btn.current?.focus();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);
  return (
    <div
      className="float layers"
      data-open={open || undefined}
      ref={(el) => {
        box.current = el;
        if (typeof ref === 'function') ref(el);
        else if (ref) ref.current = el;
      }}
    >
      <button
        ref={btn}
        type="button"
        className="layers-btn"
        aria-expanded={open}
        aria-controls="layer-pop"
        onClick={() => setOpen(!open)}
      >
        <Ui id="ui-layers" />
        图层
        <Ui id="ui-chevron" />
      </button>
      <div className="layer-pop" id="layer-pop" role="group" aria-label="图层与步速" hidden={!open}>
        <LayerOptions {...p} />
      </div>
    </div>
  );
}

/* ---------------- walk ---------------- */

/**
 * 走一遍, the time scrubber and what the walk reaches — nothing else (the walker lives in 图层; an
 * elder's walk says so in the readout, an estimate wears ≈).
 */
export function WalkCard({
  ref,
  T,
  playing,
  walked,
  onPlay,
  onScrub,
  area,
  circleKm2,
  missShare,
  profile,
  crossing,
}: {
  ref?: Ref<HTMLDivElement>;
  T: number;
  playing: boolean;
  walked: boolean;
  onPlay(): void;
  onScrub(T: number): void;
  /** reachable km² at T */
  area: number;
  /** the profile's straight 15′ circle, km² */
  circleKm2: number;
  /** share of that circle the walk does not reach in 15′ */
  missShare: number;
  profile: Profile;
  /** 含过街等待 is on: the readouts are estimates */
  crossing: boolean;
}) {
  // an estimate reads as one (The Honest Number Rule)
  const est = crossing ? '≈' : '';
  const m = T / 60;
  const minutes = Number.isInteger(m) ? String(m) : m.toFixed(1);
  const who = profile === 'elder' ? '老人' : '';
  return (
    <div className="float walk" ref={ref}>
      <button
        type="button"
        className="play"
        data-busy={playing}
        aria-label={playing ? '停止回放' : '走一遍：从 0 到 15 分钟回放步行可达范围'}
        onClick={onPlay}
      >
        <Pg id="pg-play" />
        <span>
          {playing ? (
            <>
              行走中 <span className="num">{(T / 60).toFixed(1)}′</span>
            </>
          ) : walked ? (
            '再走一遍'
          ) : (
            '走一遍'
          )}
        </span>
      </button>
      <div className="scrub">
        <input
          type="range"
          min={0}
          max={1200}
          step={10}
          value={T}
          aria-label="步行时间"
          aria-valuetext={`${minutes} 分钟，${who}走得到${crossing ? '约' : ''} ${area.toFixed(2)} 平方公里`}
          onChange={(e) => onScrub(Number(e.target.value))}
        />
        <div className="ticks" aria-hidden="true">
          {[0, 5, 10, 15, 20].map((t) => (
            <span key={t} className={t === 15 ? 'k15' : undefined} style={{ ['--p' as string]: t / 20 }}>
              {t}′
            </span>
          ))}
        </div>
      </div>
      <output
        className="readout"
        aria-live="off"
        title={crossing ? '含过街等待，步行时间加 5%（估算）' : undefined}
      >
        <span className="ro-t">
          <b className="num">{minutes}′</b>
          <span>
            {who}走得到{' '}
            <span className="num">
              {est}
              {area.toFixed(2)}
            </span>{' '}
            km²
          </span>
        </span>
        <span className="ro-s">
          {T === 900 ? (
            <>
              直线圈 <span className="num">{circleKm2.toFixed(2)}</span> km²，圈里{' '}
              <span className="num">
                {est}
                {Math.round(missShare * 100)}%
              </span>{' '}
              走不到
            </>
          ) : (
            <>
              直线 <span className="num">15′</span> 圈 <span className="num">{circleKm2.toFixed(2)}</span> km²
            </>
          )}
        </span>
      </output>
    </div>
  );
}

/**
 * The 走一遍 card's place while a live check streams in: the stage line (what is being measured now),
 * its progress and the way out (the ladder of stages is the panel's). 走一遍 comes back with the result.
 */
export function StageCard({
  ref,
  stage,
  onCancel,
}: {
  ref?: Ref<HTMLDivElement>;
  stage: StageEvent | null;
  onCancel(): void;
}) {
  return (
    <div className="float walk stage-card" ref={ref} role="status">
      <span className="stage-dot" aria-hidden="true">
        <Pg id="pg-walk" />
      </span>
      <div className="stage-main">
        <b>{stage?.message ?? '连接服务端…'}</b>
        <span className="progress" aria-hidden="true">
          <span style={{ transform: `scaleX(${Math.max(0.02, Math.min(1, stage?.progress ?? 0.02))})` }} />
        </span>
      </div>
      <button type="button" className="btn" onClick={onCancel}>
        取消
      </button>
    </div>
  );
}

/* ---------------- scale, provenance ---------------- */

const NICE = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];

export function MapMeta({
  ref,
  bottom = null,
  pxPerM,
  canReset,
  onReset,
  lines,
}: {
  ref?: Ref<HTMLDivElement>;
  /** stood on the 走一遍 card (px from the map's foot) when it leaves no room beside it */
  bottom?: number | null;
  pxPerM: number;
  canReset: boolean;
  onReset(): void;
  /** provenance: the sources that must stay on the map, in one line */
  lines: string[];
}) {
  const m = [...NICE].reverse().find((d) => d * pxPerM <= 160) ?? NICE[0]!;
  const label = m >= 1000 ? `${m / 1000} km` : `${m} m`;
  return (
    <div className="map-meta" ref={ref} style={bottom === null ? undefined : { bottom }}>
      <div className="meta-row">
        {canReset ? (
          <button type="button" className="recentre" onClick={onReset} title="回到片区中心（上北）">
            <Ui id="ui-locate" />
            回到中心
          </button>
        ) : null}
        <div className="scalebar" role="img" aria-label={`比例尺 ${label}`}>
          <span className="sb-bar" style={{ width: Math.round(m * pxPerM) }} />
          <span className="num">{label}</span>
        </div>
      </div>
      {lines.length ? (
        <p className="attrib">
          {lines.map((src, i) => (
            // the line breaks between its sources, never inside one
            <Fragment key={src}>
              {i ? ' · ' : ''}
              <span className="src">{src}</span>
            </Fragment>
          ))}
        </p>
      ) : null}
    </div>
  );
}
