/**
 * Demand points of the live mode (技术设计文档 §7.1): residential compounds from one place search
 * ("住宅区$小区"), with the compound's gate as the point residents start walking from.
 *
 * Baidu lists a compound together with its sub-POIs ("滨河花园-1号门", "滨河花园东门", "滨河花园-3号楼")
 * and sometimes twice. Entries are merged by base name (gate and building suffixes stripped); the gate
 * is the main POI's navi_location, else a gate sub-POI, else the POI point. Compound outlines (AOI) are a
 * paid Baidu service, so communities have no outline in live mode.
 *
 * Then the same homes counted twice under other names (measured around 万科翡翠公园 and 玉兰香苑,
 * 2026-09-29), each merge and drop recorded (ResidentialResult.dedupe):
 *
 *   numerals  phase numbers spelled one way (core phaseNumerals) before the base-name merge:
 *             万科翡翠公园-I期 ≡ 万科翡翠公园-1期 ≡ 万科翡翠公园一期; siblings under one parent_id with the
 *             same name are one phase however far apart Baidu put their points. The record kept (its
 *             name, gate and point) is the one whose address names no other compound or phase
 *             (万科翡翠公园-1期, not -I期 filed under 六期), else Baidu's first
 *   misplaced a phase whose own address names another listed phase of its estate and whose point lies
 *             within MISPLACED_RADIUS_M of it is a misplaced record of that phase and is dropped
 *             (万科翡翠公园-I期 → 六期, 102 m), unless it merged with another spelling of itself above
 *   parent    a compound whose parent_id is another compound in the list: a parent with two or more
 *             phases there is dropped (its phases stand for it); one with a single child absorbs it
 *   alias     a compound whose address names another compound (≥ 4 characters) and whose point lies
 *             within ALIAS_RADIUS_M of it is that compound (益江路286弄小区 → 玉兰香苑一期A组, 7 m).
 *             Addresses alone merge nothing: Baidu files 万科翡翠公园-I期 under "川和路万科翡翠公园-六期",
 *             102 m from 六期, and neighbours (东窑新村 / 华陇小区, 30 m) keep their own names
 */
import type { PlacePoi } from '@zoudedao/baidu';
import {
  COMMITTEE_NAME,
  normalizeName,
  phaseNumerals,
  reviewOf,
  type CommunityReview,
  type LngLat,
  type LocalFrame,
  type XY,
} from '@zoudedao/core';

import { r1 } from './round.js';

export type GateSource = 'navi' | 'gate_poi' | 'location';

export interface DemandSite {
  /** Unique display name; also the demand id of the coverage check. */
  id: string;
  name: string;
  /** Baidu uid of the compound POI. */
  uid: string | null;
  /**
   * Baidu address of the compound POI (often names its 弄, which catchment tables list); the official
   * table's spelling where the community review corrects it.
   */
  address?: string | null;
  /** The community review says it has no 对口小学 by law (商办产权): why. */
  no_catchment?: string;
  /** Gate in the local frame. */
  xy: XY;
  /**
   * Where the compound sits (the main POI's location, local frame): what a map labels, while routing,
   * checks, catchment and siting start from the gate `xy`. Absent for sites made elsewhere.
   */
  label_xy?: XY;
  bd09: LngLat;
  gate: GateSource;
  straight_m: number;
  /** uids of the entries merged into this compound. */
  merged: string[];
}

const RESIDENTIAL_TAG = /住宅区|别墅|宿舍/;
const GATE_TAG = /^出入口/;
const SEP = String.raw`(?:[-－—_·•\s]|[（(])*`;
const GATE_SUFFIX = new RegExp(
  `${SEP}(?:[东南西北]{1,2}|正|主|侧|后|前|人行|车行|消防)?(?:[0-9０-９一二三四五六七八九十]+号?)?(?:大门|门|出入口|入口|出口)[）)]?$`,
);
const BUILDING_SUFFIX = new RegExp(
  `${SEP}[0-9０-９A-Za-z一二三四五六七八九十]+(?:号楼|栋|幢|座|单元)[）)]?$`,
);
const NUMBER_SUFFIX = /[-－—_][0-9０-９]+号?$/;

/** "滨河花园-1号门" / "滨河花园(东门)" / "滨河花园-3号楼" → "滨河花园"; phases and blocks stay. */
export function baseName(name: string): string {
  let s = name.trim();
  for (let i = 0; i < 3; i++) {
    const next = s.replace(GATE_SUFFIX, '').replace(BUILDING_SUFFIX, '').replace(NUMBER_SUFFIX, '').trim();
    if (next === s || next.length < 2) break;
    s = next;
  }
  return s;
}

/**
 * Key of a compound name for the merges: base name, normalised, phase numbers spelled one way
 * (万科·翡翠公园-3期 and 万科翡翠公园三期 → 万科翡翠公园3期).
 */
export function compoundKey(name: string): string {
  return phaseNumerals(normalizeName(baseName(name)));
}

/**
 * A phase whose address names another listed phase of its estate and whose point lies this close to
 * that phase's is a misplaced record of it (万科翡翠公园-I期: "川和路万科翡翠公园-六期", 102 m from 六期).
 */
export const MISPLACED_RADIUS_M = 150;
/** An alias's point lies this close to the compound its address names (益江路286弄小区: 7 m). */
export const ALIAS_RADIUS_M = 30;
/** A name this short in an address proves nothing (小区, 花园 …). */
const ALIAS_MIN_CHARS = 4;

interface Entry {
  poi: PlacePoi;
  kind: 'home' | 'gate';
  base: string;
  key: string;
  xy: XY;
}

interface Cluster {
  entries: Entry[];
  /** The POI the site is named after and whose gate and location it takes. */
  main: Entry;
  /** Merged into another cluster or dropped. */
  gone: boolean;
}

export interface ResidentialOptions {
  frame: LocalFrame;
  /** Gates farther from the centre are outside the analysis. */
  extent_m: number;
  /** Keep the nearest this many compounds. */
  max: number;
  /** Same base name farther apart than this is another compound. */
  mergeRadius_m?: number;
  /** Curated verdicts on Baidu's compounds (core community-review): excluded, no catchment, address. */
  reviews?: readonly CommunityReview[];
}

/** One merge or drop of the dedupe rules (numerals, parent, alias), for the explanation. */
export interface DedupeItem {
  rule: 'phase_numeral' | 'misplaced_phase' | 'parent_child' | 'parent_of_phases' | 'alias';
  /** Display name (base name) of the compound merged away or dropped. */
  name: string;
  uid: string | null;
  /** The compound it went into (merges). */
  into?: string;
  /** The phases that stand for a dropped parent. */
  phases?: string[];
  /** The other phase a misplaced phase's address and point both point to. */
  points_to?: string;
}

/** stats.residential_dedupe: counts per rule and every merge and drop. */
export interface ResidentialDedupe {
  /** Parents dropped because two or more of their phases are in the list. */
  parents_dropped: number;
  /** Only children merged into their parent. */
  children_merged: number;
  /** POIs merged into a compound whose name differs only in how the phase number is spelled. */
  numeral_merged: number;
  /** Phases dropped as misplaced records of another listed phase (address and point both point there). */
  misplaced_dropped: number;
  /** Compounds merged into the one their address names, within ALIAS_RADIUS_M. */
  alias_merged: number;
  items: DedupeItem[];
}

export interface ResidentialResult {
  demand: DemandSite[];
  /** Compounds found before the extent and count limits. */
  found: number;
  dropped: { name: string; reason: string }[];
  dedupe: ResidentialDedupe;
}

const dist = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const homesOf = (c: Cluster) => c.entries.filter((e) => e.kind === 'home');
const PHASE_NUMBER = /(\d+)期/g;

/**
 * Does the POI's own address name another compound of the list (a key ≥ 4 characters that is neither
 * its own nor part of it, so its estate's name does not count) or another phase? Baidu files
 * 万科翡翠公园-I期 under "川和路万科翡翠公园-六期", next to 六期: that record is the misplaced one.
 */
function addressNamesOther(e: Entry, keys: ReadonlySet<string>): boolean {
  if (!e.poi.address) return false;
  const address = phaseNumerals(normalizeName(e.poi.address));
  const own = new Set([...e.key.matchAll(PHASE_NUMBER)].map((m) => m[1]));
  if ([...address.matchAll(PHASE_NUMBER)].some((m) => own.size > 0 && !own.has(m[1]))) return true;
  for (const k of keys) {
    if (k.length >= ALIAS_MIN_CHARS && k !== e.key && !e.key.includes(k) && address.includes(k)) return true;
  }
  return false;
}

export function residentialDemand(pois: readonly PlacePoi[], opts: ResidentialOptions): ResidentialResult {
  const { frame } = opts;
  const mergeRadius = opts.mergeRadius_m ?? 400;
  const dropped: ResidentialResult['dropped'] = [];
  const dedupe: ResidentialDedupe = {
    parents_dropped: 0,
    children_merged: 0,
    numeral_merged: 0,
    misplaced_dropped: 0,
    alias_merged: 0,
    items: [],
  };
  const seen = new Set<string>();
  const entries: Entry[] = [];
  for (const poi of pois) {
    const id = poi.uid ?? `${poi.name}@${poi.location.join(',')}`;
    if (seen.has(id)) continue;
    seen.add(id);
    // not anyone's home: a residents' committee by its name, or what the community review excluded
    if (COMMITTEE_NAME.test(poi.name.trim())) {
      dropped.push({ name: poi.name, reason: 'committee' });
      continue;
    }
    const review = reviewOf(opts.reviews ?? [], [poi.uid]);
    if (review?.action === 'exclude') {
      dropped.push({ name: poi.name, reason: `reviewed:${review.kind}` });
      continue;
    }
    const tag = `${poi.classifiedTag ?? ''};${poi.tag ?? ''}`;
    const kind = RESIDENTIAL_TAG.test(tag)
      ? 'home'
      : GATE_TAG.test(poi.classifiedTag ?? poi.tag ?? '')
        ? 'gate'
        : null;
    if (!kind) {
      dropped.push({ name: poi.name, reason: `not_residential:${poi.classifiedTag ?? poi.tag ?? ''}` });
      continue;
    }
    entries.push({
      poi,
      kind,
      base: baseName(poi.name),
      key: compoundKey(poi.name),
      xy: frame.toXY(poi.location[0], poi.location[1]),
    });
  }

  // group by key (base name, phase numbers spelled one way), then split groups whose members lie far
  // apart (two compounds, one name) — unless they are one parent's children of the same name
  const byKey = new Map<string, Entry[]>();
  for (const e of entries) byKey.set(e.key, [...(byKey.get(e.key) ?? []), e]);
  const homeKeys = new Set(entries.filter((e) => e.kind === 'home').map((e) => e.key));
  const clusters: Cluster[] = [];
  for (const group of byKey.values()) {
    const homesFirst = [...group].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'home' ? -1 : 1));
    const mine: Entry[][] = [];
    for (const e of homesFirst) {
      const parent = e.kind === 'home' ? e.poi.parentId : null;
      const c = mine.find(
        (m) =>
          dist(m[0]!.xy, e.xy) <= mergeRadius ||
          (!!parent && m.some((x) => x.kind === 'home' && x.poi.parentId === parent)),
      );
      if (c) c.push(e);
      else mine.push([e]);
    }
    for (const m of mine) {
      const homes = m.filter((e) => e.kind === 'home');
      const named = homes.filter((e) => e.poi.name.trim() === e.base);
      const candidates = named.length ? named : homes;
      // spellings of one phase (I期 / 1期): the record whose address names no other compound or phase
      // is the right one; Baidu's order decides when both or neither do
      const variants = new Set(candidates.map((e) => normalizeName(e.base))).size > 1;
      const main =
        (variants ? candidates.find((e) => !addressNamesOther(e, homeKeys)) : undefined) ??
        candidates[0] ??
        m[0]!;
      const mainName = normalizeName(main.base);
      for (const e of homes) {
        if (e === main || normalizeName(e.base) === mainName) continue;
        dedupe.numeral_merged++;
        dedupe.items.push({ rule: 'phase_numeral', name: e.base, uid: e.poi.uid, into: main.base });
      }
      clusters.push({ entries: m, main, gone: false });
    }
  }
  const absorb = (into: Cluster, from: Cluster) => {
    into.entries.push(...from.entries);
    from.gone = true;
  };

  // misplaced phases: a phase (one spelling only; merged spellings were settled above) whose address
  // names another phase of its estate that is listed, and whose point lies next to that phase's
  const phaseOf = (key: string) => {
    const m = /^(.+?)(\d+)期/.exec(key);
    return m ? { estate: m[1]!, n: m[2]! } : null;
  };
  for (const c of clusters) {
    const homes = homesOf(c);
    if (c.gone || !homes.length || new Set(homes.map((e) => normalizeName(e.base))).size > 1) continue;
    const own = phaseOf(c.main.key);
    const address = c.main.poi.address ? phaseNumerals(normalizeName(c.main.poi.address)) : '';
    if (!own || !address) continue;
    const target = clusters.find(
      (t) =>
        t !== c &&
        !t.gone &&
        homesOf(t).some((e) => {
          const other = phaseOf(e.key);
          return (
            !!other &&
            other.estate === own.estate &&
            other.n !== own.n &&
            address.includes(e.key) &&
            dist(c.main.xy, e.xy) <= MISPLACED_RADIUS_M
          );
        }),
    );
    if (!target) continue;
    c.gone = true;
    dedupe.misplaced_dropped++;
    dropped.push({ name: c.main.base, reason: 'misplaced_phase' });
    dedupe.items.push({
      rule: 'misplaced_phase',
      name: c.main.base,
      uid: c.main.poi.uid,
      points_to: target.main.base,
    });
  }

  // parent / child: Baidu's parent_id links a phase to its estate
  const byUid = new Map<string, Cluster>();
  for (const c of clusters) for (const e of homesOf(c)) if (e.poi.uid) byUid.set(e.poi.uid, c);
  const parentOf = new Map<Cluster, Cluster>();
  for (const c of clusters) {
    if (c.gone) continue;
    for (const e of [c.main, ...homesOf(c)]) {
      const p = e.kind === 'home' && e.poi.parentId ? byUid.get(e.poi.parentId) : undefined;
      if (p && p !== c) {
        parentOf.set(c, p);
        break;
      }
    }
  }
  const depth = new Map<Cluster, number>();
  for (const c of clusters) {
    const chain = new Set<Cluster>([c]);
    let p = parentOf.get(c);
    while (p && !chain.has(p)) {
      chain.add(p);
      p = parentOf.get(p);
    }
    // a loop of parent_ids links nothing
    if (p) parentOf.delete(c);
    depth.set(c, chain.size - 1);
  }
  const children = new Map<Cluster, Cluster[]>();
  for (const [c, p] of parentOf) children.set(p, [...(children.get(p) ?? []), c]);
  // deepest first: a dropped phase hands its own phases up to its parent
  const standIns = new Map<Cluster, Cluster[]>();
  const parents = [...children.keys()].sort((a, b) => depth.get(b)! - depth.get(a)!);
  for (const p of parents) {
    const phases = children.get(p)!.flatMap((k) => standIns.get(k) ?? (k.gone ? [] : [k]));
    if (phases.length >= 2) {
      p.gone = true;
      standIns.set(p, phases);
      dedupe.parents_dropped++;
      dropped.push({ name: p.main.base, reason: 'parent_of_phases' });
      dedupe.items.push({
        rule: 'parent_of_phases',
        name: p.main.base,
        uid: p.main.poi.uid,
        phases: phases.map((k) => k.main.base),
      });
    } else if (phases.length === 1) {
      const child = phases[0]!;
      absorb(p, child);
      dedupe.children_merged++;
      dedupe.items.push({
        rule: 'parent_child',
        name: child.main.base,
        uid: child.main.poi.uid,
        into: p.main.base,
      });
    }
  }

  // alias: a compound whose address names another one right next to it is that one
  const live = () => clusters.filter((c) => !c.gone);
  for (const a of live()) {
    if (a.gone) continue;
    const target = (() => {
      for (const ea of homesOf(a)) {
        const address = ea.poi.address ? phaseNumerals(normalizeName(ea.poi.address)) : '';
        if (!address) continue;
        for (const b of live()) {
          if (b === a) continue;
          const hit = homesOf(b).some(
            (eb) =>
              eb.key.length >= ALIAS_MIN_CHARS &&
              address.includes(eb.key) &&
              dist(ea.xy, eb.xy) <= ALIAS_RADIUS_M,
          );
          if (hit) return b;
        }
      }
      return null;
    })();
    if (!target) continue;
    absorb(target, a);
    dedupe.alias_merged++;
    dedupe.items.push({ rule: 'alias', name: a.main.base, uid: a.main.poi.uid, into: target.main.base });
  }

  const sites: DemandSite[] = [];
  for (const { entries: cluster, main } of live()) {
    const homes = cluster.filter((e) => e.kind === 'home');
    const base = main.base;
    // a lone gate only stands for a compound when its name says so (the 小区 keyword found it)
    if (!homes.length && !/小区/.test(base)) {
      for (const e of cluster) dropped.push({ name: e.poi.name, reason: 'gate_without_compound' });
      continue;
    }
    let gate: { xy: XY; bd09: LngLat; source: GateSource };
    if (main.poi.naviLocation) {
      const [lng, lat] = main.poi.naviLocation;
      gate = { xy: frame.toXY(lng, lat), bd09: [lng, lat], source: 'navi' };
    } else {
      const gates = cluster
        .filter((e) => e.kind === 'gate')
        .sort((a, b) => dist(a.xy, main.xy) - dist(b.xy, main.xy));
      const g = gates[0];
      gate = g
        ? { xy: g.xy, bd09: [g.poi.location[0], g.poi.location[1]], source: 'gate_poi' }
        : { xy: main.xy, bd09: [main.poi.location[0], main.poi.location[1]], source: 'location' };
    }
    const review = reviewOf(opts.reviews ?? [], [main.poi.uid]);
    // the official name where the review gives one (益江路511弄 → 玉兰香苑二期A块)
    const name = review?.action === 'name' ? review.official_name! : base;
    sites.push({
      id: name,
      name,
      uid: main.poi.uid,
      address: review?.action === 'address' ? review.address! : (main.poi.address ?? null),
      ...(review?.action === 'no_catchment' ? { no_catchment: review.reason } : {}),
      xy: [r1(gate.xy[0]), r1(gate.xy[1])],
      label_xy: [r1(main.xy[0]), r1(main.xy[1])],
      bd09: gate.bd09,
      gate: gate.source,
      straight_m: r1(Math.hypot(gate.xy[0], gate.xy[1])),
      merged: cluster.filter((e) => e !== main && e.poi.uid).map((e) => e.poi.uid!),
    });
  }

  const inside = sites
    .filter((s) => s.straight_m <= opts.extent_m)
    .sort((a, b) => a.straight_m - b.straight_m);
  const demand = inside.slice(0, Math.max(0, opts.max));
  // one name, two compounds: keep ids unique
  const used = new Map<string, number>();
  for (const d of demand) {
    const n = (used.get(d.name) ?? 0) + 1;
    used.set(d.name, n);
    if (n > 1) d.id = d.name = `${d.name}（${n}）`;
  }
  return { demand, found: sites.length, dropped, dedupe };
}
