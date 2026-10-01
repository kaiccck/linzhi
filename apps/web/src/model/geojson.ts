/**
 * The check as GeoJSON (报告 → 下载 GeoJSON), for a planner's own GIS: the 5′ / 10′ / 15′ isochrones,
 * the straight 15′ circle, the communities with their verdicts under the rule set on screen, the
 * facilities, and the gray areas. Coordinates are WGS-84 (RFC 7946): local metres → BD-09 through the
 * analysis' frame → WGS-84 with @zoudedao/core's public conversion (accurate to a few metres).
 */
import { bd09ToWgs84, type ContourMeta, type XY, viaName } from '@zoudedao/core';
import { CATS, circleR, distWords, type Model } from './derive.js';

type Pos = [number, number];
type Geometry =
  | { type: 'Point'; coordinates: Pos }
  | { type: 'Polygon'; coordinates: Pos[][] }
  | { type: 'MultiPolygon'; coordinates: Pos[][][] };

export interface Feature {
  type: 'Feature';
  geometry: Geometry;
  properties: Record<string, string | number | boolean | null>;
}

export interface AnalysisGeoJSON {
  type: 'FeatureCollection';
  name: string;
  /** a foreign member (RFC 7946 §6.1): where the data came from and how it was converted */
  metadata: Record<string, string | number | null>;
  features: Feature[];
}

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** Signed area (shoelace, local metres): > 0 counter-clockwise. */
function signedArea(ring: readonly XY[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    a += (ring[j]![0] - ring[i]![0]) * (ring[j]![1] + ring[i]![1]);
  return a / 2;
}

function inside(ring: readonly XY[], [x, y]: XY): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/**
 * Rings (outer counter-clockwise, holes clockwise, as the engine writes them) grouped into polygons:
 * by `meta` when it lists every ring's parent, otherwise by winding and containment.
 */
export function polygonsOf(rings: readonly (readonly XY[])[], meta?: readonly ContourMeta[]): XY[][][] {
  const list = rings.filter((r) => r.length >= 3);
  if (meta && meta.length === rings.length && list.length === rings.length) {
    const polys = new Map<number, XY[][]>();
    rings.forEach((r, i) => {
      if (!meta[i]!.hole) polys.set(i, [[...r]]);
    });
    rings.forEach((r, i) => {
      const parent = meta[i]!.parent;
      if (meta[i]!.hole && parent !== null) polys.get(parent)?.push([...r]);
    });
    return [...polys.values()];
  }
  const outers = list.filter((r) => signedArea(r) >= 0).map((r) => [[...r]] as XY[][]);
  for (const hole of list.filter((r) => signedArea(r) < 0)) {
    const home = outers.find((p) => inside(p[0]!, hole[0]!));
    if (home) home.push([...hole]);
  }
  return outers;
}

export function analysisGeoJSON(model: Model, opts: { scale: number }): AnalysisGeoJSON {
  const { data, frame } = model;
  const wgs = ([x, y]: readonly number[]): Pos => {
    const [lng, lat] = frame.toLngLat(x!, y!);
    const [a, b] = bd09ToWgs84(lng, lat);
    return [r6(a), r6(b)];
  };
  const ring = (r: readonly XY[]): Pos[] => {
    const out = r.map(wgs);
    const [f, l] = [out[0]!, out[out.length - 1]!];
    if (f[0] !== l[0] || f[1] !== l[1]) out.push([f[0], f[1]]);
    return out;
  };
  const multi = (polys: XY[][][]): Geometry =>
    polys.length === 1
      ? { type: 'Polygon', coordinates: polys[0]!.map(ring) }
      : { type: 'MultiPolygon', coordinates: polys.map((p) => p.map(ring)) };
  const features: Feature[] = [];

  // isochrones (the analysis' own contours: the measured adult speed)
  for (const L of ['300', '600', '900'] as const) {
    const polys = polygonsOf(data.contours[L] ?? [], data.contours_meta?.[L]);
    if (!polys.length) continue;
    const area = data.stats.areas_km2?.[L]?.iso;
    features.push({
      type: 'Feature',
      geometry: multi(polys),
      properties: {
        layer: 'isochrone',
        minutes: Number(L) / 60,
        area_km2: typeof area === 'number' ? area : null,
        speed_mps: model.vAdult,
      },
    });
  }

  // the straight 15′ circle at the profile's radius
  const R = circleR(model, opts.scale);
  const circle: XY[] = Array.from({ length: 72 }, (_, i) => {
    const a = (i / 72) * Math.PI * 2;
    return [Math.cos(a) * R, Math.sin(a) * R];
  });
  features.push({
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [ring(circle)] },
    properties: { layer: 'straight_circle', radius_m: Math.round(R), minutes: 15 },
  });

  // communities and their verdicts
  for (const u of model.units) {
    const props: Feature['properties'] = { layer: 'community', code: u.code, name: u.name };
    for (const cat of CATS) {
      const c = u.checks[cat];
      props[`${cat}_status`] = c.verified === false ? '待核实' : c.status;
      props[`${cat}_straight_m`] = c.straight_m >= 0 ? Math.round(c.straight_m) : null;
      props[`${cat}_route_m`] = c.route_m >= 0 ? Math.round(c.route_m) : null;
      props[`${cat}_via`] = viaName(c) ?? null;
    }
    if (u.catchment) {
      props.catchment_school = u.catchment.school;
      props.catchment_route_m = u.catchment.route_m;
    }
    features.push({
      type: 'Feature',
      geometry: u.outlined
        ? { type: 'Polygon', coordinates: [ring(u.pts)] }
        : { type: 'Point', coordinates: wgs(u.centroid) },
      properties: props,
    });
  }

  // facilities (market stalls fold into their market, as everywhere else)
  for (const p of data.pois) {
    if (p.stall_of) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: wgs(p.xy) },
      properties: {
        layer: 'poi',
        name: p.name,
        category: p.cat,
        source: p.source,
        uid: p.uid,
        official: p.official?.name ?? null,
      },
    });
  }

  // gray areas
  for (const g of data.gray_areas ?? []) {
    const polys = polygonsOf(g.rings, g.meta);
    if (!polys.length) continue;
    features.push({
      type: 'Feature',
      geometry: multi(polys),
      properties: {
        layer: 'gray_area',
        kind: g.kind,
        min_missing: g.min_missing,
        area_km2: Math.round(g.area_m2 / 1e3) / 1e3,
      },
    });
  }

  return {
    type: 'FeatureCollection',
    name: `${data.meta.name} · 15 分钟生活圈体检`,
    metadata: {
      analysis: model.id,
      analysis_id: (data.meta as { analysis_id?: string }).analysis_id ?? null,
      rules: `步行 ${distWords(model.ruleM)}（赛题）`,
      measured_on: model.measuredOn,
      generated: data.meta.generated,
      crs: 'WGS 84（EPSG:4326）：由 BD-09 按公开公式换算，误差约数米',
      source: '邻至（Apache-2.0）：百度地图步行路线实测；小区轮廓与设施另见 attribution',
      attribution: (data.meta.attribution ?? []).join(' | '),
    },
    features,
  };
}

/** The file name the download takes: zoudedao-zj-a.geojson. */
export const geojsonName = (model: Model, analysisId: string | null) =>
  `zoudedao-${(analysisId ?? model.id).replace(/[^\w.-]+/g, '-')}.geojson`;
