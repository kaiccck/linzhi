/**
 * A citation's places on the map: the anchors of a 问询 tool result (communities, facilities, gray
 * areas, a simulated site) resolved against the analysis on screen, so pointing at [T2] lights the
 * places T2 is about. Anchors of another analysis (an answer about a different area) resolve to
 * nothing: their local metres belong to another frame.
 */
import type { XY } from '@zoudedao/core';
import type { AskAnchor, AskCitation } from '../data/ask.js';
import type { Model } from './derive.js';

export interface MapSpot {
  key: string;
  /** what lit it, e.g. "T2 服务缺口清单" */
  label: string;
  /** unit codes to light */
  codes: string[];
  pois: { key: string; name: string; category: string; xy: XY }[];
  /** indexes into data.gray_areas */
  gray: number[];
  sites: { key: string; label: string; xy: XY }[];
  /** every point the spot names, to bring into view */
  focus: XY[];
}

/** An analysis id without its profile: zj-a~elder is the place of zj-a. */
export const placeOf = (id: string | null | undefined) => (id ?? '').replace(/~elder$/, '');

export function spotOf(
  model: Model,
  analysisId: string | null,
  cite: AskCitation,
  key: string,
): MapSpot | null {
  const here = placeOf(analysisId) || model.id;
  const mine = (a: AskAnchor) => !a.analysis_id || placeOf(a.analysis_id) === here;
  const byCode = new Map(model.units.map((u) => [u.code, u]));
  const byName = new Map(model.units.map((u) => [u.name, u]));
  const spot: MapSpot = {
    key,
    label: `${cite.id} ${cite.title}`,
    codes: [],
    pois: [],
    gray: [],
    sites: [],
    focus: [],
  };
  const areas = model.data.gray_areas ?? [];
  for (const a of cite.anchors) {
    if (!mine(a)) continue;
    switch (a.type) {
      case 'community': {
        const byC = a.code ? byCode.get(a.code) : undefined;
        const unit = byC && (!a.name || byC.name === a.name) ? byC : byName.get(a.name);
        if (!unit || spot.codes.includes(unit.code)) break;
        spot.codes.push(unit.code);
        spot.focus.push(unit.centroid);
        break;
      }
      case 'poi':
        if (spot.pois.some((p) => p.name === a.name && p.xy[0] === a.xy[0] && p.xy[1] === a.xy[1])) break;
        spot.pois.push({ key: `p${spot.pois.length}`, name: a.name, category: a.category, xy: a.xy });
        spot.focus.push(a.xy);
        break;
      case 'gray_area': {
        const g = areas[a.index];
        if (!g || !g.rings.length || spot.gray.includes(a.index)) break;
        spot.gray.push(a.index);
        for (const ring of g.rings) for (let i = 0; i < ring.length; i += 8) spot.focus.push(ring[i]!);
        break;
      }
      case 'site':
        spot.sites.push({ key: `s${spot.sites.length}`, label: a.label, xy: a.xy });
        spot.focus.push(a.xy);
        break;
    }
  }
  return spot.codes.length || spot.pois.length || spot.gray.length || spot.sites.length ? spot : null;
}

/** "3 个小区、1 处设施、2 片灰色区域" — what the map now shows for a citation. */
export function spotWords(s: MapSpot): string {
  return [
    s.codes.length ? `${s.codes.length} 个小区` : '',
    s.pois.length ? `${s.pois.length} 处设施` : '',
    s.gray.length ? `${s.gray.length} 片灰色区域` : '',
    s.sites.length ? `${s.sites.length} 个模拟位置` : '',
  ]
    .filter(Boolean)
    .join('、');
}
