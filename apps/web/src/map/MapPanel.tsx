import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { compositionFor, NARROW_PX, staticView, type View } from '../geo/view.js';
import { fmtInt, reachArea, V_ELDER, type Model } from '../model/derive.js';
import type { UiState } from '../state.js';
import { MetaPlate, ModesPlate, SearchPlate, WalkPlate, type Note } from '../components/Controls.js';
import type { AnalysisRun } from '../App.js';
import type { Health } from '../data/api.js';
import { locate, type LocateCandidate } from '../data/locate.js';
import { BaiduBasemap } from './BaiduBasemap.js';
import { BaiduLoadError, loadBaidu } from './loadBaidu.js';
import { MapOverlay } from './MapOverlay.js';
import { ScenePainter } from './paint.js';

type BasemapState = { kind: 'loading' } | { kind: 'baidu' } | { kind: 'offline'; reason: string };

interface Props {
  model: Model;
  ui: UiState;
  /** walking-time multiplier of the profile */
  scale: number;
  dataNote: string | null;
  health: Health | null;
  run: AnalysisRun | null;
  onAnalyze(c: LocateCandidate): void;
  onCancelAnalysis(): void;
  onPlay(): void;
  onScrub(T: number): void;
  onProfile(p: UiState['profile']): void;
  onCircle(on: boolean): void;
  onHeat(on: boolean): void;
  onHot(code: string | null): void;
}

const TILE_TIMEOUT_MS = 15000;
const FORCE_OFFLINE = new URLSearchParams(window.location.search).get('basemap') === 'offline';

function describeFailure(err: unknown): string {
  if (err instanceof BaiduLoadError) {
    if (err.reason === 'no-key') return '未配置浏览器端 AK（VITE_BAIDU_BROWSER_AK）';
    if (err.reason === 'unsupported') return '浏览器不支持 WebGL';
    if (err.reason === 'timeout') return '百度地图脚本加载超时';
    return '无法连接百度地图';
  }
  return '百度地图加载失败';
}

export function MapPanel(props: Props) {
  const { model, ui, scale, dataNote, health, run, onAnalyze, onCancelAnalysis } = props;
  const live = health?.mode === 'live';
  const panelRef = useRef<HTMLElement>(null);
  const bmRef = useRef<HTMLDivElement>(null);
  const underRef = useRef<HTMLCanvasElement>(null);
  const overRef = useRef<HTMLCanvasElement>(null);
  const walkRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ W: number; H: number; dpr: number } | null>(null);
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const [basemap, setBasemap] = useState<BasemapState>(() =>
    FORCE_OFFLINE ? { kind: 'offline', reason: '已按 ?basemap=offline 关闭百度底图' } : { kind: 'loading' },
  );
  const [liveView, setLiveView] = useState<View | null>(null);
  const [userMoved, setUserMoved] = useState(false);
  const userMovedRef = useRef(false);
  userMovedRef.current = userMoved;
  const [search, setSearch] = useState('');
  const [notes, setNotes] = useState<Note[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [approvalNo, setApprovalNo] = useState<string | null>(null);
  const bmInst = useRef<BaiduBasemap | null>(null);
  const painter = useMemo(() => new ScenePainter(model), [model]);
  const area = useMemo(() => reachArea(model.raster, ui.T, scale), [model.raster, ui.T, scale]);

  const narrow = size ? size.W < NARROW_PX : false;
  const offline = basemap.kind === 'offline';
  const view: View | null =
    basemap.kind === 'baidu' && liveView && size && liveView.width === size.W && liveView.height === size.H
      ? liveView
      : size
        ? staticView(size.W, size.H, compositionFor(narrow))
        : null;

  /* ---------- panel size (the mockup's capture bug was a stale resize: observe the box itself) ---------- */
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
        setLiveView(v);
      } else st.stable++;
      st.raf = st.stable < 15 ? requestAnimationFrame(step) : 0;
    };
    st.raf = requestAnimationFrame(step);
  }, []);
  useEffect(() => () => cancelAnimationFrame(sync.current.raf), []);

  const placeCopyright = useCallback(() => {
    const bm = bmInst.current;
    const panel = panelRef.current;
    const walk = walkRef.current;
    if (!bm || !panel || !walk) return;
    const stacked = panel.clientWidth < NARROW_PX && window.matchMedia('(max-width: 860px)').matches;
    // above the walk plate (stacked screens: level with the one-line provenance)
    const bottom = stacked ? 84 : panel.clientHeight - walk.offsetTop + 8;
    bm.placeCopyright(16, Math.round(bottom));
  }, []);

  const pick = useCallback(
    (x: number, y: number) => {
      setSearch(`已点选：东 ${fmtInt(x)} m，北 ${fmtInt(y)} m（样例模式不重新计算）`);
      setNotes((n) => [...n.filter((k) => k.id !== 'sample'), sampleNote(model, dataNote, live)]);
    },
    [model, dataNote, live],
  );

  /* ---------- Baidu basemap lifecycle ---------- */
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
        bm = new BaiduBasemap(B, bmRef.current, model.frame, {
          onChange: scheduleSync,
          onTilesLoaded: () => {
            window.clearTimeout(watchdog);
            if (!cancelled) setBasemap({ kind: 'baidu' });
            // Baidu adds its logo control asynchronously; offsets sent before that are dropped
            placeCopyright();
            window.setTimeout(() => {
              placeCopyright();
              if (!cancelled && bm) setApprovalNo(bm.approvalNumber());
            }, 400);
            scheduleSync();
          },
          onUserMove: () => setUserMoved(true),
          onClick: (lng, lat) => {
            const [x, y] = model.frame.toXY(lng, lat);
            pick(x, y);
          },
        });
        bmInst.current = bm;
        // dev-only handle for interaction checks (pan/zoom sync) from the capture scripts
        if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__zddBasemap = bm;
        const s = sizeRef.current;
        if (s) bm.fit(compositionFor(s.W < NARROW_PX), s.W, s.H);
        placeCopyright();
        scheduleSync();
        watchdog = window.setTimeout(() => {
          if (!bm?.tilesLoaded) goOffline('百度地图瓦片加载超时（请检查网络，或 AK 的 Referer 白名单）');
        }, TILE_TIMEOUT_MS);
      })
      .catch((err: unknown) => goOffline(describeFailure(err)));
    return () => {
      cancelled = true;
      window.clearTimeout(watchdog);
      bm?.destroy();
      bmInst.current = null;
    };
  }, [model.frame, scheduleSync, placeCopyright, pick]);

  // container resized: let Baidu re-measure, keep the mockup framing unless the user has moved the map
  useEffect(() => {
    const bm = bmInst.current;
    if (!bm || !size) return;
    bm.map.checkResize();
    if (!userMovedRef.current) bm.fit(compositionFor(size.W < NARROW_PX), size.W, size.H);
    placeCopyright();
    scheduleSync();
  }, [size, scheduleSync, placeCopyright]);

  const searchCtl = useRef<AbortController | null>(null);
  const onSearch = useCallback(() => {
    const q = search.trim();
    const show = (note: Note) => setNotes((n) => [...n.filter((k) => k.id !== 'sample'), note]);
    if (!q || q.startsWith('已点选')) {
      show(sampleNote(model, dataNote, live));
      return;
    }
    searchCtl.current?.abort();
    const ctl = new AbortController();
    searchCtl.current = ctl;
    show({ id: 'sample', text: <>正在查找「{q}」…</>, dismissible: false });
    locate(q, ctl.signal)
      .then((r) => {
        if (ctl.signal.aborted) return;
        if (r.kind === 'sample') {
          show({
            id: 'sample',
            text:
              r.id === model.id ? (
                <>
                  「{q}」就是当前样例：{model.place.title}。
                </>
              ) : (
                <>
                  找到样例社区 {r.name}：<a href={`?sample=${encodeURIComponent(r.id)}`}>切换到这个样例</a>
                </>
              ),
          });
        } else if (r.kind === 'place' && live) {
          if (!r.needsConfirmation && r.best.confidence >= 0.6) {
            setNotes((n) => n.filter((k) => k.id !== 'sample'));
            onAnalyze(r.best);
            return;
          }
          // ambiguous: list the candidates and let the planner pick the centre
          show({
            id: 'sample',
            text: (
              <>
                「{q}」有几个可能的位置，请选一个作为体检中心：
                <span className="picks">
                  {r.candidates.slice(0, 3).map((c) => (
                    <button
                      type="button"
                      key={`${c.center_bd09[0]},${c.center_bd09[1]}`}
                      onClick={() => {
                        setNotes((n) => n.filter((k) => k.id !== 'sample'));
                        onAnalyze(c);
                      }}
                    >
                      <b>{c.name}</b>
                      <small>
                        {c.address ? `${c.address} · ` : ''}
                        {c.reason}
                      </small>
                    </button>
                  ))}
                </span>
              </>
            ),
          });
        } else if (r.kind === 'place') {
          show(sampleNote(model, dataNote, live, `已定位：${r.best.name}。`));
        } else if (r.kind === 'none') {
          show(sampleNote(model, dataNote, live, `没有找到「${q}」。`));
        } else {
          show(sampleNote(model, dataNote, live, `${r.message}，无法检索地址。`));
        }
      })
      .catch(() => {});
  }, [search, model, dataNote, live, onAnalyze]);
  useEffect(() => () => searchCtl.current?.abort(), []);

  const resetView = useCallback(() => {
    const bm = bmInst.current;
    const s = sizeRef.current;
    setUserMoved(false);
    if (!bm || !s) return;
    bm.fit(compositionFor(s.W < NARROW_PX), s.W, s.H);
    scheduleSync();
  }, [scheduleSync]);

  /* ---------- canvases ---------- */
  useLayoutEffect(() => {
    if (!view || !size) return;
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
    painter.paint(
      under.getContext('2d')!,
      over.getContext('2d')!,
      view,
      { T: ui.T, scale, circle: ui.circle, heat: ui.heat, hot: ui.hot, playing: ui.playing },
      size.dpr,
      offline,
    );
  }, [view, size, painter, ui.T, scale, ui.circle, ui.heat, ui.hot, ui.playing, offline]);

  /* ---------- capture / e2e hook: <html data-zdd-ready="baidu|offline"> once the first frame is complete ---------- */
  const readyKind = offline ? 'offline' : basemap.kind === 'baidu' && liveView ? 'baidu' : '';
  useEffect(() => {
    const root = document.documentElement;
    if (!readyKind) {
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
  }, [readyKind]);

  /* ---------- notes under the search plate ---------- */
  const offlineNote: Note | null =
    basemap.kind === 'offline' && !dismissed.has('offline')
      ? {
          id: 'offline',
          text: (
            <>
              <strong>离线底图</strong>：{basemap.reason}。当前为 OpenStreetMap 预览底图，步行数据不受影响。
            </>
          ),
        }
      : null;
  const runNote: Note | null = !run
    ? null
    : run.status === 'running'
      ? {
          id: 'run',
          dismissible: false,
          text: (
            <>
              <strong>正在体检</strong>：{run.label}
              {run.stage ? ` · ${run.stage.message}` : ' · 连接服务端…'}
              {run.replay ? '（服务端当前为样例回放，结果仍是申城佳苑样例）' : ''}
              <span className="progress" aria-hidden="true">
                <span style={{ width: `${Math.round((run.stage?.progress ?? 0.02) * 100)}%` }} />
              </span>
              <button type="button" className="link" onClick={onCancelAnalysis}>
                取消
              </button>
            </>
          ),
        }
      : {
          id: 'run',
          text: (
            <>
              <strong>体检未完成</strong>：{run.label} · {run.message}。当前仍显示 {model.place.title}。
            </>
          ),
        };
  const shownNotes = [...(runNote ? [runNote] : []), ...(offlineNote ? [offlineNote] : []), ...notes];
  const dismiss = (id: string) => {
    if (id === 'run') onCancelAnalysis();
    setNotes((n) => n.filter((k) => k.id !== id));
    setDismissed((d) => new Set(d).add(id));
  };

  const rail = !narrow && !ui.playing && ui.T >= 900;
  const date = model.measuredOn;
  const attribution = offline
    ? {
        full: ['底图 © OpenStreetMap 贡献者（离线预览）', `步行路线：百度地图实测 ${date}`],
        short: `底图 © OSM（离线预览）· 路线 百度实测 ${date}`,
      }
    : {
        full: [
          `底图 © 百度地图 · 步行路线：百度地图实测 ${date}`,
          [approvalNo ? `审图号 ${approvalNo}` : '', model.usesOsm ? '小区轮廓 © OpenStreetMap 贡献者' : '']
            .filter(Boolean)
            .join(' · '),
        ].filter(Boolean),
        // one line on a 390px phone: logo + approval number + route source/date + OSM
        short: [approvalNo, `百度实测 ${date}`, model.usesOsm ? '© OSM' : ''].filter(Boolean).join(' · '),
      };

  return (
    <main
      className="map"
      ref={panelRef}
      aria-label={`${model.data.meta.name}步行可达地图`}
      data-basemap={offline ? 'offline' : 'baidu'}
      style={{ ['--logo-room' as string]: offline ? '0px' : '68px' }}
    >
      {/* DOM order = keyboard order: search and settings first, then the map atoms, then the walk */}
      <SearchPlate
        value={search}
        onChange={setSearch}
        onSubmit={onSearch}
        notes={shownNotes}
        onDismiss={dismiss}
      />
      <ModesPlate
        profile={ui.profile}
        onProfile={props.onProfile}
        circle={ui.circle}
        onCircle={props.onCircle}
        heat={ui.heat}
        onHeat={props.onHeat}
        vAdult={model.vAdult}
        vElder={V_ELDER}
      />
      <div
        className="bm"
        ref={bmRef}
        onClick={(e) => {
          // offline only: Baidu reports its own clicks (and ignores drags)
          if (!offline || !view || e.target !== e.currentTarget) return;
          const r = e.currentTarget.getBoundingClientRect();
          pick(view.mx(e.clientX - r.left), view.my(e.clientY - r.top));
        }}
      />
      <canvas className="layer under" ref={underRef} aria-hidden="true" />
      <canvas className="layer over" ref={overRef} aria-hidden="true" />
      {view && (
        <MapOverlay
          model={model}
          view={view}
          narrow={narrow}
          offline={offline}
          playing={ui.playing}
          T={ui.T}
          scale={scale}
          circle={ui.circle}
          rail={rail}
          hot={ui.hot}
          onHot={props.onHot}
        />
      )}

      <WalkPlate
        ref={walkRef}
        T={ui.T}
        playing={ui.playing}
        walked={ui.walked}
        onPlay={props.onPlay}
        onScrub={props.onScrub}
        area={area}
        circleArea={model.data.stats.area_circle15_km2}
      />
      <MetaPlate
        pxPerM={view ? view.s : 0.34}
        canReset={!offline && userMoved}
        onReset={resetView}
        attribution={attribution}
      />
    </main>
  );
}

function sampleNote(model: Model, dataNote: string | null, live: boolean, lead = ''): Note {
  return {
    id: 'sample',
    text: live ? (
      <>
        {lead}
        换一个更完整的地址（带路名或门牌）再试。当前显示：{model.place.title}。
      </>
    ) : (
      <>
        {lead}
        <strong>样例模式</strong>只查样例社区；检索任意地址、重新算路需要服务端 live 模式（见
        README）。当前回放：
        {model.place.title}。{dataNote ? ` ${dataNote}` : ''}
      </>
    ),
  };
}
