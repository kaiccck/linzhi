import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { AnalysisRun } from './App.js';
import type { Health } from './data/api.js';
import type { SampleInfo } from './data/loadAnalysis.js';
import type { LocateCandidate } from './data/locate.js';
import { Board, type BoardTab } from './components/Board.js';
import { MapPanel } from './map/MapPanel.js';
import { profileScale, type Model } from './model/derive.js';
import { initialUi, uiReducer, type Profile } from './state.js';

const WALK_MS = 3400;
const WALK_TO = 900;

/** The check screen: the map sign on the left, the cobalt board on the right. */
export function Screen({
  model,
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
  boardTab,
  onBoardTab,
  analysisId,
  askBlocked,
}: {
  model: Model;
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
  boardTab: BoardTab;
  onBoardTab(tab: BoardTab): void;
  /** what 问询 answers about; null when it cannot (reason in askBlocked) */
  analysisId: string | null;
  askBlocked: string | null;
}) {
  const [ui, dispatch] = useReducer(uiReducer, initialUi);
  const playingRef = useRef(false);
  playingRef.current = ui.playing;
  const raf = useRef(0);
  const scale = profileScale(ui.profile, model.vAdult);

  const stopLoop = () => {
    cancelAnimationFrame(raf.current);
    raf.current = 0;
  };

  // 走一遍: the reach replays from 0; plates, codes and cells hold their verdict until 15′
  const onPlay = useCallback(() => {
    if (playingRef.current) {
      stopLoop();
      dispatch({ type: 'stop' });
      return;
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      dispatch({ type: 'finish' });
      return;
    }
    stopLoop();
    dispatch({ type: 'play' });
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / WALK_MS);
      const eased = 1 - Math.pow(1 - p, 3);
      if (p < 1) {
        dispatch({ type: 'tick', T: Math.round(eased * WALK_TO) });
        raf.current = requestAnimationFrame(tick);
      } else {
        raf.current = 0;
        dispatch({ type: 'finish' });
      }
    };
    raf.current = requestAnimationFrame(tick);
  }, []);

  const onScrub = useCallback((T: number) => {
    stopLoop();
    dispatch({ type: 'scrub', T });
  }, []);
  const onHot = useCallback((code: string | null) => dispatch({ type: 'hot', code }), []);
  const onProfile = useCallback((profile: Profile) => dispatch({ type: 'profile', profile }), []);
  const onCircle = useCallback((on: boolean) => dispatch({ type: 'circle', on }), []);
  const onHeat = useCallback((on: boolean) => dispatch({ type: 'heat', on }), []);

  useEffect(() => {
    // capture helper, as in the mockup: #play starts the walk on load
    if (window.location.hash === '#play') onPlay();
    return stopLoop;
  }, [onPlay]);

  return (
    <div className="app">
      <MapPanel
        model={model}
        ui={ui}
        scale={scale}
        dataNote={dataNote}
        health={health}
        run={run}
        onAnalyze={onAnalyze}
        onCancelAnalysis={onCancelAnalysis}
        onPlay={onPlay}
        onScrub={onScrub}
        onProfile={onProfile}
        onCircle={onCircle}
        onHeat={onHeat}
        onHot={onHot}
      />
      <Board
        model={model}
        scale={scale}
        hot={ui.hot}
        walking={ui.playing}
        sourceNote={sourceNote}
        sourceTag={sourceTag}
        samples={samples}
        activeSample={activeSample}
        onOpenSample={onOpenSample}
        onHot={onHot}
        tab={boardTab}
        onTab={onBoardTab}
        analysisId={analysisId}
        askBlocked={askBlocked}
        advisor={health?.advisor}
      />
    </div>
  );
}
