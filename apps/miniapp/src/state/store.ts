/**
 * The mini program's one store: the analysis on screen (a sample or a stored live check), the
 * server's health, the history menu and a live check streaming in — what the web's App owns
 * (apps/web/src/App.tsx), here shared by every page (the map screen, the search, 问询, the report).
 */
import Taro from '@tarojs/taro';
import { useSyncExternalStore } from 'react';
import { analyze, getHealth, type Health, type StageEvent } from '@web/data/api';
import { analysisIdOf, askGate, measureGate } from '@web/data/gates';
import { getHistory, getLiveAnalysis, type HistoryItem } from '@web/data/history';
import { isAnalysisResult, loadAnalysis, type Loaded } from '@web/data/loadAnalysis';
import { conversionText, type LocateCandidate } from '@web/data/locate';
import { emptyStream, mergePartial, type StreamState } from '@web/data/stream';
import { deriveModel, type Model } from '@web/model/derive';

export type Status =
  | { status: 'loading' }
  | { status: 'ready'; loaded: Loaded; model: Model; seq: number }
  | { status: 'error'; message: string };

export type Run =
  | {
      status: 'running';
      label: string;
      stage: StageEvent | null;
      replay: boolean;
      conversion?: string;
      stream: StreamState;
    }
  | { status: 'failed'; label: string; message: string };

export interface AppState {
  view: Status;
  health: Health | null;
  run: Run | null;
  history: HistoryItem[] | null;
}

let state: AppState = { view: { status: 'loading' }, health: null, run: null, history: null };
const listeners = new Set<() => void>();

function set(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  for (const l of listeners) l();
}

export const getState = () => state;
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useStore(): AppState {
  return useSyncExternalStore(subscribe, getState, getState);
}

/* ---------------- derived facts every page needs ---------------- */

export interface Shown {
  model: Model;
  loaded: Loaded;
  seq: number;
  /** what 问询, routes and 实测核验 ask the server about (null: they cannot) */
  analysisId: string | null;
  askBlocked: string | null;
  measureBlocked: string | null;
  /** 样例 / 实时体检 / 样例回放 */
  sourceTag: string;
  live: boolean;
}

export function shown(s: AppState = state): Shown | null {
  if (s.view.status !== 'ready') return null;
  const { loaded, model, seq } = s.view;
  const analysisId = analysisIdOf(
    loaded.source,
    loaded.id,
    (loaded.data.meta as { analysis_id?: unknown }).analysis_id,
  );
  return {
    model,
    loaded,
    seq,
    analysisId,
    askBlocked: askGate(loaded.source, analysisId),
    measureBlocked: measureGate(loaded.source, s.health, analysisId),
    sourceTag: loaded.source === 'live' ? '实时体检' : loaded.source === 'replay' ? '样例回放' : '样例',
    live: loaded.source === 'live',
  };
}

/* ---------------- actions ---------------- */

const LAST_KEY = 'zdd:last';
const remember = (id: string) => {
  try {
    Taro.setStorageSync(LAST_KEY, id);
  } catch {
    /* storage unavailable: start from the first sample next time */
  }
};
const recalled = (): string | null => {
  try {
    const v: unknown = Taro.getStorageSync(LAST_KEY);
    return typeof v === 'string' && v ? v : null;
  } catch {
    return null;
  }
};

let loadCtl: AbortController | null = null;
let runCtl: AbortController | null = null;

function put(loaded: Loaded) {
  set((s) => ({
    view: {
      status: 'ready',
      loaded,
      model: deriveModel(loaded.data, loaded.id),
      seq: s.view.status === 'ready' ? s.view.seq + 1 : 0,
    },
  }));
}

const offline = (err: unknown) => {
  const m = err instanceof Error ? err.message : String(err);
  return /Failed to fetch|HTTP|JSON/.test(m) ? '连不上邻至服务端，请确认网络后重试。' : m;
};

/**
 * The sample a first visit opens: 玉兰香苑 (zj-b), every check of it verified against official sources
 * (data/official/community-review.json) — the demo's opening.
 */
export const OPENING_SAMPLE = 'zj-b';

/** The first screen: the last analysis seen here, else the opening sample. */
export function boot() {
  set({ view: { status: 'loading' } });
  loadCtl?.abort();
  const ctl = new AbortController();
  loadCtl = ctl;
  void getHealth(ctl.signal).then((h) => {
    if (!ctl.signal.aborted) set({ health: h });
  });
  const last = recalled();
  const live = last && /^live-[0-9a-f]{6,16}$/i.test(last) ? last : null;
  const first = live
    ? Promise.all([getLiveAnalysis(live, ctl.signal), loadAnalysis(OPENING_SAMPLE, ctl.signal)])
        .then(([data, sample]): Loaded => ({ id: 'live', data, source: 'live', samples: sample.samples }))
        .catch(() => loadAnalysis(OPENING_SAMPLE, ctl.signal))
    : loadAnalysis(last ?? OPENING_SAMPLE, ctl.signal);
  first
    .then((loaded) => {
      if (ctl.signal.aborted) return;
      if (loaded.source === 'bundled') {
        set({ view: { status: 'error', message: '连不上邻至服务端，请确认网络后重试。' } });
        return;
      }
      put(loaded);
      refreshHistory(true);
    })
    .catch((err: unknown) => {
      if (!ctl.signal.aborted) set({ view: { status: 'error', message: offline(err) } });
    });
}

let historyAt = 0;
export function refreshHistory(force = false) {
  if (!force && Date.now() - historyAt < 10000) return;
  historyAt = Date.now();
  getHistory(new AbortController().signal)
    .then((history) => set({ history }))
    .catch(() => {});
}

export function openSample(id: string) {
  runCtl?.abort();
  set({ run: null });
  loadCtl?.abort();
  const ctl = new AbortController();
  loadCtl = ctl;
  Taro.showLoading({ title: '载入中' }).catch(() => {});
  loadAnalysis(id, ctl.signal)
    .then((loaded) => {
      if (ctl.signal.aborted || loaded.source === 'bundled') return;
      remember(loaded.id);
      put(loaded);
    })
    .catch(() => {
      if (!ctl.signal.aborted) Taro.showToast({ title: '样例没有载入', icon: 'none' });
    })
    .finally(() => Taro.hideLoading());
}

export function openLive(id: string) {
  runCtl?.abort();
  set({ run: null });
  loadCtl?.abort();
  const ctl = new AbortController();
  loadCtl = ctl;
  Taro.showLoading({ title: '载入中' }).catch(() => {});
  getLiveAnalysis(id, ctl.signal)
    .then((data) => {
      if (ctl.signal.aborted) return;
      remember(id);
      const samples = state.view.status === 'ready' ? state.view.loaded.samples : [];
      put({ id: 'live', data, source: 'live', samples });
    })
    .catch(() => {
      if (ctl.signal.aborted) return;
      Taro.showToast({ title: '这次体检已过期', icon: 'none' });
      refreshHistory(true);
    })
    .finally(() => Taro.hideLoading());
}

export const openHistory = (item: HistoryItem) => (item.sample ? openSample(item.id) : openLive(item.id));

/** Live mode: stream a new check for a located centre; swap it in when the result lands. */
export function startAnalysis(c: LocateCandidate) {
  runCtl?.abort();
  const ctl = new AbortController();
  runCtl = ctl;
  const replay = state.health?.analyzer === 'replay';
  const conversion = conversionText(c.crs, c.converted_via) ?? undefined;
  set({
    run: {
      status: 'running',
      label: c.name,
      stage: null,
      replay,
      ...(conversion ? { conversion } : {}),
      stream: emptyStream(),
    },
  });
  const running = (f: (r: Extract<Run, { status: 'running' }>) => Run) =>
    set((s) => (s.run?.status === 'running' && !ctl.signal.aborted ? { run: f(s.run) } : {}));
  analyze(
    // the engine names the area "<label>周边": a label that already says 周边 would say it twice
    { center_bd09: c.center_bd09, label: c.name.replace(/周边$/, '') || c.name, profile: 'adult' },
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
  )
    .then((data) => {
      if (ctl.signal.aborted) return;
      if (!isAnalysisResult(data)) throw new Error('分析结果数据结构不完整');
      const id = replay ? 'zj-a' : 'live';
      const stamped = (data.meta as { analysis_id?: unknown }).analysis_id;
      if (typeof stamped === 'string') remember(stamped);
      const samples = state.view.status === 'ready' ? state.view.loaded.samples : [];
      put({ id, data, source: replay ? 'replay' : 'live', samples });
      set({ run: null });
      Taro.vibrateShort({ type: 'medium' }).catch(() => {});
      refreshHistory(true);
    })
    .catch((err: unknown) => {
      if (ctl.signal.aborted) return;
      set({ run: { status: 'failed', label: c.name, message: offline(err) } });
    });
}

export function cancelAnalysis() {
  runCtl?.abort();
  set({ run: null });
}

export const clearRun = () => set({ run: null });

/* ---------------- another page → the map ---------------- */

/** A community another page (问询, the report) asks the map screen to open when it shows again. */
let pendingUnit: string | null = null;
export const openUnitOnMap = (code: string) => {
  pendingUnit = code;
};
export const takePendingUnit = () => {
  const c = pendingUnit;
  pendingUnit = null;
  return c;
};
