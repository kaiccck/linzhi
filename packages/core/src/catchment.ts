/**
 * 对口小学 (primary-school catchment): which public primary school a compound is assigned to by the
 * district's 招生地段 table, e.g. 浦东新区教育局《2025年浦东新区公办小学招生地段公示》 (data/official/
 * pudong-catchment-2025.json). The assigned school is often not the nearest one: all twelve compounds of
 * the 申城佳苑 sample go to 孙桥小学, whatever lies closer.
 *
 * A compound is matched by, in this order:
 *   lane   its 弄号 (from the name or the Baidu address): 顺和路60弄, 益江路286弄小区
 *   name   the table's 小区名称 after normalisation: 孙桥黄浦花园 ↔ 黄浦花园, 玉兰香苑3期 ↔ 玉兰香苑三期,
 *          玉兰香苑一期A组 ↔ 玉兰香苑一期A块, 樟盛苑社区 ↔ 樟盛苑
 *   phase  a name with fewer qualifiers than the table's: 玉兰香苑-二期 ↔ 玉兰香苑二期A块/B块/C块,
 *          张江玉兰香苑-B块 ↔ 玉兰香苑一期B块/二期B块
 *   base   the name without 期/块/区 when nothing matched with them: 川杨新苑-南区 ↔ 川杨新苑一期…六期
 * and only when every matching row assigns the same school; otherwise the compound stays unmatched
 * (ambiguous). Rows marked 已动迁 have no residents and are skipped.
 */
import type { XY } from './coords.js';
import { foldName, laneKey, schoolKey, stripRegion } from './names.js';
import type { Poi } from './types.js';

export interface CatchmentEntry {
  /** 序号 in the published table. */
  seq?: number;
  /** 对口地段: a lane (孙环路177弄), a door (张江路689号) or a village (韩荡村). */
  lane: string;
  /** 小区名称, when the table gives one. */
  compound?: string;
  /** 情况说明: 已动迁, 单号, 信息变更 … */
  note?: string;
}

export interface CatchmentSchool {
  /** As published, campus in brackets when the table names one: 上海市浦东新区第二中心小学（张江校区）. */
  school: string;
  entries: CatchmentEntry[];
}

/** A catchment table as stored in data/official/*.json (kind: 'catchment'). */
export interface CatchmentList {
  id: string;
  kind: 'catchment';
  title: string;
  publisher: string;
  published: string;
  url: string;
  retrieved?: string;
  region: { city: string; district?: string };
  /**
   * What the stored rows cover: `towns` = every row whose 对口地段所属街镇 is one of these was transcribed;
   * `name_prefixes` = place names compound names often start with (孙桥黄浦花园 for 黄浦花园).
   */
  coverage?: { towns?: string[]; name_prefixes?: string[] };
  note?: string;
  counts?: Record<string, number>;
  schools: CatchmentSchool[];
}

export type CatchmentMethod = 'lane' | 'name' | 'phase' | 'base';

export interface CatchmentHit {
  school: string;
  method: CatchmentMethod;
  /** Rows behind the match, all assigning `school`. */
  entries: CatchmentEntry[];
  /** `method:detail`, e.g. lane:顺和路60弄, name:申城佳苑一期A块, phase:玉兰香苑二期A块/玉兰香苑二期B块. */
  matched_by: string;
}

export interface CatchmentMiss {
  /** none: no row names the compound; ambiguous: rows of different schools do. */
  reason: 'none' | 'ambiguous';
  schools?: string[];
  method?: CatchmentMethod;
}

/** Does the list cover a place (reverse-geocoded city / district / town)? */
export function catchmentCovers(
  list: Pick<CatchmentList, 'region' | 'coverage'>,
  region: { city?: string; district?: string; town?: string } | null | undefined,
): boolean {
  if (!region) return false;
  if (list.region.city && region.city && region.city !== list.region.city) return false;
  if (list.region.district && region.district !== list.region.district) return false;
  const towns = list.coverage?.towns;
  return !towns?.length || (!!region.town && towns.includes(region.town));
}

const DIGITS: Record<string, string> = {
  '1': '一',
  '2': '二',
  '3': '三',
  '4': '四',
  '5': '五',
  '6': '六',
  '7': '七',
  '8': '八',
  '9': '九',
  '10': '十',
  I: '一',
  II: '二',
  III: '三',
  IV: '四',
  V: '五',
  VI: '六',
  VII: '七',
  VIII: '八',
  IX: '九',
  X: '十',
};

export interface CompoundParts {
  /** Place-name prefix that was stripped (孙桥 of 孙桥黄浦花园), else null. */
  prefix: string | null;
  /** Name without prefix, 期 and block, e.g. 玉兰香苑. */
  base: string;
  /** 二期 … */
  phase: string | null;
  /** B块, 南区 … */
  block: string | null;
  /** base + phase + block. */
  full: string;
}

/**
 * 张江玉兰香苑-二期 → 玉兰香苑 / 二期; 玉兰香苑一期A组 → 玉兰香苑 / 一期 / A块; 万科翡翠公园-I期 → 万科翡翠公园 / 一期.
 * `prefixes` are place names stripped from the front (张江镇, 张江, 孙桥 …); region prefixes always go,
 * and so does a trailing 社区 / 小区.
 */
export function compoundParts(name: string, prefixes: readonly string[] = []): CompoundParts {
  let s = foldName(name)
    .toUpperCase()
    .replace(/[()\-－—_,，、.。:：'"]/g, '');
  s = s.replace(/(\d{1,2}|X|IX|VI{0,3}|IV|I{1,3})期/g, (_m, n: string) => `${DIGITS[n] ?? n}期`);
  s = s.replace(/([A-Z])(?:块|组|区)/g, '$1块');
  s = stripRegion(s);
  let prefix: string | null = null;
  for (const p of [...prefixes].sort((a, b) => b.length - a.length)) {
    if (s.startsWith(p) && s.length - p.length >= 2) {
      prefix = p.replace(/(?:镇|街道|乡)$/, '');
      s = s.slice(p.length);
      break;
    }
  }
  const tail = /(?:社区|小区)$/.exec(s);
  if (tail && s.length - tail[0].length >= 2) s = s.slice(0, -tail[0].length);
  const m = /^(.+?)([一二三四五六七八九十]+期)?([A-Z]块|[东南西北中]区)?$/.exec(s);
  const base = m?.[1] ?? s;
  const phase = m?.[2] ?? null;
  const block = m?.[3] ?? null;
  return { prefix, base, phase, block, full: `${base}${phase ?? ''}${block ?? ''}` };
}

/** Same place prefix, or one side without any: 孙桥黄浦花园 ↔ 黄浦花园, but not 张江公寓 ↔ 孙桥公寓. */
const samePrefix = (a: CompoundParts, b: CompoundParts) => !a.prefix || !b.prefix || a.prefix === b.prefix;

interface Row {
  school: string;
  entry: CatchmentEntry;
  parts: CompoundParts | null;
  lane: string | null;
  /** Village or street without a number: its name can match a compound's. */
  place: CompoundParts | null;
}

const RELOCATED = /已动迁/;

function rows(list: CatchmentList): Row[] {
  const prefixes = namePrefixes(list);
  const out: Row[] = [];
  for (const s of list.schools) {
    for (const entry of s.entries) {
      if (entry.note && RELOCATED.test(entry.note)) continue;
      const lane = laneKey(entry.lane);
      out.push({
        school: s.school,
        entry,
        parts: entry.compound ? compoundParts(entry.compound, prefixes) : null,
        lane,
        place:
          !entry.compound && !lane && !/\d/.test(entry.lane) ? compoundParts(entry.lane, prefixes) : null,
      });
    }
  }
  return out;
}

function namePrefixes(list: Pick<CatchmentList, 'coverage'>): string[] {
  const out = new Set<string>(list.coverage?.name_prefixes ?? []);
  for (const t of list.coverage?.towns ?? []) {
    out.add(t);
    const short = t.replace(/(?:镇|街道|乡)$/, '');
    if (short.length >= 2) out.add(short);
  }
  return [...out];
}

const label = (r: Row) => r.entry.compound || r.entry.lane;

function decide(method: CatchmentMethod, found: Row[], detail: string): CatchmentHit | CatchmentMiss | null {
  if (!found.length) return null;
  const schools = [...new Set(found.map((r) => r.school))];
  if (schools.length > 1) return { reason: 'ambiguous', schools, method };
  return {
    school: schools[0]!,
    method,
    entries: found.map((r) => r.entry),
    matched_by: `${method}:${detail}`,
  };
}

const uniqueLabels = (found: Row[]) => [...new Set(found.map(label))].join('/');

/**
 * The school a compound is assigned to, by lane, name, phase or base name (module comment), or why not.
 * `address` is the compound's street address when known (Baidu's POI address), searched for a 弄号 too.
 */
export function matchCatchment(
  list: CatchmentList,
  name: string,
  address?: string | null,
): CatchmentHit | CatchmentMiss {
  const all = rows(list);
  for (const text of [name, address]) {
    const lane = laneKey(text);
    if (!lane) continue;
    const hit = decide(
      'lane',
      all.filter((r) => r.lane === lane),
      lane,
    );
    if (hit) return hit;
  }
  const me = compoundParts(name, namePrefixes(list));
  const of = (r: Row) => (r.parts ?? r.place)!;
  const named = all.filter((r) => (r.parts ?? r.place) && samePrefix(of(r), me));
  const exact = named.filter((r) => of(r).full === me.full);
  const byName = decide('name', exact, uniqueLabels(exact));
  if (byName) return byName;
  if (me.phase || me.block) {
    const partial = named.filter((r) => {
      const p = of(r);
      return (
        p.base === me.base &&
        (!me.phase || p.phase === me.phase) &&
        (!me.block || p.block === me.block) &&
        (p.phase !== null || p.block !== null)
      );
    });
    const byPhase = decide('phase', partial, uniqueLabels(partial));
    if (byPhase) return byPhase;
  }
  const base = named.filter((r) => of(r).base === me.base);
  return decide('base', base, uniqueLabels(base)) ?? { reason: 'none' };
}

export const isCatchmentHit = (m: CatchmentHit | CatchmentMiss): m is CatchmentHit => 'school' in m;

export interface SchoolSite {
  /** Official name when a list confirmed the POI, else the POI name. */
  name: string;
  /** `name` comes from an official list (the POI's confirmation, or a geocoded list entry). */
  official?: boolean;
  uid?: string;
  /** School point (the four-state straight line is measured to it). */
  xy: XY;
  /** Where to route to: the entrance when known. */
  route_xy: XY;
}

/**
 * The campuses of an assigned school among the facility POIs (by school key on the official name, then
 * the Baidu name), else among `extra` (e.g. geocoded official-list entries). A school the table names
 * without a campus (上海市浦东新区孙桥小学) yields every campus found.
 */
export function schoolCampuses(
  school: string,
  pois: readonly Poi[],
  /** Geocoded official-list schools, used only when no POI is a campus of the school. */
  extra: readonly { name: string; xy: XY; uid?: string }[] = [],
): SchoolSite[] {
  const want = schoolKey(school);
  const same = (n: string | undefined) => {
    if (!n) return false;
    const k = schoolKey(n);
    return k.base === want.base && (want.campus === null || k.campus === want.campus);
  };
  const out: SchoolSite[] = [];
  for (const p of pois) {
    if (p.cat !== '小学' || p.stall_of) continue;
    if (!same(p.official?.name) && !same(p.name)) continue;
    out.push({
      name: p.official?.name ?? p.name,
      ...(p.official ? { official: true } : {}),
      uid: p.uid,
      xy: p.xy,
      route_xy: p.navi_xy ?? p.xy,
    });
  }
  if (out.length) return out;
  for (const e of extra) {
    if (!same(e.name)) continue;
    out.push({ name: e.name, official: true, ...(e.uid ? { uid: e.uid } : {}), xy: e.xy, route_xy: e.xy });
  }
  return out;
}
