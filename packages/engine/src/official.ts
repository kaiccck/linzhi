/**
 * Multi-source POI fusion (技术设计文档 §6.4): an official facility list — 浦东新区商务委's
 * standardized-market evaluation, 浦东教育局's 2026 enrolment list of primary schools, 市卫健委's
 * community health centres — confirms, re-classifies or adds facilities that Baidu's place search
 * mis-tags or misses. The list decides what a facility is; Baidu keeps the say on where its door is
 * (uid, navi_location) whenever the two agree.
 *
 * Found in 申城佳苑 (2026-09-28): 浦商生鲜(申城佳苑店) (孙建路858号, 309 m from the centre) is tagged
 * plain 购物 and never comes back for 菜市场$菜场$农贸市场$生鲜市场; 浦商生鲜(环西店) and 浦商农产品(紫薇店)
 * are tagged 生鲜超市, which the task rule does not count. With the list, the area's 菜市场 gaps drop
 * from 4 to 2.
 *
 * An active entry within the radius is matched to a Baidu row from everything the place searches
 * returned (before cleaning, so plain-购物 rows count too): same name key or same street address
 * (road and number, 号 or 弄), within a category's radius of the geocoded point, never a market stall
 * and never a row of an unrelated category (a pharmacy in the market's building is not the market).
 * Name keys by category: a market's branch (浦商生鲜(申城佳苑店) ↔ 浦商生鲜申城佳苑店), a school's name and
 * campus (孙桥小学(张江校区) ↔ 上海市浦东新区孙桥小学（张江校区）, 校区/分校 spellings folded), a health
 * centre's name without region. School and centre names are unique within a district, so a name
 * alone may match farther out (big campuses, geocoded doors). Unmatched, an entry is added at its
 * geocoded address. Inactive entries (装修改造, 业态调整, 特殊教育 …) change nothing.
 */
import { parseAddress, type PlacePoi } from '@zoudedao/baidu';
import {
  categorize,
  healthKey,
  roadNumber,
  schoolKey,
  type DroppedPoi,
  type FacilityCategory,
  type LngLat,
  type LocalFrame,
  type Poi,
} from '@zoudedao/core';

import { r1 } from './round.js';

/** One facility of an official list (data/official/*.json). */
export interface OfficialEntry {
  rank?: number;
  seq?: number;
  town?: string;
  /** Official name, e.g. 浦商生鲜申城佳苑店, 上海市浦东新区孙桥小学（张江校区）. */
  name: string;
  /** Street address as published, e.g. 孙建路858号. */
  address?: string;
  score?: number;
  /** 'active' = in service; anything else (装修改造, 业态调整, 特殊教育 …) is never added. */
  status: string;
  /** Geocoded point of the address, BD-09. */
  bd09?: LngLat;
  /** Baidu geocoding flags of bd09; trusted only when precise at 门址 / 楼号 level. */
  geocode?: { precise: boolean; confidence?: number | null; level?: string | null; query?: string };
  /** Schools list: 学校代码, school and campus as published, 公办/民办, 对口招生范围, 新开办 … */
  code?: string;
  school?: string;
  campus?: string;
  sector?: string;
  catchment?: string;
  opened?: string;
  /** Towns of the school's 2025 地段 (geocoding order only). */
  catchment_towns?: string[];
  /** Health list: the full published address when it names several sites. */
  address_full?: string;
}

/** An official facility list as stored in data/official/*.json; the server reads files, the engine does not. */
export interface OfficialList {
  id: string;
  /** Absent or 'facilities' for facility lists (catchment tables and exclusions have their own kinds). */
  kind?: 'facilities';
  /** What every entry is, e.g. 菜市场. */
  category: FacilityCategory;
  title: string;
  publisher: string;
  published: string;
  url: string;
  retrieved?: string;
  region: { city: string; district?: string };
  note?: string;
  counts?: Record<string, number>;
  entries: OfficialEntry[];
}

/** Per-list outcome within one analysis (stats.official). */
export interface OfficialSummary {
  list: string;
  category: FacilityCategory;
  /** Active entries within the radius. */
  in_range: number;
  /** Matched a Baidu POI Baidu already put in the list's category. */
  confirmed: number;
  /** Matched a Baidu POI Baidu classified otherwise (生鲜超市, plain 购物 …): re-classified. */
  reclassified: number;
  /** Not among Baidu's results: added at the geocoded official address. */
  added: number;
  /** Of `added`, entries whose address geocoded imprecisely. */
  imprecise: number;
  /** Inactive entries within range (never used). */
  inactive_in_range: number;
  /** Active entries of the list without coordinates yet (never used, wherever they are). */
  ungeocoded?: number;
}

export interface FusionResult {
  pois: Poi[];
  dropped: DroppedPoi[];
  summaries: OfficialSummary[];
  /** One Chinese line per list that had anything in range (meta.notes). */
  notes: string[];
  /** Publisher, title, date and URL of every list used (meta.attribution). */
  attribution: string[];
  warnings: string[];
}

/** Match radius around the geocoded point; up to MAX when name and street address both agree. */
export const OFFICIAL_MATCH_M = 250;
export const OFFICIAL_MATCH_MAX_M = 400;

/** Radii by what agrees, per category (metres). Schools and health centres have district-unique names. */
export interface MatchRadii {
  name: number;
  street: number;
  both: number;
}

const DEFAULT_RADII: MatchRadii = {
  name: OFFICIAL_MATCH_M,
  street: OFFICIAL_MATCH_M,
  both: OFFICIAL_MATCH_MAX_M,
};

export const OFFICIAL_MATCH_RADII: Readonly<Partial<Record<FacilityCategory, MatchRadii>>> = {
  小学: { name: 800, street: OFFICIAL_MATCH_M, both: 1000 },
  社区卫生: { name: 600, street: OFFICIAL_MATCH_M, both: 800 },
};

export const radiiOf = (cat: FacilityCategory): MatchRadii => OFFICIAL_MATCH_RADII[cat] ?? DEFAULT_RADII;

const KNOWN: ReadonlySet<FacilityCategory> = new Set<FacilityCategory>([
  '小学',
  '菜市场',
  '药店',
  '生鲜超市',
  '幼儿园',
  '社区卫生',
  '养老',
  '超市',
  '公交',
  '地铁',
  '公园',
]);

/** Measure word of a category in the Chinese notes (家 for the rest: markets, pharmacies, 社区卫生 …). */
const MEASURE: Partial<Record<FacilityCategory, string>> = { 小学: '所', 幼儿园: '所', 社区卫生: '家' };
const measureOf = (cat: FacilityCategory) => MEASURE[cat] ?? '家';

/** Baidu categories a listed facility may hide under ('其他' = no category, e.g. a plain 购物 tag). */
function compatible(cat: FacilityCategory): ReadonlySet<FacilityCategory> {
  if (cat === '菜市场' || cat === '生鲜超市')
    return new Set<FacilityCategory>(['菜市场', '生鲜超市', '超市', '其他']);
  return new Set<FacilityCategory>([cat, '其他']);
}

// brand and format words go, the branch name stays: 浦商生鲜(申城佳苑店) → 申城佳苑
const BRAND_WORDS =
  /浦商生鲜|浦商邻里荟|浦商菜市场|浦商农产品|清美鲜家|生鲜|邻里荟|菜市场|菜场|农贸市场|集贸市场|市场|集市|店/g;

/** Branch name of a market-like name: 浦商生鲜(申城佳苑店) and 浦商生鲜申城佳苑店 both → 申城佳苑. */
export function branchToken(name: string): string {
  return name
    .normalize('NFKC')
    .replace(/[()[\]【】\s·・.]/g, '')
    .replace(BRAND_WORDS, '');
}

/** The key two names of one facility share, by the list's category (module comment). */
export function officialNameKey(name: string, category: FacilityCategory): string {
  if (category === '菜市场' || category === '生鲜超市') return branchToken(name);
  if (category === '小学' || category === '幼儿园') return schoolKey(name).key;
  if (category === '社区卫生') return healthKey(name);
  return healthKey(name);
}

/** Street and number only: 上海市浦东新区孙建路858号(近孙环路) → 孙建路858号; null without a number. */
export function streetAddress(address: string | null | undefined): string | null {
  if (!address) return null;
  const text = address
    .normalize('NFKC')
    .replace(/\([^)]*\)/g, '')
    .replace(/\s/g, '');
  const m = /^(.*?\d[\d\-－—]*号)/.exec(parseAddress(text).core);
  return m ? m[1]! : null;
}

/** Same site by address: equal street and number, or the same road and number as 号 on one side and 弄 on the other. */
export function sameStreet(a: string | null | undefined, b: string | null | undefined): boolean {
  const sa = streetAddress(a);
  if (sa !== null && sa === streetAddress(b)) return true;
  const ra = roadNumber(a);
  return ra !== null && ra === roadNumber(b);
}

const precise = (e: OfficialEntry) =>
  !e.geocode || (e.geocode.precise && (e.geocode.level === '门址' || e.geocode.level === '楼号'));

export function fuseOfficial(args: {
  lists: readonly OfficialList[];
  pois: readonly Poi[];
  dropped: readonly DroppedPoi[];
  /** Every row the place searches returned, before cleaning. */
  pool: readonly PlacePoi[];
  frame: LocalFrame;
  radius_m: number;
  /** District of the analysis, when known: a list of that district reports its entries without coordinates. */
  district?: string | undefined;
}): FusionResult {
  const { frame } = args;
  const pois = args.pois.map((p) => ({ ...p }));
  let dropped = args.dropped.slice();
  const byUid = new Map(pois.map((p) => [p.uid, p]));
  const survivor = new Map<string, Poi>();
  for (const p of pois) for (const m of p.merged_uids ?? []) survivor.set(m, p);
  const rows = new Map<string, PlacePoi>();
  for (const r of args.pool) if (r.uid && !rows.has(r.uid)) rows.set(r.uid, r);
  const claimed = new Set<string>();
  const summaries: OfficialSummary[] = [];
  const notes: string[] = [];
  const attribution: string[] = [];
  const warnings: string[] = [];

  for (const list of args.lists) {
    if (!KNOWN.has(list.category)) {
      warnings.push(`名录 ${list.id} 的类别“${list.category}”无法识别，未使用`);
      continue;
    }
    const ok = compatible(list.category);
    const radii = radiiOf(list.category);
    const s: OfficialSummary = {
      list: list.id,
      category: list.category,
      in_range: 0,
      confirmed: 0,
      reclassified: 0,
      added: 0,
      imprecise: 0,
      inactive_in_range: 0,
    };
    const ungeocoded = list.entries.filter((e) => !e.bd09 && e.status === 'active').length;
    if (ungeocoded) s.ungeocoded = ungeocoded;
    const from = new Set<string>();
    const inactive = new Set<string>();
    list.entries.forEach((e, index) => {
      if (!e.bd09) return;
      const xy = frame.toXY(e.bd09[0], e.bd09[1]);
      if (Math.hypot(xy[0], xy[1]) > args.radius_m) return;
      if (e.status !== 'active') {
        s.inactive_in_range++;
        inactive.add(e.status);
        return;
      }
      s.in_range++;
      const official: NonNullable<Poi['official']> = {
        list: list.id,
        name: e.name,
        ...(e.address ? { address: e.address } : {}),
      };

      // the best Baidu row for the entry
      const token = officialNameKey(e.name, list.category);
      let best: { row: PlacePoi; score: number; d: number } | null = null;
      for (const [uid, row] of rows) {
        if (claimed.has(uid)) continue;
        const [x, y] = frame.toXY(row.location[0], row.location[1]);
        const d = Math.hypot(x - xy[0], y - xy[1]);
        if (d > radii.both) continue;
        const cleaned = byUid.get(uid) ?? survivor.get(uid);
        if (cleaned?.stall_of) continue; // a stall is never the market itself
        const cat = cleaned?.cat ?? categorize(row.name, row.classifiedTag ?? row.tag ?? '').cat;
        if (!ok.has(cat)) continue;
        const byName = token.length >= 2 && officialNameKey(row.name, list.category) === token;
        const byStreet = sameStreet(e.address, row.address);
        if (!(byName || byStreet)) continue;
        if (d > (byName && byStreet ? radii.both : byName ? radii.name : radii.street)) continue;
        const score = (byName && byStreet ? 2 : 1) + (cat === list.category ? 0.5 : 0) - d / 1e4;
        if (!best || score > best.score) best = { row, score, d };
      }

      if (best) {
        const uid = best.row.uid!;
        claimed.add(uid);
        const target = byUid.get(uid) ?? survivor.get(uid);
        if (target) {
          if (target.cat === list.category) {
            target.official = official;
            s.confirmed++;
          } else {
            target.official = { ...official, reclassified_from: target.cat };
            from.add(target.cat);
            target.cat = list.category;
            s.reclassified++;
          }
          return;
        }
        // returned by Baidu but dropped in cleaning (no usable tag): back in, under the list's category
        const row = best.row;
        const tag = row.classifiedTag ?? row.tag ?? '';
        const was = tag.split(';')[0] || '其他';
        const [x, y] = frame.toXY(row.location[0], row.location[1]);
        const navi = row.naviLocation ? frame.toXY(row.naviLocation[0], row.naviLocation[1]) : null;
        const poi: Poi = {
          uid,
          name: row.name,
          cat: list.category,
          ...(tag ? { tag } : {}),
          xy: [r1(x), r1(y)],
          navi_xy: navi ? [r1(navi[0]), r1(navi[1])] : null,
          source: 'baidu',
          ...(row.parentId ? { parent_uid: row.parentId } : {}),
          straight_m: r1(Math.hypot(x, y)),
          official: { ...official, reclassified_from: was },
        };
        pois.push(poi);
        byUid.set(uid, poi);
        dropped = dropped.filter((d) => d.uid !== uid);
        from.add(was);
        s.reclassified++;
        return;
      }

      pois.push({
        uid: `gov:${list.id}:${index}`,
        name: e.name,
        cat: list.category,
        xy: [r1(xy[0]), r1(xy[1])],
        navi_xy: null,
        source: 'gov',
        straight_m: r1(Math.hypot(xy[0], xy[1])),
        official,
      });
      s.added++;
      if (!precise(e)) {
        s.imprecise++;
        const level = e.geocode?.level ? `“${e.geocode.level}”级` : '未知精度';
        const flag = e.geocode?.precise === false ? '（非精确）' : '';
        warnings.push(
          `${list.category}名录：${e.name}${e.address ? `（${e.address}）` : ''}的官方地址只定位到${level}${flag}，补充的点位可能有偏差`,
        );
      }
    });

    summaries.push(s);
    const sameDistrict = !args.district || !list.region.district || list.region.district === args.district;
    const missing = ungeocoded && sameDistrict ? `名录中另有 ${ungeocoded} 条尚无坐标，没有参与融合。` : '';
    if (!s.in_range && !s.inactive_in_range) {
      if (missing) {
        notes.push(
          `${list.category}名录（${list.publisher}《${list.title}》）：范围内没有已定位的条目；${missing}`,
        );
        attribution.push(`${list.publisher}《${list.title}》（${list.published}）：${list.url}`);
      }
      continue;
    }
    const m = measureOf(list.category);
    const fromText = [...from].map((c) => (c === '其他' ? '其他类别' : c)).join('或') || '其他类别';
    const rest = s.inactive_in_range
      ? `；另有 ${s.inactive_in_range} ${m}${[...inactive].join('、')}，未计入`
      : '';
    notes.push(
      `${list.category}名录（${list.publisher}《${list.title}》）：范围内 ${s.in_range} ${m}，与百度 POI 一致 ${s.confirmed} ${m}，` +
        `百度标为${fromText}而改类 ${s.reclassified} ${m}，百度检索未返回、按官方地址补充 ${s.added} ${m}${rest}。${missing}`,
    );
    attribution.push(`${list.publisher}《${list.title}》（${list.published}）：${list.url}`);
  }
  return { pois, dropped, summaries, notes, attribution, warnings };
}
