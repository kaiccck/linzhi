/**
 * The 60px top bar: the mark, the four modes (体检 / 规划 / 报告 / 问询), the area switcher (the
 * sample's letter and NAME, or the live result on screen), and the search box — an address or a
 * coordinate pair; a pair grows a frame choice (BD-09 unless told otherwise) in the box's popover,
 * where the search's notes appear too. On a phone the bar takes two rows and the search folds into
 * a button.
 */
import { Fragment, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { Centre } from '../centre.js';
import { CRS_OPTIONS, parseCoords } from '../data/coords.js';
import { headlineGaps, shortTime, type HistoryItem } from '../data/history.js';
import type { SampleInfo } from '../data/loadAnalysis.js';
import type { Model } from '../model/derive.js';
import type { Mode } from '../state.js';
import { HelpButton } from './Help.js';
import { BRAND, BrandMark } from './Brand.js';
import { Ui } from './Icons.js';

export type TopTab = Mode | 'report';

const MODES: { id: TopTab; label: string }[] = [
  { id: 'check', label: '体检' },
  { id: 'plan', label: '规划' },
  { id: 'report', label: '报告' },
  { id: 'ask', label: '问询' },
];

/** Sample letter from its id: zj-b → B. */
export const letterOf = (id: string) =>
  /^[a-z]+-([a-z0-9]+)$/i.exec(id)?.[1]?.toUpperCase() ?? id.toUpperCase();

/** Radiogroup keyboard model: arrows move the selection, one tab stop. */
export function arrowSelect<T>(
  e: KeyboardEvent<HTMLElement>,
  options: readonly T[],
  current: T,
  select: (next: T, index: number) => void,
) {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
  e.preventDefault();
  const i = options.indexOf(current);
  const step = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
  const k = (i + step + options.length) % options.length;
  select(options[k]!, k);
}

/** One row of the area menu: a sample, a live check from the history, or the live result on screen. */
export interface AreaOption {
  key: string;
  code: string;
  name: string;
  note: string;
  live: boolean;
  /** "画圈 x → 走一遍 y" under the rule set on screen, when the history knows it */
  gaps: { circle: number; walk: number } | null;
  current: boolean;
  /** what choosing it does (nothing for the row on screen) */
  open: (() => void) | null;
}

/**
 * The area menu's rows: the recent live checks the server remembers (newest first), then the samples,
 * each with its headline from GET /api/history. The live result on screen leads when the history does
 * not list it (yet).
 */
export function areaOptions(opts: {
  samples: SampleInfo[];
  history: HistoryItem[] | null;
  active: string | null;
  activeLive: string | null;
  current: { code: string; name: string; live: boolean };
  onOpen(id: string): void;
  onOpenHistory?(item: HistoryItem): void;
}): { live: AreaOption[]; samples: AreaOption[] } {
  const { history } = opts;
  const lives = (history ?? []).filter((h) => !h.sample).slice(0, 8);
  const byId = new Map((history ?? []).map((h) => [h.id, h]));
  const live: AreaOption[] = lives.map((h) => ({
    key: h.id,
    code: '实时',
    name: h.name,
    note: [shortTime(h.created_at), h.label, h.profile === 'elder' ? '老人步速' : null]
      .filter(Boolean)
      .join(' · '),
    live: true,
    gaps: headlineGaps(h.headline),
    current: opts.current.live && opts.activeLive === h.id,
    open: opts.current.live && opts.activeLive === h.id ? null : () => opts.onOpenHistory?.(h),
  }));
  if (opts.current.live && !live.some((o) => o.current)) {
    live.unshift({
      key: '__live',
      code: opts.current.code,
      name: opts.current.name,
      note: '当前实时体检',
      live: true,
      gaps: null,
      current: true,
      open: null,
    });
  }
  const samples: AreaOption[] = opts.samples.map((s) => {
    const h = byId.get(s.id);
    const current = !opts.current.live && s.id === opts.active;
    return {
      key: s.id,
      code: letterOf(s.id),
      name: s.name,
      note: s.center_label ? `样例 · 中心 ${s.center_label}` : '样例',
      live: false,
      gaps: h ? headlineGaps(h.headline) : null,
      current,
      open: current ? null : () => opts.onOpen(s.id),
    };
  });
  return { live, samples };
}

function Gaps({ g }: { g: { circle: number; walk: number } }) {
  return (
    <span className="o-gaps" aria-label={`画圈 ${g.circle} 项缺口，走一遍 ${g.walk} 项`}>
      画圈 <b className="num">{g.circle}</b> → 走一遍 <b className="num">{g.walk}</b>
    </span>
  );
}

function AreaMenu({
  samples,
  active,
  current,
  sourceNote,
  onOpen,
  history,
  activeLive,
  onOpenHistory,
  onMenu,
}: {
  samples: SampleInfo[];
  /** id of the sample on screen; null for a live or replayed check */
  active: string | null;
  /** what is on screen: its letter (or 实时) and name */
  current: { code: string; name: string; live: boolean };
  sourceNote: string;
  onOpen(id: string): void;
  history: HistoryItem[] | null;
  activeLive: string | null;
  onOpenHistory?(item: HistoryItem): void;
  onMenu?(): void;
}) {
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();
  const groups = areaOptions({
    samples,
    history,
    active,
    activeLive,
    current,
    onOpen,
    ...(onOpenHistory ? { onOpenHistory } : {}),
  });
  const options = [...groups.live, ...groups.samples];
  const selected = Math.max(
    0,
    options.findIndex((o) => o.current),
  );
  useEffect(() => {
    if (!open) return;
    setCursor(selected);
    list.current?.focus();
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!list.current?.contains(t) && !btn.current?.contains(t)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open, selected]);
  const choose = (k: number) => {
    const o = options[k];
    setOpen(false);
    btn.current?.focus();
    o?.open?.();
  };
  const onKey = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key === 'Escape' || e.key === 'Tab') {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
      }
      setOpen(false);
      btn.current?.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = options.length;
      setCursor((c) => (c + (e.key === 'ArrowDown' ? 1 : -1) + n) % n);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setCursor(e.key === 'Home' ? 0 : options.length - 1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      choose(cursor);
    }
  };
  const alone = options.length < 2;
  const row = (o: AreaOption, k: number) => (
    <li
      key={o.key}
      id={`${id}-o${k}`}
      role="option"
      aria-selected={o.current}
      className={k === cursor ? 'cursor' : undefined}
      onPointerEnter={() => setCursor(k)}
      onClick={() => choose(k)}
    >
      <span className={'area-code num' + (o.live ? ' live' : '')}>{o.code}</span>
      <span className="o-main">
        <span className="o-name">{o.name}</span>
        <small>{o.note}</small>
      </span>
      {o.gaps ? <Gaps g={o.gaps} /> : null}
    </li>
  );
  return (
    <div className="area">
      <button
        ref={btn}
        type="button"
        className="area-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-menu`}
        aria-label={`片区：${current.name}${alone ? '' : '（切换片区）'}`}
        title={sourceNote}
        disabled={alone}
        onClick={() => {
          if (!open) onMenu?.();
          setOpen((o) => !o);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            onMenu?.();
            setOpen(true);
          }
        }}
      >
        <span className={'area-code num' + (current.live ? ' live' : '')}>{current.code}</span>
        <span className="area-name">{current.name}</span>
        {alone ? null : <Ui id="ui-chevron" />}
      </button>
      {open ? (
        <ul
          ref={list}
          className="area-menu"
          id={`${id}-menu`}
          role="listbox"
          aria-label="片区"
          tabIndex={-1}
          aria-activedescendant={`${id}-o${cursor}`}
          onKeyDown={onKey}
        >
          {groups.live.length ? (
            <Fragment>
              <li className="grp" role="presentation">
                最近的实时体检
              </li>
              {groups.live.map((o, k) => row(o, k))}
            </Fragment>
          ) : null}
          {groups.samples.length ? (
            <Fragment>
              {groups.live.length ? (
                <li className="grp" role="presentation">
                  样例
                </li>
              ) : null}
              {groups.samples.map((o, k) => row(o, groups.live.length + k))}
            </Fragment>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

function Search({ centre, open, onClose }: { centre: Centre; open: boolean; onClose(): void }) {
  const { search, setSearch, crs, onCrs, submit, notes, dismiss } = centre;
  const coords = parseCoords(search);
  const isCoords = coords?.ok === true;
  const [focus, setFocus] = useState(false);
  const [hidden, setHidden] = useState(false);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const ids = CRS_OPTIONS.map((o) => o.id);
  // a new note (or a new text) opens the popover again
  useEffect(() => setHidden(false), [notes, search]);
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setFocus(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, []);
  const pop = !hidden && ((isCoords && focus) || notes.length > 0);
  return (
    <div
      className={'search-box' + (open ? ' open' : '')}
      ref={box}
      onFocus={() => setFocus(true)}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && pop) {
          setHidden(true);
          e.stopPropagation();
        } else if (e.key === 'Escape') onClose();
      }}
    >
      <form
        className="search"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Ui id="ui-search" />
        <input
          ref={input}
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="输入地址或经纬度"
          aria-label="输入地址或经纬度，或在地图上点选中心"
          aria-describedby={notes.length ? 'search-notes' : undefined}
          enterKeyHint="search"
          autoComplete="off"
          spellCheck={false}
        />
      </form>
      {pop ? (
        <div className="search-pop">
          {isCoords ? (
            <div className="crs-row">
              <span className="crs-label" id="crs-label">
                坐标系
              </span>
              <div
                className="seg crs"
                role="radiogroup"
                aria-labelledby="crs-label"
                onKeyDown={(e) =>
                  arrowSelect(e, ids, crs, (next, k) => {
                    onCrs(next);
                    refs.current[k]?.focus();
                  })
                }
              >
                {CRS_OPTIONS.map((o, i) => (
                  <button
                    key={o.id}
                    ref={(el) => {
                      refs.current[i] = el;
                    }}
                    type="button"
                    role="radio"
                    aria-checked={crs === o.id}
                    tabIndex={crs === o.id ? 0 : -1}
                    onClick={() => onCrs(o.id)}
                  >
                    {o.source} <span className="num">{o.code}</span>
                  </button>
                ))}
              </div>
              <span className="crs-hint">回车换算</span>
            </div>
          ) : null}
          {notes.length ? (
            <div className="notes" id="search-notes" role="status">
              {notes.map((n) => (
                <div className="note" key={n.id}>
                  <div className="note-text">{n.text}</div>
                  {n.dismissible !== false ? (
                    <button type="button" className="x" aria-label="关闭提示" onClick={() => dismiss(n.id)}>
                      <Ui id="ui-close" />
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function TopBar({
  tab,
  onTab,
  samples,
  activeSample,
  current,
  sourceNote,
  onOpenSample,
  centre,
  history = null,
  activeLive = null,
  onOpenHistory,
  onMenu,
  help = null,
  live = false,
  onTour,
  tourWhy = '数据载入后可以演示',
}: {
  tab: TopTab;
  onTab(tab: TopTab): void;
  samples: SampleInfo[];
  activeSample: string | null;
  current: { code: string; name: string; live: boolean };
  sourceNote: string;
  onOpenSample(id: string): void;
  /** null while the data loads */
  centre: Centre | null;
  /** GET /api/history: recent live checks and the samples, with their headlines */
  history?: HistoryItem[] | null;
  /** the id of the live check on screen */
  activeLive?: string | null;
  onOpenHistory?(item: HistoryItem): void;
  /** the area menu is opening (the history may be refreshed) */
  onMenu?(): void;
  /** the analysis the “?” panel explains */
  help?: Model | null;
  live?: boolean;
  /** 演示: open 路演模式 (absent while it cannot run: the button stays, disabled, saying why) */
  onTour?(): void;
  tourWhy?: string;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  return (
    <header className="topbar" data-search={searchOpen ? 'open' : undefined}>
      <a className="brand" href="./" aria-label={`${BRAND}，15 分钟生活圈体检`}>
        <BrandMark />
        <span className="brand-word">{BRAND}</span>
        <span className="brand-desc">15 分钟生活圈体检</span>
      </a>
      <nav className="modes" aria-label="功能">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            className="mode"
            aria-current={tab === m.id ? 'page' : undefined}
            onClick={() => onTab(m.id)}
          >
            {m.label}
          </button>
        ))}
      </nav>
      <div className="top-tools">
        <AreaMenu
          samples={samples}
          active={activeSample}
          current={current}
          sourceNote={sourceNote}
          onOpen={onOpenSample}
          history={history}
          activeLive={activeLive}
          {...(onOpenHistory ? { onOpenHistory } : {})}
          {...(onMenu ? { onMenu } : {})}
        />
        {centre ? (
          <>
            <button
              type="button"
              className="search-toggle"
              aria-label="搜索地址或经纬度"
              aria-expanded={searchOpen}
              onClick={() => setSearchOpen((o) => !o)}
            >
              <Ui id={searchOpen ? 'ui-close' : 'ui-search'} />
            </button>
            <Search centre={centre} open={searchOpen} onClose={() => setSearchOpen(false)} />
          </>
        ) : (
          // while the data loads: the box in its place, not yet usable (nothing in the bar moves later)
          <>
            <span className="search-toggle wait" aria-hidden="true">
              <Ui id="ui-search" />
            </span>
            <div className="search-box" aria-hidden="true">
              <div className="search wait">
                <Ui id="ui-search" />
                <input type="search" tabIndex={-1} disabled placeholder="输入地址或经纬度" />
              </div>
            </div>
          </>
        )}
        {help ? (
          <HelpButton model={help} live={live} />
        ) : (
          <span className="tool-btn help-btn wait" aria-hidden="true">
            ?
          </span>
        )}
        <button
          type="button"
          className="tool-btn tour-btn"
          onClick={onTour}
          disabled={!onTour}
          title={onTour ? '路演模式：六步讲清这次体检（← → 翻页，Esc 退出）' : tourWhy}
          aria-label={onTour ? '演示：进入路演模式' : `演示（${tourWhy}）`}
        >
          <Ui id="ui-present" />
          <span>演示</span>
        </button>
      </div>
    </header>
  );
}
