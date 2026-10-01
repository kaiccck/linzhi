/**
 * Choosing a centre: the top bar's search (an address, or coordinates in a chosen frame) and a point
 * picked on the map. Live mode checks the new centre (a typed or found place at once, a map click
 * after a confirmation, since a check costs Baidu quota); sample mode says honestly that it does not
 * recompute, and shows where the point lies. The notes it writes appear under the search box.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { bearingDeg, type XY } from '@zoudedao/core';
import type { AnalysisRun } from './App.js';
import { crsCode, fmtLngLat, parseCoords, type Crs } from './data/coords.js';
import { locate, locateCoords, type LocateCandidate } from './data/locate.js';
import { fmtInt, type Model } from './model/derive.js';

export interface Note {
  id: string;
  text: ReactNode;
  dismissible?: boolean;
}

/** A centre chosen on the map or typed as coordinates, before (or while) it is checked. */
export interface PendingPoint {
  /** local metres in the frame of the analysis on screen */
  xy: XY;
  bd09: [number, number];
  /** what it is: 地图点选 / 坐标 */
  what: string;
  /** the point in numerals, e.g. 121.64420, 31.19007 */
  coords: string;
  /** show the confirmation plate (live mode, a point picked on the map) */
  ask: boolean;
  from: 'click' | 'coords';
  candidate: LocateCandidate;
  /** a live check from this point is under way (the marker stays until the result lands) */
  running: boolean;
}

const round6 = (v: number) => Number(v.toFixed(6));

/** "东北 620 m" / "正西 1.4 km": where a point lies from the centre of the analysis on screen. */
export function fromCentre(x: number, y: number): string {
  const words = ['正北', '东北', '正东', '东南', '正南', '西南', '正西', '西北'];
  const d = Math.hypot(x, y);
  const dir = words[Math.round(bearingDeg(x, y) / 45) % 8]!;
  return d < 1000 ? `${dir} ${fmtInt(d)} m` : `${dir} ${(d / 1000).toFixed(1)} km`;
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
        <strong>样例模式</strong>只查样例社区；检索任意地址、重新算路需要服务端 live 模式（见 README）。当前：
        {model.place.title}。{dataNote ? ` ${dataNote}` : ''}
      </>
    ),
  };
}

export interface Centre {
  search: string;
  setSearch(v: string): void;
  crs: Crs;
  onCrs(crs: Crs): void;
  submit(): void;
  notes: Note[];
  dismiss(id: string): void;
  pending: PendingPoint | null;
  /** a point picked on the map (BD-09) */
  pick(lng: number, lat: number): void;
  confirm(): void;
  cancel(restoreFocus: boolean): void;
  /** the map tells whether a typed point can be brought into view (Baidu pans; offline cannot) */
  canReveal: RefObject<(xy: XY) => boolean>;
}

export function useCentre({
  model,
  dataNote,
  live,
  run,
  resultKey,
  onAnalyze,
  onCancelAnalysis,
}: {
  model: Model;
  dataNote: string | null;
  live: boolean;
  run: AnalysisRun | null;
  resultKey: string;
  onAnalyze(c: LocateCandidate): void;
  onCancelAnalysis(): void;
}): Centre {
  const [search, setSearch] = useState('');
  const [crs, setCrs] = useState<Crs>('bd09');
  const [notes, setNotes] = useState<Note[]>([]);
  const [pending, setPending] = useState<PendingPoint | null>(null);
  const canReveal = useRef<(xy: XY) => boolean>(() => true);

  const show = useCallback(
    (note: Note) => setNotes((n) => [...n.filter((k) => k.id !== 'sample'), note]),
    [],
  );
  const clearSample = useCallback(() => setNotes((n) => n.filter((k) => k.id !== 'sample')), []);

  /* ---------- a centre picked on the map ---------- */
  const pick = useCallback(
    (lng: number, lat: number) => {
      const xy = model.frame.toXY(lng, lat);
      const coords = fmtLngLat([lng, lat], 5);
      const candidate: LocateCandidate = {
        name: `地图点选 ${coords}`,
        center_bd09: [round6(lng), round6(lat)],
        source: 'click',
        confidence: 1,
        reason: '在地图上点选的中心',
      };
      const base = { xy, bd09: candidate.center_bd09, what: '地图点选', coords, from: 'click' as const };
      if (live) {
        // live: ask first — a check costs Baidu quota, a stray click must not
        clearSample();
        setPending({ ...base, candidate, ask: true, running: false });
        return;
      }
      setPending({ ...base, candidate, ask: false, running: false });
      show({
        id: 'sample',
        text: (
          <>
            <strong>地图点选</strong> <span className="num">{coords}</span>（BD-09，在当前片区中心
            {fromCentre(xy[0], xy[1])} 处）。
            <br />
            <strong>样例模式</strong>不重新计算：以任意点为中心体检需要服务端配置百度 Key（live 模式，见
            README）。当前：{model.place.title}。{dataNote ? ` ${dataNote}` : ''}
          </>
        ),
      });
    },
    [model, live, dataNote, show, clearSample],
  );

  const prevFocus = useRef<Element | null>(null);
  useEffect(() => {
    if (pending?.ask) prevFocus.current ??= document.activeElement;
    else prevFocus.current = null;
  }, [pending?.ask]);
  const cancel = useCallback(
    (restoreFocus: boolean) => {
      const back = prevFocus.current;
      setPending(null);
      clearSample();
      if (restoreFocus && back instanceof HTMLElement && back.isConnected && back !== document.body) {
        back.focus({ preventScroll: true });
      }
    },
    [clearSample],
  );
  const confirm = useCallback(() => {
    if (!pending) return;
    setPending({ ...pending, ask: false, running: true });
    onAnalyze(pending.candidate);
  }, [pending, onAnalyze]);
  // Esc cancels the confirmation plate, wherever focus is
  useEffect(() => {
    if (!pending?.ask) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      cancel(true);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [pending?.ask, cancel]);
  // the marker of a started check goes when the check stops (a result clears it below)
  useEffect(() => {
    if (pending?.running && run?.status !== 'running') setPending(null);
  }, [run, pending?.running]);
  // a new analysis clears what belonged to the last one: a picked point and its notes
  const firstResult = useRef(true);
  useEffect(() => {
    if (firstResult.current) {
      firstResult.current = false;
      return;
    }
    setPending(null);
    setNotes([]);
  }, [resultKey]);

  /* ---------- search: an address, or coordinates in the chosen frame ---------- */
  const searchCtl = useRef<AbortController | null>(null);
  const runSearch = useCallback(
    (text: string, frame: Crs) => {
      const q = text.trim();
      if (!q) {
        show(sampleNote(model, dataNote, live));
        return;
      }
      searchCtl.current?.abort();
      const ctl = new AbortController();
      searchCtl.current = ctl;

      const coords = parseCoords(q);
      if (coords && !coords.ok) {
        show({
          id: 'sample',
          text: (
            <>
              「{q}」像是两个数字，但不是中国境内的经纬度（经度约 <span className="num">73–135</span>
              ，纬度约 <span className="num">4–54</span>）。请按「经度, 纬度」输入，例如{' '}
              <span className="num">121.644195, 31.190070</span>。
            </>
          ),
        });
        return;
      }
      if (coords?.ok) {
        const input: [number, number] = [coords.lng, coords.lat];
        show({
          id: 'sample',
          dismissible: false,
          text: (
            <>
              正在换算坐标 <span className="num">{fmtLngLat(input)}</span>（{crsCode(frame)} → BD-09）…
            </>
          ),
        });
        locateCoords(coords.lng, coords.lat, frame, ctl.signal)
          .then((r) => {
            if (ctl.signal.aborted) return;
            if (r.kind !== 'coordinate') {
              const why = r.kind === 'unavailable' ? r.message : '没有得到换算结果';
              show(sampleNote(model, dataNote, live, `${why}，坐标没有换算。`));
              return;
            }
            const p = r.point;
            const [lng, lat] = p.center_bd09;
            const xy = model.frame.toXY(lng, lat);
            const via =
              frame === 'bd09' || p.converted_via === 'none'
                ? '无需转换'
                : p.converted_via === 'baidu_geoconv'
                  ? '百度坐标转换'
                  : '按公开公式换算';
            const onScreen = canReveal.current(xy);
            const base = {
              xy,
              bd09: p.center_bd09,
              what: '坐标',
              coords: fmtLngLat(p.center_bd09),
              from: 'coords' as const,
              candidate: { ...p, crs: p.crs ?? frame },
            };
            if (live) {
              clearSample();
              setPending({ ...base, ask: false, running: true });
              onAnalyze(base.candidate);
              return;
            }
            setPending({ ...base, ask: false, running: false });
            show({
              id: 'sample',
              text: (
                <>
                  <strong>坐标</strong> {crsCode(p.crs ?? frame)}{' '}
                  <span className="num">{fmtLngLat(input)}</span>
                  {frame !== 'bd09' ? (
                    <>
                      {' '}
                      → BD-09 <span className="num">{fmtLngLat(p.center_bd09)}</span>
                    </>
                  ) : null}
                  （{via}），落在当前片区中心{fromCentre(xy[0], xy[1])} 处
                  {onScreen ? '，见地图上的蓝色圆标' : '，在离线底图的范围以外'}
                  {coords.swapped ? '；已按「经度, 纬度」读取' : ''}。
                  {p.sample_id && p.sample_id !== model.id ? (
                    <>
                      {' '}
                      附近就有样例：<a href={`?sample=${encodeURIComponent(p.sample_id)}`}>切换到这个样例</a>
                      。
                    </>
                  ) : p.sample_id === model.id ? (
                    ' 这正是当前样例的中心附近。'
                  ) : null}
                  <br />
                  <strong>样例模式</strong>不重新计算：以任意点为中心体检需要服务端配置百度 Key。
                </>
              ),
            });
          })
          .catch(() => {});
        return;
      }

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
              clearSample();
              onAnalyze(r.best);
              return;
            }
            // ambiguous: list the candidates and let the planner pick the centre
            show({
              id: 'sample',
              text: (
                <>
                  「{q}」有几个可能的位置，请选一个作为片区中心：
                  <span className="picks">
                    {r.candidates.slice(0, 3).map((c) => (
                      <button
                        type="button"
                        key={`${c.center_bd09[0]},${c.center_bd09[1]}`}
                        onClick={() => {
                          clearSample();
                          onAnalyze(c);
                        }}
                      >
                        <b>{c.name}</b>
                        {/* the address tells the candidates apart; `reason` is the matcher's own log */}
                        {c.address ? <small>{c.address}</small> : null}
                      </button>
                    ))}
                  </span>
                </>
              ),
            });
          } else if (r.kind === 'place' || r.kind === 'coordinate') {
            const name = r.kind === 'place' ? r.best.name : r.point.name;
            show(sampleNote(model, dataNote, live, `已定位：${name}。`));
          } else if (r.kind === 'none') {
            show(sampleNote(model, dataNote, live, `没有找到「${q}」。`));
          } else {
            show(sampleNote(model, dataNote, live, `${r.message}，无法检索地址。`));
          }
        })
        .catch(() => {});
    },
    [model, dataNote, live, onAnalyze, show, clearSample],
  );
  useEffect(() => () => searchCtl.current?.abort(), []);
  const submit = useCallback(() => runSearch(search, crs), [runSearch, search, crs]);
  const onCrs = useCallback(
    (next: Crs) => {
      setCrs(next);
      // sample mode re-converts a point already shown, so the planner can see where each frame lands;
      // live mode waits for Enter (a new check costs quota)
      if (!live && pending?.from === 'coords' && parseCoords(search)?.ok) runSearch(search, next);
    },
    [live, pending?.from, search, runSearch],
  );

  /* ---------- the run's own note (a check started from here, before it streams, or why it stopped) ---------- */
  const running = run?.status === 'running' ? run : null;
  const runNote: Note | null = !run
    ? null
    : running
      ? running.stream.partial.meta
        ? null // streaming: the panel and the map carry its progress
        : {
            id: 'run',
            dismissible: false,
            text: (
              <>
                <strong>正在体检</strong>：{running.label}
                {running.conversion ? (
                  <>
                    <br />
                    {running.conversion}
                  </>
                ) : null}
                {running.stage ? ` · ${running.stage.message}` : ' · 连接服务端…'}
                {running.replay ? '（服务端当前为样例回放，结果仍是申城佳苑样例）' : ''}
                <button type="button" className="link" onClick={onCancelAnalysis}>
                  取消
                </button>
              </>
            ),
          }
      : run.status === 'failed'
        ? {
            id: 'run',
            text: (
              <>
                <strong>体检未完成</strong>：{run.label} · {run.message}。当前仍显示 {model.place.title}。
              </>
            ),
          }
        : null;
  const [runDismissed, setRunDismissed] = useState<AnalysisRun | null>(null);
  const shown = [...(runNote && runDismissed !== run ? [runNote] : []), ...notes];

  const dismiss = useCallback(
    (id: string) => {
      if (id === 'run') {
        if (run?.status === 'running') onCancelAnalysis();
        setRunDismissed(run);
        return;
      }
      // the note of a picked or typed point goes with its marker
      if (id === 'sample' && pending && !pending.running) setPending(null);
      setNotes((n) => n.filter((k) => k.id !== id));
    },
    [run, pending, onCancelAnalysis],
  );

  return {
    search,
    setSearch,
    crs,
    onCrs,
    submit,
    notes: shown,
    dismiss,
    pending,
    pick,
    confirm,
    cancel,
    canReveal,
  };
}
