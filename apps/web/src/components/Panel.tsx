/**
 * The 400px panel beside the map, conclusion first. 体检: the place, the answer in communities, the
 * category buttons (they choose what the list and the map show), the communities that cannot walk to
 * the chosen category, the next step, and the way into 中心周边设施 (a page of its own, with a way back). 规划: the place and the category
 * buttons, then what a new site would fix and the suggested sites. 问询: the place, the verdict in one
 * line, and the advisor. While a live check streams in, the panel shows the measuring instead (RunBoard).
 */
import { memo } from 'react';
import { FRESH_RULE_TEXT, type HardCategory } from '@zoudedao/core';
import type { Health } from '../data/api.js';
import type { WhatIfBranch } from '../data/history.js';
import type { SampleInfo } from '../data/loadAnalysis.js';
import type { StreamModel, StreamState } from '../data/stream.js';
import { V_ELDER, type Model } from '../model/derive.js';
import { freshLine, freshTally } from '../model/fresh.js';
import type { SitePin, WhatIfEstimate } from '../model/siting.js';
import type { MapSpot } from '../model/spots.js';
import type { CheckView, Mode, PlanState, Profile } from '../state.js';
import { AdvisorPanel } from './Advisor.js';
import { CategoryCards } from './Categories.js';
import { NumText } from './NumText.js';
import { FacilityEntry, FacilityView } from './Facilities.js';
import { GapList } from './GapList.js';
import { Planning } from './Planning.js';
import { RunBoard } from './RunBoard.js';
import { Verdict, VerdictBrief } from './Verdict.js';
import { Chev } from './Icons.js';

/** A live check on its way: what the panel shows instead of a verdict. */
export interface PanelRun {
  label: string;
  stream: StreamState;
  model: StreamModel;
  note: string | null;
}

function Place({ model, sourceTag }: { model: Model; sourceTag: string | null }) {
  const meta = [model.place.line, sourceTag].filter(Boolean).join(' · ');
  return (
    <section className="place" aria-label="分析地点">
      <div className="place-row">
        <h1>{model.place.title}</h1>
      </div>
      {meta ? <p className="place-meta">{meta}</p> : null}
    </section>
  );
}

/**
 * 体检 in one column, one category at a time: the answer (with the colours' key under its bars), the
 * category buttons (the map follows them), the communities that cannot walk to one (the rest folded),
 * the next step, and the way into 中心周边设施.
 */
function Checkup({
  model,
  cat,
  onCat,
  scale,
  hot,
  walking,
  onHot,
  onEvidence,
  selected,
  onPlan,
  onFacilities,
}: {
  model: Model;
  cat: HardCategory;
  onCat(cat: HardCategory): void;
  scale: number;
  hot: string | null;
  walking: boolean;
  onHot(code: string | null): void;
  onEvidence(code: string | null): void;
  selected: string | null;
  onPlan(): void;
  onFacilities(): void;
}) {
  const head = model.heads.find((h) => h.cat === cat)!;
  const gaps = head.pseudo + head.blind;
  // where the market gaps can still buy vegetables: said while 菜市场 is the category on the map
  const fresh = cat === '菜市场' ? freshLine(model) : null;
  return (
    <section className="checkup" id="panel-sheet" aria-label="各小区缺口">
      <Verdict model={model} walking={walking} />
      <CategoryCards model={model} cat={cat} onCat={onCat} walking={walking} />
      <GapList
        model={model}
        cat={cat}
        scale={scale}
        hot={hot}
        walking={walking}
        onHot={onHot}
        onEvidence={onEvidence}
        selected={selected}
      />
      {fresh ? (
        <p className="fresh-line" title={FRESH_RULE_TEXT}>
          {freshTally(model).withAlt ? <i className="k-a" aria-hidden="true" /> : null}
          <span>
            <NumText text={fresh} />
          </span>
        </p>
      ) : null}
      {gaps ? (
        // kept in place while 走一遍 plays (nothing below it jumps), back when the verdict lands
        <button
          type="button"
          className={'sheet-next' + (walking ? ' waiting' : '')}
          onClick={onPlan}
          disabled={walking}
          aria-hidden={walking || undefined}
          tabIndex={walking ? -1 : undefined}
        >
          去规划补点 →
        </button>
      ) : null}
      <FacilityEntry model={model} scale={scale} onOpen={onFacilities} />
    </section>
  );
}

export interface PanelProps {
  model: Model;
  mode: Mode;
  sub: CheckView;
  onSub(v: CheckView): void;
  cat: HardCategory;
  onCat(cat: HardCategory): void;
  /** walking-time multiplier of the selected profile */
  scale: number;
  profile: Profile;
  hot: string | null;
  walking: boolean;
  onHot(code: string | null): void;
  /** 圈内设施: the categories the map shows, ticked in the list */
  facCats: readonly string[];
  onFacCat(cat: string, on: boolean): void;
  /** visible provenance tag after the place line, e.g. 样例回放 (docs/api.md) */
  sourceTag: string | null;
  sourceNote: string;
  dataNote: string | null;
  samples: SampleInfo[];
  /** the analysis POST /api/ask answers about; null when it cannot */
  analysisId: string | null;
  askBlocked: string | null;
  advisor: Health['advisor'];
  /** changes with every analysis put on screen (the 问询 log starts over) */
  resultKey: string;
  pins: SitePin[];
  plan: PlanState;
  estimate: WhatIfEstimate | null;
  measureBlocked: string | null;
  onPlace(): void;
  onUseSite?(site: SitePin): void;
  onClearSite(): void;
  onMeasure(): void;
  onHotSite(key: string | null): void;
  run: PanelRun | null;
  onCancelRun(): void;
  /** a unit's row clicked: draw its walking route on the map (null closes it) */
  onEvidence(code: string | null): void;
  /** the unit whose route is on the map, for the category on screen */
  selected: string | null;
  /** a citation's places on the map now, and a citation pointed at (问询) */
  spot?: { spot: MapSpot; pinned: boolean } | null;
  onSpot(s: { spot: MapSpot; pinned: boolean } | null): void;
  /** what-if measurements saved on this analysis (null: none read) */
  branches: WhatIfBranch[] | null;
  onRestoreBranch(b: WhatIfBranch): void;
  /** 为这些小区找补点: to 规划, the category kept */
  onPlan(): void;
}

export const Panel = memo(function Panel(props: PanelProps) {
  const { model, mode, run } = props;
  const elder = props.profile === 'elder';
  const kmh = ((elder ? V_ELDER : model.vAdult) * 3.6).toFixed(1);
  return (
    <aside
      className={'panel' + (props.walking ? ' walking' : '') + ` m-${mode}`}
      aria-label={mode === 'ask' ? '问询' : mode === 'plan' ? '规划' : '体检结论'}
    >
      {run ? (
        <RunBoard label={run.label} stream={run.stream} model={run.model} note={run.note} />
      ) : (
        <>
          <Place model={model} sourceTag={props.sourceTag} />
          {mode === 'check' && props.sub === 'sheet' ? (
            <Checkup
              model={model}
              cat={props.cat}
              onCat={props.onCat}
              scale={props.scale}
              hot={props.hot}
              walking={props.walking}
              onHot={props.onHot}
              onEvidence={props.onEvidence}
              selected={props.selected}
              onPlan={props.onPlan}
              onFacilities={() => props.onSub('fac')}
            />
          ) : null}
          {mode === 'check' && props.sub === 'fac' ? (
            <button type="button" className="fac-back" onClick={() => props.onSub('sheet')}>
              <Chev dir="left" />
              各小区缺口
            </button>
          ) : null}
          {mode === 'check' ? (
            <FacilityView
              model={model}
              scale={props.scale}
              kmh={kmh}
              profileWord={elder ? '老人' : '成人'}
              hidden={props.sub !== 'fac'}
              shown={props.facCats}
              onShow={props.onFacCat}
            />
          ) : null}
          {mode === 'plan' ? (
            <>
              <CategoryCards model={model} cat={props.cat} onCat={props.onCat} walking={props.walking} />
              <Planning
                model={model}
                cat={props.cat}
                pins={props.pins}
                plan={props.plan}
                estimate={props.estimate}
                measureBlocked={props.measureBlocked}
                onPlace={props.onPlace}
                onUseSite={props.onUseSite}
                onClear={props.onClearSite}
                onMeasure={props.onMeasure}
                onHot={props.onHot}
                onHotSite={props.onHotSite}
                branches={props.branches}
                onRestoreBranch={props.onRestoreBranch}
              />
            </>
          ) : null}
          {mode === 'ask' ? <VerdictBrief model={model} /> : null}
          <AdvisorPanel
            key={props.resultKey}
            model={model}
            analysisId={props.analysisId}
            blocked={props.askBlocked}
            advisor={props.advisor}
            samples={props.samples}
            hidden={mode !== 'ask'}
            onHot={props.onHot}
            spot={props.spot ?? null}
            onSpot={props.onSpot}
          />
          {mode === 'ask' || !props.dataNote ? null : (
            <footer className="panel-foot" title={props.sourceNote}>
              <span className="data-note">{props.dataNote}</span>
            </footer>
          )}
        </>
      )}
    </aside>
  );
});
