/**
 * The area menu's rows (the web's top bar and the mini program's area sheet): the recent live checks
 * the server remembers and the samples, each with its headline. Pure: no component, no DOM.
 */
import { headlineGaps, shortTime, type HistoryItem } from '../data/history.js';
import type { SampleInfo } from '../data/loadAnalysis.js';

/** Sample letter from its id: zj-b → B. */
export const letterOf = (id: string) =>
  /^[a-z]+-([a-z0-9]+)$/i.exec(id)?.[1]?.toUpperCase() ?? id.toUpperCase();

/** One row of the area menu: a sample, a live check from the history, or the live result on screen. */
export interface AreaOption {
  key: string;
  code: string;
  name: string;
  note: string;
  live: boolean;
  /** "画圈 x → 走一遍 y" under the rule set on screen, when the history knows it */
  gaps: { circle: number; walk: number } | null;
  current: boolean;
  /** what choosing it does (nothing for the row on screen) */
  open: (() => void) | null;
}

/**
 * The area menu's rows: the recent live checks the server remembers (newest first), then the samples,
 * each with its headline from GET /api/history. The live result on screen leads when the history does
 * not list it (yet).
 */
export function areaOptions(opts: {
  samples: SampleInfo[];
  history: HistoryItem[] | null;
  active: string | null;
  activeLive: string | null;
  current: { code: string; name: string; live: boolean };
  onOpen(id: string): void;
  onOpenHistory?(item: HistoryItem): void;
}): { live: AreaOption[]; samples: AreaOption[] } {
  const { history } = opts;
  // one row per place and profile: checking the same place again replaces its row (newest first)
  const seen = new Set<string>();
  const lives = (history ?? [])
    .filter((h) => !h.sample)
    .filter((h) => {
      const key = `${h.name}|${h.label ?? ''}|${h.profile ?? 'adult'}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 8);
  const byId = new Map((history ?? []).map((h) => [h.id, h]));
  const live: AreaOption[] = lives.map((h) => ({
    key: h.id,
    code: '实时',
    name: h.name,
    // the label only when the name does not already say it (浦江镇周边 · 浦江镇)
    note: [
      shortTime(h.created_at),
      h.label && !h.name.includes(h.label) ? h.label : null,
      h.profile === 'elder' ? '老人步速' : null,
    ]
      .filter(Boolean)
      .join(' · '),
    live: true,
    gaps: headlineGaps(h.headline),
    current: opts.current.live && opts.activeLive === h.id,
    open: opts.current.live && opts.activeLive === h.id ? null : () => opts.onOpenHistory?.(h),
  }));
  if (opts.current.live && !live.some((o) => o.current)) {
    live.unshift({
      key: '__live',
      code: opts.current.code,
      name: opts.current.name,
      note: '当前实时体检',
      live: true,
      gaps: null,
      current: true,
      open: null,
    });
  }
  const samples: AreaOption[] = opts.samples.map((s) => {
    const h = byId.get(s.id);
    const current = !opts.current.live && s.id === opts.active;
    return {
      key: s.id,
      code: letterOf(s.id),
      name: s.name,
      // the section is headed 样例 already
      note: s.center_label ? `中心 ${s.center_label}` : '',
      live: false,
      gaps: h ? headlineGaps(h.headline) : null,
      current,
      open: current ? null : () => opts.onOpen(s.id),
    };
  });
  return { live, samples };
}
