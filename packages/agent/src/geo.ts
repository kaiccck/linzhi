/**
 * GeoJSON output. Results are stored in local metres around meta.center_bd09 (x east, y north; see
 * meta.frame_formula); this inverts that frame to BD-09 and converts to the requested datum. WGS84 is
 * the default because GeoJSON (RFC 7946) and geojson.io assume it; BD-09 overlays Baidu maps and
 * GCJ-02 overlays Gaode/Tencent maps.
 */
import {
  bd09ToGcj02,
  bd09ToWgs84,
  checkedCategories,
  closeRing,
  nestRings,
  simplifyRing,
  type AnalysisResult,
  type ContourMeta,
  type IsoLevel,
  type XY,
  viaName,
} from '@zoudedao/core';
import {
  LIMIT_S,
  circleRadius,
  facilityTimer,
  frameOf,
  grayLayers,
  isNotApplicable,
  isPending,
  isWalkGap,
  profileOf,
  speedOf,
  type CheckRow,
  checkRows,
  describePlace,
} from './analysis.js';
import { round } from './format.js';
import { siteSuggestionsOf } from './siting.js';
import { facilityOverview, type FacilityRow } from './summary.js';

export type Crs = 'wgs84' | 'gcj02' | 'bd09';

export const CRS_ZH: Record<Crs, string> = {
  wgs84: 'WGS84（GPS、OpenStreetMap、geojson.io）',
  gcj02: 'GCJ-02（高德、腾讯地图）',
  bd09: 'BD-09（百度地图）',
};

export type Position = [number, number];

export type Geometry =
  | { type: 'Point'; coordinates: Position }
  | { type: 'Polygon'; coordinates: Position[][] }
  | { type: 'MultiPolygon'; coordinates: Position[][][] };

export interface Feature {
  type: 'Feature';
  geometry: Geometry;
  properties: Record<string, unknown>;
}

export interface FeatureCollection {
  type: 'FeatureCollection';
  /** Foreign members (RFC 7946 §6.1): what this is and which datum the coordinates use. */
  name: string;
  coordinate_system: Crs;
  attribution: string[];
  /** Health-check export only: the 圈内设施统计 at the analysis' profile (summary.ts FacilityRow). */
  facility_stats?: FacilityRow[];
  features: Feature[];
}

/** Local XY → [lng, lat] in the requested datum, rounded to `precision` decimals. */
export function projector(result: AnalysisResult, crs: Crs, precision = 6): (xy: XY) => Position {
  const frame = frameOf(result.meta);
  const f = 10 ** precision;
  const convert =
    crs === 'wgs84' ? bd09ToWgs84 : crs === 'gcj02' ? bd09ToGcj02 : (lng: number, lat: number) => [lng, lat];
  return ([x, y]) => {
    const [lng, lat] = frame.toLngLat(x, y);
    const [a, b] = convert(lng, lat);
    return [Math.round(a! * f) / f, Math.round(b! * f) / f];
  };
}

/** Closed ring of projected positions without consecutive duplicates; null when degenerate. */
function projectRing(ring: XY[], project: (xy: XY) => Position, simplify_m: number): Position[] | null {
  const src = simplify_m > 0 ? simplifyRing(ring, simplify_m) : closeRing(ring);
  const out: Position[] = [];
  for (const p of src) {
    const q = project(p);
    const last = out[out.length - 1];
    if (!last || last[0] !== q[0] || last[1] !== q[1]) out.push(q);
  }
  const first = out[0];
  const last = out[out.length - 1];
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) out.push([first[0], first[1]]);
  return out.length >= 4 ? out : null;
}

/**
 * Rings (outer counter-clockwise, holes clockwise) → MultiPolygon coordinates. `meta` says which ring
 * is a hole of which outer ring; without it rings are nested by orientation. Orientation survives the
 * projection (lng grows with x, lat with y), so the RFC 7946 right-hand rule holds.
 */
export function multiPolygon(
  rings: readonly XY[][],
  meta: readonly ContourMeta[] | undefined,
  project: (xy: XY) => Position,
  simplify_m = 0,
): Position[][][] {
  const nested =
    meta && meta.length === rings.length
      ? rings.map((ring, i) => ({ ring, hole: meta[i]!.hole, parent: meta[i]!.parent ?? -1 }))
      : nestRings(rings.slice()).map((n) => ({ ring: n.ring, hole: n.hole, parent: n.parent }));
  const polygons = new Map<number, Position[][]>();
  const order: number[] = [];
  nested.forEach((n, i) => {
    const coords = projectRing(n.ring, project, simplify_m);
    if (!coords) return;
    if (!n.hole) {
      polygons.set(i, [coords]);
      order.push(i);
    } else {
      polygons.get(n.parent)?.push(coords);
    }
  });
  return order.map((i) => polygons.get(i)!);
}

/** Counter-clockwise circle ring around (cx, cy), closed. */
export function circleRing(r: number, n = 128, cx = 0, cy = 0): XY[] {
  const pts: XY[] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return closeRing(pts);
}

export const LEVEL_OF_MINUTES: Record<5 | 10 | 15, IsoLevel> = { 5: '300', 10: '600', 15: '900' };

// simplestyle-spec colours so geojson.io draws the layers like the product: guide-sign yellow for
// reach, cobalt for the circle, red only for 伪覆盖 (DESIGN.md).
const LEVEL_FILL: Record<IsoLevel, string> = { '300': '#F2B705', '600': '#F6C945', '900': '#FBE08A' };
const STATUS_COLOR: Record<string, string> = {
  伪覆盖: '#E23A2E',
  盲区: '#1F1F1F',
  覆盖: '#1446B0',
  待核实: '#8A8A8A',
  不适用: '#BBBBBB',
};

export interface IsochroneOptions {
  levels?: readonly (5 | 10 | 15)[];
  crs?: Crs;
  /** Douglas–Peucker tolerance in metres; 0 keeps the stored rings. */
  simplify?: number;
  includeCircle?: boolean;
  precision?: number;
}

function header(result: AnalysisResult, name: string, crs: Crs): Omit<FeatureCollection, 'features'> {
  return {
    type: 'FeatureCollection',
    name,
    coordinate_system: crs,
    attribution: [...(result.meta.attribution ?? []), '由邻至（zoudedao）从分析结果确定性生成'],
  };
}

/** 5/10/15-minute isochrones (largest first) plus the straight-line 15-minute circle and the centre. */
export function isochroneFeatures(result: AnalysisResult, opts: IsochroneOptions = {}): Feature[] {
  const crs = opts.crs ?? 'wgs84';
  const project = projector(result, crs, opts.precision ?? 6);
  const levels = [...new Set<5 | 10 | 15>(opts.levels ?? [5, 10, 15])].sort((a, b) => b - a);
  const profile = profileOf(result);
  const speed = speedOf(result);
  const features: Feature[] = [];
  for (const minutes of levels) {
    const level = LEVEL_OF_MINUTES[minutes];
    const rings = result.contours[level] ?? [];
    const meta = result.contours_meta?.[level];
    const coords = multiPolygon(rings, meta, project, opts.simplify ?? 0);
    const area = result.stats.areas_km2?.[level];
    features.push({
      type: 'Feature',
      geometry: { type: 'MultiPolygon', coordinates: coords },
      properties: {
        kind: 'isochrone',
        name: `${minutes} 分钟步行等时圈`,
        minutes,
        level_s: Number(level),
        area_km2: area?.iso ?? null,
        circle_area_km2: area?.circle ?? null,
        polygons: coords.length,
        holes: coords.reduce((n, p) => n + p.length - 1, 0),
        profile,
        speed_mps: speed,
        fill: LEVEL_FILL[level],
        'fill-opacity': 0.45,
        stroke: '#B08900',
        'stroke-width': 1,
      },
    });
  }
  if (opts.includeCircle ?? true) {
    const r = result.baseline.circle_r15_m;
    features.push({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [circleRing(r).map(project)] },
      properties: {
        kind: 'baseline_circle',
        name: '直线 15 分钟圆（画圆法对照）',
        minutes: 15,
        radius_m: r,
        area_km2: result.stats.area_circle15_km2,
        stroke: '#1446B0',
        'stroke-width': 2,
        fill: '#1446B0',
        'fill-opacity': 0,
      },
    });
  }
  features.push({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: project([0, 0]) },
    properties: {
      kind: 'center',
      name: result.meta.center_label ?? result.meta.name,
      center_bd09: result.meta.center_bd09,
      'marker-color': '#1446B0',
      'marker-symbol': 'star',
    },
  });
  return features;
}

export function isochroneCollection(result: AnalysisResult, opts: IsochroneOptions = {}): FeatureCollection {
  const crs = opts.crs ?? 'wgs84';
  return {
    ...header(result, `${result.meta.name} · 步行等时圈`, crs),
    features: isochroneFeatures(result, opts),
  };
}

// Same order as Community.worst_status in the samples: nothing nearby at all is the worst case.
const STATUS_RANK: Record<string, number> = { 覆盖: 0, 待核实: 1, 伪覆盖: 2, 盲区: 3 };

function communityProperties(rows: CheckRow[]): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  const missing: string[] = [];
  const pending: string[] = [];
  let worst = '覆盖';
  for (const { category, check } of rows) {
    const status = isNotApplicable(check) ? '不适用' : isPending(check) ? '待核实' : check.status_main;
    props[`${category}_status`] = status;
    props[`${category}_verified`] = !isPending(check);
    props[`${category}_borderline`] = check.borderline;
    props[`${category}_straight_m`] = check.straight_m;
    props[`${category}_route_m`] = check.route_m;
    const via = viaName(check);
    if (via) props[`${category}_via`] = via;
    if (isPending(check) && !isNotApplicable(check)) pending.push(category);
    if (isWalkGap(check)) missing.push(category);
    if ((STATUS_RANK[status] ?? 0) > (STATUS_RANK[worst] ?? 0)) worst = status;
  }
  return {
    missing: missing.join('、'),
    missing_count: missing.length,
    pending: pending.join('、'),
    status: worst,
    'marker-color': STATUS_COLOR[worst] ?? '#1446B0',
    ...props,
  };
}

/** Everything of a health check as one FeatureCollection (export_report format=geojson). */
export function reportCollection(result: AnalysisResult, crs: Crs = 'wgs84'): FeatureCollection {
  const project = projector(result, crs);
  const features = isochroneFeatures(result, { crs });
  const rows = checkRows(result);

  result.communities.forEach((c, index) => {
    const mine = rows.filter((r) => r.index === index);
    const props: Record<string, unknown> = { kind: 'community', name: c.name, ...communityProperties(mine) };
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: project(c.centroid) },
      properties: props,
    });
    if (c.pts.length >= 3) {
      const ring = multiPolygon([c.pts], [{ hole: false, parent: null, area_m2: c.area_m2 ?? 0 }], project);
      if (ring.length) {
        features.push({
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: ring[0]! },
          properties: {
            kind: 'community_outline',
            name: c.name,
            source: c.osm_id ? `OpenStreetMap ${c.osm_id}` : '分析结果',
            status: props.status,
            stroke: props['marker-color'],
            fill: props['marker-color'],
            'fill-opacity': 0.15,
          },
        });
      }
    }
  });

  // walking time to each facility's entrance at the analysis' profile, as the 圈内设施统计 counts it
  const timeTo = facilityTimer(result);
  const radius = circleRadius(result);
  // green: a category this analysis checked per community; grey: counted only
  const checked: readonly string[] = checkedCategories(result);
  for (const p of result.pois) {
    const t = timeTo(p.navi_xy ?? p.xy);
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: project(p.xy) },
      properties: {
        kind: 'poi',
        name: p.name,
        category: p.cat,
        source: p.source,
        uid: p.uid,
        ...(p.stall_of ? { stall_of: p.stall_of } : {}),
        walk_min: t === null ? null : round(t / 60, 1),
        within_walk15: t !== null && t <= LIMIT_S,
        within_circle15: Math.hypot(p.xy[0], p.xy[1]) <= radius,
        'marker-size': 'small',
        'marker-color': checked.includes(p.cat) ? '#0B7A3E' : '#9A9A9A',
      },
    });
  }

  const layers = grayLayers(result);
  (result.gray_areas ?? []).forEach((g, i) => {
    const coords = multiPolygon(g.rings, g.meta, project);
    if (!coords.length) return;
    features.push({
      type: 'Feature',
      geometry: { type: 'MultiPolygon', coordinates: coords },
      properties: {
        kind: 'gray_area',
        name: g.kind === 'pseudo' ? '灰色区域（伪覆盖）' : `灰色区域（至少缺 ${g.min_missing} 类）`,
        gap_kind: g.kind,
        min_missing: g.min_missing,
        area_m2: g.area_m2,
        area_km2: round(g.area_m2 / 1e6, 3),
        polygons: layers[i]?.polygons ?? coords.length,
        communities: layers[i]?.communities.join('、') ?? '',
        fill: g.kind === 'pseudo' ? '#E23A2E' : '#555555',
        'fill-opacity': 0.25,
      },
    });
  });

  for (const [category, entry] of Object.entries(siteSuggestionsOf(result))) {
    for (const s of entry.list) {
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: project(s.xy) },
        properties: {
          kind: 'site_suggestion',
          name: `建议新增${category}（第 ${s.rank} 候选）`,
          category,
          rank: s.rank,
          place: describePlace(result, s.xy),
          covers: s.covers.join('、'),
          gain: s.gain,
          verified: s.verified,
          estimate: !s.verified,
          basis: entry.source === 'analysis' ? '分析结果' : '邻至按 L̂ 估算（未经实测核验）',
          'marker-color': '#1446B0',
          'marker-symbol': 'cross',
        },
      });
    }
  }

  return {
    ...header(result, `${result.meta.name} · 15 分钟生活圈体检`, crs),
    facility_stats: facilityOverview(result)?.rows ?? [],
    features,
  };
}
