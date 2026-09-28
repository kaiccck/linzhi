import { memo, useEffect, useRef, useState, type RefObject } from 'react';
import type { FacilityCheck, HardCategory } from '@zoudedao/core';
import type { Health } from '../data/api.js';
import type { SampleInfo } from '../data/loadAnalysis.js';
import { CAT_ICON, CATS, fmtInt, type Model, type Unit } from '../model/derive.js';
import { AdvisorPanel } from './Advisor.js';
import { Pg } from './Icons.js';

/** What the lower half of the board shows: the unit directory, or the 问询 desk. */
export type BoardTab = 'dir' | 'ask';

interface BoardProps {
  model: Model;
  /** walking-time multiplier of the selected profile */
  scale: number;
  hot: string | null;
  walking: boolean;
  sourceNote: string;
  /** visible provenance tag after the place line, e.g. 样例回放 (docs/api.md) */
  sourceTag: string | null;
  samples: SampleInfo[];
  activeSample: string | null;
  onOpenSample(id: string): void;
  onHot(code: string | null): void;
  tab: BoardTab;
  onTab(tab: BoardTab): void;
  /** the analysis POST /api/ask answers about; null when it cannot */
  analysisId: string | null;
  /** why 问询 cannot work here (static build without a server …) */
  askBlocked: string | null;
  advisor: Health['advisor'];
}

const kmLabel = (m: number) => (m % 1000 === 0 ? `${m / 1000} 公里` : `${fmtInt(m)} 米`);

/**
 * "≤" drawn to the numeral face's proportions: neither Barlow nor the sign face has a Latin-width ≤
 * (the sign face's is the full-width CJK form), and an upper bound must read as tightly as "≤13′".
 */
const Le = () => (
  <svg className="le" viewBox="0 0 10 14" aria-hidden="true" focusable="false">
    <path d="M8.8 1.9 1.6 5.8l7.2 3.9M1.6 12.4h7.2" />
  </svg>
);

function Bound({ kind }: { kind: '' | '≤' | '≈' }) {
  if (kind === '≤') return <Le />;
  return kind ? <>{kind}</> : null;
}

/**
 * Rows hidden below the fold of the scrolling directory. Live checks list up to 30 communities; the
 * list is sorted worst first, so the hint only says how many milder ones are left.
 */
function useRowsBelow(ref: RefObject<HTMLOListElement | null>, count: number): number {
  const [below, setBelow] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const fold = el.scrollTop + el.clientHeight;
      let n = 0;
      for (const row of Array.from(el.children) as HTMLElement[]) {
        if (row.offsetTop + row.offsetHeight / 2 > fold) n++;
      }
      setBelow(n);
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, [ref, count]);
  return below;
}

/** Sample letter from its id: zj-b → B. */
const plateOf = (id: string) => /^[a-z]+-([a-z0-9]+)$/i.exec(id)?.[1]?.toUpperCase() ?? id.toUpperCase();

/**
 * The header's code plates: one per bundled sample (A 申城佳苑, B 玉兰香苑 …), the one on screen filled.
 * A live check adds its own filled 实时 plate. Without the sample list (no server) only the code shows.
 */
function SamplePlates({
  samples,
  active,
  code,
  sourceNote,
  onOpen,
}: {
  samples: SampleInfo[];
  active: string | null;
  code: string;
  sourceNote: string;
  onOpen(id: string): void;
}) {
  if (samples.length < 2) {
    return (
      <span className="code num" title={sourceNote}>
        {code}
      </span>
    );
  }
  return (
    <nav className="sample-plates" aria-label="样例片区">
      {samples.map((smp) => {
        const on = smp.id === active;
        const label = `样例 ${plateOf(smp.id)}：${smp.name}`;
        return (
          <button
            key={smp.id}
            type="button"
            className={'sample-plate num' + (on ? ' on' : '')}
            aria-pressed={on}
            aria-label={label}
            title={on ? `${label}（${sourceNote}）` : label}
            onClick={() => {
              if (!on) onOpen(smp.id);
            }}
          >
            {plateOf(smp.id)}
          </button>
        );
      })}
      {active === null ? (
        <span className="sample-plate num on" title={sourceNote}>
          {code}
        </span>
      ) : null}
    </nav>
  );
}

/** One directory cell: measured walking minutes over the straight-line estimate (DESIGN.md "Verdict cell"). */
function Cell({
  cat,
  s,
  scale,
  vAdult,
}: {
  cat: HardCategory;
  s: FacilityCheck;
  scale: number;
  vAdult: number;
}) {
  const walkMin = Math.round((s.dur_s * scale) / 60);
  const lineMin = Math.round((s.straight_m / vAdult / 60) * scale);
  const bound: '' | '≤' | '≈' = s.route_upper_bound ? '≤' : s.route_basis === 'estimated' ? '≈' : '';
  if (s.verified === false) {
    // pending: no verdict colour until the community is routed on its own
    const label = `${cat} 待核实：已测路线 ${fmtInt(s.route_m)} 米只是上限，附近还有更近的设施未测`;
    return (
      <span className="cell s-pending" role="img" title={label} aria-label={label}>
        <span className="m pend">待核</span>
        <span className="alt">
          <Bound kind={bound} />
          {walkMin}′
        </span>
      </span>
    );
  }
  let cls = '';
  if (s.status === '盲区') cls = 's-blind';
  else if (s.status === '伪覆盖') cls = 's-pseudo';
  else if (s.status === '临界') {
    cls = 's-edge' + (s.status_main === '伪覆盖' ? ' edge-bad' : s.status_main === '盲区' ? ' s-blind' : '');
  }
  const edge = s.status === '临界';
  const label = `${cat} ${s.status}：步行 ${fmtInt(s.route_m)} 米约 ${walkMin} 分钟，直线 ${fmtInt(s.straight_m)} 米`;
  return (
    <span className={'cell ' + cls} role="img" title={label} aria-label={label}>
      {edge ? (
        // borderline cells show metres: the 1 km line is only visible in the number itself
        <span className="m metre">
          {fmtInt(s.route_m)}
          <small>m</small>
        </span>
      ) : (
        <span className="m">
          <Bound kind={bound} />
          {walkMin}′
        </span>
      )}
      <span className="alt">直线 {lineMin}′</span>
    </span>
  );
}

function Row({ u, props }: { u: Unit; props: BoardProps }) {
  const { scale, model, hot, onHot } = props;
  return (
    <li
      className={'dir-row' + (hot === u.code ? ' hot' : '')}
      tabIndex={0}
      data-code={u.code}
      onMouseEnter={() => onHot(u.code)}
      onMouseLeave={() => onHot(null)}
      onFocus={() => onHot(u.code)}
      onBlur={() => onHot(null)}
    >
      <span className="code">{u.code}</span>
      <span className="name" title={u.name}>
        {u.nameMain}
        {u.nameSub ? <small>{u.nameSub}</small> : null}
      </span>
      {CATS.map((k) => (
        <Cell key={k} cat={k} s={u.checks[k]} scale={scale} vAdult={model.vAdult} />
      ))}
    </li>
  );
}

export const Board = memo(function Board(props: BoardProps) {
  const { model, walking, sourceNote, sourceTag, tab, onTab } = props;
  const n = model.units.length;
  const rowsRef = useRef<HTMLOListElement>(null);
  const below = useRowsBelow(rowsRef, n);
  const plateRef = useRef<HTMLButtonElement>(null);
  // each opening by the visitor focuses the question field; going back returns focus to the plate
  const [opened, setOpened] = useState(0);
  const toggle = () => {
    if (tab === 'ask') onTab('dir');
    else {
      onTab('ask');
      setOpened((k) => k + 1);
    }
  };
  const back = () => {
    onTab('dir');
    window.requestAnimationFrame(() => plateRef.current?.focus());
  };
  return (
    <aside
      className={'board' + (walking ? ' walking' : '') + (tab === 'ask' ? ' asking' : '')}
      aria-label="体检结论"
    >
      <header className="brand">
        <div className="mark" aria-hidden="true">
          <Pg id="pg-walk" />
        </div>
        <div className="wordmark">
          <h1>走得到</h1>
          <p>15 分钟生活圈体检</p>
        </div>
        <SamplePlates
          samples={props.samples}
          active={props.activeSample}
          code={model.code}
          sourceNote={sourceNote}
          onOpen={props.onOpenSample}
        />
      </header>

      <section className="place" aria-label="分析地点">
        <div className="place-txt">
          <h2>{model.place.title}</h2>
          {model.place.line || sourceTag ? (
            <p>{[model.place.line, sourceTag].filter(Boolean).join(' · ')}</p>
          ) : null}
        </div>
        {/* 问询处: the sign's information plate beside the place it answers about */}
        <button
          ref={plateRef}
          type="button"
          className="ask-toggle"
          aria-pressed={tab === 'ask'}
          aria-controls="panel-ask"
          title={tab === 'ask' ? '回到小区目录' : '问询：按这次体检的结果回答问题'}
          onClick={toggle}
        >
          <span className="tile" aria-hidden="true">
            <Pg id="pg-info" />
          </span>
          问询
        </button>
      </section>

      <section className="verdict" aria-live="polite">
        {model.walkGaps > model.circleGaps ? (
          <>
            <p className="line muted">
              画圈，只找到 <span className="num">{model.circleGaps}</span> 个缺口。
            </p>
            <p className="line">
              走一遍，找到 <span className="num">{model.walkGaps}</span> 个。
            </p>
          </>
        ) : model.walkGaps > 0 ? (
          // walking never finds fewer gaps than the circle (a route is never shorter than the line);
          // when it finds the same ones, the facilities are missing outright
          <>
            <p className="line muted">
              画圈找到 <span className="num">{model.circleGaps}</span> 个缺口，
            </p>
            <p className="line">
              走一遍，也是 <span className="num">{model.walkGaps}</span> 个。
            </p>
          </>
        ) : (
          <>
            <p className="line muted">画圈没有找到缺口，</p>
            <p className="line">走一遍，也没有。</p>
          </>
        )}
        <p className="sub">
          {n} 个小区 × {CATS.length} 类设施，按百度实测步行路线逐一核对。
        </p>
      </section>

      <section className="directory" aria-label="小区 × 设施步行分钟" hidden={tab !== 'dir'}>
        <div className="dir-head">
          <span className="h-name">
            <span>小区（由重到轻）</span>
            <span className="h-ok">走得到</span>
          </span>
          {model.heads.map((h) => (
            <span className="h-cat" key={h.cat}>
              <span className="tile" aria-hidden="true">
                <Pg id={CAT_ICON[h.cat]!} />
              </span>
              {h.cat}
              <small>
                <span className="nw">
                  {h.ok}/{n}
                </span>
                {h.pending ? (
                  <>
                    <span className="sep"> · </span>
                    <span className="nw">{h.pending} 待核</span>
                  </>
                ) : null}
              </small>
            </span>
          ))}
        </div>
        <ol className="dir-rows" ref={rowsRef}>
          {model.boardOrder.map((u) => (
            <Row key={u.code} u={u} props={props} />
          ))}
        </ol>
        {below > 0 ? (
          <button
            type="button"
            className="dir-more"
            onClick={() => {
              const el = rowsRef.current;
              el?.scrollBy({ top: el.clientHeight * 0.8, behavior: 'smooth' });
            }}
          >
            还有 {below} 个小区，向下滚动查看
          </button>
        ) : null}
      </section>

      <AdvisorPanel
        model={model}
        analysisId={props.analysisId}
        blocked={props.askBlocked}
        advisor={props.advisor}
        samples={props.samples}
        hidden={tab !== 'ask'}
        opened={opened}
        onBack={back}
        onHot={props.onHot}
      />

      <footer className="legend" hidden={tab !== 'dir'}>
        <ul>
          <li>
            <span className="lg-num">9′</span>走得到
          </li>
          <li>
            <span className="plate-s s-pseudo" aria-hidden="true" />
            伪覆盖：画圈有，走不到
          </li>
          <li>
            <span className="plate-s s-blind" aria-hidden="true" />
            盲区
          </li>
          <li>
            <span className="plate-s s-edge" aria-hidden="true" />
            临界：离 {kmLabel(model.ruleM)} ±50 m，显示米数
          </li>
          <li>
            <span className="plate-s s-pending" aria-hidden="true" />
            待核：尚未对该小区单独实测
          </li>
        </ul>
        <p>
          大字：百度实测步行分钟（≤ 为路线上限）；小字：按直线估的分钟。规则：步行 {kmLabel(model.ruleM)}
          内应有小学、菜市场、药店。
        </p>
      </footer>
    </aside>
  );
});
