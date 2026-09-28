import { useRef, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import type { Profile } from '../state.js';
import { Pg } from './Icons.js';

/* ---------------- search ---------------- */

export interface Note {
  id: string;
  text: ReactNode;
  dismissible?: boolean;
}

export function SearchPlate({
  value,
  onChange,
  onSubmit,
  notes,
  onDismiss,
}: {
  value: string;
  onChange(v: string): void;
  onSubmit(): void;
  notes: Note[];
  onDismiss(id: string): void;
}) {
  return (
    <>
      <form
        className="plate search"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <Pg id="pg-search" />
        <input
          type="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="输入地址，或在地图上点选中心"
          aria-label="输入地址，或在地图上点选中心"
          aria-describedby={notes.length ? 'map-notes' : undefined}
          enterKeyHint="search"
          autoComplete="off"
        />
      </form>
      {notes.length > 0 && (
        <div className="notes" id="map-notes" role="status">
          {notes.map((n) => (
            <div className="note" key={n.id}>
              {n.text}
              {n.dismissible !== false && (
                <button type="button" className="x" aria-label="关闭提示" onClick={() => onDismiss(n.id)}>
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/* ---------------- modes ---------------- */

export function ModesPlate({
  profile,
  onProfile,
  circle,
  onCircle,
  heat,
  onHeat,
  vAdult,
  vElder,
}: {
  profile: Profile;
  onProfile(p: Profile): void;
  circle: boolean;
  onCircle(on: boolean): void;
  heat: boolean;
  onHeat(on: boolean): void;
  vAdult: number;
  vElder: number;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const options: { id: Profile; label: string; kmh: string }[] = [
    { id: 'adult', label: '成人', kmh: (vAdult * 3.6).toFixed(1) },
    { id: 'elder', label: '老人', kmh: (vElder * 3.6).toFixed(1) },
  ];
  // radiogroup keyboard model: arrows move the selection, one tab stop
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const i = options.findIndex((o) => o.id === profile);
    const next =
      options[
        (i + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1) + options.length) % options.length
      ]!;
    onProfile(next.id);
    refs.current[options.indexOf(next)]?.focus();
  };
  return (
    <div className="plate modes" role="group" aria-label="分析设置">
      <div className="seg" role="radiogroup" aria-label="步行人群" onKeyDown={onKey}>
        {options.map((o, i) => (
          <button
            key={o.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={profile === o.id}
            tabIndex={profile === o.id ? 0 : -1}
            onClick={() => onProfile(o.id)}
          >
            {o.label} <span className="num">{o.kmh}</span> km/h
          </button>
        ))}
      </div>
      <label className="chk">
        <input type="checkbox" checked={circle} onChange={(e) => onCircle(e.target.checked)} />
        <span>直线圈</span>
      </label>
      <label className="chk heat">
        <input type="checkbox" checked={heat} onChange={(e) => onHeat(e.target.checked)} />
        <span>耗时色阶</span>
      </label>
    </div>
  );
}

/* ---------------- walk ---------------- */

export function WalkPlate({
  ref,
  T,
  playing,
  walked,
  onPlay,
  onScrub,
  area,
  circleArea,
}: {
  ref?: Ref<HTMLDivElement>;
  T: number;
  playing: boolean;
  walked: boolean;
  onPlay(): void;
  onScrub(T: number): void;
  area: number;
  circleArea: number;
}) {
  const minutes = (T / 60).toFixed(T % 60 ? 1 : 0);
  return (
    <div className="plate walk" ref={ref}>
      <button
        type="button"
        className="play"
        data-busy={playing}
        aria-label={playing ? '停止回放' : '走一遍：播放步行范围从 0 到 15 分钟的生长'}
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
          aria-label="步行时间（秒）"
          aria-valuetext={`${Math.round(T / 60)} 分钟`}
          onChange={(e) => onScrub(Number(e.target.value))}
        />
        <div className="ticks" aria-hidden="true">
          {[0, 5, 10, 15, 20].map((m) => (
            <span key={m} style={{ left: `${(m / 20) * 100}%` }}>
              {m}′
            </span>
          ))}
        </div>
      </div>
      <output className="readout" aria-live="off">
        <b>
          {minutes}′ <span className="word">走得到</span>
        </b>
        <small>
          <span className="num">{area.toFixed(2)}</span> km² · 直线圈{' '}
          <span className="num">{circleArea.toFixed(2)}</span> km²
        </small>
      </output>
    </div>
  );
}

/* ---------------- scale, north, provenance ---------------- */

const NICE = [50, 100, 200, 250, 500, 1000, 2000, 5000];

export function MetaPlate({
  pxPerM,
  canReset,
  onReset,
  attribution,
}: {
  pxPerM: number;
  canReset: boolean;
  onReset(): void;
  /** provenance: full lines (wide maps) and one short line (stacked screens) */
  attribution: { full: string[]; short: string };
}) {
  const m = [...NICE].reverse().find((d) => d * pxPerM <= 200) ?? NICE[0]!;
  const label = m >= 1000 ? `${m / 1000} km` : `${m} m`;
  return (
    <div className="meta">
      <div className="scalebar" aria-label={`比例尺 ${label}`}>
        <span className="bar" style={{ width: Math.round(m * pxPerM) }} />
        <span className="num">{label}</span>
      </div>
      {canReset ? (
        <button
          type="button"
          className="north"
          onClick={onReset}
          title="上北 · 回到分析中心"
          aria-label="上北；回到分析中心"
        >
          <Pg id="pg-north" />
          <span>北</span>
        </button>
      ) : (
        <div className="north" role="img" aria-label="上北">
          <Pg id="pg-north" />
          <span aria-hidden="true">北</span>
        </div>
      )}
      <p className="attrib">
        <span className="full">
          {attribution.full.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </span>
        <span className="short">{attribution.short}</span>
      </p>
    </div>
  );
}
