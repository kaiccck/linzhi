/**
 * Curated exclusions (data/official/exclusions.json): Baidu POIs an official source shows are not a
 * facility of their category, e.g. 上海市浦东新区育华学校(雪英校区), tagged 教育培训;小学 by Baidu but not
 * among the schools that enrol first-graders in 2026 — or whole brands by a name pattern, e.g. the
 * 前置仓 of online grocers (叮咚买菜(孙桥站)) that Baidu tags 购物;超市;生鲜超市, which would otherwise
 * stand in as a 买菜替代. Applied after cleaning and official-list fusion; every entry names
 * its reason, source and the date it was checked.
 */
import { normalizeName } from './poi.js';
import type { FacilityCategory, Poi } from './types.js';

export interface FacilityExclusion {
  /**
   * The category the POI must have for a name or name_pattern entry to apply, or several (a brand's
   * stations may be tagged 生鲜超市, 超市 or 菜市场). uid entries apply whatever the category.
   */
  category: FacilityCategory | readonly FacilityCategory[];
  /** Baidu uid; the POI (or one it absorbed as a duplicate) with this uid is excluded. */
  uid?: string;
  /** Name as Baidu spells it; without a uid, a POI of the category with this normalised name is excluded. */
  name?: string;
  /**
   * JavaScript regular expression (compiled with the `u` flag) over the POI name after NFKC
   * normalisation, so full-width brackets and letters read as half-width: "叮咚买菜（孙桥站）" is
   * tested as "叮咚买菜(孙桥站)". Without a uid, every POI of the category whose name matches is
   * excluded. Only for points that are provably no facility (pickup stations, delivery warehouses);
   * never for real stores.
   */
  name_pattern?: string;
  address?: string;
  /** Why, in Chinese (shown in meta.notes). */
  reason: string;
  /** Where the fact comes from (URL of the official page). */
  source: string;
  /** Date the exclusion was checked, YYYY-MM-DD. */
  date: string;
}

/** data/official/exclusions.json. */
export interface ExclusionList {
  id: string;
  kind: 'exclusions';
  title?: string;
  note?: string;
  entries: FacilityExclusion[];
}

export interface ExcludedPoi {
  uid: string;
  name: string;
  /** The category the POI was counted as. */
  category: FacilityCategory;
  reason: string;
  source: string;
  date: string;
  /** The name_pattern that matched, for pattern exclusions. */
  pattern?: string;
}

/** The categories an entry applies to. */
export function exclusionCategories(x: Pick<FacilityExclusion, 'category'>): readonly FacilityCategory[] {
  return typeof x.category === 'string' ? [x.category] : x.category;
}

const compiled = new Map<string, RegExp | null>();

/** The compiled name_pattern (u flag), or null when it is no valid regular expression. */
export function exclusionPattern(source: string): RegExp | null {
  let re = compiled.get(source);
  if (re === undefined) {
    try {
      re = new RegExp(source, 'u');
    } catch {
      re = null;
    }
    compiled.set(source, re);
  }
  return re;
}

/** Does the entry's name_pattern match the name (NFKC-normalised)? False without a valid pattern. */
export function matchesNamePattern(x: Pick<FacilityExclusion, 'name_pattern'>, name: string): boolean {
  if (!x.name_pattern) return false;
  const re = exclusionPattern(x.name_pattern);
  return !!re && re.test(name.normalize('NFKC'));
}

/**
 * Does the exclusion name this POI? By uid (merged duplicates included); else, for a POI of one of
 * its categories, by name_pattern or by normalised name.
 */
export function excludes(
  x: FacilityExclusion,
  p: Pick<Poi, 'uid' | 'name' | 'cat' | 'merged_uids'>,
): boolean {
  if (x.uid) return p.uid === x.uid || !!p.merged_uids?.includes(x.uid);
  if (!exclusionCategories(x).includes(p.cat)) return false;
  if (x.name_pattern) return matchesNamePattern(x, p.name);
  return !!x.name && normalizeName(p.name) === normalizeName(x.name);
}

/**
 * A pattern entry that names this place whatever its category: for raw search rows, before they are
 * categorised (official lists must never "confirm" a delivery warehouse as a market).
 */
export function excludedByPattern(
  name: string,
  exclusions: readonly FacilityExclusion[],
): FacilityExclusion | undefined {
  return exclusions.find((x) => !x.uid && !!x.name_pattern && matchesNamePattern(x, name));
}

/**
 * Why an entry of an exclusion list cannot be used, in Chinese, or null when it can: a category (or a
 * non-empty list of them), a uid, name or valid name_pattern, and a reason, source and date.
 */
export function exclusionProblem(e: unknown): string | null {
  const x = (typeof e === 'object' && e !== null ? e : {}) as Record<string, unknown>;
  const cats = x.category;
  const catOk =
    typeof cats === 'string'
      ? cats.length > 0
      : Array.isArray(cats) && cats.length > 0 && cats.every((c) => typeof c === 'string' && c.length > 0);
  if (!catOk) return '缺少 category（类别，或类别数组）';
  const has = (k: string) => typeof x[k] === 'string' && (x[k] as string).length > 0;
  if (!has('uid') && !has('name') && !has('name_pattern')) return '缺少 uid、name 或 name_pattern';
  if (
    x.name_pattern !== undefined &&
    (typeof x.name_pattern !== 'string' || !exclusionPattern(x.name_pattern))
  )
    return `name_pattern 不是有效的正则表达式：${String(x.name_pattern)}`;
  if (!has('reason') || !has('source')) return '缺少 reason 或 source（每条都要写明理由与来源）';
  if (!has('date')) return '缺少核实日期 date（YYYY-MM-DD）';
  return null;
}

/** The POIs without the excluded ones, and what was excluded why. The input is left alone. */
export function applyExclusions(
  pois: readonly Poi[],
  exclusions: readonly FacilityExclusion[],
): { pois: Poi[]; excluded: ExcludedPoi[] } {
  if (!exclusions.length) return { pois: pois.slice(), excluded: [] };
  const kept: Poi[] = [];
  const excluded: ExcludedPoi[] = [];
  for (const p of pois) {
    const x = exclusions.find((e) => excludes(e, p));
    if (!x) {
      kept.push(p);
      continue;
    }
    excluded.push({
      uid: p.uid,
      name: p.name,
      category: p.cat,
      reason: x.reason,
      source: x.source,
      date: x.date,
      ...(!x.uid && x.name_pattern ? { pattern: x.name_pattern } : {}),
    });
  }
  return { pois: kept, excluded };
}
