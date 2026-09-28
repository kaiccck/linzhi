/**
 * Demand points of the live mode (技术设计文档 §7.1): residential compounds from one place search
 * ("住宅区$小区"), with the compound's gate as the point residents start walking from.
 *
 * Baidu lists a compound together with its sub-POIs ("滨河花园-1号门", "滨河花园东门", "滨河花园-3号楼")
 * and sometimes twice. Entries are merged by base name (gate and building suffixes stripped); the gate
 * is the main POI's navi_location, else a gate sub-POI, else the POI point. Compound outlines (AOI) are a
 * paid Baidu service, so communities have no outline in live mode.
 */
import type { PlacePoi } from '@zoudedao/baidu';
import { normalizeName, type LngLat, type LocalFrame, type XY } from '@zoudedao/core';

import { r1 } from './round.js';

export type GateSource = 'navi' | 'gate_poi' | 'location';

export interface DemandSite {
  /** Unique display name; also the demand id of the coverage check. */
  id: string;
  name: string;
  /** Baidu uid of the compound POI. */
  uid: string | null;
  /** Gate in the local frame. */
  xy: XY;
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

interface Entry {
  poi: PlacePoi;
  kind: 'home' | 'gate';
  base: string;
  key: string;
  xy: XY;
}

export interface ResidentialOptions {
  frame: LocalFrame;
  /** Gates farther from the centre are outside the analysis. */
  extent_m: number;
  /** Keep the nearest this many compounds. */
  max: number;
  /** Same base name farther apart than this is another compound. */
  mergeRadius_m?: number;
}

export interface ResidentialResult {
  demand: DemandSite[];
  /** Compounds found before the extent and count limits. */
  found: number;
  dropped: { name: string; reason: string }[];
}

const dist = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function residentialDemand(pois: readonly PlacePoi[], opts: ResidentialOptions): ResidentialResult {
  const { frame } = opts;
  const mergeRadius = opts.mergeRadius_m ?? 400;
  const dropped: ResidentialResult['dropped'] = [];
  const seen = new Set<string>();
  const entries: Entry[] = [];
  for (const poi of pois) {
    const id = poi.uid ?? `${poi.name}@${poi.location.join(',')}`;
    if (seen.has(id)) continue;
    seen.add(id);
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
    const base = baseName(poi.name);
    entries.push({
      poi,
      kind,
      base,
      key: normalizeName(base),
      xy: frame.toXY(poi.location[0], poi.location[1]),
    });
  }

  // group by base name, then split groups whose members lie far apart (two compounds, one name)
  const byKey = new Map<string, Entry[]>();
  for (const e of entries) byKey.set(e.key, [...(byKey.get(e.key) ?? []), e]);
  const clusters: Entry[][] = [];
  for (const group of byKey.values()) {
    const homesFirst = [...group].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'home' ? -1 : 1));
    const mine: Entry[][] = [];
    for (const e of homesFirst) {
      const c = mine.find((m) => dist(m[0]!.xy, e.xy) <= mergeRadius);
      if (c) c.push(e);
      else mine.push([e]);
    }
    clusters.push(...mine);
  }

  const sites: DemandSite[] = [];
  for (const cluster of clusters) {
    const homes = cluster.filter((e) => e.kind === 'home');
    const base = cluster[0]!.base;
    // a lone gate only stands for a compound when its name says so (the 小区 keyword found it)
    if (!homes.length && !/小区/.test(base)) {
      for (const e of cluster) dropped.push({ name: e.poi.name, reason: 'gate_without_compound' });
      continue;
    }
    const main = homes.find((e) => e.poi.name.trim() === base) ?? homes[0] ?? cluster[0]!;
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
    sites.push({
      id: base,
      name: base,
      uid: main.poi.uid,
      xy: [r1(gate.xy[0]), r1(gate.xy[1])],
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
  return { demand, found: sites.length, dropped };
}
