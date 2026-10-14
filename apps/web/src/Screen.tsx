import { lazy, Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { HardCategory, XY } from '@zoudedao/core';
import type { AnalysisRun, View } from './App.js';
import { useCentre } from './centre.js';
import { worstCategory } from './components/Categories.js';
import { Panel, type PanelRun } from './components/Panel.js';
import { TopBar, type TopTab } from './components/TopBar.js';
import { TourCard } from './components/Tour.js';
import { ApiError, type Health } from './data/api.js';
import { getBranches, type HistoryItem, type WhatIfBranch } from './data/history.js';
import type { SampleInfo } from './data/loadAnalysis.js';
import type { LocateCandidate } from './data/locate.js';
import { bundledRoute, getRoute } from './data/route.js';
import { streamModel } from './data/stream.js';
import { postWhatIf } from './data/whatif.js';
import type { EvidenceView } from './map/evidenceCard.js';
import { MapPanel, type MapPlan, type MapStream } from './map/MapPanel.js';
import { profileScale, type Model } from './model/derive.js';
import { evidenceBase, evidenceFacts, noRouteReason } from './model/evidence.js';
import { sitePins, whatIf, type SitePin } from './model/siting.js';
import type { MapSpot } from './model/spots.js';
import { tourSteps } from './model/tour.js';
import {
  initialPlan,
  initialUi,
  uiReducer,
  type CheckView,
  type Evidence,
  type Mode,
  type PlanState,
  type Profile,
} from './state.js';

/** 走一遍: 15′ in 2.8 s, slow off the mark and into the edge, and it lands the instant it reaches 15′. */
const WALK_MS = 2800;
const WALK_TO = 900;
const easeInOut = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
/** the opening's pause between the map settling and the walk, and the longest it waits for the map */
const INTRO_BREATH_MS = 450;
const INTRO_LATEST_MS = 7000;

/** ?tour opens 路演模式 on its first step, ?tour=3 on the third */
const tourFromUrl = (): number | null => {
  const q = new URLSearchParams(window.location.search);
  if (!q.has('tour')) return null;
  const n = Number(q.get('tour'));
  return Number.isInteger(n) && n >= 1 ? n - 1 : 0;
};

// the printable report is its own chunk (and its own print stylesheet): the check screen never pays for it
const Report = lazy(() => import('./report/Report.js'));

/**
 * The check screen: the top bar, the panel and the map — or the printed report of the same analysis.
 * It stays mounted from one analysis to the next (the Baidu map is never rebuilt); `resultKey` marks
 * a new analysis, which resets what belonged to the last one.
 */
export function Screen({
  model,
  resultKey,
  dataNote,
  sourceNote,
  sourceTag,
  health,
  run,
  samples,
  activeSample,
  onOpenSample,
  onAnalyze,
  onCancelAnalysis,
  mode,
  onMode,
  analysisId,
  askBlocked,
  measureBlocked,
  view,
  onView,
  server,
  history,
  activeLive,
  onOpenHistory,
  onHistoryMenu,
  intro = false,
}: {
  model: Model;
  resultKey: string;
  dataNote: string | null;
  sourceNote: string;
  sourceTag: string | null;
  health: Health | null;
  run: AnalysisRun | null;
  samples: SampleInfo[];
  /** id of the sample on screen; null for a live or replayed check */
  activeSample: string | null;
  onOpenSample(id: string): void;
  onAnalyze(c: LocateCandidate): void;
  onCancelAnalysis(): void;
  mode: Mode;
  onMode(mode: Mode): void;
  /** what 问询 and 实测核验 are about; null when they cannot (reasons below) */
  analysisId: string | null;
  askBlocked: string | null;
  measureBlocked: string | null;
  view: View;
  onView(view: View): void;
  /** a server stands behind /api (not the bundled sample alone) */
  server: boolean;
  /** GET /api/history: recent live checks and the samples (null until it answers) */
  history: HistoryItem[] | null;
  /** the id of the live check on screen */
  activeLive: string | null;
  onOpenHistory(item: HistoryItem): void;
  /** the area menu opened: a chance to refresh the history */
  onHistoryMenu(): void;
  /** the first visit's opening: the reach waits at 0 and walks once by itself when the map is ready */
  intro?: boolean;
}) {
  const [ui, dispatch] = useReducer(uiReducer, intro, (i) =>
    i ? { ...initialUi, T: 0, playing: true } : initialUi,
  );
  const playingRef = useRef(false);
  playingRef.current = ui.playing;
  const raf = useRef(0);
  const scale = profileScale(ui.profile, model.vAdult);
  const [cat, setCat] = useState<HardCategory>(() => worstCategory(model));
  const [sub, setSub] = useState<CheckView>(() => (window.location.hash === '#facilities' ? 'fac' : 'sheet'));
  const [plan, setPlan] = useState<PlanState>(initialPlan);
  const planRef = useRef(plan);
  planRef.current = plan;
  const measureCtl = useRef<AbortController | null>(null);
  const live = health?.mode === 'live';
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const evidenceRef = useRef(evidence);
  evidenceRef.current = evidence;
  const evCtl = useRef<AbortController | null>(null);
  const [spot, setSpot] = useState<{ spot: MapSpot; pinned: boolean } | null>(null);
  const [tourAt, setTourAt] = useState<number | null>(tourFromUrl);
  const touring = tourAt !== null;
  const [branches, setBranches] = useState<WhatIfBranch[] | null>(null);
  const [branchSeq, setBranchSeq] = useState(0);

  const centre = useCentre({ model, dataNote, live, run, resultKey, onAnalyze, onCancelAnalysis });
  const centreRef = useRef(centre);
  centreRef.current = centre;
  // 新体检: the map (or the search) is asked for a new centre; pressed again, it stops asking
  const onNewCheck = useCallback(() => {
    const c = centreRef.current;
    if (c.picking) {
      c.stopPick();
      return;
    }
    // one click mode at a time: 规划's own placing stops
    setPlan((p) => (p.placing ? { ...p, placing: false } : p));
    c.startPick();
  }, []);

  const stopLoop = () => {
    cancelAnimationFrame(raf.current);
    raf.current = 0;
  };

  // a new analysis on screen: its reach at 15′, its worst category, no planned site
  // (keyed on the result, not on a first-run flag: StrictMode's second mount is no new analysis)
  const shownKey = useRef(resultKey);
  useEffect(() => {
    if (shownKey.current === resultKey) return;
    shownKey.current = resultKey;
    stopLoop();
    dispatch({ type: 'reset' });
    setCat(worstCategory(model));
    measureCtl.current?.abort();
    setPlan(initialPlan);
    evCtl.current?.abort();
    setEvidence(null);
    setSpot(null);
    setBranches(null);
    // the model is read for its worst category once per result, not again when the rule set changes
  }, [resultKey]);

  // the walk: the reach from 0 to 15′ over WALK_MS, eased in and out
  const walk = useCallback(() => {
    stopLoop();
    dispatch({ type: 'play' });
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / WALK_MS);
      const T = Math.round((easeInOut(p) * WALK_TO) / 10) * 10;
      // no frame waits at 15′: the verdict lands as the walk reaches it
      if (T < WALK_TO) {
        dispatch({ type: 'tick', T });
        raf.current = requestAnimationFrame(tick);
      } else {
        raf.current = 0;
        dispatch({ type: 'finish' });
      }
    };
    raf.current = requestAnimationFrame(tick);
  }, []);

  // 走一遍: the reach replays from 0; tints, codes and rows hold their verdict until 15′
  const onPlay = useCallback(() => {
    if (playingRef.current) {
      stopLoop();
      dispatch({ type: 'stop' });
      return;
    }
    // The Verdict Waits: a route on the map is a verdict's evidence, it goes while the reach replays
    evCtl.current?.abort();
    setEvidence(null);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      dispatch({ type: 'finish' });
      return;
    }
    walk();
  }, [walk]);

  // the opening (App asks for it once per tab): held at 0 until the map says it is ready
  // (<html data-zdd-ready>), a breath, then the same walk; a planner who got there first wins
  useEffect(() => {
    if (!intro) return;
    const root = document.documentElement;
    let timer = 0;
    const go = () => {
      if (timer) return;
      timer = window.setTimeout(() => {
        if (playingRef.current && !raf.current) walk();
      }, INTRO_BREATH_MS);
    };
    const mo = new MutationObserver(() => {
      if (root.dataset.zddReady) go();
    });
    if (root.dataset.zddReady) go();
    else mo.observe(root, { attributes: true, attributeFilter: ['data-zdd-ready'] });
    // a basemap that never settles: walk on the drawn map rather than hold the verdict back
    const late = window.setTimeout(go, INTRO_LATEST_MS);
    return () => {
      mo.disconnect();
      clearTimeout(timer);
      clearTimeout(late);
    };
  }, [intro, walk]);

  const onScrub = useCallback((T: number) => {
    stopLoop();
    dispatch({ type: 'scrub', T });
  }, []);
  const onHot = useCallback((code: string | null) => dispatch({ type: 'hot', code }), []);
  const onProfile = useCallback((profile: Profile) => dispatch({ type: 'profile', profile }), []);
  const onCircle = useCallback((on: boolean) => dispatch({ type: 'circle', on }), []);
  const onHeat = useCallback((on: boolean) => dispatch({ type: 'heat', on }), []);
  const onGray = useCallback((on: boolean) => dispatch({ type: 'gray', on }), []);
  const onMethod = useCallback((on: boolean) => dispatch({ type: 'method', on }), []);
  const onCrossing = useCallback((on: boolean) => dispatch({ type: 'crossing', on }), []);
  const onFacCat = useCallback((cat: string, on: boolean) => dispatch({ type: 'facCat', cat, on }), []);

  const onTab = useCallback(
    (tab: TopTab) => {
      if (tab === 'report') {
        stopLoop();
        dispatch({ type: 'stop' });
        onView('report');
        return;
      }
      onMode(tab);
      if (view === 'report') onView('check');
    },
    [onMode, onView, view],
  );

  useEffect(() => {
    // capture helpers, as in the mockup: #play starts the walk on load, #gray turns the layer on
    if (view !== 'check') return;
    if (window.location.hash === '#play') onPlay();
    if (window.location.hash === '#gray') onGray(true);
    if (window.location.hash === '#method') onMethod(true);
    return stopLoop;
  }, [onPlay, onGray, onMethod, view]);

  /* ---------- 规划: suggestions, and the planner's own site ---------- */
  const pins = useMemo(() => sitePins(model), [model]);
  const estimate = useMemo(
    () => (plan.site ? whatIf(model, cat, plan.site.xy) : null),
    [model, cat, plan.site],
  );
  const measured = plan.measure.status === 'done' ? plan.measure.result.newly_covered : null;
  // the report carries the planner's own site as it stands on the 规划 page
  const reportWhatIf = useMemo(
    () =>
      plan.site && estimate
        ? {
            cat,
            covers: measured
              ? estimate.demand.filter((u) => measured.includes(u.name))
              : estimate.flips.map((f) => f.unit),
            verified: !!measured,
          }
        : null,
    [plan.site, estimate, measured, cat],
  );
  const onPlan = useCallback(() => onMode('plan'), [onMode]);
  const onPlace = useCallback(() => {
    measureCtl.current?.abort();
    centreRef.current.stopPick();
    setPlan((p) => ({ ...p, placing: true }));
    onMode('plan');
  }, [onMode]);
  const onPlaceAt = useCallback((xy: XY, bd09: [number, number]) => {
    measureCtl.current?.abort();
    setPlan((p) => ({ ...p, placing: false, site: { xy, bd09 }, measure: { status: 'idle' } }));
  }, []);
  const onUseSite = useCallback(
    (site: SitePin) => {
      centreRef.current.stopPick();
      onPlaceAt(site.xy, model.frame.toLngLat(...site.xy));
    },
    [model, onPlaceAt],
  );
  const onCancelPlacing = useCallback(() => setPlan((p) => (p.placing ? { ...p, placing: false } : p)), []);
  const onClearSite = useCallback(() => {
    measureCtl.current?.abort();
    setPlan((p) => ({ ...p, placing: false, site: null, measure: { status: 'idle' } }));
  }, []);
  const onHotSite = useCallback(
    (key: string | null) => setPlan((p) => (p.hotSite === key ? p : { ...p, hotSite: key })),
    [],
  );
  // a measurement answers one category: choosing another starts over (a saved branch that brings its
  // own category along stays)
  useEffect(() => {
    if (touring) return;
    const m = planRef.current.measure;
    if (m.status === 'idle' || m.cat === cat) return;
    measureCtl.current?.abort();
    setPlan((p) => ({ ...p, measure: { status: 'idle' } }));
  }, [cat, touring]);
  const onMeasure = useCallback(() => {
    const site = plan.site;
    if (!site || !analysisId || measureBlocked) return;
    measureCtl.current?.abort();
    const ctl = new AbortController();
    measureCtl.current = ctl;
    setPlan((p) => ({ ...p, measure: { status: 'running', cat } }));
    postWhatIf({ analysis_id: analysisId, category: cat, site_bd09: site.bd09 }, ctl.signal)
      .then((result) => {
        if (ctl.signal.aborted) return;
        setPlan((p) => ({ ...p, measure: { status: 'done', cat, result } }));
        // the server saved it as a branch of this analysis: the list below picks it up
        setBranchSeq((n) => n + 1);
      })
      .catch((err: unknown) => {
        if (ctl.signal.aborted) return;
        setPlan((p) => ({
          ...p,
          measure: {
            status: 'failed',
            cat,
            message: err instanceof Error ? err.message : String(err),
          },
        }));
      });
  }, [plan.site, analysisId, measureBlocked, cat]);

  // the what-if measurements saved on this analysis (GET /api/analysis/:id/branches), read in 规划
  useEffect(() => {
    if (mode !== 'plan' || !analysisId || !server) return;
    const ctl = new AbortController();
    getBranches(analysisId, ctl.signal)
      .then((b) => {
        if (!ctl.signal.aborted) setBranches(b);
      })
      .catch(() => {
        if (!ctl.signal.aborted) setBranches(null);
      });
    return () => ctl.abort();
  }, [mode, analysisId, server, branchSeq]);
  // a saved branch back on the map: its site, its category, its measured answer
  const onRestoreBranch = useCallback(
    (b: WhatIfBranch) => {
      measureCtl.current?.abort();
      setCat(b.category);
      setPlan((p) => ({
        ...p,
        placing: false,
        site: { xy: model.frame.toXY(b.site_bd09[0], b.site_bd09[1]), bd09: b.site_bd09 },
        measure: {
          status: 'done',
          cat: b.category,
          result: b,
          saved: { id: b.id, created_at: b.created_at },
        },
      }));
    },
    [model],
  );
  useEffect(() => () => measureCtl.current?.abort(), []);
  // Esc puts the site down again (placing only; the rest of the page keeps its own Esc)
  useEffect(() => {
    if (!plan.placing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancelPlacing();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [plan.placing, onCancelPlacing]);
  // leaving 规划 stops placing (a stray click must not put a site down unseen)
  useEffect(() => {
    if (mode !== 'plan') onCancelPlacing();
  }, [mode, onCancelPlacing]);

  /* ---------- 步行路线证据: the real walking route of one unit's check ---------- */
  const closeEvidence = useCallback(() => {
    evCtl.current?.abort();
    setEvidence(null);
  }, []);
  const openEvidence = useCallback(
    (code: string, forCat: HardCategory) => {
      evCtl.current?.abort();
      const base = evidenceBase(model, code, forCat);
      if (!base) return;
      const why = noRouteReason(base.check, forCat, model.ruleOf[forCat]);
      if (why) {
        setEvidence({ status: 'failed', code, cat: forCat, message: why });
        return;
      }
      const ctl = new AbortController();
      evCtl.current = ctl;
      setEvidence({ status: 'loading', code, cat: forCat });
      const req = { community: base.unit.name, category: forCat };
      const toXY = (lng: number, lat: number) => model.frame.toXY(lng, lat);
      // no server: the bundled sample's stored routes (a static page still shows its 伪覆盖 routes)
      const route = analysisId
        ? getRoute({ ...req, analysis_id: analysisId }, toXY, ctl.signal)
        : bundledRoute(model.id, req, toXY).then((r) => {
            if (r) return r;
            throw new ApiError(
              'offline',
              '未连接服务端，内置数据里也没有这条路线；启动邻至服务端后可以查看。',
            );
          });
      route
        .then((r) => {
          if (!ctl.signal.aborted) setEvidence({ status: 'done', code, cat: forCat, route: r });
        })
        .catch((err: unknown) => {
          if (ctl.signal.aborted) return;
          const message = err instanceof Error ? err.message : String(err);
          setEvidence({ status: 'failed', code, cat: forCat, message });
        });
    },
    [model, analysisId],
  );
  const onEvidence = useCallback(
    (code: string | null) => {
      const cur = evidenceRef.current;
      if (!code || (cur && cur.code === code && cur.cat === cat)) {
        closeEvidence();
        return;
      }
      if (playingRef.current) return;
      openEvidence(code, cat);
    },
    [cat, openEvidence, closeEvidence],
  );
  // a route answers one category (路演 opens the category it needs with it)
  useEffect(() => {
    const e = evidenceRef.current;
    if (e && e.cat !== cat) closeEvidence();
  }, [cat, closeEvidence]);
  useEffect(() => () => evCtl.current?.abort(), []);
  // Esc closes the route (路演 keeps its own keys)
  useEffect(() => {
    if (!evidence || touring) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) closeEvidence();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [evidence, touring, closeEvidence]);
  const evidenceView = useMemo<EvidenceView | null>(() => {
    if (!evidence) return null;
    const base = evidenceBase(model, evidence.code, evidence.cat);
    if (!base) return null;
    const facts =
      evidence.status === 'done'
        ? evidenceFacts(model, base, evidence.route, { scale, crossing: ui.crossing })
        : null;
    return {
      status: evidence.status,
      base,
      facts,
      message: evidence.status === 'failed' ? evidence.message : null,
    };
  }, [evidence, model, scale, ui.crossing]);

  // a citation's places light only while 问询 is up
  useEffect(() => {
    if (mode !== 'ask') setSpot(null);
  }, [mode]);

  /* ---------- 路演模式: six steps told on the map, in large type ---------- */
  const steps = useMemo(
    () => (touring ? tourSteps(model, { scale, pins }) : []),
    [touring, model, scale, pins],
  );
  const step = tourAt === null ? null : (steps[Math.min(tourAt, steps.length - 1)] ?? null);
  const beforeTour = useRef<{ mode: Mode; sub: CheckView; cat: HardCategory; gray: boolean } | null>(null);
  const startTour = useCallback(() => {
    centreRef.current.stopPick();
    beforeTour.current = { mode, sub, cat, gray: ui.gray };
    onView('check');
    setTourAt(0);
    // the projector: the whole screen when the browser allows it (Esc leaves both)
    void document.documentElement.requestFullscreen?.().catch(() => {});
  }, [mode, sub, cat, ui.gray, onView]);
  const exitTour = useCallback(() => {
    stopLoop();
    setTourAt(null);
    closeEvidence();
    const b = beforeTour.current;
    beforeTour.current = null;
    if (b) {
      onMode(b.mode);
      setSub(b.sub);
      setCat(b.cat);
      onGray(b.gray);
    } else onGray(false);
    dispatch({ type: 'scrub', T: 900 });
    setPlan((p) => ({ ...p, hotSite: null }));
    const url = new URL(window.location.href);
    if (url.searchParams.has('tour')) {
      url.searchParams.delete('tour');
      window.history.replaceState(window.history.state, '', url);
    }
    if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
  }, [closeEvidence, onMode, onGray]);
  // leaving the browser's full screen (its own Esc) leaves the tour too
  useEffect(() => {
    if (!touring) return;
    let wasFull = !!document.fullscreenElement;
    const onChange = () => {
      if (wasFull && !document.fullscreenElement) exitTour();
      wasFull = !!document.fullscreenElement;
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [touring, exitTour]);
  // each step sets the map: its mode and view, its category, its layers, its route, its walk
  const stepId = step ? `${tourAt}:${step.id}` : '';
  useEffect(() => {
    if (!step) return;
    const m = step.map;
    stopLoop();
    onMode(m.mode);
    setSub(m.sub);
    setCat(m.cat);
    onGray(m.gray);
    setPlan((p) => ({ ...p, placing: false, hotSite: m.site }));
    if (m.evidence) openEvidence(m.evidence.code, m.evidence.cat);
    else closeEvidence();
    if (m.T === 'play') {
      dispatch({ type: 'scrub', T: 0 });
      const id = requestAnimationFrame(() => onPlay());
      return () => cancelAnimationFrame(id);
    }
    dispatch({ type: 'scrub', T: m.T });
    // a step is applied when it is reached, not again when anything it reads changes
  }, [stepId]);

  const mapPlan: MapPlan = {
    active: mode === 'plan',
    pins,
    hotSite: plan.hotSite,
    placing: plan.placing && !touring,
    estimate: mode === 'plan' && !touring ? estimate : null,
    measured: mode === 'plan' && !touring ? measured : null,
  };

  /* ---------- a live check streaming in ---------- */
  const running = run?.status === 'running' ? run : null;
  const sModel = useMemo(
    () => (running ? streamModel(running.stream.partial, running.stream.seen) : null),
    [running],
  );
  const mapStream: MapStream | null =
    running && sModel ? { model: sModel, label: running.label, stage: running.stream.stage } : null;
  const panelRun: PanelRun | null =
    running && sModel
      ? {
          label: running.label,
          stream: running.stream,
          model: sModel,
          note: running.replay ? '服务端当前为样例回放，结果仍是申城佳苑样例' : (running.conversion ?? null),
        }
      : null;

  const current = {
    code: model.code,
    name: model.data.meta.name,
    live: activeSample === null,
  };

  return (
    <div className={'app' + (view === 'report' ? ' reporting' : '') + (touring ? ' touring' : '')}>
      <TopBar
        tab={view === 'report' ? 'report' : mode}
        onTab={onTab}
        samples={samples}
        activeSample={activeSample}
        current={current}
        sourceNote={sourceNote}
        onOpenSample={onOpenSample}
        centre={view === 'report' ? null : centre}
        history={history}
        activeLive={activeLive}
        onOpenHistory={onOpenHistory}
        onMenu={onHistoryMenu}
        help={model}
        live={live}
        onTour={view === 'report' || running ? undefined : startTour}
        tourWhy={running ? '体检进行中，结束后可以演示' : '回到体检页可以演示'}
        onNewCheck={view === 'report' || running || touring ? undefined : onNewCheck}
        newCheckOn={centre.picking}
        newCheckWhy={running ? '体检进行中' : touring ? '演示中不能选点' : '回到体检页可以选点'}
      />
      {view === 'report' ? (
        <Suspense fallback={<p className="report-loading">正在排版体检报告…</p>}>
          <Report
            model={model}
            profile={ui.profile}
            scale={scale}
            sourceNote={sourceNote}
            sourceTag={sourceTag}
            analysisId={analysisId}
            pins={pins}
            whatif={reportWhatIf}
          />
        </Suspense>
      ) : (
        <div className="workspace" data-mode={mode}>
          <Panel
            model={model}
            mode={mode}
            onPlan={onPlan}
            sub={sub}
            onSub={setSub}
            cat={cat}
            onCat={setCat}
            scale={scale}
            profile={ui.profile}
            hot={ui.hot}
            walking={ui.playing}
            onHot={onHot}
            facCats={ui.facCats}
            onFacCat={onFacCat}
            sourceTag={sourceTag}
            sourceNote={sourceNote}
            dataNote={dataNote}
            samples={samples}
            analysisId={analysisId}
            askBlocked={askBlocked}
            advisor={health?.advisor}
            resultKey={resultKey}
            pins={pins}
            plan={plan}
            estimate={estimate}
            measureBlocked={measureBlocked}
            onPlace={onPlace}
            onUseSite={onUseSite}
            onClearSite={onClearSite}
            onMeasure={onMeasure}
            onHotSite={onHotSite}
            run={panelRun}
            onCancelRun={onCancelAnalysis}
            onEvidence={onEvidence}
            selected={evidence?.cat === cat ? evidence.code : null}
            spot={spot}
            onSpot={setSpot}
            branches={branches}
            onRestoreBranch={onRestoreBranch}
          />
          <MapPanel
            model={model}
            resultKey={resultKey}
            ui={ui}
            scale={scale}
            mode={mode}
            sub={sub}
            cat={cat}
            stream={mapStream}
            plan={mapPlan}
            centre={centre}
            onCancelAnalysis={onCancelAnalysis}
            onPlay={onPlay}
            onScrub={onScrub}
            onProfile={onProfile}
            onCircle={onCircle}
            onHeat={onHeat}
            onGray={onGray}
            onHot={onHot}
            onPlaceAt={onPlaceAt}
            onCancelPlacing={onCancelPlacing}
            onHotSite={onHotSite}
            onMethod={onMethod}
            onCrossing={onCrossing}
            evidence={evidenceView}
            onEvidence={onEvidence}
            spot={spot}
            onSpotClose={() => setSpot(null)}
            tour={
              step && tourAt !== null
                ? {
                    card: (
                      <TourCard
                        steps={steps}
                        at={tourAt}
                        onGo={setTourAt}
                        onExit={exitTour}
                        place={model.place.title}
                        code={model.code}
                        evidence={evidenceView}
                      />
                    ),
                    hold: step.map.hold,
                    legend: !step.map.hold,
                  }
                : null
            }
          />
        </div>
      )}
    </div>
  );
}
