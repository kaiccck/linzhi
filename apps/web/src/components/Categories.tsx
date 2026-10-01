/**
 * The checked categories side by side, one tile each: pictogram and how many communities cannot walk to
 * one within the rule (a tick when none) over the category's name. They choose the category the list,
 * the map's tints and the 规划 view show (a radiogroup: arrows move, one tab stop); the chosen one wears
 * the cobalt edge. The share that can (24/30) and what is pending are in the tile's spoken label.
 */
import { useRef, type KeyboardEvent } from 'react';
import type { HardCategory } from '@zoudedao/core';
import { CAT_COLOR, CAT_ICON, distWords, type CategoryHead, type Model } from '../model/derive.js';
import { Pg } from './Icons.js';

export function cardLabel(h: CategoryHead, n: number, rule: number): string {
  const parts = [
    `${h.cat}：${n} 个小区里 ${h.ok} 个步行 ${distWords(rule)}内走得到`,
    h.pseudo ? `伪覆盖 ${h.pseudo}` : '',
    h.blind ? `盲区 ${h.blind}` : '',
    h.pending ? `待核 ${h.pending}` : '',
  ].filter(Boolean);
  return parts.join('，');
}

/** The card's line of words: the gaps on foot and what is still unverified. */
export function cardNote(h: CategoryHead): { gaps: number; pending: number } {
  return { gaps: h.pseudo + h.blind, pending: h.pending };
}

export function CategoryCards({
  model,
  cat,
  onCat,
}: {
  model: Model;
  cat: HardCategory;
  onCat(cat: HardCategory): void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const n = model.units.length;
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const cats = model.cats;
    const i = cats.indexOf(cat);
    const next =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? (i + 1) % cats.length
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? (i - 1 + cats.length) % cats.length
          : -1;
    if (next < 0) return;
    e.preventDefault();
    onCat(cats[next]!);
    refs.current[next]?.focus();
  };
  return (
    <div
      className={'cats' + (n > 16 ? ' dense' : '')}
      role="radiogroup"
      aria-label="设施类别"
      style={{ ['--n' as string]: model.heads.length }}
      onKeyDown={onKey}
    >
      {model.heads.map((h, i) => {
        const on = h.cat === cat;
        const rule = model.ruleOf[h.cat];
        const { gaps, pending } = cardNote(h);
        return (
          <button
            key={h.cat}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            className="cat"
            aria-label={cardLabel(h, n, rule)}
            onClick={() => onCat(h.cat)}
          >
            <span className="cat-top" aria-hidden="true">
              <Pg id={CAT_ICON[h.cat]!} color={CAT_COLOR[h.cat]} />
              <b className={'cat-n num' + (gaps ? '' : pending ? ' pending' : ' clear')}>
                {gaps || (pending ? 0 : '✓')}
              </b>
            </span>
            <span className="cat-name" aria-hidden="true">
              {h.cat}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** The category with the most gaps on foot (the one the panel opens on). */
export function worstCategory(model: Model): HardCategory {
  let best = model.heads[0]!;
  for (const h of model.heads) if (h.pseudo + h.blind > best.pseudo + best.blind) best = h;
  return best.cat;
}
