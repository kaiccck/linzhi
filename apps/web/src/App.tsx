import { useCallback, useEffect, useRef, useState } from 'react';
import type { BoardTab } from './components/Board.js';
import { IconSprite, Pg } from './components/Icons.js';
import { analyze, getHealth, type Health, type StageEvent } from './data/api.js';
import { isAnalysisResult, loadAnalysis, type Loaded } from './data/loadAnalysis.js';
import type { LocateCandidate } from './data/locate.js';
import { deriveModel, type Model } from './model/derive.js';
import { Screen } from './Screen.js';

type AppState =
  | { status: 'loading' }
  | { status: 'ready'; loaded: Loaded; model: Model; seq: number }
  | { status: 'error'; message: string };

/** A live check in progress (or the reason the last one stopped). */
export type AnalysisRun =
  | { status: 'running'; label: string; stage: StageEvent | null; replay: boolean }
  | { status: 'failed'; label: string; message: string };

const params = new URLSearchParams(window.location.search);
const requestedSample = params.get('sample');
/** deep link to a live check: ?center=<lng>,<lat>&label=<名称> (live mode only) */
const requestedCenter = (() => {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(params.get('center') ?? '');
  if (!m) return null;
  const lng = Number(m[1]);
  const lat = Number(m[2]);
  return lng > 72 && lng < 138 && lat > 0.8 && lat < 56 ? ([lng, lat] as [number, number]) : null;
})();

export function App() {
  const [state, setState] = useState<AppState>({ status: 'loading' });
  const [health, setHealth] = useState<Health | null>(null);
  const [run, setRun] = useState<AnalysisRun | null>(null);
  const runCtl = useRef<AbortController | null>(null);
  // kept here, not in the board: a new sample or live result keeps the 问询 desk open
  const [boardTab, setBoardTab] = useState<BoardTab>('dir');

  useEffect(() => {
    const ctl = new AbortController();
    void getHealth(ctl.signal).then((h) => {
      if (!ctl.signal.aborted) setHealth(h);
    });
    loadAnalysis(requestedSample, ctl.signal)
      .then((loaded) => {
        if (loaded.source === 'bundled') {
          console.info(
            `[走得到] 未使用服务端数据（${loaded.apiError ?? '未知原因'}），改用内置样例 data/samples/${loaded.id}.json`,
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
    if (state.status === 'ready') document.title = `走得到 · ${state.model.data.meta.name} 15 分钟生活圈体检`;
  }, [state]);

  /** Live mode: stream a new check for a located centre and swap it in when the result lands. */
  const startAnalysis = useCallback(
    (c: LocateCandidate) => {
      runCtl.current?.abort();
      const ctl = new AbortController();
      runCtl.current = ctl;
      const replay = health?.analyzer === 'replay';
      setRun({ status: 'running', label: c.name, stage: null, replay });
      analyze(
        { center_bd09: c.center_bd09, label: c.name, profile: 'adult' },
        { onStage: (stage) => setRun((r) => (r?.status === 'running' ? { ...r, stage } : r)) },
        ctl.signal,
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
    [health],
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
        window.history.replaceState(null, '', url);
        setState((s) => ({
          status: 'ready',
          loaded,
          model: deriveModel(loaded.data, loaded.id),
          seq: s.status === 'ready' ? s.seq + 1 : 0,
        }));
      })
      .catch((err: unknown) => {
        if (ctl.signal.aborted) return;
        console.warn('[走得到] 样例载入失败', err);
      });
  }, []);
  useEffect(() => () => loadCtl.current?.abort(), []);

  const cancelAnalysis = useCallback(() => {
    runCtl.current?.abort();
    setRun(null);
  }, []);
  useEffect(() => () => runCtl.current?.abort(), []);

  if (state.status !== 'ready') {
    return (
      <>
        <IconSprite />
        <div className="app">
          <main className="map" aria-busy={state.status === 'loading'} aria-label="步行可达地图" />
          <aside className="board" aria-label="体检结论">
            <header className="brand">
              <div className="mark" aria-hidden="true">
                <Pg id="pg-walk" />
              </div>
              <div className="wordmark">
                <h1>走得到</h1>
                <p>15 分钟生活圈体检</p>
              </div>
            </header>
            <p className="board-status" role="status">
              {state.status === 'loading' ? '正在载入样例数据…' : `数据载入失败：${state.message}`}
            </p>
          </aside>
        </div>
      </>
    );
  }

  const { loaded, model } = state;
  const dataNote = loaded.source === 'bundled' ? '未连接服务端，数据来自内置样例文件。' : null;
  // 问询 asks the server about the analysis on screen: a sample by its id, a live check by the
  // meta.analysis_id the server stamped on it (docs/api.md); the replay is sample zj-a either way
  const stamped = (loaded.data.meta as { analysis_id?: unknown }).analysis_id;
  const liveId = typeof stamped === 'string' && stamped ? stamped : null;
  const analysisId =
    loaded.source === 'api'
      ? loaded.id
      : loaded.source === 'bundled'
        ? null
        : (liveId ?? (loaded.source === 'replay' ? loaded.id : null));
  const askBlocked =
    loaded.source === 'bundled'
      ? '当前页面没有连接服务端，数据来自内置样例文件；用 pnpm dev 或 docker compose up 启动服务后刷新页面即可提问。'
      : analysisId === null
        ? '这次实时体检的结果没有编号（服务端版本较旧），问询暂时回答不了它；切换到样例后可以提问。'
        : null;
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
        key={`${model.id}#${state.seq}`}
        model={model}
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
        boardTab={boardTab}
        onBoardTab={setBoardTab}
        analysisId={analysisId}
        askBlocked={askBlocked}
      />
    </>
  );
}
