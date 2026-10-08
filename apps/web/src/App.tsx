import { useCallback, useEffect, useRef, useState } from 'react';
import { IconSprite } from './components/Icons.js';
import { PanelSkeleton } from './components/Skeleton.js';
import { TopBar } from './components/TopBar.js';
import { analyze, getHealth, type AnalyzeFn, type Health, type StageEvent } from './data/api.js';
import { analysisIdOf, askGate, measureGate } from './data/gates.js';
import { getHistory, getLiveAnalysis, type HistoryItem } from './data/history.js';
import { isAnalysisResult, loadAnalysis, type Loaded } from './data/loadAnalysis.js';
import { conversionText, type LocateCandidate } from './data/locate.js';
import { exposeNearby, findNearby } from './data/nearby.js';
import { emptyStream, mergePartial, type StreamState } from './data/stream.js';
import { loadBaidu } from './map/loadBaidu.js';
import { deriveModel, type Model } from './model/derive.js';
import { Screen } from './Screen.js';
import type { Mode } from './state.js';

type AppState =
  | { status: 'loading' }
  | { status: 'ready'; loaded: Loaded; model: Model; seq: number }
  | { status: 'error'; message: string };

/** A live check in progress (or the reason the last one stopped). */
export type AnalysisRun =
  | {
      status: 'running';
      label: string;
      stage: StageEvent | null;
      replay: boolean;
      /** typed coordinates: how they reached BD-09 ("已用百度坐标转换：WGS-84 → BD-09") */
      conversion?: string;
      /** what has streamed in so far (partial results, the quota ledger) */
      stream: StreamState;
    }
  | { status: 'failed'; label: string; message: string };

/** The check screen (map + board) or the printable 体检报告 of the same analysis (?report). */
export type View = 'check' | 'report';

const params = new URLSearchParams(window.location.search);
const requestedSample = params.get('sample');
/** ?analysis=live-1a2b3c4d reopens a stored live check (GET /api/analysis/:id) */
const requestedLive = /^live-[0-9a-f]{6,16}$/i.exec(params.get('analysis') ?? '')?.[0] ?? null;
/**
 * Dev-only: ?fakeLive makes the page behave as if the server were in live mode (the map-click
 * confirmation plate …) for screenshots. It never reaches POST /api/analyze: a check fails at once —
 * unless ?fakeStream=<sample> is set too, which streams that sample the way the engine streams a
 * live check (data/fakeStream.ts; &hold=<stage> stops it there, e.g. refine2).
 */
const FAKE_LIVE = import.meta.env.DEV && (params.has('fakeLive') || params.has('fakeStream'));
const FAKE_STREAM = import.meta.env.DEV ? params.get('fakeStream') : null;
// dev only: the 浏览器端周边检索 of any centre, for the samples' capture script
if (import.meta.env.DEV)
  exposeNearby(() => loadBaidu(import.meta.env.VITE_BAIDU_BROWSER_AK as string | undefined));
/**
 * The first visit in a tab opens with 走一遍: the reach walks out once by itself when the map is ready,
 * the product's argument before any word of it. Not for a deep link (a view, a step, a check, a hash),
 * a capture (?still, an automated browser) or reduced motion.
 */
const INTRO = (() => {
  const deep = ['still', 'tour', 'report', 'plan', 'ask', 'analysis', 'center', 'fakeLive', 'fakeStream'];
  if (deep.some((k) => params.has(k)) || window.location.hash) return false;
  if (navigator.webdriver || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false;
  try {
    if (sessionStorage.getItem('zdd:intro')) return false;
    sessionStorage.setItem('zdd:intro', '1');
    return true;
  } catch {
    return false;
  }
})();
const viewFromUrl = (): View =>
  new URLSearchParams(window.location.search).has('report') ? 'report' : 'check';
/** deep link to a live check: ?center=<lng>,<lat>&label=<名称> (live mode only) */
const requestedCenter = (() => {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(params.get('center') ?? '');
  if (!m) return null;
  const lng = Number(m[1]);
  const lat = Number(m[2]);
  return lng > 72 && lng < 138 && lat > 0.8 && lat < 56 ? ([lng, lat] as [number, number]) : null;
})();

/** Where a live check streams from: the server, or (dev only) a recorded sample streamed in its place. */
async function analyzer(): Promise<AnalyzeFn> {
  if (!FAKE_STREAM) return analyze;
  const { fakeAnalyzer } = await import('./data/fakeStream.js');
  return fakeAnalyzer(async () => (await loadAnalysis(FAKE_STREAM)).data, {
    ...(params.get('hold') ? { hold: params.get('hold')! } : {}),
  });
}

export function App() {
  const [state, setState] = useState<AppState>({ status: 'loading' });
  const [health, setHealth] = useState<Health | null>(null);
  const [run, setRun] = useState<AnalysisRun | null>(null);
  const runCtl = useRef<AbortController | null>(null);
  // kept here, not in the screen: a new sample or live result keeps the mode and the rule set
  const [mode, setMode] = useState<Mode>(() =>
    params.has('ask') ? 'ask' : params.has('plan') ? 'plan' : 'check',
  );
  const [view, setViewState] = useState<View>(viewFromUrl);
  const [history, setHistory] = useState<HistoryItem[] | null>(null);

  // ?report in the URL: the back button and a reload both land on the view the URL names
  const setView = useCallback((next: View) => {
    const url = new URL(window.location.href);
    if (next === 'report') url.searchParams.set('report', '');
    else url.searchParams.delete('report');
    const href = url.toString().replace(/([?&])report=(?=&|$)/, '$1report');
    if (next === 'report') window.history.pushState({ zdd: 'report' }, '', href);
    else if ((window.history.state as { zdd?: string } | null)?.zdd === 'report') window.history.back();
    else window.history.replaceState(null, '', href);
    setViewState(next);
    window.scrollTo(0, 0);
  }, []);
  useEffect(() => {
    const onPop = () => setViewState(viewFromUrl());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    // dev: ?hold=load keeps the page loading (its skeleton), for captures
    if (import.meta.env.DEV && params.get('hold') === 'load') return;
    const ctl = new AbortController();
    void getHealth(ctl.signal).then((h) => {
      if (ctl.signal.aborted) return;
      setHealth(FAKE_LIVE ? { ...(h ?? { ok: true }), mode: 'live', analyzer: undefined } : h);
    });
    // a stored live check named in the URL, else a sample (the API's, else the bundled file)
    const first = requestedLive
      ? Promise.all([getLiveAnalysis(requestedLive, ctl.signal), loadAnalysis(requestedSample, ctl.signal)])
          .then(([data, sample]): Loaded => ({ id: 'live', data, source: 'live', samples: sample.samples }))
          .catch((err: unknown) => {
            if (ctl.signal.aborted) throw err;
            console.warn('[邻至] 实时体检结果取不到，改为样例', err);
            return loadAnalysis(requestedSample, ctl.signal);
          })
      : loadAnalysis(requestedSample, ctl.signal);
    first
      .then((loaded) => {
        if (loaded.source === 'bundled') {
          console.info(
            `[邻至] 未使用服务端数据（${loaded.apiError ?? '未知原因'}），改用内置样例 data/samples/${loaded.id}.json`,
          );
        }
        setState({ status: 'ready', loaded, model: deriveModel(loaded.data, loaded.id), seq: 0 });
      })
      .catch((err: unknown) => {
        if (ctl.signal.aborted) return;
        setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      });
    return () => ctl.abort();
  }, []);

  useEffect(() => {
    if (state.status === 'ready') document.title = `邻至 · ${state.model.data.meta.name} 15 分钟生活圈体检`;
  }, [state]);

  /* ---------- the history (GET /api/history): recent live checks and the samples ---------- */
  const historyAt = useRef(0);
  const historyCtl = useRef<AbortController | null>(null);
  const hasServer = state.status === 'ready' && state.loaded.source !== 'bundled';
  const refreshHistory = useCallback((force = false) => {
    // the menu asks when it opens; once every 10 s is plenty
    if (!force && Date.now() - historyAt.current < 10000) return;
    historyAt.current = Date.now();
    historyCtl.current?.abort();
    const ctl = new AbortController();
    historyCtl.current = ctl;
    getHistory(ctl.signal)
      .then((items) => {
        if (!ctl.signal.aborted) setHistory(items);
      })
      .catch(() => {
        // an older server has no history: the menu keeps the samples alone
        if (!ctl.signal.aborted) setHistory((h) => h ?? null);
      });
  }, []);
  useEffect(() => {
    if (hasServer) refreshHistory(true);
  }, [hasServer, refreshHistory]);
  useEffect(() => () => historyCtl.current?.abort(), []);

  /** Live mode: stream a new check for a located centre and swap it in when the result lands. */
  const startAnalysis = useCallback(
    (c: LocateCandidate) => {
      runCtl.current?.abort();
      if (FAKE_LIVE && !FAKE_STREAM) {
        setRun({ status: 'failed', label: c.name, message: '开发标记 ?fakeLive 只演示界面，没有发起体检' });
        return;
      }
      const ctl = new AbortController();
      runCtl.current = ctl;
      const replay = health?.analyzer === 'replay';
      const conversion = conversionText(c.crs, c.converted_via) ?? undefined;
      setRun({
        status: 'running',
        label: c.name,
        stage: null,
        replay,
        ...(conversion ? { conversion } : {}),
        stream: emptyStream(),
      });
      const running = (f: (r: Extract<AnalysisRun, { status: 'running' }>) => AnalysisRun) =>
        setRun((r) => (r?.status === 'running' && !ctl.signal.aborted ? f(r) : r));
      // first the facilities Baidu's own map search finds (the server's search leaves some out); the
      // replay and the dev stand-in have no use for them
      const nearby = async () => {
        if (replay || FAKE_STREAM) return [];
        const B = await loadBaidu(import.meta.env.VITE_BAIDU_BROWSER_AK as string | undefined).catch(
          () => null,
        );
        if (!B) return [];
        return findNearby(B, c.center_bd09, ctl.signal, (done, total) =>
          running((r) => {
            const stage = {
              stage: 'facilities',
              message: `在百度地图上检索周边设施（${done}/${total}）`,
              progress: (0.04 * done) / total,
            };
            return { ...r, stage, stream: { ...r.stream, stage } };
          }),
        );
      };
      void Promise.all([analyzer(), nearby()])
        .then(([go, browserPois]) =>
          go(
            {
              center_bd09: c.center_bd09,
              label: c.name,
              profile: 'adult',
              ...(browserPois.length ? { browser_pois: browserPois } : {}),
            },
            {
              onStage: (stage) => running((r) => ({ ...r, stage, stream: { ...r.stream, stage } })),
              onPartial: (p) => running((r) => ({ ...r, stream: mergePartial(r.stream, p) })),
              onQuota: (q) =>
                running((r) => ({
                  ...r,
                  stream: {
                    ...r.stream,
                    quota: {
                      ...r.stream.quota,
                      [q.service]: { used: q.used, ...(q.limit ? { limit: q.limit } : {}) },
                    },
                  },
                })),
            },
            ctl.signal,
          ),
        )
        .then((data) => {
          if (ctl.signal.aborted) return;
          if (!isAnalysisResult(data)) throw new Error('分析结果数据结构不完整');
          // the replay analyzer returns sample zj-a (docs/api.md): keep its sample identity and say so
          const id = replay ? 'zj-a' : 'live';
          setState((s) => ({
            status: 'ready',
            loaded: {
              id,
              data,
              source: replay ? 'replay' : 'live',
              samples: s.status === 'ready' ? s.loaded.samples : [],
            },
            model: deriveModel(data, id),
            seq: s.status === 'ready' ? s.seq + 1 : 1,
          }));
          setRun(null);
          // the server stored it: the area menu lists it from now on
          refreshHistory(true);
        })
        .catch((err: unknown) => {
          if (ctl.signal.aborted) return;
          setRun({
            status: 'failed',
            label: c.name,
            message: err instanceof Error ? err.message : String(err),
          });
        });
    },
    [health, refreshHistory],
  );
  // ?center=… starts one live check as soon as the server says it can
  const deepLinked = useRef(false);
  useEffect(() => {
    if (deepLinked.current || !requestedCenter || health?.mode !== 'live' || state.status !== 'ready') return;
    deepLinked.current = true;
    startAnalysis({
      name: params.get('label') ?? '指定中心',
      center_bd09: requestedCenter,
      source: 'geocoding',
      confidence: 1,
      reason: '链接指定的中心点',
    });
  }, [health, state.status, startAnalysis]);
  // dev-only capture hook: start the fake stream from a script (?fakeStream=<sample>)
  useEffect(() => {
    if (!FAKE_STREAM || state.status !== 'ready') return;
    const w = window as unknown as Record<string, unknown>;
    w.__zddRun = (label = '开发演示：流式体检') =>
      startAnalysis({
        name: label,
        center_bd09: state.model.data.meta.center_bd09,
        source: 'geocoding',
        confidence: 1,
        reason: '开发演示',
      });
    return () => {
      delete w.__zddRun;
    };
  }, [state, startAnalysis]);

  /** Switch to another bundled sample (the plates in the board header); the URL keeps ?sample=. */
  const loadCtl = useRef<AbortController | null>(null);
  const openSample = useCallback((id: string) => {
    runCtl.current?.abort();
    setRun(null);
    loadCtl.current?.abort();
    const ctl = new AbortController();
    loadCtl.current = ctl;
    loadAnalysis(id, ctl.signal)
      .then((loaded) => {
        if (ctl.signal.aborted) return;
        const url = new URL(window.location.href);
        url.search = `?sample=${encodeURIComponent(loaded.id)}`;
        window.history.replaceState(window.history.state, '', url);
        setState((s) => ({
          status: 'ready',
          loaded,
          model: deriveModel(loaded.data, loaded.id),
          seq: s.status === 'ready' ? s.seq + 1 : 0,
        }));
      })
      .catch((err: unknown) => {
        if (ctl.signal.aborted) return;
        console.warn('[邻至] 样例载入失败', err);
      });
  }, []);
  useEffect(() => () => loadCtl.current?.abort(), []);

  /** A live check from the history, read back from the server (no new check, no quota). */
  const openLive = useCallback(
    (id: string) => {
      runCtl.current?.abort();
      setRun(null);
      loadCtl.current?.abort();
      const ctl = new AbortController();
      loadCtl.current = ctl;
      getLiveAnalysis(id, ctl.signal)
        .then((data) => {
          if (ctl.signal.aborted) return;
          const url = new URL(window.location.href);
          url.search = `?analysis=${encodeURIComponent(id)}`;
          window.history.replaceState(window.history.state, '', url);
          setState((s) => ({
            status: 'ready',
            loaded: {
              id: 'live',
              data,
              source: 'live',
              samples: s.status === 'ready' ? s.loaded.samples : [],
            },
            model: deriveModel(data, 'live'),
            seq: s.status === 'ready' ? s.seq + 1 : 0,
          }));
        })
        .catch((err: unknown) => {
          if (ctl.signal.aborted) return;
          console.warn('[邻至] 实时体检结果载入失败', err);
          // it may have expired (30 days): the menu stops offering it
          refreshHistory(true);
        });
    },
    [refreshHistory],
  );
  const openHistory = useCallback(
    (item: HistoryItem) => (item.sample ? openSample(item.id) : openLive(item.id)),
    [openSample, openLive],
  );
  const onHistoryMenu = useCallback(() => {
    if (hasServer) refreshHistory();
  }, [hasServer, refreshHistory]);

  const cancelAnalysis = useCallback(() => {
    runCtl.current?.abort();
    setRun(null);
  }, []);
  useEffect(() => () => runCtl.current?.abort(), []);

  // the task rule only (步行 1 公里): the GB 50180 checks a result may carry are not shown
  const ready = state.status === 'ready' ? state : null;
  const shown = ready ? ready.model : null;

  if (!ready || !shown) {
    return (
      <>
        <IconSprite />
        <div className="app">
          <TopBar
            tab="check"
            onTab={() => {}}
            samples={[]}
            activeSample={null}
            current={{ code: '·', name: state.status === 'error' ? '载入失败' : '正在载入', live: false }}
            sourceNote=""
            onOpenSample={() => {}}
            centre={null}
          />
          <div className="workspace">
            <aside className="panel" aria-label="体检结论" aria-busy={state.status === 'loading'}>
              {state.status === 'error' ? (
                <div className="panel-error" role="alert">
                  <h1>数据没有载入</h1>
                  <p>{state.message}</p>
                  <button type="button" className="btn" onClick={() => window.location.reload()}>
                    重新载入
                  </button>
                </div>
              ) : (
                <>
                  <p className="sr-only" role="status">
                    正在载入样例数据…
                  </p>
                  <PanelSkeleton />
                </>
              )}
            </aside>
            <main className="map" aria-busy={state.status === 'loading'} aria-label="步行可达地图" />
          </div>
        </div>
      </>
    );
  }

  const { loaded } = ready;
  const dataNote = loaded.source === 'bundled' ? '未连接服务端，数据来自内置样例文件。' : null;
  // 问询 and 实测核验 ask the server about the analysis on screen: a sample by its id, a live check by
  // the meta.analysis_id the server stamped on it (docs/api.md); the replay is sample zj-a either way
  const analysisId = analysisIdOf(
    loaded.source,
    loaded.id,
    (loaded.data.meta as { analysis_id?: unknown }).analysis_id,
  );
  const askBlocked = askGate(loaded.source, analysisId);
  const measureBlocked = measureGate(loaded.source, health, analysisId);
  const sourceNote = {
    api: `数据：服务端 /api/analysis/${loaded.id}`,
    bundled: `数据：内置样例 data/samples/${loaded.id}.json（未连接服务端）`,
    live: '数据：服务端实时体检（POST /api/analyze）',
    replay: '数据：样例回放（服务端尚未接入实时分析器）',
  }[loaded.source];
  return (
    <>
      <IconSprite />
      <Screen
        model={shown}
        resultKey={`${ready.model.id}#${ready.seq}`}
        dataNote={dataNote}
        sourceNote={sourceNote}
        sourceTag={loaded.source === 'replay' ? '样例回放' : loaded.source === 'live' ? '实时体检' : null}
        health={health}
        run={run}
        samples={loaded.samples}
        activeSample={loaded.source === 'api' || loaded.source === 'bundled' ? loaded.id : null}
        onOpenSample={openSample}
        onAnalyze={startAnalysis}
        onCancelAnalysis={cancelAnalysis}
        mode={mode}
        onMode={setMode}
        analysisId={analysisId}
        askBlocked={askBlocked}
        measureBlocked={measureBlocked}
        view={view}
        onView={setView}
        server={loaded.source !== 'bundled'}
        history={history}
        activeLive={loaded.source === 'live' ? analysisId : null}
        onOpenHistory={openHistory}
        onHistoryMenu={onHistoryMenu}
        intro={INTRO}
      />
    </>
  );
}
