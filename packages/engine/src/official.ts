/**
 * Multi-source POI fusion (技术设计文档 §6.4): an official facility list — e.g. 浦东新区商务委's
 * standardized-market evaluation — confirms, re-classifies or adds facilities that Baidu's place search
 * mis-tags or misses. The list decides what a facility is; Baidu keeps the say on where its door is
 * (uid, navi_location) whenever the two agree.
 *
 * Found in 申城佳苑 (2026-09-28): 浦商生鲜(申城佳苑店) (孙建路858号, 309 m from the centre) is tagged
 * plain 购物 and never comes back for 菜市场$菜场$农贸市场$生鲜市场; 浦商生鲜(环西店) and 浦商农产品(紫薇店)
 * are tagged 生鲜超市, which the task rule does not count. With the list, the area's 菜市场 gaps drop
 * from 4 to 2.
 *
 * An active entry within the facility radius is matched to a Baidu row from everything the place
 * searches returned (before cleaning, so plain-购物 rows count too): same branch token or same street
 * address, within 250 m of the geocoded point (400 m when both agree), never a market stall and never
 * a row of an unrelated category (a pharmacy in the market's building is not the market). Unmatched,
 * it is added at its geocoded address. Inactive entries (装修改造, 业态调整 …) change nothing.
 */
import { parseAddress, type PlacePoi } from '@zoudedao/baidu';
import {
  categorize,
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
  town?: string;
  /** Official name, e.g. 浦商生鲜申城佳苑店. */
  name: string;
  /** Street address as published, e.g. 孙建路858号. */
  address?: string;
  score?: number;
  /** 'active' = in service; anything else (装修改造, 业态调整 …) is never added. */
  status: string;
  /** Geocoded point of the address, BD-09. */
  bd09?: LngLat;
  /** Baidu geocoding flags of bd09; trusted only when precise at 门址 / 楼号 level. */
  geocode?: { precise: boolean; confidence?: number | null; level?: string | null; query?: string };
}

/** An official facility list as stored in data/official/*.json; the server reads files, the engine does not. */
export interface OfficialList {
  id: string;
  /** What every entry is, e.g. 菜市场. */
  category: FacilityCategory;
  title: string;
  publisher: string;
  published: string;
  url: string;
  retrieved?: string;
  region: { city: string; district?: string };
  note?: string;
  counts?: { listed: number; active: number };
  entries: OfficialEntry[];
}

/** Per-list outcome within one analysis (stats.official). */
export interface OfficialSummary {
  list: string;
  category: FacilityCategory;
  /** Active entries within the facility radius. */
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

/** Match radius around the geocoded point; up to MAX when branch name and street address both agree. */
export const OFFICIAL_MATCH_M = 250;
export const OFFICIAL_MATCH_MAX_M = 400;

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
      const token = branchToken(e.name);
      const street = streetAddress(e.address);
      let best: { row: PlacePoi; score: number; d: number } | null = null;
      for (const [uid, row] of rows) {
        if (claimed.has(uid)) continue;
        const [x, y] = frame.toXY(row.location[0], row.location[1]);
        const d = Math.hypot(x - xy[0], y - xy[1]);
        if (d > OFFICIAL_MATCH_MAX_M) continue;
        const cleaned = byUid.get(uid) ?? survivor.get(uid);
        if (cleaned?.stall_of) continue; // a stall is never the market itself
        const cat = cleaned?.cat ?? categorize(row.name, row.classifiedTag ?? row.tag ?? '').cat;
        if (!ok.has(cat)) continue;
        const byName = token.length >= 2 && branchToken(row.name) === token;
        const byStreet = street !== null && streetAddress(row.address) === street;
        if (!(byName || byStreet) || d > (byName && byStreet ? OFFICIAL_MATCH_MAX_M : OFFICIAL_MATCH_M))
          continue;
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
    if (!s.in_range && !s.inactive_in_range) continue;
    const fromText = [...from].join('或') || '其他类别';
    const rest = s.inactive_in_range
      ? `；另有 ${s.inactive_in_range} 家${[...inactive].join('、')}，未计入`
      : '';
    notes.push(
      `${list.category}名录（${list.publisher}《${list.title}》）：范围内 ${s.in_range} 家，与百度 POI 一致 ${s.confirmed} 家，` +
        `百度标为${fromText}而改类 ${s.reclassified} 家，百度检索未返回、按官方地址补充 ${s.added} 家${rest}。`,
    );
    attribution.push(`${list.publisher}《${list.title}》（${list.published}）：${list.url}`);
  }
  return { pois, dropped, summaries, notes, attribution, warnings };
}
