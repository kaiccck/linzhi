/**
 * Number grounding (技术设计文档 §8.1: the agent never computes a number itself). Every Arabic-digit
 * number in an answer must come from the tool results of this turn, the user's own words, or a short
 * list of domain constants; numbers backed by a tool result must also sit in a sentence citing it
 * ([T1]).
 *
 * Matching rule for a number x written with d decimals against a tool value v (same unit family,
 * after unit conversion m↔km, m²↔km², s↔min↔h, ratio↔%):
 *   - exact: x = v (thousands separators and trailing zeros ignored), or
 *   - rounded: d ≤ 3, x is v rounded to d decimals, AND x keeps at least min(3, significant digits
 *     of v) significant digits.
 * The second condition is deliberate: 1.88 倍 may be written 1.88 or 1.880, but not 1.9 or 2 —
 * rounding that drops precision is the model doing arithmetic, and a hallucinated 1.9 would
 * otherwise hide behind a real 1.88. Likewise 53.3% passes and 53% does not; 1,053 m may be written
 * 1.05 km but not 1.1 km. A number written with a physical unit (m, km², 分钟, 倍 …) only matches a
 * tool value that carries a unit of the same kind; unitless tool values back counts only.
 *
 * What this cannot catch: a real number used for the wrong thing. Small counts recur across a
 * result (6 小区 covered by a school, 6 verified school gaps), so "6 个" passes wherever a 6 exists.
 * Grounding proves provenance, not meaning; the citation check narrows it to the cited result.
 */
import type { Fact } from './format.js';

// ------------------------------------------------------------------------------------ units

type Family = 'length' | 'area' | 'time' | 'speed' | 'percent' | 'times' | 'count' | 'angle' | 'none';

interface UnitDef {
  key: string;
  family: Family;
  /** Size of one unit in the family's base unit (m, m², s, %, …). */
  scale: number;
}

const U = (key: string, family: Family, scale: number): UnitDef => ({ key, family, scale });

const UNIT_DEFS: Record<string, UnitDef> = {
  km2: U('km2', 'area', 1e6),
  m2: U('m2', 'area', 1),
  km: U('km', 'length', 1000),
  m: U('m', 'length', 1),
  'm/s': U('m/s', 'speed', 1),
  h: U('h', 'time', 3600),
  min: U('min', 'time', 60),
  s: U('s', 'time', 1),
  '%': U('%', 'percent', 1),
  ratio: U('ratio', 'percent', 100),
  x: U('x', 'times', 1),
  deg: U('deg', 'angle', 1),
  count: U('count', 'count', 1),
};

// Longest first; ASCII units must not run into further letters ("5G", "3D" are identifiers).
const UNIT_RE =
  /^(?:(平方公里|平方千米|km2)|(平方米|m2)|(公里|千米|km)(?![A-Za-z])|(m\/s|米\/秒|米每秒)|(米|m)(?![A-Za-z])|(小时|h)(?![A-Za-z])|(分钟|min)(?![A-Za-z])|(秒|s)(?![A-Za-z])|(%|个百分点)|(倍|×|x)(?![A-Za-z])|(°|度)|(个|项|家|所|条|处|座|类|名|户|人|次|栋|间|份|件))/;
const UNIT_KEYS = ['km2', 'm2', 'km', 'm/s', 'm', 'h', 'min', 's', '%', 'x', 'deg', 'count'];

/** Unit at the start of `text` (after optional spaces): its key and how many characters it spans. */
function unitAt(text: string): { key: string; length: number } | null {
  const lead = /^\s*/.exec(text)![0].length;
  const m = UNIT_RE.exec(text.slice(lead));
  if (!m) return null;
  const group = m.slice(1).findIndex((g) => g !== undefined);
  return { key: UNIT_KEYS[group]!, length: lead + m[0].length };
}

/** Unit of a fact's unit string ('km²', '倍', '个', 'm/s', '' …). */
export function unitKey(unit: string): string {
  const u = unit.normalize('NFKC').trim();
  if (!u) return '';
  if (u === 'ratio') return 'ratio';
  const hit = unitAt(u);
  return hit && hit.length === u.length ? hit.key : '';
}

/** Unit implied by a JSON key: straight_m, area_iso15_km2, walk_min, reach_share, overstate_x … */
function unitOfKey(key: string): string {
  if (/_km2$/.test(key)) return 'km2';
  if (/_m2$/.test(key)) return 'm2';
  if (/_km$/.test(key)) return 'km';
  if (/_mps$/.test(key)) return 'm/s';
  if (/(^|_)m$/.test(key)) return 'm';
  if (/_min$|^minutes$/.test(key)) return 'min';
  if (/_s$/.test(key)) return 's';
  if (/_pct$/.test(key)) return '%';
  if (/(share|ratio)$/.test(key)) return 'ratio';
  if (/_x$/.test(key)) return 'x';
  return '';
}

const familyOf = (key: string): Family => UNIT_DEFS[key]?.family ?? 'none';
const scaleOf = (key: string): number => UNIT_DEFS[key]?.scale ?? 1;

// ------------------------------------------------------------------------------ extraction

export type TokenKind = 'number' | 'date' | 'code';

export interface NumberToken {
  kind: TokenKind;
  /** As written (NFKC-normalised), with its unit, e.g. "1.88 倍"; dates as YYYY-MM-DD. */
  text: string;
  /** The digits as written, e.g. "1,857" or "1.88". */
  literal: string;
  /** Absolute value (sign is not checked). */
  value: number;
  decimals: number;
  /** Significant digits as written. */
  sig: number;
  /** Unit key ('' when none). */
  unit: string;
  /** Offset in the normalised text. */
  index: number;
  end: number;
}

const DATE_RE = /(?<!\d)(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})(?:\s*日)?(?!\d)/g;
const CODE_RE = /\b(?:GB|TD|CJJ|JGJ|DB)\s*(?:\/\s*T\s*)?\d{3,6}(?:\s*[-—–]\s*\d{4})?/g;
const MASKS: RegExp[] = [
  /https?:\/\/\S+/g, // URLs
  /\d+(?:\.\d+){2,}/g, // clause numbers: 表3.0.4, 附录 C.0.1
  /(?<!\d)\d{1,2}:\d{2}(?::\d{2})?(?!\d)/g, // clock times
  /^[ \t]*\d{1,2}[.、)）](?=\s)/gm, // "1. " list markers
  /[（(]\s*\d{1,2}\s*[)）]/g, // (1) enumerations
  /[[【]\s*T\d+(?:\s*[,，、]\s*T?\d+)*\s*[\]】]/g, // citation markers
];
const NUM_RE = /(?<![A-Za-z0-9_.])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?/g;
const JOIN_RE = /^\s*(?:[-–—~～至到、,，/和与及或]|以及)\s*$/;

const blank = (s: string) => ' '.repeat(s.length);

function sigOfLiteral(literal: string): number {
  return Math.max(1, literal.replace(/[^0-9]/g, '').replace(/^0+/, '').length);
}

function sigOfValue(v: number): number {
  const s = Math.abs(v)
    .toFixed(6)
    .replace(/\.?0+$/, '');
  return Math.max(1, s.replace('.', '').replace(/^0+/, '').length);
}

/** Every number, date and standard code in `text`, with units (propagated across ranges and lists). */
export function extractNumbers(input: string): NumberToken[] {
  let text = input.normalize('NFKC');
  const out: NumberToken[] = [];

  for (const m of text.matchAll(DATE_RE)) {
    const [y, mo, d] = [m[1]!, m[2]!.padStart(2, '0'), m[3]!.padStart(2, '0')];
    const iso = `${y}-${mo}-${d}`;
    out.push({
      kind: 'date',
      text: iso,
      literal: iso,
      value: Number(y),
      decimals: 0,
      sig: 4,
      unit: '',
      index: m.index,
      end: m.index + m[0].length,
    });
    text = text.slice(0, m.index) + blank(m[0]) + text.slice(m.index + m[0].length);
  }
  for (const m of text.matchAll(CODE_RE)) {
    const code = m[0]
      .replace(/\s+/g, ' ')
      .replace(/[—–]/g, '-')
      .replace(/\s*-\s*/, '-')
      .replace(/\s*\/\s*/g, '/');
    out.push({
      kind: 'code',
      text: code,
      literal: code,
      value: 0,
      decimals: 0,
      sig: 0,
      unit: '',
      index: m.index,
      end: m.index + m[0].length,
    });
    text = text.slice(0, m.index) + blank(m[0]) + text.slice(m.index + m[0].length);
  }
  for (const re of MASKS) text = text.replace(re, blank);

  const nums: NumberToken[] = [];
  for (const m of text.matchAll(NUM_RE)) {
    const start = m.index;
    let end = start + m[0].length;
    // "live-123", "S20-1", "BD-09": digits after letter + hyphen belong to an identifier
    if (text[start - 1] === '-' && /[A-Za-z]/.test(text[start - 2] ?? '')) continue;
    const intPart = m[1]!.replace(/,/g, '');
    const frac = m[2] ?? '';
    let value = Number(`${intPart}${frac ? `.${frac}` : ''}`);
    let rest = text.slice(end);
    if (rest.startsWith('万')) {
      value *= 1e4;
      end += 1;
      rest = rest.slice(1);
    }
    const unit = unitAt(rest);
    // "3D", "5G", "1a2b": a letter right after the digits that is not a unit
    if (/^[A-Za-z]/.test(rest) && !unit) continue;
    if (unit) end += unit.length;
    const literal = m[0];
    nums.push({
      kind: 'number',
      text: text.slice(start, end).trim(),
      literal,
      value,
      decimals: frac.length,
      sig: sigOfLiteral(literal),
      unit: unit?.key ?? '',
      index: start,
      end,
    });
  }
  // "5、10、15 分钟", "3.5–6.6%": the unit written once at the end applies to the whole list
  for (let i = nums.length - 2; i >= 0; i--) {
    const cur = nums[i]!;
    const next = nums[i + 1]!;
    if (!cur.unit && next.unit && JOIN_RE.test(text.slice(cur.end, next.index))) cur.unit = next.unit;
  }
  return [...out, ...nums].sort((a, b) => a.index - b.index);
}

// ------------------------------------------------------------------------------------ pool

/** Where numbers may come from: a tool result (id 'T1' …), the question, or anything else. */
export interface NumberSource {
  id: string;
  text?: string;
  facts?: readonly Fact[];
  data?: unknown;
  /** Names whose digits are part of the name (顺和路60弄); also collected from `data`. */
  names?: readonly string[];
}

/** Keys whose string values name things: digits inside them are not numeric claims. */
const NAME_KEYS = new Set([
  'name',
  'label',
  'title',
  'community',
  'via',
  'nearest_straight',
  'stall_of',
  'market_name',
  'center_label',
  'address',
  'place',
  'query',
  'filename',
]);

/** Strings with digits under name-like keys of a tool result (community, facility and place names). */
export function entityNames(data: unknown): string[] {
  const out = new Set<string>();
  const walk = (value: unknown, key: string, depth: number) => {
    if (depth > 16) return;
    if (typeof value === 'string') {
      if (NAME_KEYS.has(key) && /\d/.test(value) && value.length <= 80) out.add(value);
    } else if (Array.isArray(value)) {
      for (const v of value) walk(v, key, depth + 1);
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) if (!SKIP_KEYS.has(k)) walk(v, k, depth + 1);
    }
  };
  walk(data, '', 0);
  return [...out];
}

interface PoolEntry {
  v: number;
  unit: string;
  src: string;
}

interface Pool {
  entries: PoolEntry[];
  dates: Map<string, Set<string>>;
  codes: Map<string, Set<string>>;
  names: Set<string>;
}

/** Heavy geometry and raw sample arrays: never shown to the model, never a source. */
const SKIP_KEYS = new Set([
  'coordinates',
  'geometry',
  'pts',
  'xy',
  't_s',
  'rings',
  'contours',
  'contours_meta',
  'samples',
  'paths',
  'field',
  'base',
  'reach_by_bearing',
]);
const MAX_ENTRIES = 50_000;

/** Domain constants any answer may use (with a unit of the right kind). */
const CONSTANTS: { v: number; unit: string }[] = [
  { v: 5, unit: 'min' },
  { v: 10, unit: 'min' },
  { v: 15, unit: 'min' },
  { v: 300, unit: 'm' },
  { v: 500, unit: 'm' },
  { v: 1000, unit: 'm' },
  { v: 50, unit: 'm' },
  { v: 1.17, unit: 'm/s' },
];
const CONSTANT_CODES = ['GB 50180-2018', 'GB 50180', 'GB50180-2018', 'GB50180'];

function addText(pool: Pool, text: string, src: string): void {
  for (const t of extractNumbers(text)) {
    if (t.kind === 'date') {
      addMark(pool.dates, t.text, src);
      pool.entries.push({ v: Number(t.text.slice(0, 4)), unit: '', src });
    } else if (t.kind === 'code') {
      addMark(pool.codes, normCode(t.text), src);
    } else {
      pool.entries.push({ v: t.value, unit: t.unit, src });
    }
  }
}

function addMark(map: Map<string, Set<string>>, key: string, src: string): void {
  const set = map.get(key) ?? new Set<string>();
  set.add(src);
  map.set(key, set);
}

const normCode = (c: string) => c.replace(/\s+/g, '').toUpperCase();

function addData(
  pool: Pool,
  value: unknown,
  key: string,
  inherited: string,
  src: string,
  depth: number,
): void {
  if (depth > 16 || pool.entries.length > MAX_ENTRIES) return;
  if (typeof value === 'number') {
    if (Number.isFinite(value))
      pool.entries.push({ v: Math.abs(value), unit: unitOfKey(key) || inherited, src });
  } else if (typeof value === 'string') {
    if (/\d/.test(value)) addText(pool, value, src);
  } else if (Array.isArray(value)) {
    for (const v of value) addData(pool, v, key, inherited, src, depth + 1);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (SKIP_KEYS.has(k)) continue;
      addData(pool, v, k, unitOfKey(k) || inherited, src, depth + 1);
    }
  }
}

function buildPool(sources: readonly NumberSource[], constants: boolean): Pool {
  const pool: Pool = { entries: [], dates: new Map(), codes: new Map(), names: new Set() };
  for (const s of sources) {
    for (const n of [...(s.names ?? []), ...entityNames(s.data)]) pool.names.add(n.normalize('NFKC'));
    if (s.text) addText(pool, s.text, s.id);
    for (const f of s.facts ?? []) {
      pool.entries.push({ v: Math.abs(f.value), unit: unitKey(f.unit), src: s.id });
      addText(pool, f.label, s.id);
    }
    if (s.data !== undefined) addData(pool, s.data, '', '', s.id, 0);
  }
  if (constants) {
    for (const c of CONSTANTS) pool.entries.push({ v: c.v, unit: c.unit, src: 'constant' });
    for (const c of CONSTANT_CODES) addMark(pool.codes, normCode(c), 'constant');
  }
  return pool;
}

// -------------------------------------------------------------------------------- matching

/** Values `entry` may be written as, in the token's unit. */
function presentations(entry: PoolEntry, tokenUnit: string): number[] {
  const pf = familyOf(entry.unit);
  const tf = familyOf(tokenUnit);
  if (entry.src === 'constant') {
    // constants only count with a unit of their kind: "15 分钟" yes, a bare "15" no
    return tf === pf ? [(entry.v * scaleOf(entry.unit)) / scaleOf(tokenUnit)] : [];
  }
  if (tf === 'none') return [entry.v];
  // a unitless tool value backs a count ("12 个") or a percentage of a ratio, but never a quantity
  // with a physical unit: "2 倍" or "775 m" must match a value that carries such a unit
  if (pf === 'none') return tf === 'count' ? [entry.v] : tf === 'percent' ? [entry.v * 100] : [];
  if (pf !== tf) return [];
  return [(entry.v * scaleOf(entry.unit)) / scaleOf(tokenUnit)];
}

function matches(token: NumberToken, w: number): boolean {
  const x = token.value;
  if (Math.abs(x - w) <= 1e-9 * Math.max(1, Math.abs(w))) return true;
  if (token.decimals > 3) return false;
  const half = 0.5 * 10 ** -token.decimals;
  if (Math.abs(x - w) > half + 1e-9 * Math.max(1, Math.abs(w))) return false;
  return token.sig >= Math.min(3, sigOfValue(w));
}

function supportOf(token: NumberToken, pool: Pool): Set<string> {
  if (token.kind === 'date') return pool.dates.get(token.text) ?? new Set();
  if (token.kind === 'code') {
    const code = normCode(token.text);
    const out = new Set<string>();
    for (const [k, srcs] of pool.codes)
      if (k === code || k.startsWith(code)) for (const s of srcs) out.add(s);
    return out;
  }
  const out = new Set<string>();
  for (const e of pool.entries) {
    if (out.has(e.src)) continue;
    if (presentations(e, token.unit).some((w) => matches(token, w))) out.add(e.src);
  }
  return out;
}

// ------------------------------------------------------------------------------- citations

const CITE_RE = /[[【]\s*T(\d+)((?:\s*[,，、]\s*T?\d+)*)\s*[\]】]/g;

/** Citation ids per text span: sentences (a "；" does not end one), and whole Markdown tables. */
function citationScopes(text: string): { start: number; end: number; ids: Set<string> }[] {
  const scopes: { start: number; end: number; ids: Set<string> }[] = [];
  const lines = text.split('\n');
  let offset = 0;
  let table: { start: number; end: number } | null = null;
  const flushTable = () => {
    if (table) scopes.push({ ...table, ids: new Set() });
    table = null;
  };
  for (const line of lines) {
    const start = offset;
    const end = offset + line.length;
    offset = end + 1;
    if (/^\s*\|/.test(line)) {
      table = table ? { start: table.start, end } : { start, end };
      continue;
    }
    flushTable();
    let s = start;
    for (const m of line.matchAll(/[。！？!?]+/g)) {
      const e = start + m.index + m[0].length;
      scopes.push({ start: s, end: e, ids: new Set() });
      s = e;
    }
    if (s < end) scopes.push({ start: s, end, ids: new Set() });
  }
  flushTable();
  for (const m of text.matchAll(CITE_RE)) {
    const ids = [`T${m[1]}`, ...[...(m[2] ?? '').matchAll(/\d+/g)].map((d) => `T${d[0]}`)];
    const k = scopes.findIndex((sc) => m.index >= sc.start && m.index < sc.end);
    const scope = scopes[k];
    if (!scope) continue;
    for (const id of ids) scope.ids.add(id);
    // "……80%。[T1]": a marker opening its span belongs to the sentence it follows
    const prev = scopes[k - 1];
    if (prev && !text.slice(scope.start, m.index).trim()) for (const id of ids) prev.ids.add(id);
  }
  // a table's citation may sit in the line right before or after it
  scopes.forEach((sc, i) => {
    if (sc.ids.size || !/^\s*\|/.test(text.slice(sc.start, sc.end))) return;
    for (const near of [scopes[i - 1], scopes[i + 1]]) for (const id of near?.ids ?? []) sc.ids.add(id);
  });
  return scopes;
}

// ---------------------------------------------------------------------------------- report

export interface TokenCheck {
  token: string;
  kind: TokenKind;
  supported: boolean;
  /** Source ids that contain the number ('T1', 'question', 'constant'). */
  sources: string[];
  /** Tool-backed numbers only: was a supporting result cited in the same sentence? */
  cited?: boolean;
}

export interface GroundingReport {
  /** true when every number is backed by a source. */
  ok: boolean;
  /** Numbers found in no source, as written. */
  unsupported: string[];
  /** Numbers checked. */
  checked: number;
  /** Numbers backed by a tool result whose sentence cites none of the results that contain them. */
  uncited: string[];
  details: TokenCheck[];
}

export interface GroundingOptions {
  /** Accept the domain constants (default true). */
  constants?: boolean;
  /** Check [T#] citations of tool-backed numbers (default true). */
  citations?: boolean;
}

const isTool = (id: string) => /^T\d+$/.test(id);

export function checkGrounding(
  text: string,
  sources: readonly NumberSource[],
  opts: GroundingOptions = {},
): GroundingReport {
  const pool = buildPool(sources, opts.constants ?? true);
  // names from the tool results are entities, not quantities: blank them before reading numbers
  let normalised = text.normalize('NFKC');
  for (const name of [...pool.names].sort((a, b) => b.length - a.length)) {
    normalised = normalised.split(name).join(' '.repeat(name.length));
  }
  const tokens = extractNumbers(normalised);
  const scopes = opts.citations === false ? [] : citationScopes(normalised);
  const details: TokenCheck[] = tokens.map((t) => {
    const srcs = [...supportOf(t, pool)];
    const check: TokenCheck = { token: t.text, kind: t.kind, supported: srcs.length > 0, sources: srcs };
    if (opts.citations !== false && srcs.length && srcs.every(isTool)) {
      const scope = scopes.find((sc) => t.index >= sc.start && t.index < sc.end);
      check.cited = !!scope && srcs.some((s) => scope.ids.has(s));
    }
    return check;
  });
  const unsupported = [...new Set(details.filter((d) => !d.supported).map((d) => d.token))];
  const uncited = [...new Set(details.filter((d) => d.cited === false).map((d) => d.token))];
  return { ok: unsupported.length === 0, unsupported, checked: details.length, uncited, details };
}
