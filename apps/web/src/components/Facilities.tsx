/**
 * 圈内设施 — per category, what the straight 15′ circle claims next to what the 15′ walk from the
 * centre really reaches. The tally is the point: one square per facility the circle claims, solid
 * where the walk gets there, a dashed outline where only the circle does (the map's dashed marks).
 * Numbers stand beside it — reached / claimed, and the walk to the nearest one. Each row's box puts
 * its category on the map: every kind at once is too crowded to read.
 */
import { memo, useMemo } from 'react';
import { CAT_COLOR, fmtInt, type Model } from '../model/derive.js';
import { NumText } from './NumText.js';
import { facilitySummary, rowLabel, type FacilityRow, type Mark } from '../model/facilities.js';
import { Pg, Ui } from './Icons.js';

/** Squares shown before the tally folds into "+n" (the numbers beside it always carry the count). */
export const TALLY_MAX = 12;

export function Tally({ marks, max = TALLY_MAX }: { marks: Mark[]; max?: number }) {
  if (!marks.length) return <span className="tally none">圈里没有</span>;
  const shown = marks.length > max ? marks.slice(0, max - 1) : marks;
  const rest = marks.length - shown.length;
  return (
    <span className="tally" aria-hidden="true">
      {shown.map((m, i) => (
        <i key={i} className={'mk mk-' + m} />
      ))}
      {rest > 0 ? <span className="more num">+{rest}</span> : null}
    </span>
  );
}

function Row({
  r,
  radiusM,
  on,
  onShow,
}: {
  r: FacilityRow;
  radiusM: number;
  on: boolean;
  onShow(cat: string, on: boolean): void;
}) {
  return (
    <li className={'fac-row' + (on ? ' on' : '')} style={{ ['--c' as string]: CAT_COLOR[r.cat] }}>
      <button
        type="button"
        className="fac-pick"
        aria-pressed={on}
        aria-label={`${rowLabel(r, radiusM)}。在地图上显示`}
        onClick={() => onShow(r.cat, !on)}
      >
        <span className="box" aria-hidden="true">
          <Ui id="ui-check" />
        </span>
        <span className="ico" aria-hidden="true">
          <Pg id={r.icon} />
        </span>
        <span className="fn" aria-hidden="true">
          {r.cat}
        </span>
      </button>
      <Tally marks={r.tally} />
      <span className="n num" aria-hidden="true">
        <b>{r.walk}</b>
        <span>/{r.circle}</span>
      </span>
      <span className="near num" aria-hidden="true">
        {r.nearestMin === null ? '—' : `${r.nearestMin}′`}
      </span>
    </li>
  );
}

const pct = (part: number, whole: number) => `${whole ? (100 * Math.max(0, part)) / whole : 0}%`;

/**
 * The way into 中心周边设施 from the community view: one row, its two numbers (the circle's claim and
 * the walk's count), a chevron.
 */
export function FacilityEntry({ model, scale, onOpen }: { model: Model; scale: number; onOpen(): void }) {
  const s = useMemo(() => facilitySummary(model, scale), [model, scale]);
  return (
    <button type="button" className="fac-entry" onClick={onOpen}>
      <span className="fe-t">中心周边设施</span>
      <span className="fe-s">
        直线圈里 <span className="num">{s.circle}</span> 处 · <span className="num">15′</span> 走得到{' '}
        <span className="num">{s.walk}</span> 处
      </span>
      <svg className="chev" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
        <path d="M3.5 2 6.5 5 3.5 8" />
      </svg>
    </button>
  );
}

export const FacilityView = memo(function FacilityView({
  model,
  scale,
  kmh,
  profileWord,
  hidden,
  shown,
  onShow,
}: {
  model: Model;
  scale: number;
  /** walking speed of the profile, e.g. "4.2" */
  kmh: string;
  profileWord: string;
  hidden: boolean;
  /** the categories the map shows */
  shown: readonly string[];
  onShow(cat: string, on: boolean): void;
}) {
  const s = useMemo(() => facilitySummary(model, scale), [model, scale]);
  return (
    <section className="fac" id="panel-fac" aria-label="中心周边设施" hidden={hidden}>
      <p className="sr-only">
        从片区中心出发，直线画的 15 分钟圈里有 {s.circle} 处设施，15 分钟步行只走得到 {s.walk} 处。
      </p>
      <div className="v-top" aria-hidden="true">
        <b className="v-n">{s.walk}</b>
        <p className="v-lines">
          <span className="v-t1">
            处设施 <span className="num">15′</span> 走得到
          </span>
          <span className="v-t2">
            从片区中心出发 · {profileWord} <span className="num">{kmh}</span> km/h
          </span>
        </p>
      </div>
      <div className="v-compare" aria-hidden="true">
        <span className="vc-k">画圈</span>
        <span className="vc-track">
          <i className="vc-walk" style={{ width: pct(s.walk, s.circle) }} />
          <i className="vc-claim" style={{ width: pct(s.circle - s.walk, s.circle) }} />
        </span>
        <span className="vc-n num">{s.circle}</span>
        <span className="vc-k">走一遍</span>
        <span className="vc-track">
          <i className="vc-walk" style={{ width: pct(s.walk, s.circle) }} />
        </span>
        <span className="vc-n num">{s.walk}</span>
      </div>
      <p className="v-note" aria-hidden="true">
        <NumText text={`直线圈半径 ${fmtInt(s.radiusM)} m；圈里有 ${s.circle - s.walk} 处 15′ 走不到`} />
      </p>
      <div className="fac-cols" aria-hidden="true">
        <span className="keys">
          <span>
            <i className="mk mk-walk" />
            走得到
          </span>
          <span>
            <i className="mk mk-claim" />
            画圈有，走不到
          </span>
        </span>
        <span className="c-right">
          <span>走得到/圈里</span>
          <span>最近</span>
        </span>
      </div>
      <ol className="fac-rows">
        {s.rows.map((r) => (
          <Row key={r.cat} r={r} radiusM={s.radiusM} on={shown.includes(r.cat)} onShow={onShow} />
        ))}
      </ol>
    </section>
  );
});
