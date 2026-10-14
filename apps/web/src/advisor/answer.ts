/**
 * 问询 text model: the advisor's answer (plain text with [T1] citations, "- " lists, now and then a
 * Markdown table from a model) becomes blocks of inline tokens the board can set in its own type —
 * numbers in the numeral face, citations and unit codes as code plates, community names linked to
 * their unit on the map. Nothing here changes what the answer says.
 */
import type { CheckStatus, HardCategory } from '@zoudedao/core';
import { type Model } from '../model/derive.js';
import { HISTORY_CONTENT_MAX, HISTORY_MAX, type AskAnswer, type HistoryTurn } from '../data/ask.js';

export type Inline =
  | { t: 'text'; s: string }
  /** a number with its Latin unit ("1,084.1 m", "0.9 m/s", "54%") */
  | { t: 'num'; s: string }
  | { t: 'cite'; ids: string[] }
  /**
   * A unit of the analysis on screen; `name` when the text names it (code alone otherwise).
   * `repeat`: the answer mentioned this unit before, so it is linked without another code plate.
   */
  | { t: 'unit'; code: string; name: string | null; repeat?: boolean }
  /** L̂, the siting estimator of the simulate tool (its combining hat is drawn, not typed) */
  | { t: 'lhat' }
  | { t: 'strong'; parts: Inline[] };

export type Block =
  /** tag: the template's "结论：" / "估算（未经实测核验）：" lead-in, set as a label instead */
  | { t: 'p'; text: string; tag?: 'conclusion' | 'estimate' }
  | { t: 'h'; text: string }
  | { t: 'list'; ordered: boolean; items: string[] }
  | { t: 'table'; rows: string[][] };

/**
 * The agent's closing line ("（未配置大模型：以上回答由模板……）"): the provenance line under the
 * answer says the same in the board's own words.
 */
const FOOTER = /^（(?:未配置大模型|大模型[^：]{0,24})：以上.{0,80}）$/;

export function stripFooter(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  if (lines.length && FOOTER.test(lines[lines.length - 1]!.trim())) lines.pop();
  return lines.join('\n').trim();
}

export function parseAnswer(text: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let table: string[][] | null = null;
  const flushPara = () => {
    if (para.length) blocks.push({ t: 'p', text: para.join('\n') });
    para = [];
  };
  const flushList = () => {
    if (list) blocks.push({ t: 'list', ...list });
    list = null;
  };
  const flushTable = () => {
    if (table?.length) blocks.push({ t: 'table', rows: table });
    table = null;
  };
  for (const raw of stripFooter(text).split('\n')) {
    const line = raw.trim();
    if (!line) {
      flushPara();
      flushList();
      flushTable();
      continue;
    }
    if (line.startsWith('|')) {
      flushPara();
      flushList();
      if (/^\|[\s:|-]+$/.test(line)) continue; // |---|---|
      (table ??= []).push(
        line
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((c) => c.trim()),
      );
      continue;
    }
    flushTable();
    const item = /^(?:[-*•·]|(\d{1,2})[.、)）])\s*(.+)$/.exec(line);
    if (item && (item[1] !== undefined || /^[-*•·]\s/.test(line))) {
      flushPara();
      const ordered = item[1] !== undefined;
      if (list && list.ordered !== ordered) flushList();
      (list ??= { ordered, items: [] }).items.push(item[2]!);
      continue;
    }
    flushList();
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading) {
      flushPara();
      blocks.push({ t: 'h', text: heading[1]! });
      continue;
    }
    para.push(line);
  }
  flushPara();
  flushList();
  flushTable();
  for (const b of blocks) {
    if (b.t !== 'p') continue;
    const estimate = /^估算（未经实测核验）[：:]\s*/.exec(b.text);
    const conclusion = /^结论[：:]\s*/.exec(b.text);
    if (estimate) Object.assign(b, { tag: 'estimate', text: b.text.slice(estimate[0].length) });
    else if (conclusion) Object.assign(b, { tag: 'conclusion', text: b.text.slice(conclusion[0].length) });
  }
  return blocks;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A number and the Latin unit right after it: both belong to the numeral face. */
export const NUMBER_RE = String.raw`\d[\d,]*(?:\.\d+)?(?:\s?(?:km²|km2|m²|m2|m\/s|km|m|%)(?![A-Za-z]))?`;

export interface UnitRef {
  code: string;
  name: string;
}

/**
 * Inline tokens of one line of answer text. One pass, leftmost match first; at a position the order
 * is: bracketed citation, unit code (with the unit's name right after it), community name, a bare
 * citation id that the answer really cites ("与工具结果 T1 相同"), L̂, number (with its unit).
 */
export function makeInliner(units: readonly UnitRef[], citeIds: readonly string[] = []) {
  const byCode = new Map(units.map((u) => [u.code, u]));
  // two-character names ("东区") would light up ordinary words
  const byName = new Map(units.filter((u) => [...u.name].length >= 3).map((u) => [u.name, u]));
  const names = [...byName.keys()].sort((a, b) => b.length - a.length).map(escapeRe);
  const nameAlt = names.length ? `(${names.join('|')})` : '(\\b\\B)';
  const cited = new Set(citeIds);
  const re = new RegExp(
    [
      String.raw`[[【]\s*T(\d+)((?:\s*[,，、]\s*T?\d+)*)\s*[\]】]`,
      String.raw`(?<![A-Za-z0-9])([A-Z]-\d{2})(?!\d)(?:\s?${nameAlt})?`,
      nameAlt,
      String.raw`(?<![A-Za-z0-9])T(\d{1,2})(?![\dA-Za-z])`,
      'L\u0302',
      NUMBER_RE,
    ]
      .map((p) => `(?:${p})`)
      .join('|'),
    'g',
  );

  const tokens = (text: string): Inline[] => {
    const out: Inline[] = [];
    const push = (tok: Inline) => {
      const last = out[out.length - 1];
      if (tok.t === 'text' && last?.t === 'text') last.s += tok.s;
      else if (tok.t !== 'text' || tok.s) out.push(tok);
    };
    let at = 0;
    for (const m of text.matchAll(re)) {
      push({ t: 'text', s: text.slice(at, m.index) });
      at = m.index + m[0].length;
      if (m[1] !== undefined) {
        const rest = [...(m[2] ?? '').matchAll(/\d+/g)].map((d) => `T${d[0]}`);
        push({ t: 'cite', ids: [`T${m[1]}`, ...rest] });
      } else if (m[3] !== undefined) {
        const unit = byCode.get(m[3]);
        if (unit) push({ t: 'unit', code: unit.code, name: m[4] ?? null });
        else {
          push({ t: 'text', s: m[3] + m[0].slice(m[3].length, m[0].length - (m[4]?.length ?? 0)) });
          if (m[4]) push({ t: 'unit', code: byName.get(m[4])!.code, name: m[4] });
        }
      } else if (m[5] !== undefined) {
        push({ t: 'unit', code: byName.get(m[5])!.code, name: m[5] });
      } else if (m[6] !== undefined) {
        const id = `T${m[6]}`;
        push(cited.has(id) ? { t: 'cite', ids: [id] } : { t: 'text', s: m[0] });
      } else if (m[0] === 'L\u0302') {
        push({ t: 'lhat' });
      } else {
        push({ t: 'num', s: m[0] });
      }
    }
    push({ t: 'text', s: text.slice(at) });
    return out;
  };

  /** "**bold**" from a model becomes strong; everything else is tokens. */
  return (text: string): Inline[] => {
    const parts = text.split(/\*\*(.+?)\*\*/);
    if (parts.length === 1) return tokens(text);
    return parts.flatMap((part, k): Inline[] =>
      k % 2 ? [{ t: 'strong', parts: tokens(part) }] : tokens(part),
    );
  };
}

// --------------------------------------------------------------------------- token blocks

/** A block with its text already tokenized: one Inline[] per line (per cell in tables). */
export type TBlock =
  | { t: 'p'; lines: Inline[][]; tag?: 'conclusion' | 'estimate' }
  | { t: 'h'; lines: Inline[][] }
  | { t: 'list'; ordered: boolean; items: Inline[][][] }
  | { t: 'table'; rows: Inline[][][][] };

/**
 * Tokenizes every block and marks repeated units: a unit gets its code plate the first time the
 * answer names it; later mentions stay linked to the map without a plate, so the text keeps reading.
 */
export function tokenizeBlocks(blocks: readonly Block[], inline: (s: string) => Inline[]): TBlock[] {
  const lines = (text: string) => text.split('\n').map(inline);
  const out: TBlock[] = blocks.map((b): TBlock => {
    switch (b.t) {
      case 'p':
        return { t: 'p', lines: lines(b.text), ...(b.tag ? { tag: b.tag } : {}) };
      case 'h':
        return { t: 'h', lines: lines(b.text) };
      case 'list':
        return { t: 'list', ordered: b.ordered, items: b.items.map(lines) };
      case 'table':
        return { t: 'table', rows: b.rows.map((r) => r.map(lines)) };
    }
  });
  const seen = new Set<string>();
  const mark = (parts: Inline[]) => {
    for (const p of parts) {
      if (p.t === 'strong') mark(p.parts);
      else if (p.t === 'unit') {
        if (seen.has(p.code) && p.name) p.repeat = true;
        seen.add(p.code);
      }
    }
  };
  for (const b of out) {
    if (b.t === 'p' || b.t === 'h') b.lines.forEach(mark);
    else if (b.t === 'list') b.items.forEach((item) => item.forEach(mark));
    else b.rows.forEach((r) => r.forEach((cell) => cell.forEach(mark)));
  }
  return out;
}

// ----------------------------------------------------------------------------- suggestions

export interface Suggestion {
  /** what is sent */
  question: string;
  /** compact label once the conversation has started */
  short: string;
}

const RANK: Record<CheckStatus, number> = { 盲区: 0, 伪覆盖: 1, 临界: 2, 覆盖: 3 };
const MEASURE: Record<HardCategory, string> = {
  幼儿园: '所',
  小学: '所',
  菜市场: '家',
  药店: '家',
  社区卫生: '家',
};

/**
 * The category a unit misses worst: 盲区 before 伪覆盖, then the longer walk; verified checks only.
 * `plannable`: only what a new facility fixes — not 小学, which is the assigned school, never a nearer one.
 */
export function worstCategory(unit: Model['units'][number], plannable = false): HardCategory | null {
  const bad = (Object.keys(unit.checks) as HardCategory[])
    .filter((cat) => !plannable || cat !== '小学')
    .map((cat) => ({ cat, c: unit.checks[cat] }))
    .filter(({ c }) => c.verified !== false && c.status_main !== '覆盖')
    .sort((a, b) => (RANK[a.c.status_main] ?? 3) - (RANK[b.c.status_main] ?? 3) || b.c.route_m - a.c.route_m);
  return bad[0]?.cat ?? null;
}

/** Three questions derived from the analysis on screen; every word comes from the data. */
export function suggestionsFor(model: Model): Suggestion[] {
  const area = model.data.meta.name;
  const out: Suggestion[] = [{ question: `${area}的老人买菜方便吗？`, short: '老人买菜方便吗？' }];
  // what opening a facility would fix: never 小学 (the assigned school decides, not distance)
  const worst = model.boardOrder.find((u) => worstCategory(u, true));
  const cat = worst && worstCategory(worst, true);
  if (worst && cat) {
    out.push({
      question: `如果在 ${worst.code} ${worst.name}附近开一${MEASURE[cat]}${cat}呢？`,
      short: `${worst.code} 附近开${cat}？`,
    });
  } else {
    out.push({ question: '15 分钟能走多远？', short: '15 分钟能走多远？' });
  }
  out.push({ question: '导出体检报告', short: '导出体检报告' });
  return out;
}

// ----------------------------------------------------------------------------------- history

/** The conversation so far as the server takes it: last 8 turns, footers dropped, 2,000 characters each. */
export function historyOf(done: { question: string; answer: AskAnswer }[]): HistoryTurn[] {
  const clip = (s: string) => {
    const chars = [...s];
    return chars.length > HISTORY_CONTENT_MAX ? chars.slice(0, HISTORY_CONTENT_MAX - 1).join('') + '…' : s;
  };
  return done
    .flatMap((x): HistoryTurn[] => [
      { role: 'user', content: clip(x.question) },
      { role: 'assistant', content: clip(stripFooter(x.answer.answer)) },
    ])
    .slice(-HISTORY_MAX);
}

/** "5.1 KB" for the download plate. */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** "Markdown" / "GeoJSON" / "JSON" from an attachment. */
export function formatName(mime: string, filename: string): string {
  if (/markdown/i.test(mime) || /\.md$/i.test(filename)) return 'Markdown';
  if (/geo\+json/i.test(mime) || /\.geojson$/i.test(filename)) return 'GeoJSON';
  if (/json/i.test(mime)) return 'JSON';
  return filename.split('.').pop()?.toUpperCase() ?? '文件';
}
