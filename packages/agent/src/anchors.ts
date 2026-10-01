/**
 * Evidence anchors: the places a tool result talks about — communities (with the map code the web
 * shows, A-01 …), facilities (POIs), 灰色区域 layers and a simulated site — so the citations of an
 * answer can highlight them on the map. Coordinates are the analysis' own: XY in its local frame
 * (metres, x east, y north) and BD-09. Anchors never reach the model and are no number sources: they
 * are for the screen only.
 */
import type { AnalysisResult, Community, FacilityCategory, LngLat, Poi, XY } from '@zoudedao/core';
import { normName, toBd09 } from './analysis.js';

export interface CommunityAnchor {
  type: 'community';
  /** The analysis the tool read (e.g. zj-a~elder: same places as zj-a). */
  analysis_id: string;
  name: string;
  /** The web's map code (communityCodes). */
  code: string;
  /** communities[].centroid: the gate in live results, the outline centroid in zj-a. */
  xy: XY;
  bd09: LngLat;
}

export interface PoiAnchor {
  type: 'poi';
  analysis_id: string;
  name: string;
  uid: string;
  category: FacilityCategory;
  xy: XY;
  bd09: LngLat;
}

export interface GrayAreaAnchor {
  type: 'gray_area';
  analysis_id: string;
  /** `${kind}-${min_missing}`, e.g. gap-1, gap-2, pseudo-1: one layer of gray_areas. */
  id: string;
  kind: 'gap' | 'pseudo';
  min_missing: number;
  /** Position in the result's gray_areas. */
  index: number;
  area_m2: number;
}

/** A place a tool reasoned about that is no POI: the new facility of simulate_facility. */
export interface SiteAnchor {
  type: 'site';
  analysis_id: string;
  label: string;
  xy: XY;
  bd09: LngLat;
}

export type Anchor = CommunityAnchor | PoiAnchor | GrayAreaAnchor | SiteAnchor;

/** Anchors per tool result at most: enough for every community of a live check (30) and some POIs. */
export const ANCHORS_MAX = 40;

const r1 = (v: number) => Math.round(v * 10) / 10;

/**
 * The web's map code of every community, in result order (apps/web model/derive.ts): A-01, A-02 …
 * north to south, then west to east; the letter is the sample's own (zj-b → B), A otherwise (live
 * results, derived ids use their base id).
 */
export function communityCodes(result: AnalysisResult, id: string): string[] {
  const base = id.replace(/~elder$/, '');
  const prefix = /^[a-z]+-([a-z])$/i.exec(base)?.[1]?.toUpperCase() ?? 'A';
  const codes = new Array<string>(result.communities.length).fill('');
  result.communities
    .map((c, i) => ({ c, i }))
    .sort((a, b) => b.c.centroid[1] - a.c.centroid[1] || a.c.centroid[0] - b.c.centroid[0])
    .forEach(({ i }, k) => {
      codes[i] = `${prefix}-${String(k + 1).padStart(2, '0')}`;
    });
  return codes;
}

/** Collects the anchors of one tool result: unique, in the order they are named, at most ANCHORS_MAX. */
export class AnchorBook {
  readonly anchors: Anchor[] = [];
  readonly #seen = new Set<string>();
  #codes: string[] | undefined;

  constructor(
    readonly result: AnalysisResult,
    readonly analysisId: string,
    readonly max = ANCHORS_MAX,
  ) {}

  #push(key: string, anchor: Anchor): void {
    if (this.#seen.has(key) || this.anchors.length >= this.max) return;
    this.#seen.add(key);
    this.anchors.push(anchor);
  }

  #code(index: number): string {
    this.#codes ??= communityCodes(this.result, this.analysisId);
    return this.#codes[index] ?? '';
  }

  /** A community by its exact name (else its normalised name). */
  community(name: string | null | undefined): this {
    if (!name) return this;
    const list = this.result.communities;
    let i = list.findIndex((c) => c.name === name);
    if (i < 0) i = list.findIndex((c) => normName(c.name) === normName(name));
    if (i >= 0) this.communityAt(i);
    return this;
  }

  communityAt(index: number): this {
    const c: Community | undefined = this.result.communities[index];
    if (!c) return this;
    this.#push(`c:${index}`, {
      type: 'community',
      analysis_id: this.analysisId,
      name: c.name,
      code: this.#code(index),
      xy: [r1(c.centroid[0]), r1(c.centroid[1])],
      bd09: toBd09(this.result, c.centroid),
    });
    return this;
  }

  /** A facility by uid (merged duplicates included), else by name (and category when given). */
  poi(ref: { uid?: string | null; name?: string | null; category?: FacilityCategory | null }): this {
    const pois = this.result.pois ?? [];
    let p: Poi | undefined;
    if (ref.uid) p = pois.find((x) => x.uid === ref.uid || x.merged_uids?.includes(ref.uid!));
    if (!p && ref.name) {
      const named = pois.filter((x) => x.name === ref.name);
      p = named.find((x) => !ref.category || x.cat === ref.category) ?? named[0];
    }
    if (!p) return this;
    this.#push(`p:${p.uid}`, {
      type: 'poi',
      analysis_id: this.analysisId,
      name: p.name,
      uid: p.uid,
      category: p.cat,
      xy: [r1(p.xy[0]), r1(p.xy[1])],
      bd09: toBd09(this.result, p.xy),
    });
    return this;
  }

  /** Every 灰色区域 layer of the result. */
  grayAreas(): this {
    (this.result.gray_areas ?? []).forEach((g, index) => {
      if (!g.rings?.length) return;
      this.#push(`g:${index}`, {
        type: 'gray_area',
        analysis_id: this.analysisId,
        id: `${g.kind}-${g.min_missing}`,
        kind: g.kind,
        min_missing: g.min_missing,
        index,
        area_m2: g.area_m2,
      });
    });
    return this;
  }

  site(label: string, xy: XY): this {
    this.#push(`s:${xy[0]},${xy[1]}`, {
      type: 'site',
      analysis_id: this.analysisId,
      label,
      xy: [r1(xy[0]), r1(xy[1])],
      bd09: toBd09(this.result, xy),
    });
    return this;
  }
}
