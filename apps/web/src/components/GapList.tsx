/**
 * 体检单 for one category at a time: the communities that cannot walk to one within the rule (and those
 * not verified yet), the longest walk first, each with its measured walk on its verdict's tint — red
 * 伪覆盖 (the circle says it is covered), slate 盲区 (the circle agrees it is not), a dashed grey edge
 * 待核 (only an upper bound). The communities that can fold under one line, the nearest to the rule
 * first. The category buttons above choose which category; a row clicked draws that community's walk
 * on the map.
 */
import { memo, useEffect, useState } from 'react';
import type { FacilityCheck, HardCategory } from '@zoudedao/core';
import { distWords, fmtInt, poiName, type Model, type Unit } from '../model/derive.js';
import { catchmentText } from '../model/evidence.js';
import { checkLook, lookClass, LOOK_WORD, type Look } from '../model/looks.js';
import { Le } from './Le.js';

/** Looks that need no attention: within the rule (临界 within it too). */
const FINE: ReadonlySet<Look> = new Set(['ok', 'edge']);

/** The community needs attention for this category: its row stays open (the rest fold). */
export const needsLook = (u: Unit, cat: HardCategory) => !FINE.has(checkLook(u.checks[cat]));

/** What a check says in words (a row's title and spoken label). */
export function cellWords(cat: HardCategory, s: FacilityCheck, scale: number): string {
  const look = checkLook(s);
  if (look === 'none') return `${cat}：设施清单里没有`;
  if (look === 'pending')
    return `${cat} 待核：已测路线 ${fmtInt(s.route_m)} 米只是上限，附近还有更近的设施未测`;
  const min = Math.round((s.dur_s * scale) / 60);
  const fresh = s.alt ? `；可在${poiName(s.alt.name)}买菜，步行 ${fmtInt(s.alt.route_m)} 米` : '';
  return `${cat} ${LOOK_WORD[look]}：步行 ${fmtInt(s.route_m)} 米约 ${min} 分钟，直线 ${fmtInt(s.straight_m)} 米${fresh}`;
}

/** Gaps first (no facility at all, then the longest walk), then what is pending. */
const RANK: Partial<Record<Look, number>> = { none: 0, pseudo: 1, blind: 1, 'edge-over': 1, pending: 2 };
const walk = (s: FacilityCheck) => (s.route_m > 0 ? s.route_m : Infinity);

/** The measured walk, set by where it came from (The Honest Number Rule). */
function Value({ s, walking }: { s: FacilityCheck; walking: boolean }) {
  const look = checkLook(s);
  if (look === 'none') return <span className="gl-v num s-blind">无</span>;
  const bound =
    look === 'pending' || s.route_upper_bound ? (
      <Le />
    ) : s.route_basis === 'lower_bound' ? (
      '≥'
    ) : s.route_basis === 'estimated' ? (
      '≈'
    ) : null;
  const tone = walking ? 's-quiet' : look === 'ok' ? 'quiet' : lookClass(look);
  return (
    <span className={`gl-v num ${tone}`}>
      {bound}
      {fmtInt(s.route_m)}
      <small>m</small>
      {s.alt && !walking ? <i className="k-a" /> : null}
    </span>
  );
}

function Row({
  u,
  cat,
  scale,
  hot,
  walking,
  selected,
  onHot,
  onEvidence,
}: {
  u: Unit;
  cat: HardCategory;
  scale: number;
  hot: boolean;
  walking: boolean;
  selected: boolean;
  onHot(code: string | null): void;
  onEvidence?(code: string | null): void;
}) {
  const open = onEvidence && !walking ? () => onEvidence(u.code) : undefined;
  const s = u.checks[cat];
  const words = cellWords(cat, s, scale);
  const school = cat === '小学' && u.catchment ? `；${catchmentText(u.catchment)}` : '';
  const label =
    `${u.code} ${u.name}：${words}${school}` +
    (open
      ? selected
        ? `（地图上已画出到${cat}的步行路线）`
        : `（回车：在地图上画出到${cat}的步行路线）`
      : '');
  return (
    <li
      className={'gl-row' + (hot ? ' hot' : '') + (selected ? ' sel' : '')}
      tabIndex={0}
      data-code={u.code}
      title={words}
      aria-label={label}
      aria-current={selected ? 'true' : undefined}
      onClick={open}
      onKeyDown={
        open
          ? (e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return;
              e.preventDefault();
              open();
            }
          : undefined
      }
      onMouseEnter={() => onHot(u.code)}
      onMouseLeave={() => onHot(null)}
      onFocus={() => onHot(u.code)}
      onBlur={() => onHot(null)}
    >
      <span className="code s-quiet" aria-hidden="true">
        {u.code}
      </span>
      <span className="nm" aria-hidden="true">
        {u.nameMain}
        {u.nameSub ? <small>{u.nameSub}</small> : null}
      </span>
      <Value s={s} walking={walking} />
    </li>
  );
}

export const GapList = memo(function GapList({
  model,
  cat,
  scale,
  hot,
  walking,
  onHot,
  onEvidence,
  selected = null,
}: {
  model: Model;
  /** the chosen category (the buttons above; the map shows the same) */
  cat: HardCategory;
  scale: number;
  hot: string | null;
  walking: boolean;
  onHot(code: string | null): void;
  /** a row clicked: that community's walk to the category, drawn on the map (null closes it) */
  onEvidence?(code: string | null): void;
  /** the community whose route is on the map */
  selected?: string | null;
}) {
  const main = model.units
    .filter((u) => needsLook(u, cat))
    .sort((a, b) => {
      const [sa, sb] = [a.checks[cat], b.checks[cat]];
      return (
        (RANK[checkLook(sa)] ?? 3) - (RANK[checkLook(sb)] ?? 3) ||
        walk(sb) - walk(sa) ||
        a.code.localeCompare(b.code)
      );
    });
  // the ones that walk there: nearest the rule first (the ones a new road or a closed gate would tip)
  const rest = model.units
    .filter((u) => !needsLook(u, cat))
    .sort((a, b) => walk(b.checks[cat]) - walk(a.checks[cat]) || a.code.localeCompare(b.code));
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [model, cat]);
  const shown = open || rest.some((u) => u.code === selected);
  const rule = distWords(model.ruleOf[cat]);
  const row = (u: Unit) => (
    <Row
      key={u.code}
      u={u}
      cat={cat}
      scale={scale}
      hot={hot === u.code}
      walking={walking}
      selected={selected === u.code}
      onHot={onHot}
      {...(onEvidence ? { onEvidence } : {})}
    />
  );
  return (
    <ol
      className="gl"
      aria-label={
        main.length
          ? `步行 ${rule}内走不到${cat}的 ${main.length} 个小区，由远到近`
          : `${model.units.length} 个小区步行 ${rule}内都走得到${cat}`
      }
    >
      {main.map(row)}
      {rest.length ? (
        <li className="gl-fold">
          <button type="button" aria-expanded={shown} onClick={() => setOpen(!shown)}>
            {main.length ? '其余 ' : ''}
            <span className="num">{rest.length}</span> 个小区步行 {rule}内{main.length ? '' : '都'}走得到{cat}
            <svg className="chev" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
              <path d="M3.5 2 6.5 5 3.5 8" />
            </svg>
          </button>
        </li>
      ) : null}
      {shown ? rest.map(row) : null}
    </ol>
  );
});
