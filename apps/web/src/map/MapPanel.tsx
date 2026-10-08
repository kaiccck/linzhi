/**
 * The map: the real Baidu basemap (JSAPI GL, light style) with our ground and time field under it and
 * the verdict's print over it, the HTML atoms placed by layout.ts, and the floating controls. Falls
 * back to the sample's own OpenStreetMap layers when Baidu cannot load (no AK, no WebGL, no network).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal, flushSync } from 'react-dom';
import type { HardCategory, XY } from '@zoudedao/core';
import {
  LayerMenu,
  LayerOptions,
  MapLegend,
  MapMeta,
  StageCard,
  WalkCard,
  type LayerProps,
  type LegendKind,
  type MethodCounts,
} from '../components/Controls.js';
import type { Centre } from '../centre.js';
import { Ui } from '../components/Icons.js';
import { NumText } from '../components/NumText.js';
import type { StageEvent } from '../data/api.js';
import type { StreamModel } from '../data/stream.js';
import { loadMapFaces } from '../fonts.js';
import {
  affineView,
  compositionFor,
  focusedComposition,
  NARROW_PX,
  staticView,
  type Composition,
  type View,
} from '../geo/view.js';
import { circleKm2, circleMissShare, reachArea, V_ELDER, type Model, type Unit } from '../model/derive.js';
import { CROSSING } from '../model/evidence.js';
import { facilityMarks } from '../model/facilities.js';
import { freshMarks } from '../model/fresh.js';
import { grayRuleText, hasGray } from '../model/gray.js';
import { categoryLook, neutralLook, type Look } from '../model/looks.js';
import type { SitePin, WhatIfEstimate } from '../model/siting.js';
import { spotWords, type MapSpot } from '../model/spots.js';
import type { CheckView, Mode, UiState } from '../state.js';
import { BaiduBasemap } from './BaiduBasemap.js';
import { evidenceItem, type EvidenceView } from './evidenceCard.js';
import { EvidenceLayer, SpotLayer, SpotMarks } from './EvidenceLayer.js';
import { findingItems, type FindingItem } from './findings.js';
import { labelBoxes, layoutOverlay, rectQuads, type Rect } from './layout.js';
import { BaiduLoadError, loadBaidu } from './loadBaidu.js';
import { CardContent, cardClass, MapOverlay } from './MapOverlay.js';
import { ScenePainter } from './paint.js';
import { PlanLines, siteInputs } from './PlanLayer.js';
import { StreamLayer } from './StreamLayer.js';
import { StreamPainter } from './streamPaint.js';

type BasemapState = { kind: 'loading' } | { kind: 'baidu' } | { kind: 'offline'; reason: string };

/** 规划 on the map: what the panel's 规划 view shows, pinned where it would go. */
export interface MapPlan {
  active: boolean;
  pins: SitePin[];
  hotSite: string | null;
  /** the next click places a site */
  placing: boolean;
  estimate: WhatIfEstimate | null;
  /** community names 实测核验 confirmed (null before it ran) */
  measured: string[] | null;
}

/** A live check streaming in: drawn in place of the analysis until its result lands. */
export interface MapStream {
  model: StreamModel;
  label: string;
  stage: StageEvent | null;
}

interface Props {
  model: Model;
  /** changes with every analysis put on screen */
  resultKey: string;
  ui: UiState;
  /** walking-time multiplier of the profile */
  scale: number;
  mode: Mode;
  sub: CheckView;
  cat: HardCategory;
  stream: MapStream | null;
  plan: MapPlan;
  centre: Centre;
  onCancelAnalysis(): void;
  onPlay(): void;
  onScrub(T: number): void;
  onProfile(p: UiState['profile']): void;
  onCircle(on: boolean): void;
  onHeat(on: boolean): void;
  onGray(on: boolean): void;
  onHot(code: string | null): void;
  onPlaceAt(xy: XY, bd09: [number, number]): void;
  onCancelPlacing(): void;
  onHotSite(key: string | null): void;
  onMethod(on: boolean): void;
  onCrossing(on: boolean): void;
  /** 步行路线证据 on screen (the route of one unit's check), or null */
  evidence: EvidenceView | null;
  /** a unit clicked (its code, its finding card): draw its walking route; null closes it */
  onEvidence(code: string | null): void;
  /** a citation's places (问询): lit while it is pointed at, brought into view when it is pinned */
  spot: { spot: MapSpot; pinned: boolean } | null;
  /** the chip's ×: the pinned places go dark */
  onSpotClose?(): void;
  /**
   * 路演模式: the step card (it takes the 走一遍 card's place: the left side of a wide map, the foot
   * of a narrow one), whether the step holds every verdict back, and whether the legend shows
   */
  tour: { card: ReactNode; hold: boolean; legend: boolean } | null;
}

/** A composition moved by a local offset (the centre of a streaming check in this frame). */
const shifted = (c: Composition, [dx, dy]: XY): Composition => ({ ...c, cx: c.cx + dx, cy: c.cy + dy });

const TILE_TIMEOUT_MS = 15000;
/** 路演 on a wide map: the span that fits the reach in the part the step card leaves free */
const TOUR_SPAN = 2400;
const REDUCED = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
/** Baidu's logo control (62 × 26 px, and a hair of room) */
const LOGO = { w: 66, h: 26 };
const FORCE_OFFLINE = new URLSearchParams(window.location.search).get('basemap') === 'offline';
const round6 = (v: number) => Number(v.toFixed(6));
const EMPTY: Record<string, { w: number; h: number }> = {};

function describeFailure(err: unknown): string {
  if (err instanceof BaiduLoadError) {
    if (err.reason === 'no-key') return '未配置百度浏览器端 AK';
    if (err.reason === 'unsupported') return '浏览器不支持 WebGL';
    if (err.reason === 'timeout') return '百度地图加载超时';
    return '无法连接百度地图';
  }
  return '百度地图加载失败';
}

/** A DOM box in map px (relative to the map panel). */
function relRect(el: HTMLElement | null, panel: HTMLElement): Rect | null {
  if (!el || !el.offsetParent) return null;
  const a = el.getBoundingClientRect();
  const m = panel.getBoundingClientRect();
  if (!a.width || !a.height) return null;
  return { x: a.left - m.left, y: a.top - m.top, w: a.width, h: a.height };
}

/**
 * Zoomed in to the buildings (Baidu stands them up from about level 19) the time field thins out, so the
 * walls read through it: full strength to 1.5 px per metre, a third at 5 (level 20) and beyond.
 */
function fieldFade(pxPerM: number): number {
  const t = Math.min(1, Math.max(0, Math.log2(pxPerM / 1.5) / Math.log2(5 / 1.5)));
  return Math.round((1 - t * 0.66) * 100) / 100;
}

export function MapPanel(props: Props) {
  const { model, ui, scale, stream, plan, centre, mode, sub, cat } = props;
  const panelRef = useRef<HTMLElement>(null);
  const bmRef = useRef<HTMLDivElement>(null);
  const underRef = useRef<HTMLCanvasElement>(null);
  const overRef = useRef<HTMLCanvasElement>(null);
  const legendRef = useRef<HTMLDivElement>(null);
  const layersRef = useRef<HTMLDivElement>(null);
  const walkRef = useRef<HTMLDivElement>(null);
  const metaRef = useRef<HTMLDivElement>(null);
  const tourRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ W: number; H: number; dpr: number } | null>(null);
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const [basemap, setBasemap] = useState<BasemapState>(() =>
    FORCE_OFFLINE ? { kind: 'offline', reason: '网址指定' } : { kind: 'loading' },
  );
  const [liveView, setLiveView] = useState<View | null>(null);
  const [userMoved, setUserMoved] = useState(false);
  const userMovedRef = useRef(false);
  userMovedRef.current = userMoved;
  const [floats, setFloats] = useState<{
    rects: Rect[];
    top: number;
    walkTop: number;
    left: number;
    /** the provenance plate's bottom when the 走一遍 card leaves no room beside it (null: its own place) */
    metaBottom: number | null;
  }>({
    rects: [],
    top: 72,
    walkTop: 0,
    left: 0,
    metaBottom: null,
  });
  const [cardSizes, setCardSizes] = useState(EMPTY);
  const [fontsReady, setFontsReady] = useState(false);
  const [dock, setDock] = useState<HTMLDivElement | null>(null);
  const bmInst = useRef<BaiduBasemap | null>(null);
  const painter = useMemo(() => new ScenePainter(model), [model]);
  const streamPainter = useMemo(() => new StreamPainter(), []);
  // 含过街等待 stretches walking times on the field and its readouts, never the circle or a verdict
  const timeScale = scale * (ui.crossing ? CROSSING : 1);
  const area = useMemo(() => reachArea(model.raster, ui.T, timeScale), [model.raster, ui.T, timeScale]);
  const missShare = useMemo(() => circleMissShare(model, scale, timeScale), [model, scale, timeScale]);
  const grayAvailable = useMemo(() => hasGray(model), [model]);
  const marks = useMemo(() => facilityMarks(model, scale), [model, scale]);

  const narrow = size ? size.W < NARROW_PX : false;
  const offline = basemap.kind === 'offline';
  const touring = !!props.tour;
  /** 路演 on a wide map: the step card covers the left side, the map is framed to its right */
  const tourWide = touring && !narrow;
  const pending = centre.pending;
  // a streaming check's centre, in the frame of the analysis on screen (the map is framed on it)
  const streamAt = useMemo<XY | null>(
    () => (stream ? model.frame.toXY(stream.model.center[0], stream.model.center[1]) : null),
    [stream, model.frame],
  );
  const streamKey = streamAt ? streamAt.join(',') : '';
  const unitPoints = useMemo(() => model.units.map((u) => u.centroid), [model.units]);
  // the framing: the mockup's composition on a wide map; on a narrow one the codes and 你在这里,
  // centred in the band the legend and the 走一遍 card leave free
  const framing = (W: number, H: number): { c: Composition; shift: number; shiftX: number } => {
    const isNarrow = W < NARROW_PX;
    if (touring && !isNarrow && floats.left > 0) {
      // the analysis centre in the middle of what the step card leaves free, the reach fitted to it
      const span = (TOUR_SPAN * Math.min(W, H)) / Math.max(1, Math.min(W - floats.left, H));
      return { c: { cx: 0, cy: 0, span }, shift: 0, shiftX: Math.round(floats.left / 2) };
    }
    const base = compositionFor(isNarrow);
    const c = streamAt ? shifted(base, streamAt) : isNarrow ? focusedComposition(base, unitPoints) : base;
    const free = isNarrow && floats.walkTop > floats.top + 40;
    return { c, shift: free ? Math.round((floats.top + floats.walkTop) / 2 - H / 2) : 0, shiftX: 0 };
  };
  const framingRef = useRef(framing);
  framingRef.current = framing;
  const still = size ? framing(size.W, size.H) : null;
  const view: View | null =
    basemap.kind === 'baidu' && liveView && size && liveView.width === size.W && liveView.height === size.H
      ? liveView
      : size && still
        ? staticView(size.W, size.H, still.c, still.shift, still.shiftX, model.frame.lat0)
        : null;
  const viewRef = useRef(view);
  viewRef.current = view;
  // the streaming check's own local metres on this map: the same projection, moved to its centre
  const streamView: View | null =
    view && streamAt
      ? affineView(view.width, view.height, view.x(streamAt[0]), view.y(streamAt[1]), view.sx, view.sy)
      : null;
  const planRef = useRef(plan);
  planRef.current = plan;

  /* ---------- panel size ---------- */
  useLayoutEffect(() => {
    const el = panelRef.current!;
    const measure = () => {
      const W = el.clientWidth;
      const H = el.clientHeight;
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      setSize((prev) => (prev && prev.W === W && prev.H === H && prev.dpr === dpr ? prev : { W, H, dpr }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  /* ---------- the floating controls: nothing on the map goes under them ---------- */
  const measureFloats = useCallback(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const rects: Rect[] = [];
    for (const el of [
      legendRef.current,
      layersRef.current,
      walkRef.current,
      metaRef.current,
      tourRef.current,
    ]) {
      const r = relRect(el, panel);
      if (r) rects.push({ x: r.x - 8, y: r.y - 8, w: r.w + 16, h: r.h + 16 });
    }
    const walk = relRect(walkRef.current, panel);
    const walkTop = walk ? walk.y : panel.clientHeight;
    // the provenance plate keeps the bottom right unless the 走一遍 card reaches under it (a narrow
    // map's card spans the width): then it stands on the card. Its width and right edge never change
    // with its height, so lifting it cannot undo the reason it was lifted.
    const meta = relRect(metaRef.current, panel);
    const metaBottom =
      walk && meta && walk.x + walk.w + 12 > meta.x ? Math.round(panel.clientHeight - walk.y + 8) : null;
    const tops = [legendRef.current, layersRef.current].map((el) => relRect(el, panel)).filter((r) => !!r);
    const top = tops.length ? Math.max(...tops.map((r) => r!.y + r!.h)) + 10 : 72;
    // the step card on the map's left side (路演 on a wide map): the free part starts right of it
    const card = relRect(tourRef.current, panel);
    const left = card ? Math.round(card.x + card.w + 16) : 0;
    setFloats((prev) => {
      const same =
        prev.top === top &&
        prev.walkTop === walkTop &&
        prev.left === left &&
        prev.metaBottom === metaBottom &&
        prev.rects.length === rects.length &&
        prev.rects.every((p, i) => {
          const q = rects[i]!;
          return (
            Math.abs(p.x - q.x) < 0.5 &&
            Math.abs(p.y - q.y) < 0.5 &&
            Math.abs(p.w - q.w) < 0.5 &&
            Math.abs(p.h - q.h) < 0.5
          );
        });
      return same ? prev : { rects, top, walkTop, left, metaBottom };
    });
  }, []);
  // the stage card takes the 走一遍 card's place while a check streams (a new element to observe);
  // Baidu's logo joins the boxes once its map exists
  const streaming = !!stream;
  const baiduUp = basemap.kind === 'baidu';
  useLayoutEffect(() => {
    measureFloats();
    const ro = new ResizeObserver(measureFloats);
    for (const el of [
      legendRef.current,
      layersRef.current,
      walkRef.current,
      metaRef.current,
      tourRef.current,
      panelRef.current,
    ])
      if (el) ro.observe(el);
    return () => ro.disconnect();
  }, [measureFloats, streaming, baiduUp, touring, narrow]);

  /* ---------- canvas text needs the faces: repaint once they are in ---------- */
  useEffect(() => {
    let cancelled = false;
    const base = model.data.base;
    const sample =
      (base?.roads.map((r) => r.name ?? '').join('') ?? '') +
      (base?.landuse.map((l) => l.name ?? '').join('') ?? '') +
      (base?.places?.map((p) => p.name).join('') ?? '') +
      '片区中心直线画的圈半径';
    void loadMapFaces(sample).then(() => {
      if (!cancelled) setFontsReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [model]);

  /* ---------- projection sync: re-read the map every frame while it moves, stop when it settles ---------- */
  const sync = useRef({ raf: 0, stable: 0, key: '' });
  const scheduleSync = useCallback(() => {
    const st = sync.current;
    st.stable = 0;
    if (st.raf) return;
    const step = () => {
      const bm = bmInst.current;
      const s = sizeRef.current;
      if (!bm || !s) {
        st.raf = 0;
        return;
      }
      const v = bm.readView(s.W, s.H);
      if (v && v.key !== st.key) {
        st.key = v.key;
        st.stable = 0;
        // commit in this frame, so the codes move with the map rather than a frame behind it
        flushSync(() => setLiveView(v));
      } else st.stable++;
      st.raf = st.stable < 15 ? requestAnimationFrame(step) : 0;
    };
    st.raf = requestAnimationFrame(step);
  }, []);
  useEffect(() => () => cancelAnimationFrame(sync.current.raf), []);

  const dockRef = useRef<HTMLDivElement | null>(null);
  /** where the layout put Baidu's logo along its band (left edge, px) */
  const logoX = useRef(16);
  const placeCopyright = useCallback(() => {
    const bm = bmInst.current;
    const panel = panelRef.current;
    if (!bm || !panel) return;
    const walk = walkRef.current;
    const dockEl = dockRef.current;
    // above the 走一遍 card, and above a card docked over it (whichever reaches higher); with no such
    // card (路演 on a wide map) at the foot of the map, right of the step card
    const foot = walk ? walk.offsetTop : panel.clientHeight - 8;
    const top = dockEl && dockEl.firstElementChild ? Math.min(dockEl.offsetTop, foot) : foot;
    bm.placeCopyright(Math.round(logoX.current), Math.round(panel.clientHeight - top + 8));
  }, []);

  /* ---------- a centre picked on the map (or a site placed) ---------- */
  const placeRef = useRef(props.onPlaceAt);
  placeRef.current = props.onPlaceAt;
  const streamingRef = useRef(false);
  streamingRef.current = !!stream;
  const pick = useCallback(
    (lng: number, lat: number, force = false) => {
      // 规划: the click places the planned site instead of choosing a new centre
      if (planRef.current.placing) {
        placeRef.current(model.frame.toXY(lng, lat), [round6(lng), round6(lat)]);
        return;
      }
      // a check is streaming in: the map shows its centre, not the one on screen
      if (streamingRef.current) return;
      // a centre only after 新体检 asked for one (the hook ignores a click otherwise)
      centre.pick(lng, lat, force);
    },
    [model, centre],
  );
  // Baidu keeps the handler it was created with; route clicks through a ref so the map is never rebuilt
  const pickRef = useRef(pick);
  pickRef.current = pick;

  // a typed point can be brought into view on the Baidu map (by panning); the offline preview cannot move
  useEffect(() => {
    centre.canReveal.current = (xy: XY) => {
      const v = viewRef.current;
      if (!v) return false;
      const x = v.x(xy[0]);
      const y = v.y(xy[1]);
      return !!bmInst.current || (x > 20 && y > 20 && x < v.width - 20 && y < v.height - 20);
    };
  }, [centre.canReveal]);

  // the Baidu logo moves above a docked card while it is open, and back after
  useEffect(() => {
    const id = window.requestAnimationFrame(placeCopyright);
    return () => window.cancelAnimationFrame(id);
  }, [pending?.ask, placeCopyright, floats.walkTop, props.evidence, touring]);

  // A typed centre is brought into the clear part of the map (below the legend and layers, above the
  // 走一遍 card). The Baidu map pans by the offset; 回到中心 brings the analysis back.
  const revealed = useRef('');
  useEffect(() => {
    const v = viewRef.current;
    const bm = bmInst.current;
    if (!pending || pending.from !== 'coords' || !v || !bm) return;
    const key = pending.bd09.join(',');
    if (revealed.current === key) return;
    revealed.current = key;
    const x = v.x(pending.xy[0]);
    const y = v.y(pending.xy[1]);
    const top = floats.top + 24;
    const bottom = floats.walkTop - 24;
    const left = 40;
    const right = v.width - 40;
    if (x >= left && x <= right && y >= top && y <= bottom) return;
    bm.panBy((left + right) / 2 - x, (top + Math.max(top, bottom)) / 2 - y);
    setUserMoved(true);
  }, [pending, floats]);

  /* ---------- Baidu basemap lifecycle: one map for the page; a new analysis only moves it ---------- */
  const frameRef = useRef(model.frame);
  frameRef.current = model.frame;
  useEffect(() => {
    if (FORCE_OFFLINE) return;
    let cancelled = false;
    let bm: BaiduBasemap | null = null;
    let watchdog = 0;
    const goOffline = (reason: string) => {
      if (cancelled) return;
      window.clearTimeout(watchdog);
      bm?.destroy();
      bmInst.current = null;
      setBasemap({ kind: 'offline', reason });
    };
    loadBaidu(import.meta.env.VITE_BAIDU_BROWSER_AK as string | undefined)
      .then((B) => {
        if (cancelled || !bmRef.current) return;
        bm = new BaiduBasemap(B, bmRef.current, frameRef.current, {
          onChange: scheduleSync,
          onTilesLoaded: () => {
            window.clearTimeout(watchdog);
            if (!cancelled) setBasemap({ kind: 'baidu' });
            // Baidu adds its logo control asynchronously; offsets sent before that are dropped
            placeCopyright();
            window.setTimeout(placeCopyright, 400);
            scheduleSync();
          },
          onUserMove: () => setUserMoved(true),
          onClick: (lng, lat) => pickRef.current(lng, lat),
        });
        bmInst.current = bm;
        // dev-only handle for interaction checks (pan/zoom sync) from the capture scripts
        if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__zddBasemap = bm;
        const s = sizeRef.current;
        if (s) {
          const f = framingRef.current(s.W, s.H);
          bm.fit(f.c, s.W, s.H, f.shift, f.shiftX);
        }
        placeCopyright();
        scheduleSync();
        watchdog = window.setTimeout(() => {
          if (!bm?.tilesLoaded) goOffline('百度瓦片加载超时，请检查网络或 AK 的 Referer 白名单');
        }, TILE_TIMEOUT_MS);
      })
      .catch((err: unknown) => goOffline(describeFailure(err)));
    return () => {
      cancelled = true;
      window.clearTimeout(watchdog);
      bm?.destroy();
      bmInst.current = null;
    };
  }, [scheduleSync, placeCopyright]);

  // another analysis on screen (a sample, a live result): the same map reads its frame and is framed
  // on it; a streaming check is framed on its own centre while it streams, and back after
  const refit = useCallback(() => {
    const bm = bmInst.current;
    const s = sizeRef.current;
    setUserMoved(false);
    if (!bm || !s) return;
    const f = framingRef.current(s.W, s.H);
    bm.fit(f.c, s.W, s.H, f.shift, f.shiftX);
    scheduleSync();
  }, [scheduleSync]);
  const firstFrame = useRef(true);
  useEffect(() => {
    bmInst.current?.setFrame(model.frame);
    if (firstFrame.current) {
      firstFrame.current = false;
      return;
    }
    refit();
  }, [model.frame, refit]);
  const firstStream = useRef(true);
  useEffect(() => {
    if (firstStream.current) {
      firstStream.current = false;
      return;
    }
    refit();
  }, [streamKey, refit]);

  // dev-only: pick a BD-09 point as if the map had been clicked (capture scripts; no Baidu call)
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as Record<string, unknown>;
    w.__zddPick = (lng: number, lat: number) => pickRef.current(lng, lat, true);
    return () => {
      delete w.__zddPick;
    };
  }, []);

  // container resized: let Baidu re-measure, keep the framing unless the user has moved the map
  useEffect(() => {
    const bm = bmInst.current;
    if (!bm || !size) return;
    bm.map.checkResize();
    if (!userMovedRef.current) {
      const f = framingRef.current(size.W, size.H);
      bm.fit(f.c, size.W, size.H, f.shift, f.shiftX);
    }
    placeCopyright();
    scheduleSync();
  }, [size, scheduleSync, placeCopyright]);

  // a narrow map's free band moved (the legend wrapped, the stage card took the 走一遍 card's place):
  // re-centre, unless the user has moved the map
  const bandShift = still ? `${still.shift},${still.shiftX},${Math.round(still.c.span)}` : '';
  useEffect(() => {
    const bm = bmInst.current;
    const s = sizeRef.current;
    if (!bm || !s || userMovedRef.current) return;
    const f = framingRef.current(s.W, s.H);
    bm.fit(f.c, s.W, s.H, f.shift, f.shiftX);
    scheduleSync();
  }, [bandShift, scheduleSync]);
  // entering or leaving 路演 frames the map afresh (the user's own moves are forgotten)
  const firstTour = useRef(true);
  useEffect(() => {
    if (firstTour.current) {
      firstTour.current = false;
      return;
    }
    refit();
  }, [touring, refit]);

  /* ---------- what the map shows ---------- */
  const playing = ui.playing;
  // 走一遍 lands (it played and stopped at 15′): the gap codes ripple once, as the panel's bars grow
  const [landed, setLanded] = useState(false);
  const wasPlaying = useRef(false);
  useEffect(() => {
    const done = wasPlaying.current && !playing && ui.T === 900;
    wasPlaying.current = playing;
    if (done) setLanded(true);
  }, [playing, ui.T]);
  useEffect(() => {
    if (!landed) return;
    const id = window.setTimeout(() => setLanded(false), 1000);
    return () => window.clearTimeout(id);
  }, [landed]);
  const hold = !!props.tour?.hold;
  const facView = mode === 'check' && sub === 'fac';
  // 圈内设施: only the categories ticked in the panel's list, so one kind can be read at a time
  const shownMarks = useMemo(
    () => (facView ? marks.filter((m) => ui.facCats.includes(m.cat)) : marks),
    [facView, marks, ui.facCats],
  );
  // 菜市场 on the 体检 map: the shops the market gaps can buy vegetables at stand beside the markets
  const freshShown = mode === 'check' && !facView && !playing && cat === '菜市场';
  const catMarks = useMemo(
    () => (freshShown ? [...marks, ...freshMarks(model)] : marks),
    [freshShown, marks, model],
  );
  const look = useMemo<(u: Unit) => Look>(
    () => (playing || hold || facView ? neutralLook : categoryLook(cat)),
    [playing, hold, facView, cat],
  );
  const { evidence, onEvidence } = props;
  const closeEvidence = useCallback(() => onEvidence(null), [onEvidence]);
  const evItem = useMemo<FindingItem | null>(
    () =>
      evidence && !touring
        ? evidenceItem(evidence, {
            scale,
            crossing: ui.crossing,
            onClose: closeEvidence,
            rule: model.ruleOf[evidence.base.cat],
          })
        : null,
    [evidence, touring, scale, ui.crossing, closeEvidence, model],
  );
  // the map pins nothing unasked on the 体检单: a picked community's route card is its finding
  const items = useMemo<FindingItem[]>(() => {
    if (evItem) return [evItem];
    if (mode !== 'check' || stream || pending || touring) return [];
    return findingItems(model, { view: sub, marks: shownMarks });
  }, [evItem, mode, stream, pending, touring, model, sub, shownMarks]);
  const sites = useMemo(
    () => (plan.active ? siteInputs(cat, plan.pins, plan.estimate, plan.measured) : undefined),
    [plan.active, cat, plan.pins, plan.estimate, plan.measured],
  );
  // units a planned site would bring within the rule (estimated, or as measured)
  const flips = useMemo(() => {
    const e = plan.active ? plan.estimate : null;
    if (!e) return undefined;
    const names = plan.measured;
    return new Set(
      names
        ? e.demand.filter((u) => names.includes(u.name)).map((u) => u.code)
        : e.flips.map((f) => f.unit.code),
    );
  }, [plan.active, plan.estimate, plan.measured]);

  const L = useMemo(() => {
    if (!view || stream) return null;
    return layoutOverlay({
      model,
      view,
      narrow,
      playing,
      T: ui.T,
      scale,
      circle: ui.circle && !evidence,
      marks: facView ? { kind: 'all', list: shownMarks } : { kind: 'category', cat, list: catMarks },
      sites,
      floats: floats.rects,
      cards: items.flatMap((it) => {
        const s = cardSizes[it.spec.key];
        return s ? [{ ...it.spec, ...s }] : [];
      }),
      route: evidence?.facts?.path ?? model.detour?.path.pts ?? null,
      timeScale,
      logo: baiduUp
        ? tourWide
          ? { y: size!.H - 16 - LOGO.h, w: LOGO.w, h: LOGO.h, x0: floats.left }
          : { y: floats.walkTop - 8 - LOGO.h, w: LOGO.w, h: LOGO.h }
        : null,
    });
  }, [
    view,
    stream,
    model,
    narrow,
    playing,
    ui.T,
    scale,
    timeScale,
    evidence,
    tourWide,
    size,
    floats.left,
    ui.circle,
    facView,
    marks,
    shownMarks,
    catMarks,
    cat,
    sites,
    floats.rects,
    floats.walkTop,
    items,
    cardSizes,
    baiduUp,
  ]);
  // the logo follows the layout's pick along its band
  useEffect(() => {
    const x = L?.logo?.x ?? 16;
    if (x === logoX.current) return;
    logoX.current = x;
    placeCopyright();
  }, [L, placeCopyright]);
  const routeShown = !!L?.cards.some((c) => c.key === 'route');

  // Baidu's own names give way to ours, once the map has settled (a moving map keeps the last set)
  useEffect(() => {
    const bm = bmInst.current;
    if (!bm || basemap.kind !== 'baidu') return;
    const v = viewRef.current;
    const boxes = L && v ? labelBoxes(L) : [];
    const id = window.setTimeout(() => {
      bm.setLabelBlockers(
        boxes.map((b) => {
          const [lng, lat] = model.frame.toLngLat(v!.mx(b.x + b.w / 2), v!.my(b.y + b.h / 2));
          return { lng, lat, w: b.w, h: b.h };
        }),
      );
    }, 250);
    return () => window.clearTimeout(id);
  }, [L, basemap.kind, model.frame]);

  // units lit beside the one under the pointer: the unit whose route is drawn, a citation's units
  const spot = props.spot;
  const lit = useMemo(() => {
    const set = new Set<string>(spot?.spot.codes ?? []);
    if (evidence) set.add(evidence.base.unit.code);
    return set.size ? set : undefined;
  }, [spot, evidence]);

  /* ---------- a route or a citation's places brought into view (the Baidu map pans; offline cannot) ---------- */
  const shown = useRef('');
  const reveal = useCallback(
    (key: string, pts: readonly XY[]) => {
      const v = viewRef.current;
      const bm = bmInst.current;
      const s = sizeRef.current;
      if (!v || !bm || !s || !pts.length || shown.current === key) return;
      shown.current = key;
      const xs = pts.map((p) => v.x(p[0]));
      const ys = pts.map((p) => v.y(p[1]));
      const box = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
      const clear = {
        x0: Math.max(24, floats.left + 8),
        x1: s.W - 24,
        y0: floats.top + 8,
        y1: Math.max(floats.top + 40, floats.walkTop - 16),
      };
      const shift = (a0: number, a1: number, c0: number, c1: number) =>
        a1 - a0 > c1 - c0 ? (c0 + c1) / 2 - (a0 + a1) / 2 : a0 < c0 ? c0 - a0 : a1 > c1 ? c1 - a1 : 0;
      const dx = shift(box.x0, box.x1, clear.x0, clear.x1);
      const dy = shift(box.y0, box.y1, clear.y0, clear.y1);
      if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      bm.panBy(dx, dy, REDUCED());
      setUserMoved(true);
    },
    [floats],
  );
  const evKey = evidence?.status === 'done' ? `${evidence.base.unit.code}|${evidence.base.cat}` : '';
  useEffect(() => {
    if (!evKey || !evidence?.facts) return;
    const f = evidence.facts;
    reveal(`ev:${evKey}`, [...f.path, f.from, ...(f.facilityXY ? [f.facilityXY] : [])]);
    // the route's key only: a new route is revealed once, not on every view change
  }, [evKey]);
  const spotKey = spot?.pinned ? spot.spot.key : '';
  useEffect(() => {
    if (spotKey && spot) reveal(`spot:${spotKey}`, spot.spot.focus);
  }, [spotKey]);

  /* ---------- canvases ---------- */
  useLayoutEffect(() => {
    // a panel laid out at zero size (a hidden or not yet sized pane) has nothing to paint into
    if (!view || !size || size.W < 1 || size.H < 1) return;
    const under = underRef.current!;
    const over = overRef.current!;
    const w = Math.round(size.W * size.dpr);
    const h = Math.round(size.H * size.dpr);
    for (const c of [under, over]) {
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
      }
    }
    if (stream && streamView) {
      streamPainter.paint(
        under.getContext('2d')!,
        over.getContext('2d')!,
        streamView,
        stream.model,
        size.dpr,
        offline,
      );
      return;
    }
    painter.paint(
      under.getContext('2d')!,
      over.getContext('2d')!,
      view,
      {
        T: ui.T,
        scale,
        timeScale,
        circle: ui.circle && !evidence,
        heat: ui.heat,
        hot: ui.hot,
        lit,
        playing,
        gray: ui.gray,
        method: ui.method,
        look,
        route: routeShown,
        flips,
        taken: L ? rectQuads([...L.taken, ...floats.rects]) : [],
      },
      size.dpr,
      offline,
    );
  }, [
    view,
    size,
    painter,
    ui.T,
    scale,
    timeScale,
    ui.circle,
    evidence,
    ui.heat,
    ui.hot,
    lit,
    playing,
    ui.gray,
    ui.method,
    look,
    routeShown,
    flips,
    L,
    floats.rects,
    offline,
    stream,
    streamView,
    streamPainter,
    fontsReady,
  ]);

  /* ---------- capture / e2e hook: <html data-zdd-ready="baidu|offline"> once the first frame is complete ---------- */
  const readyKind = offline ? 'offline' : basemap.kind === 'baidu' && liveView ? 'baidu' : '';
  useEffect(() => {
    const root = document.documentElement;
    if (!readyKind || !fontsReady) {
      delete root.dataset.zddReady;
      return;
    }
    let cancelled = false;
    void document.fonts.ready.then(() =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (!cancelled) root.dataset.zddReady = readyKind;
        }),
      ),
    );
    return () => {
      cancelled = true;
    };
  }, [readyKind, fontsReady]);

  /* ---------- legend and provenance ---------- */
  const methodCounts = useMemo<MethodCounts>(() => {
    const { samples, barriers } = model.data;
    return {
      matrix: samples.filter((x) => x.src === 'routematrix').length,
      vertex: samples.filter((x) => x.src === 'directionlite_path').length,
      barriers: barriers?.length ?? 0,
    };
  }, [model]);
  const legend: LegendKind = useMemo(() => {
    if (playing) return { kind: 'walking' };
    if (facView) return { kind: 'facilities' };
    const looks = new Set(model.units.map((u) => categoryLook(cat)(u)));
    return {
      kind: 'category',
      cat,
      rule: model.ruleOf[cat],
      looks,
      sites: !!plan.active && plan.pins.some((p) => p.cat === cat),
      fresh: freshShown && catMarks.some((m) => m.fresh),
    };
  }, [playing, facView, model, cat, plan.active, plan.pins, freshShown, catMarks]);
  // no provenance on the map (the user's call, 2026-10-01): the 审图号 and the OpenStreetMap credit are
  // in 说明. Only a basemap that failed says so, and whose map stands in for it.
  const attribution = offline
    ? [`离线底图（${basemap.kind === 'offline' ? basemap.reason : ''}）`, '© OpenStreetMap 贡献者']
    : [];
  // 图层: the layers and the walker (the map's top right; laid flat under a phone's map)
  const layerProps: LayerProps = {
    circle: ui.circle,
    onCircle: props.onCircle,
    heat: ui.heat,
    onHeat: props.onHeat,
    gray: grayAvailable ? ui.gray : null,
    onGray: props.onGray,
    method: ui.method,
    onMethod: props.onMethod,
    profile: ui.profile,
    onProfile: props.onProfile,
    vAdult: model.vAdult,
    vElder: V_ELDER,
    crossing: ui.crossing,
    onCrossing: props.onCrossing,
  };
  const band = { top: floats.top, bottom: size ? Math.max(size.H - floats.walkTop + 10, 96) : 104 };
  const kmh = ((ui.profile === 'elder' ? V_ELDER : model.vAdult) * 3.6).toFixed(1);
  const stripNow = [
    ui.circle ? '直线圈' : '',
    ui.heat ? '色阶' : '',
    grayAvailable && ui.gray ? '灰色区域' : '',
    ui.method ? '采样点' : '',
    `${ui.profile === 'elder' ? '老人' : '成人'} ${kmh} km/h`,
    ui.crossing ? '含过街' : '',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <>
      <main
        className="map"
        ref={panelRef}
        aria-label={`${model.data.meta.name}步行可达地图`}
        data-basemap={offline ? 'offline' : 'baidu'}
        data-narrow={narrow}
        data-placing={plan.placing || undefined}
        data-picking={(centre.picking && !plan.placing) || undefined}
        data-docked={((pending?.ask || evItem) && narrow) || undefined}
        data-tour={props.tour ? (narrow ? 'narrow' : 'wide') : undefined}
      >
        <div
          className="bm"
          ref={bmRef}
          onClick={(e) => {
            // offline only: Baidu reports its own clicks (and ignores drags)
            if (!offline || !view || e.target !== e.currentTarget) return;
            const r = e.currentTarget.getBoundingClientRect();
            const [lng, lat] = model.frame.toLngLat(view.mx(e.clientX - r.left), view.my(e.clientY - r.top));
            pick(lng, lat);
          }}
        />
        <canvas
          className="layer under"
          ref={underRef}
          aria-hidden="true"
          style={view ? { opacity: fieldFade(view.s) } : undefined}
        />
        <canvas className="layer over" ref={overRef} aria-hidden="true" />
        {stream && streamView ? (
          <StreamLayer view={streamView} model={stream.model} label={stream.label} />
        ) : view && L ? (
          <>
            {plan.active ? <PlanLines view={view} estimate={plan.estimate} measured={plan.measured} /> : null}
            {spot && !playing ? (
              <>
                <SpotLayer view={view} model={model} spot={spot.spot} />
                <SpotMarks view={view} spot={spot.spot} avoid={L.units.map((u) => u.rect)} />
              </>
            ) : null}
            {evidence && !playing ? (
              <EvidenceLayer
                view={view}
                from={evidence.base.from}
                to={evidence.facts?.facilityXY ?? evidence.base.facilityXY}
                path={evidence.facts?.path ?? null}
                routeKey={`${evidence.base.unit.code}|${evidence.base.cat}|${evidence.facts?.routeM ?? ''}`}
                ruleM={model.ruleOf[evidence.base.cat]}
                tone={
                  evidence.base.look === 'pseudo' || evidence.base.look === 'edge-over'
                    ? 'pseudo'
                    : evidence.base.look === 'blind' || evidence.base.look === 'none'
                      ? 'blind'
                      : 'ink'
                }
              />
            ) : null}
            <MapOverlay
              model={model}
              view={view}
              L={L}
              look={look}
              narrow={narrow}
              hot={ui.hot}
              onHot={props.onHot}
              lit={lit}
              selected={evidence?.base.unit.code ?? null}
              onPick={touring || playing || plan.placing ? undefined : onEvidence}
              cat={cat}
              landed={landed}
              flips={flips}
              hotSite={plan.hotSite}
              onHotSite={props.onHotSite}
              cards={narrow ? undefined : items}
              onCardSizes={setCardSizes}
              pending={pending}
              band={band}
              dock={dock}
              onConfirm={centre.confirm}
              onCancel={() => centre.cancel(false)}
            />
          </>
        ) : null}

        {stream || (props.tour && !props.tour.legend) ? null : (
          <MapLegend
            ref={legendRef}
            legend={legend}
            gray={ui.gray && grayAvailable && !playing}
            grayRule={grayRuleText(model)}
            method={ui.method && !playing ? methodCounts : null}
          />
        )}
        {touring ? null : <LayerMenu ref={layersRef} {...layerProps} />}
        {spot?.pinned && !stream ? (
          // what the map lights for a clicked citation, and the way to clear it
          <div className="spot-chip" style={{ top: floats.top + 2 }} role="status">
            <span className="cite num static">{spot.spot.label.split(' ')[0]}</span>
            <span>
              {spot.spot.label.split(' ').slice(1).join(' ')} · 地图上标出{' '}
              <NumText text={spotWords(spot.spot)} />
            </span>
            <button type="button" className="x" aria-label="取消标出（Esc）" onClick={props.onSpotClose}>
              <Ui id="ui-close" />
            </button>
          </div>
        ) : null}
        {plan.placing ? (
          <p className="map-hint" role="status">
            在地图上点一个位置，放下新的设施 · <kbd>Esc</kbd>
            <button type="button" className="hint-x" onClick={props.onCancelPlacing}>
              取消
            </button>
          </p>
        ) : centre.picking && !pending?.ask ? (
          <p className="map-hint" role="status">
            新体检：在地图上点一个中心，或在上方输入地址、经纬度 · <kbd>Esc</kbd>
            <button type="button" className="hint-x" onClick={centre.stopPick}>
              取消
            </button>
          </p>
        ) : null}

        {props.tour ? (
          // the step card: down the left side of a wide map, at the foot of a narrow one (where the
          // 走一遍 card was, so the framing, the logo and the free band follow it)
          <div className="float tour-float" ref={narrow ? walkRef : tourRef}>
            {props.tour.card}
          </div>
        ) : stream ? (
          <StageCard ref={walkRef} stage={stream.stage} onCancel={props.onCancelAnalysis} />
        ) : (
          <WalkCard
            ref={walkRef}
            T={ui.T}
            playing={playing}
            walked={ui.walked}
            onPlay={props.onPlay}
            onScrub={props.onScrub}
            area={area}
            circleKm2={circleKm2(model, scale)}
            missShare={missShare}
            profile={ui.profile}
            crossing={ui.crossing}
          />
        )}
        <MapMeta
          ref={metaRef}
          bottom={floats.metaBottom}
          pxPerM={view ? view.s : 0.34}
          canReset={!offline && userMoved}
          onReset={refit}
          lines={attribution}
        />
        {/* the confirmation card and the route evidence dock here on narrow maps, over the 走一遍 card */}
        <div
          className="dock"
          ref={(el) => {
            dockRef.current = el;
            setDock(el);
          }}
        />
        {evItem && narrow && dock && !pending?.ask
          ? createPortal(
              <div className={cardClass(evItem) + ' docked'} role="group" aria-label="步行路线">
                <CardContent item={evItem} />
              </div>,
              dock,
            )
          : null}
        <span className="sr-only" aria-live="polite">
          {ui.profile === 'elder' ? `按老人步速 ${kmh} km/h 显示` : ''}
        </span>
      </main>
      {/* a phone's map strip: the layers and the walker under the map, folded to one line (what is on)
          until asked, so the verdict follows the map; the provenance stays in sight */}
      <div className="map-strip">
        <details className="ms-fold">
          <summary>
            <Ui id="ui-layers" />
            <span className="ms-t">图层与步速</span>
            <span className="ms-now">{stripNow}</span>
            <Ui id="ui-chevron" />
          </summary>
          <div className="ms-body">
            <LayerOptions {...layerProps} flat />
          </div>
        </details>
        {attribution.length ? <p className="attrib">{attribution.join(' · ')}</p> : null}
      </div>
    </>
  );
}
