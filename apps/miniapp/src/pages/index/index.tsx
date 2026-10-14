/*
 * THESIS: a map app, not a dashboard — the walk on the map, the answer in a sheet over it; refuses
 *   the web's 400 px desk squeezed onto a phone.
 * OWN-WORLD: canon map app at 高德 / Apple 地图 craft — full-bleed map, white sheet with a grip,
 *   system type with DIN numerals, one blue (#2468F2) for actions, colour spent only on verdicts
 *   (伪覆盖 red, 盲区 slate, 走得到 teal) and the sand of the walk.
 * STORY: a planner sees how many communities cannot walk to a facility and why; a resident sees
 *   what 15 minutes reach (餐饮, 超市, 公交 …); both open a community or a facility to see the walk.
 * FIRST VIEWPORT: map with the reach and coded communities; search capsule beside WeChat's capsule;
 *   the sheet at a third: area name, the verdict numeral with its circle-vs-walk bars, 走一遍 first
 *   of four actions.
 * FORM: category standard (canon), seed dc3d2634.
 * FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the
 *   verdict, DESIGN.md, and every shipping raster carrying its provenance.
 */
import { Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import type { HardCategory, XY } from '@zoudedao/core';
import { getBranches, type WhatIfBranch } from '@web/data/history';
import { locateCoords } from '@web/data/locate';
import { getRoute } from '@web/data/route';
import { postWhatIf } from '@web/data/whatif';
import type { EvidenceView } from '@web/map/evidenceCard';
import { circleKm2, circleMissShare, profileScale, reachArea, V_ELDER, type Model } from '@web/model/derive';
import { evidenceBase, evidenceFacts, noRouteReason } from '@web/model/evidence';
import { facilitySummary, type FacilityRow } from '@web/model/facilities';
import { sitePins, whatIf, type SitePin } from '@web/model/siting';
import { initialPlan, initialUi, uiReducer, type Evidence, type PlanState } from '@web/state';
import { Layers } from '../../components/Layers';
import { MapButtons, PickCard, SearchCapsule } from '../../components/MapChrome';
import { Sheet, type Snap } from '../../components/Sheet';
import { gcj02ToBd09, type MarkerHit } from '../../map/layers';
import { MapView } from '../../map/MapView';
import { lifeCircleScore } from '../../model/score';
import * as store from '../../state/store';
import { AreaHead, Gaps, Nearby, NEARBY_GROUPS, Overview, type AreaTab } from '../../views/AreaView';
import { PlacesView, placeMarks } from '../../views/PlacesView';
import { PlanView } from '../../views/PlanView';
import { RunView } from '../../views/RunView';
import { UnitView } from '../../views/UnitView';
import './index.css';

/** The category with the most gaps on foot (what the sheet opens on). */
function worstCategory(model: Model): HardCategory {
  let best = model.heads[0]!;
  for (const h of model.heads) if (h.pseudo + h.blind > best.pseudo + best.blind) best = h;
  return best.cat;
}

/** The opening 走一遍 plays once per launch, not again for every area opened after it. */
let openingPlayed = false;

/** 走一遍: 15′ in 2.8 s, eased in and out (the web's timing). */
const WALK_MS = 2800;
const WALK_TO = 900;
const easeInOut = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

/** The screen's geometry: the status bar, WeChat's capsule row, the sheet's three heights. */
function useFrame() {
  return useMemo(() => {
    const win = Taro.getWindowInfo();
    const menu = Taro.getMenuButtonBoundingClientRect();
    const H = win.windowHeight;
    const topH = menu.bottom + 8;
    const heights: Record<Snap, number> = {
      // the area's head: name, answer, actions, tabs — and nothing more over the map
      peek: 244,
      half: Math.round(H * 0.58),
      full: H - topH - 6,
    };
    return { H, W: win.windowWidth, menu, topH, heights };
  }, []);
}

type SheetView =
  | { kind: 'area' }
  | { kind: 'unit'; code: string; cat: HardCategory | null }
  | { kind: 'places'; row: FacilityRow; selected: string | null }
  | { kind: 'plan' };

export default function Index() {
  const s = store.useStore();
  const frame = useFrame();
  useEffect(() => {
    if (s.view.status === 'loading') store.boot();
    // boot once per launch
  }, []);

  // the page hooks live on the Taro object at run time (a named import is undefined)
  Taro.useShareAppMessage(() => {
    const sh = store.shown();
    return {
      title: sh ? `${sh.model.data.meta.name}：画圈说 15 分钟，走一遍才知道` : '邻至 · 15 分钟生活圈体检',
      path: '/pages/index/index',
    };
  });

  const shown = store.shown(s);
  if (!shown) {
    return (
      <View className="boot" style={{ paddingTop: `${frame.topH + 12}px` }}>
        {s.view.status === 'error' ? (
          <View className="boot-card">
            <Text className="boot-h">体检数据没有载入</Text>
            <Text className="boot-p">{s.view.message}</Text>
            <View className="boot-btn" onClick={store.boot} hoverClass="act-press">
              <Text>重新载入</Text>
            </View>
          </View>
        ) : (
          <View className="boot-card">
            <View className="sk sk-t" />
            <View className="sk sk-l" />
            <View className="sk sk-b" />
          </View>
        )}
      </View>
    );
  }
  return <Screen shown={shown} frame={frame} />;
}

function Screen({ shown, frame }: { shown: store.Shown; frame: ReturnType<typeof useFrame> }) {
  const s = store.useStore();
  const { model } = shown;
  const resultKey = `${model.id}#${shown.seq}`;
  // 灰色区域 shows from the start: marking the gaps on the map is what the check is for
  const [ui, dispatch] = useReducer(uiReducer, { ...initialUi, gray: true });
  const playingRef = useRef(false);
  playingRef.current = ui.playing;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scale = profileScale(ui.profile, model.vAdult);
  const timeScale = scale * (ui.crossing ? 1.05 : 1);
  const [cat, setCat] = useState<HardCategory>(() => worstCategory(model));
  const [snap, setSnap] = useState<Snap>('peek');
  const [view, setView] = useState<SheetView>({ kind: 'area' });
  const [plan, setPlan] = useState<PlanState>(initialPlan);
  const measureCtl = useRef<AbortController | null>(null);
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const evCtl = useRef<AbortController | null>(null);
  const [branches, setBranches] = useState<WhatIfBranch[] | null>(null);
  const [branchSeq, setBranchSeq] = useState(0);
  const [tab, setTab] = useState<AreaTab>('overview');
  const score = useMemo(() => lifeCircleScore(model), [model]);
  // 选点体检: the next tap on the map is a new centre (then confirmed on its card)
  const [pick, setPick] = useState<{
    at: { latitude: number; longitude: number } | null;
    busy: boolean;
  } | null>(null);
  const [detourOn, setDetourOn] = useState(false);
  const [layersOpen, setLayersOpen] = useState(false);
  const [recenter, setRecenter] = useState(0);
  // the sheet back down from full: the map frames again what it shows (MapView reframe)
  const [reframe, setReframe] = useState(0);
  const lastSnap = useRef(snap);
  useEffect(() => {
    if (lastSnap.current === 'full' && snap !== 'full') setReframe((n) => n + 1);
    lastSnap.current = snap;
  }, [snap]);
  const [focus, setFocus] = useState<{ key: string; points: XY[] } | null>(null);

  const stopLoop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => stopLoop, []);

  // a new analysis on screen: everything that belonged to the last one goes
  const shownKey = useRef(resultKey);
  useEffect(() => {
    if (shownKey.current === resultKey) return;
    shownKey.current = resultKey;
    stopLoop();
    dispatch({ type: 'reset' });
    setCat(worstCategory(model));
    setView({ kind: 'area' });
    measureCtl.current?.abort();
    setPlan(initialPlan);
    evCtl.current?.abort();
    setEvidence(null);
    setBranches(null);
    setFocus(null);
    setDetourOn(false);
    setSnap('peek');
  }, [resultKey, model]);

  /* ---------- 走一遍 ---------- */
  const walk = useCallback(() => {
    stopLoop();
    dispatch({ type: 'play' });
    const t0 = Date.now();
    const tick = () => {
      const p = Math.min(1, (Date.now() - t0) / WALK_MS);
      const T = Math.round((easeInOut(p) * WALK_TO) / 10) * 10;
      if (T < WALK_TO) {
        dispatch({ type: 'tick', T });
        timer.current = setTimeout(tick, 60);
      } else {
        timer.current = null;
        dispatch({ type: 'finish' });
        Taro.vibrateShort({ type: 'light' }).catch(() => {});
      }
    };
    timer.current = setTimeout(tick, 0);
  }, []);
  const onPlay = useCallback(() => {
    if (playingRef.current) {
      stopLoop();
      dispatch({ type: 'stop' });
      return;
    }
    evCtl.current?.abort();
    setEvidence(null);
    setView({ kind: 'area' });
    setSnap('peek');
    walk();
  }, [walk]);
  // the opening: the first screen of a launch walks its reach out once, the product's argument
  // before any word of it (after the map has framed the area)
  useEffect(() => {
    if (openingPlayed) return;
    openingPlayed = true;
    const t = setTimeout(() => {
      if (!playingRef.current) walk();
    }, 1400);
    return () => clearTimeout(t);
  }, [walk]);

  const onScrub = useCallback((T: number) => {
    stopLoop();
    dispatch({ type: 'scrub', T });
  }, []);

  /* ---------- 步行路线证据 ---------- */
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
      if (!shown.analysisId) {
        setEvidence({
          status: 'failed',
          code,
          cat: forCat,
          message: '这次体检没有服务端编号，取不到步行路线。',
        });
        return;
      }
      const ctl = new AbortController();
      evCtl.current = ctl;
      setEvidence({ status: 'loading', code, cat: forCat });
      getRoute(
        { community: base.unit.name, category: forCat, analysis_id: shown.analysisId },
        (lng, lat) => model.frame.toXY(lng, lat),
        ctl.signal,
      )
        .then((r) => {
          if (ctl.signal.aborted) return;
          setEvidence({ status: 'done', code, cat: forCat, route: r });
          setFocus({ key: `route:${code}:${forCat}`, points: r.path });
        })
        .catch((err: unknown) => {
          if (ctl.signal.aborted) return;
          setEvidence({
            status: 'failed',
            code,
            cat: forCat,
            message: err instanceof Error ? err.message : String(err),
          });
        });
    },
    [model, shown.analysisId],
  );
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

  const openUnit = useCallback(
    (code: string, forCat: HardCategory | null) => {
      if (playingRef.current) return;
      const u = model.units.find((x) => x.code === code);
      if (!u) return;
      setView({ kind: 'unit', code, cat: forCat });
      if (forCat) {
        setCat(forCat);
        openEvidence(code, forCat);
      } else {
        evCtl.current?.abort();
        setEvidence(null);
      }
      // the community with the facilities its checks walk to: where it stands, and how far they are
      const ends = model.cats.flatMap((k) => {
        const b = evidenceBase(model, code, k);
        return b?.facilityXY ? [b.facilityXY] : [];
      });
      setFocus({ key: `unit:${code}`, points: [u.label_xy ?? u.centroid, ...ends] });
      setSnap('half');
    },
    [model, openEvidence],
  );
  const onUnitCat = useCallback(
    (k: HardCategory) => {
      if (view.kind !== 'unit') return;
      if (view.cat === k) {
        setView({ ...view, cat: null });
        evCtl.current?.abort();
        setEvidence(null);
        return;
      }
      setView({ ...view, cat: k });
      setCat(k);
      openEvidence(view.code, k);
    },
    [view, openEvidence],
  );

  /* ---------- 规划 ---------- */
  const pins = useMemo(() => sitePins(model), [model]);
  const estimate = useMemo(
    () => (plan.site ? whatIf(model, cat, plan.site.xy) : null),
    [model, cat, plan.site],
  );
  const onPlaceAt = useCallback((xy: XY, bd09: [number, number]) => {
    measureCtl.current?.abort();
    setPlan((p) => ({ ...p, placing: false, site: { xy, bd09 }, measure: { status: 'idle' } }));
  }, []);
  const onUseSite = useCallback(
    (site: SitePin) => {
      onPlaceAt(site.xy, model.frame.toLngLat(...site.xy));
      setPlan((p) => ({ ...p, hotSite: site.key }));
      setFocus({
        key: `site:${site.key}`,
        points: [site.xy, ...site.covers.flatMap((c) => (c.unit ? [c.unit.centroid] : []))],
      });
    },
    [model, onPlaceAt],
  );
  const onMeasure = useCallback(() => {
    const site = plan.site;
    if (!site || !shown.analysisId || shown.measureBlocked) return;
    measureCtl.current?.abort();
    const ctl = new AbortController();
    measureCtl.current = ctl;
    setPlan((p) => ({ ...p, measure: { status: 'running', cat } }));
    postWhatIf({ analysis_id: shown.analysisId, category: cat, site_bd09: site.bd09 }, ctl.signal)
      .then((result) => {
        if (ctl.signal.aborted) return;
        setPlan((p) => ({ ...p, measure: { status: 'done', cat, result } }));
        setBranchSeq((n) => n + 1);
      })
      .catch((err: unknown) => {
        if (ctl.signal.aborted) return;
        const message = err instanceof Error ? err.message : String(err);
        setPlan((p) => ({ ...p, measure: { status: 'failed', cat, message } }));
      });
  }, [plan.site, shown.analysisId, shown.measureBlocked, cat]);
  useEffect(() => {
    if (view.kind !== 'plan' || !shown.analysisId) return;
    const ctl = new AbortController();
    getBranches(shown.analysisId, ctl.signal)
      .then((b) => !ctl.signal.aborted && setBranches(b))
      .catch(() => !ctl.signal.aborted && setBranches(null));
    return () => ctl.abort();
  }, [view.kind, shown.analysisId, branchSeq]);
  const onRestore = useCallback(
    (b: WhatIfBranch) => {
      setCat(b.category);
      const xy = model.frame.toXY(b.site_bd09[0], b.site_bd09[1]);
      setPlan((p) => ({
        ...p,
        placing: false,
        site: { xy, bd09: b.site_bd09 },
        measure: {
          status: 'done',
          cat: b.category,
          result: b,
          saved: { id: b.id, created_at: b.created_at },
        },
      }));
      setFocus({ key: `branch:${b.id}`, points: [xy] });
    },
    [model],
  );

  /* ---------- 15 分钟能走到 ---------- */
  const openPlaces = useCallback(
    (row: FacilityRow) => {
      setView({ kind: 'places', row, selected: null });
      // frame the centre and what the walk reaches of this category
      const reach = placeMarks(model, row.cat, timeScale).filter((m) => m.reach);
      setFocus({
        key: `places:${row.cat}`,
        points: [[0, 0] as XY, ...reach.map((m) => m.face.navi_xy ?? m.face.xy)],
      });
      setSnap('half');
    },
    [model, timeScale],
  );
  const placesMarks = useMemo(
    () => (view.kind === 'places' ? placeMarks(model, view.row.cat, timeScale) : null),
    [view, model, timeScale],
  );
  const onPlace = useCallback(
    (key: string) => {
      if (view.kind !== 'places') return;
      setView({ ...view, selected: key });
      const m = placesMarks?.find((x) => x.key === key);
      if (m) setFocus({ key: `place:${key}`, points: [[0, 0], m.face.navi_xy ?? m.face.xy] });
    },
    [view, placesMarks],
  );

  /* ---------- the map's taps ---------- */
  const onMarker = useCallback(
    (hit: MarkerHit) => {
      if (hit.kind === 'unit') openUnit(hit.code, view.kind === 'unit' ? view.cat : cat);
      else if (hit.kind === 'site') {
        const pin = pins.find((p) => p.key === hit.key);
        if (pin) onUseSite(pin);
      } else if (hit.kind === 'place') onPlace(hit.key);
      else if (hit.kind === 'poi' && hit.name) Taro.showToast({ title: hit.name, icon: 'none' });
    },
    [openUnit, view, cat, pins, onUseSite, onPlace],
  );
  const onTapMap = useCallback(
    (at: { latitude: number; longitude: number }) => {
      if (pick && !pick.busy) {
        setPick({ at, busy: false });
        return;
      }
      if (view.kind !== 'plan' || !plan.placing) return;
      const bd09 = gcj02ToBd09(at.longitude, at.latitude);
      onPlaceAt(model.frame.toXY(bd09[0], bd09[1]), [bd09[0], bd09[1]]);
      setSnap('half');
    },
    [pick, view.kind, plan.placing, model, onPlaceAt],
  );

  const back = useCallback(() => {
    evCtl.current?.abort();
    setEvidence(null);
    setPlan((p) => ({ ...p, placing: false }));
    setView({ kind: 'area' });
    setFocus(null);
    setRecenter((n) => n + 1);
  }, []);

  // dev builds only: the capture script (scripts/shot.mjs) drives the screen through getApp().__zdd
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    const app = Taro.getApp<{ __zdd?: Record<string, unknown> }>();
    app.__zdd = {
      snap: setSnap,
      cat: setCat,
      play: onPlay,
      scrub: onScrub,
      unit: (code: string, k: HardCategory | null = null) => openUnit(code, k),
      places: (c: string) => {
        const row = facilitySummary(model, scale).rows.find((r) => r.cat === c);
        if (row) openPlaces(row);
      },
      plan: () => setView({ kind: 'plan' }),
      tab: setTab,
      site: (i = 0) => {
        const pin = pins.filter((p) => p.cat === cat)[i];
        if (pin) onUseSite(pin);
      },
      measure: () => onMeasure(),
      sample: (id: string) => store.openSample(id),
      check: (lng: number, lat: number, name = '开发测试') =>
        store.startAnalysis({
          name,
          center_bd09: [lng, lat],
          source: 'coordinate',
          confidence: 1,
          reason: '开发测试',
        }),
      method: (on = true) => dispatch({ type: 'method', on }),
      pick: (latitude: number, longitude: number) => setPick({ at: { latitude, longitude }, busy: false }),
      detour: () => setDetourOn((on) => !on),
      back,
      profile: (profile: 'adult' | 'elder') => dispatch({ type: 'profile', profile }),
    };
    return () => {
      delete app.__zdd;
    };
  }, [onPlay, onScrub, openUnit, openPlaces, back, model, scale, pins, cat, onUseSite, onMeasure]);

  // a community 问询 or the report asked for: open it when the map screen shows again
  Taro.useDidShow(() => {
    const code = store.takePendingUnit();
    if (code) openUnit(code, null);
  });

  /* ---------- a live check ---------- */
  const run = s.run?.status === 'running' ? s.run : null;
  useEffect(() => {
    if (s.run?.status !== 'failed') return;
    const r = s.run;
    store.clearRun();
    Taro.showModal({ title: `${r.label}：体检没有完成`, content: r.message, showCancel: false });
  }, [s.run]);

  /* ---------- the sheet ---------- */
  const area = useMemo(() => reachArea(model.raster, ui.T, timeScale), [model.raster, ui.T, timeScale]);
  const missShare = useMemo(() => circleMissShare(model, scale, timeScale), [model, scale, timeScale]);
  const sheetH = frame.heights[snap];
  const insetBottom = Math.min(sheetH, frame.heights.half) + 10;
  const route = evidence?.status === 'done' ? evidence.route : null;
  const mapPlan = useMemo(
    () =>
      view.kind === 'plan' ? { pins, hotSite: plan.hotSite, site: plan.site?.xy ?? null, estimate } : null,
    [view.kind, pins, plan.hotSite, plan.site, estimate],
  );
  const places = useMemo(
    () =>
      view.kind === 'places' && placesMarks
        ? { marks: placesMarks, icon: view.row.icon, selected: view.selected }
        : null,
    [view, placesMarks],
  );

  const placesRows = useMemo(() => {
    const at = (c: string) => {
      const i = NEARBY_GROUPS.flatMap((g) => g.cats).indexOf(c);
      return i < 0 ? 99 : i;
    };
    return facilitySummary(model, timeScale)
      .rows.filter((r) => r.found > 0)
      .sort((a, b) => at(a.cat) - at(b.cat));
  }, [model, timeScale]);

  // the sheet: a fixed head (what this is, how to act on it) over a scrolling body
  let head: ReactNode = null;
  let body: ReactNode;
  if (run) {
    body = (
      <RunView
        label={run.label}
        stream={run.stream}
        note={run.replay ? '服务端当前为样例回放' : (run.conversion ?? null)}
        onCancel={store.cancelAnalysis}
      />
    );
  } else if (view.kind === 'unit') {
    const props = {
      model,
      code: view.code,
      cat: view.cat,
      evidence: evidenceView,
      scale,
      onBack: back,
      onCat: onUnitCat,
    };
    head = <UnitView part="head" {...props} />;
    body = <UnitView part="body" {...props} />;
  } else if (view.kind === 'places') {
    const props = {
      model,
      row: view.row,
      scale: timeScale,
      selected: view.selected,
      onSelect: onPlace,
      onBack: back,
      rows: placesRows,
      onCategory: openPlaces,
    };
    head = <PlacesView part="head" {...props} />;
    body = <PlacesView part="body" {...props} />;
  } else if (view.kind === 'plan') {
    const props = {
      model,
      cat,
      score,
      onCat: (k: HardCategory) => {
        setCat(k);
        setPlan((p) => ({ ...p, site: null, measure: { status: 'idle' as const }, hotSite: null }));
      },
      pins,
      plan,
      estimate,
      measureBlocked: shown.measureBlocked,
      branches,
      onBack: back,
      onPlace: () => {
        const placing = !plan.placing;
        setPlan((p) => ({ ...p, placing, site: placing ? null : p.site }));
        if (placing) {
          setSnap('peek');
          Taro.showToast({ title: '在地图上点一下', icon: 'none' });
        }
      },
      onUseSite,
      onClear: () =>
        setPlan((p) => ({ ...p, site: null, hotSite: null, measure: { status: 'idle' as const } })),
      onMeasure,
      onRestore,
    };
    head = <PlanView part="head" {...props} />;
    body = <PlanView part="body" {...props} />;
  } else {
    head = (
      <AreaHead
        model={model}
        sourceTag={shown.sourceTag}
        walking={ui.playing ? { T: ui.T, area } : null}
        tab={tab}
        onTab={(t) => {
          if (t !== tab) Taro.vibrateShort({ type: 'light' }).catch(() => {});
          setTab(t);
          if (snap === 'peek') setSnap('half');
        }}
        onSwitch={() => Taro.navigateTo({ url: '/pages/search/index' }).catch(() => {})}
        onStop={onPlay}
        onPlan={() => {
          setView({ kind: 'plan' });
          setSnap('half');
        }}
        onReport={() => Taro.navigateTo({ url: '/pages/report/index' }).catch(() => {})}
        onAsk={() => Taro.navigateTo({ url: '/pages/ask/index' }).catch(() => {})}
      />
    );
    body =
      tab === 'overview' ? (
        <Overview
          model={model}
          score={score}
          playKey={resultKey}
          gray={ui.gray}
          onGray={() => dispatch({ type: 'gray', on: !ui.gray })}
          method={ui.method}
          onMethod={() => {
            dispatch({ type: 'method', on: !ui.method });
            if (!ui.method) setSnap('peek');
          }}
          T={ui.T}
          playing={ui.playing}
          walked={ui.walked}
          onPlay={onPlay}
          onScrub={onScrub}
          area={area}
          circleKm2={circleKm2(model, scale)}
          missShare={missShare}
          profile={ui.profile}
          onProfile={(profile) => dispatch({ type: 'profile', profile })}
          kmh={{ adult: (model.vAdult * 3.6).toFixed(1), elder: (V_ELDER * 3.6).toFixed(1) }}
          detourOn={detourOn}
          onDetour={() => {
            const on = !detourOn;
            setDetourOn(on);
            if (on && model.detour) {
              setFocus({
                key: 'detour',
                points: [[0, 0], ...model.detour.path.pts.map((q): XY => [q[0], q[1]])],
              });
              setSnap('peek');
            }
          }}
        />
      ) : tab === 'gaps' ? (
        <Gaps
          model={model}
          cat={cat}
          onCat={setCat}
          walking={ui.playing}
          onUnit={(code) => openUnit(code, cat)}
        />
      ) : (
        <Nearby model={model} scale={timeScale} elder={ui.profile === 'elder'} onCategory={openPlaces} />
      );
  }

  return (
    <View className="screen">
      <MapView
        model={model}
        resultKey={resultKey}
        inset={[frame.topH + 8, 64, insetBottom, 24]}
        focus={focus}
        recenter={recenter}
        reframe={reframe}
        cat={cat}
        T={ui.T}
        scale={timeScale}
        playing={ui.playing}
        circle={ui.circle}
        heat={ui.heat}
        gray={ui.gray}
        hot={ui.hot}
        selected={view.kind === 'unit' ? view.code : null}
        route={view.kind === 'unit' ? route : null}
        plan={mapPlan}
        places={places}
        lit={null}
        pickAt={pick?.at ?? null}
        method={ui.method}
        detour={
          view.kind === 'area' && tab === 'overview' && detourOn
            ? (model.detour?.path.pts.map((q): XY => [q[0], q[1]]) ?? null)
            : null
        }
        onMarker={onMarker}
        onTapMap={onTapMap}
      />
      <SearchCapsule
        top={frame.menu.top}
        height={frame.menu.height}
        right={frame.W - frame.menu.left + 8}
        onTap={() => Taro.navigateTo({ url: '/pages/search/index' }).catch(() => {})}
      />
      {snap === 'full' ? null : (
        <MapButtons
          top={frame.topH + 8}
          picking={!!pick}
          onPick={() => {
            if (pick) {
              setPick(null);
              return;
            }
            if (store.getState().health?.mode !== 'live') {
              Taro.showToast({ title: '服务端为样例模式，不能体检新地点', icon: 'none' });
              return;
            }
            setPick({ at: null, busy: false });
            setSnap('peek');
            Taro.showToast({ title: '在地图上点一个中心', icon: 'none' });
          }}
          onLayers={() => setLayersOpen(true)}
          onRecenter={() => {
            setFocus(null);
            setRecenter((n) => n + 1);
          }}
        />
      )}
      {pick?.at ? (
        <PickCard
          bottom={frame.heights[snap] + 12}
          label={`${pick.at.longitude.toFixed(5)}, ${pick.at.latitude.toFixed(5)}`}
          busy={pick.busy}
          onCancel={() => setPick(null)}
          onGo={() => {
            const at = pick.at!;
            setPick({ at, busy: true });
            locateCoords(at.longitude, at.latitude, 'gcj02')
              .then((r) => {
                setPick(null);
                if (r.kind !== 'coordinate') {
                  Taro.showToast({
                    title: r.kind === 'unavailable' ? r.message : '这个点没有定位成功',
                    icon: 'none',
                  });
                  return;
                }
                store.startAnalysis({
                  ...r.point,
                  name: r.point.name.startsWith('坐标') ? '地图选点' : r.point.name,
                });
              })
              .catch(() => {
                setPick(null);
                Taro.showToast({ title: '连不上邻至服务端', icon: 'none' });
              });
          }}
        />
      ) : null}
      <Sheet
        heights={frame.heights}
        snap={snap}
        onSnap={setSnap}
        head={head ? <View className="sheet-head-pad">{head}</View> : undefined}
      >
        <View className="sheet-pad" key={view.kind === 'area' ? `area-${tab}` : view.kind}>
          <View className="enter">{body}</View>
        </View>
      </Sheet>
      <Layers
        open={layersOpen}
        onClose={() => setLayersOpen(false)}
        flags={{ circle: ui.circle, heat: ui.heat, gray: ui.gray, crossing: ui.crossing }}
        onFlag={(key, on) => dispatch({ type: key, on })}
        hasGray={!!model.data.gray_areas?.length}
      />
    </View>
  );
}
