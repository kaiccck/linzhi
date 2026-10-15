/**
 * What the mini program's <map> draws, as plain data: polygons, polylines and markers in GCJ-02
 * (Tencent's basemap). The analysis lives in local metres around its centre (BD-09 frame); every
 * point goes metres → BD-09 (model.frame) → GCJ-02 here.
 *
 * Same materials as the web map (apps/web/src/map/paint.ts): the reach in sand with its 15′ edge,
 * the straight 15′ circle dashed grey, communities tinted by the chosen category's verdict (伪覆盖
 * red, 盲区 slate, 走得到 teal, 待核 dashed grey), facility pictograms, the walking route as dots, and
 * the one cobalt line while 走一遍 plays: the walking front.
 */
import {
  bd09ToGcj02,
  gridFromField,
  levelContours,
  type HardCategory,
  type TimeField,
  type XY,
} from '@zoudedao/core';
import type { RouteEvidence } from '@web/data/route';
import { circleR, type Model, type Unit } from '@web/model/derive';
import { checkLook, type Look } from '@web/model/looks';
import type { FacilityMark } from '@web/model/facilities';
import type { SitePin, WhatIfEstimate } from '@web/model/siting';
import { unitNo } from '../model/unitNo';

export interface LatLng {
  latitude: number;
  longitude: number;
}

export interface MapPolygon {
  points: LatLng[];
  strokeWidth: number;
  strokeColor: string;
  fillColor: string;
  zIndex: number;
  dashArray?: [number, number];
}

export interface MapPolyline {
  points: LatLng[];
  color: string;
  width: number;
  dottedLine?: boolean;
  borderColor?: string;
  borderWidth?: number;
  level?: 'abovelabels' | 'abovebuildings' | 'aboveroads';
}

export interface MapLabel {
  content: string;
  color: string;
  fontSize: number;
  bgColor: string;
  borderColor: string;
  borderWidth: number;
  borderRadius: number;
  padding: number;
  anchorX: number;
  anchorY: number;
  textAlign?: 'center';
}

export interface MapMarker extends LatLng {
  id: number;
  iconPath: string;
  width: number;
  height: number;
  anchor?: { x: number; y: number };
  zIndex?: number;
  alpha?: number;
  label?: MapLabel;
  /** for screen readers (WeChat reads it as the marker's name) */
  ariaLabel?: string;
  /** what this marker gives way to when they overlap (WeChat hides the one below) */
  collision?: string;
  collisionRelation?: 'alone' | 'together';
}

/** What a marker stands for, by its id (bindmarkertap only gives the id). */
export type MarkerHit =
  | { kind: 'unit'; code: string }
  | { kind: 'poi'; uid: string; name: string }
  | { kind: 'place'; key: string }
  | { kind: 'site'; key: string }
  | { kind: 'here' }
  | { kind: 'own-site' };

export interface MapCircle extends LatLng {
  radius: number;
  color: string;
  fillColor: string;
  strokeWidth: number;
}

export interface Layers {
  circles: MapCircle[];
  polygons: MapPolygon[];
  polylines: MapPolyline[];
  markers: MapMarker[];
  hits: Map<number, MarkerHit>;
}

export const COL = {
  pseudo: '#E0483E',
  blind: '#3F4A5A',
  ok: '#1F9A8C',
  okEdge: '#62B6AB',
  edge: '#B98010',
  pending: '#98A2B0',
  cobalt: '#1446B0',
  iso: '#A27B47',
  circle: '#7B8594',
  route: '#56616F',
  ink: '#1F2A37',
} as const;

/** Community tints (the web's TINT, as #RRGGBBAA). */
const TINT: Record<Look, { fill: string; stroke: string; dash?: [number, number] }> = {
  ok: { fill: '#D4EDE7F0', stroke: COL.okEdge },
  edge: { fill: '#D4EDE7F0', stroke: COL.edge, dash: [2, 4] },
  'edge-over': { fill: '#FAD6D2F5', stroke: COL.edge, dash: [2, 4] },
  pseudo: { fill: '#FAD6D2F5', stroke: COL.pseudo },
  blind: { fill: '#D4DAE3F7', stroke: COL.blind },
  none: { fill: '#D4DAE3F7', stroke: COL.blind },
  pending: { fill: '#FFFFFFC7', stroke: COL.pending, dash: [5, 4] },
  na: { fill: '#FFFFFF66', stroke: '#A4ADB9' },
  neutral: { fill: '#FFFFFF66', stroke: '#A4ADB9' },
};

/** Text and edge of a unit's code plate per look. */
const PLATE: Record<Look, { color: string; border: string; bg: string }> = {
  ok: { color: '#17776C', border: COL.okEdge, bg: '#FFFFFF' },
  edge: { color: '#8A5F0A', border: COL.edge, bg: '#FFFFFF' },
  'edge-over': { color: '#C4382F', border: COL.edge, bg: '#FFFFFF' },
  pseudo: { color: '#C4382F', border: COL.pseudo, bg: '#FFFFFF' },
  blind: { color: '#FFFFFF', border: COL.blind, bg: COL.blind },
  none: { color: '#FFFFFF', border: COL.blind, bg: COL.blind },
  pending: { color: '#6B7585', border: COL.pending, bg: '#FFFFFF' },
  na: { color: '#5B6675', border: '#C5CCD6', bg: '#FFFFFF' },
  neutral: { color: '#5B6675', border: '#C5CCD6', bg: '#FFFFFF' },
};

/** One entry of the map's legend: a swatch drawn as the map draws it, and its word. */
export interface LegendItem {
  key: string;
  word: string;
  kind: 'plate' | 'area' | 'line';
  color: string;
  border: string;
  bg: string;
  dashed?: boolean;
}

const LEGEND_PLATES: { looks: Look[]; word: string }[] = [
  { looks: ['pseudo'], word: '绕路太远' },
  { looks: ['blind', 'none'], word: '直线也远' },
  { looks: ['edge', 'edge-over'], word: '临界' },
  { looks: ['ok'], word: '走得到' },
  { looks: ['pending'], word: '待核' },
  { looks: ['na'], word: '无对口' },
];

/**
 * What the map shows for this category, in words: the plate styles its communities actually take
 * (a red plate means 绕路太远 …), then the 灰色区域 and the straight circle when they are drawn.
 */
export function legendItems(
  model: Model,
  cat: HardCategory,
  on: { gray: boolean; circle: boolean },
): LegendItem[] {
  const looks = new Set(model.units.map((u) => checkLook(u.checks[cat])));
  const out: LegendItem[] = LEGEND_PLATES.filter((g) => g.looks.some((l) => looks.has(l))).map((g) => {
    const p = PLATE[g.looks[0]!];
    return { key: g.looks[0]!, word: g.word, kind: 'plate', ...p, dashed: g.looks[0] === 'pending' };
  });
  if (on.gray && model.data.gray_areas?.some((g) => g.kind === 'gap'))
    out.push({
      key: 'gray',
      word: '灰色区域',
      kind: 'area',
      color: '',
      border: '#3F4A5A73',
      bg: '#3F4A5A1F',
      dashed: true,
    });
  if (on.circle)
    out.push({
      key: 'circle',
      word: '直线圈',
      kind: 'line',
      color: '',
      border: COL.circle,
      bg: '',
      dashed: true,
    });
  return out;
}

/** Map marker image per facility pictogram (scripts/gen-markers.mjs → /assets/markers). */
const FAC_IMAGE: Record<string, string> = {
  'pg-food': 'food',
  'pg-store': 'store',
  'pg-parcel': 'parcel',
  'pg-bank': 'bank',
  'pg-gym': 'gym',
  'pg-library': 'library',
  'pg-school': 'school',
  'pg-kinder': 'kinder',
  'pg-market': 'market',
  'pg-fresh': 'fresh',
  'pg-pharmacy': 'pharmacy',
  'pg-clinic': 'clinic',
  'pg-metro': 'metro',
  'pg-super': 'super',
  'pg-elder': 'elder',
  'pg-bus': 'bus',
  'pg-park': 'park',
};
export const markerImage = (name: string) => `/assets/markers/${name}.png`;

/** metres in the analysis frame → GCJ-02 for the basemap */
export function toLatLng(model: Pick<Model, 'frame'>, xy: XY | readonly number[]): LatLng {
  const [lng, lat] = model.frame.toLngLat(xy[0]!, xy[1]!);
  const [glng, glat] = bd09ToGcj02(lng, lat);
  return { latitude: glat, longitude: glng };
}

/** GCJ-02 back to the analysis frame (a tap on the map) and BD-09 (what the server takes). */
export { gcj02ToBd09 } from '@zoudedao/core';

const grids = new WeakMap<TimeField, ReturnType<typeof gridFromField>>();

/**
 * The reach at T seconds for a walker `scale` times slower than the measured adult: closed outer
 * rings in metres (holes left out — the basemap's polygons cannot cut them).
 */
export function reachRings(model: Model, T: number, scale: number): XY[][] {
  if (T <= 0) return [];
  const level = T / scale;
  // the stored 15′ rings when they are exactly what is asked
  if (Math.abs(level - 900) < 1e-6 && model.data.contours?.['900']?.length) {
    const meta = model.data.contours_meta?.['900'];
    return model.data.contours['900'].filter((_, i) => !meta?.[i]?.hole);
  }
  let byLevel = ringCache.get(model.data.field);
  if (!byLevel) {
    byLevel = new Map();
    ringCache.set(model.data.field, byLevel);
  }
  const key = Math.round(level);
  const hit = byLevel.get(key);
  if (hit) return hit;
  let grid = grids.get(model.data.field);
  if (!grid) {
    grid = gridFromField(model.data.field);
    grids.set(model.data.field, grid);
  }
  const c = levelContours(grid, level, { chaikin: 1, simplify_m: 8, minRing_m2: 400 });
  const rings = c.rings.filter((_, i) => !c.meta[i]?.hole);
  // the heat map asks for every minute on each redraw: keep the rings of the steady levels
  if (byLevel.size < 64) byLevel.set(key, rings);
  return rings;
}
const ringCache = new WeakMap<TimeField, Map<number, XY[][]>>();

/**
 * Where each community's code plate sits around its point, so plates do not cover each other: the
 * chosen and the gap communities first, each at the first of five spots (on the point, right, left,
 * above, below) clear of the plates already placed. Measured in points at the area's own framing
 * (the 15′ circle across the screen); codes that find no clear spot stay on their point, and a
 * covered community's code still gives way where they crowd (marker collision).
 */
function codeSpots(model: Model, s: LayerInput, lookOf: (u: Unit) => Look): Map<string, [number, number]> {
  // conservative: a narrow phone, the circle with its margin (about 9 m a point at 15′)
  const mPerPt = (2 * circleR(model, 1) * 1.3) / 300;
  const H = 19;
  const width = (text: string) =>
    [...text].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e80 ? 11.5 : 6.6), 9);
  const rank = (u: Unit) => {
    if (s.hot === u.code || s.selected === u.code || s.lit?.has(u.code)) return 0;
    const l = lookOf(u);
    return l === 'ok' || l === 'edge' || l === 'neutral' ? 2 : 1;
  };
  const placed: [number, number, number, number][] = [];
  const out = new Map<string, [number, number]>();
  for (const u of [...model.units].sort((a, b) => rank(a) - rank(b))) {
    const [x, y] = u.label_xy ?? u.centroid;
    const px = x / mPerPt;
    const py = -y / mPerPt;
    const w = width(plateText(u, rank(u) === 0));
    const tries: [number, number][] = [
      [-w / 2, -H / 2],
      [6, -H / 2],
      [-w - 6, -H / 2],
      [-w / 2, -H - 5],
      [-w / 2, 5],
    ];
    const box = ([ax, ay]: [number, number]): [number, number, number, number] => [
      px + ax,
      py + ay,
      px + ax + w,
      py + ay + H,
    ];
    const clear = (b: [number, number, number, number]) =>
      placed.every((q) => b[2] + 2 <= q[0] || q[2] + 2 <= b[0] || b[3] + 2 <= q[1] || q[3] + 2 <= b[1]);
    const spot = tries.find((t) => clear(box(t))) ?? tries[0]!;
    placed.push(box(spot));
    out.set(u.code, [Math.round(spot[0]), Math.round(spot[1])]);
  }
  return out;
}

/**
 * A community's plate: its number (the list and the report show the same number beside the
 * name); the chosen or lit one adds the name, so the community in question reads on the map.
 */
const plateText = (u: Unit, named: boolean) => (named ? `${unitNo(u.code)} ${u.nameMain}` : unitNo(u.code));

/** Alpha of one minute's layer of the heat map: 14 stacked deepen the centre to about 0.5. */
const HEAT_ALPHA = '0F';

/** A circle as a closed dashed line (the basemap's circles cannot be dashed). */
function circlePoints(model: Model, r: number, n = 72): LatLng[] {
  const pts: LatLng[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push(toLatLng(model, [r * Math.cos(a), r * Math.sin(a)]));
  }
  return pts;
}

export interface LayerInput {
  model: Model;
  cat: HardCategory;
  /** walking time shown, seconds */
  T: number;
  /** walking-time multiplier of the profile (and the crossing allowance) */
  scale: number;
  /** 走一遍 plays: no verdict on the plates yet, the front moves */
  playing: boolean;
  circle: boolean;
  /** 耗时色阶 is on: the reach in its minute steps (5′, 10′, 15′), deeper towards the centre */
  heat: boolean;
  gray: boolean;
  hot: string | null;
  /** the unit whose walking route is on the map */
  selected: string | null;
  route: RouteEvidence | null;
  /** 规划: suggested sites, the planner's own site and what it would fix */
  plan: { pins: SitePin[]; hotSite: string | null; site: XY | null; estimate: WhatIfEstimate | null } | null;
  /**
   * One category's facilities in place of the checked category's (15 分钟能走到 → 餐饮 …): those
   * reached on foot in full, the rest the circle only claims dimmed, the picked one named.
   */
  places: { marks: readonly FacilityMark[]; icon: string; selected: string | null } | null;
  /** places a 问询 citation names */
  lit: ReadonlySet<string> | null;
  /** the walk of the worst detour (概览 → 绕路最远的方向), in metres */
  detour?: XY[] | null;
  /** 怎么测出来的: the measured samples (batch routing, route vertices) and the barriers found */
  method?: boolean;
  /** a point picked on the map as the next check's centre (GCJ-02, as the map gave it) */
  pickAt?: LatLng | null;
}

export function buildLayers(s: LayerInput): Layers {
  const { model } = s;
  const polygons: MapPolygon[] = [];
  const polylines: MapPolyline[] = [];
  const circles: MapCircle[] = [];
  const markers: MapMarker[] = [];
  const hits = new Map<number, MarkerHit>();
  let nextId = 1;
  const mark = (m: Omit<MapMarker, 'id'>, hit: MarkerHit) => {
    const id = nextId++;
    markers.push({ id, ...m });
    hits.set(id, hit);
  };

  /* ---------- the reach ---------- */
  // 耗时色阶: the walking-time field as a heat map — one faint sand layer per minute walked, stacked,
  // so the colour deepens towards the centre (where the most minutes are left) and fades towards
  // the edge; 5′ and 10′ as hairlines, the time shown as the edge. Native polygons, which every
  // runtime draws (a ground overlay image is not drawn by the devtools simulator)
  if (s.heat && !s.playing) {
    for (let L = 60; L < s.T - 1; L += 60) {
      const hair = L % 300 === 0;
      for (const ring of reachRings(model, L, s.scale)) {
        polygons.push({
          points: ring.map((p) => toLatLng(model, p)),
          fillColor: '#E3B865' + HEAT_ALPHA,
          strokeColor: hair ? '#A27B4759' : '#00000000',
          strokeWidth: hair ? 1 : 0,
          zIndex: 1,
        });
      }
    }
    for (const ring of reachRings(model, s.T, s.scale)) {
      polygons.push({
        points: ring.map((p) => toLatLng(model, p)),
        fillColor: '#F2DCAE59',
        strokeColor: COL.iso,
        strokeWidth: 2,
        zIndex: 1,
      });
    }
  } else {
    for (const ring of reachRings(model, s.T, s.scale)) {
      polygons.push({
        points: ring.map((p) => toLatLng(model, p)),
        fillColor: s.playing ? '#EAC47C4D' : '#EAC47C59',
        strokeColor: s.playing ? COL.cobalt : COL.iso,
        strokeWidth: 2,
        zIndex: 1,
      });
    }
  }

  /* ---------- 灰色区域 ---------- */
  // the gaps only (the 伪覆盖 areas lie within them and would darken them twice), light enough
  // that the codes on them stay legible
  if (s.gray && !s.playing) {
    for (const g of model.data.gray_areas ?? []) {
      if (g.kind !== 'gap') continue;
      g.rings.forEach((ring, i) => {
        if (g.meta[i]?.hole) return;
        // the levels nest (缺 2 类 lies within 缺 1 类): only the outermost is filled, the deeper ones
        // are outlined, so nothing darkens by stacking
        polygons.push({
          points: ring.map((p) => toLatLng(model, p)),
          fillColor: g.min_missing <= 1 ? '#3F4A5A1F' : '#00000000',
          strokeColor: g.min_missing <= 1 ? '#3F4A5A73' : '#3F4A5AA6',
          strokeWidth: 1,
          zIndex: 2,
          dashArray: [5, 4],
        });
      });
    }
  }

  /* ---------- the straight 15′ circle ---------- */
  if (s.circle) {
    polylines.push({
      points: circlePoints(model, circleR(model, s.scale)),
      color: COL.circle,
      width: 1.5,
      dottedLine: true,
      level: 'abovebuildings',
    });
  }

  /* ---------- communities ---------- */
  const flips = new Set(s.plan?.estimate?.flips.map((f) => f.unit.code) ?? []);
  const lookOf = (u: Unit): Look => (s.playing ? 'neutral' : checkLook(u.checks[s.cat]));
  const spots = codeSpots(model, s, lookOf);
  for (const u of model.units) {
    const look = lookOf(u);
    const hot = s.hot === u.code || s.selected === u.code || !!s.lit?.has(u.code);
    if (u.pts.length >= 3) {
      const t = TINT[look];
      const reached = s.playing && u.t >= 0 && u.t * s.scale <= s.T;
      polygons.push({
        points: u.pts.map((p) => toLatLng(model, p)),
        fillColor: reached ? '#FFFFFFB8' : t.fill,
        strokeColor: flips.has(u.code) ? COL.ok : t.stroke,
        strokeWidth: hot ? 3 : flips.has(u.code) ? 2 : 1.5,
        zIndex: 3,
        ...(t.dash && !flips.has(u.code) ? { dashArray: t.dash } : {}),
      });
    }
    const p = PLATE[look];
    mark(
      {
        ...toLatLng(model, u.label_xy ?? u.centroid),
        iconPath: markerImage('dot'),
        width: 1,
        height: 1,
        zIndex: hot ? 30 : look === 'ok' || look === 'edge' || look === 'neutral' ? 18 : 22,
        // a covered community's code gives way where codes crowd; a gap's never does
        ...(look === 'ok' || look === 'edge'
          ? { collision: 'marker', collisionRelation: 'alone' as const }
          : {}),
        label: {
          content: plateText(u, hot),
          color: hot && look !== 'blind' && look !== 'none' ? '#FFFFFF' : p.color,
          bgColor: hot && look !== 'blind' && look !== 'none' ? p.border : p.bg,
          borderColor: p.border,
          borderWidth: 1,
          borderRadius: 9,
          fontSize: 11,
          padding: 3,
          anchorX: spots.get(u.code)?.[0] ?? -10,
          anchorY: spots.get(u.code)?.[1] ?? -10,
          textAlign: 'center',
        },
        ariaLabel: `${u.code} ${u.name}`,
      },
      { kind: 'unit', code: u.code },
    );
  }

  /* ---------- facilities ---------- */
  if (s.places) {
    const img = FAC_IMAGE[s.places.icon] ?? 'super';
    for (const m of s.places.marks) {
      const sel = s.places.selected === m.key;
      mark(
        {
          ...toLatLng(model, m.face.navi_xy ?? m.face.xy),
          iconPath: markerImage(m.reach ? `fac-${img}` : `fac-${img}-dim`),
          width: sel ? 34 : m.reach ? 24 : 16,
          height: sel ? 34 : m.reach ? 24 : 16,
          anchor: { x: 0.5, y: 0.5 },
          zIndex: sel ? 45 : m.reach ? 14 : 9,
          ...(sel
            ? {
                label: {
                  content: m.face.name,
                  color: COL.ink,
                  bgColor: '#FFFFFF',
                  borderColor: '#DFE2E7',
                  borderWidth: 1,
                  borderRadius: 6,
                  fontSize: 12,
                  padding: 5,
                  anchorX: 18,
                  anchorY: -30,
                },
              }
            : {}),
          ariaLabel: m.face.name,
        },
        { kind: 'place', key: m.key },
      );
    }
  } else {
    // on a phone only the chosen category's facilities: the others would bury the codes
    const kin = s.cat === '菜市场' ? ['菜市场', '生鲜超市'] : [s.cat];
    for (const poi of model.pois) {
      const img = FAC_IMAGE[poi.icon];
      if (!img || !kin.includes(poi.cat)) continue;
      mark(
        {
          ...toLatLng(model, poi.xy),
          iconPath: markerImage(`fac-${img}`),
          width: 26,
          height: 26,
          anchor: { x: 0.5, y: 0.5 },
          zIndex: 12,
          ariaLabel: `${poi.cat} ${poi.name}`,
        },
        { kind: 'poi', uid: poi.uid, name: poi.name },
      );
    }
  }

  /* ---------- 怎么测出来的 ---------- */
  if (s.method && !s.playing) {
    for (const x of model.data.samples) {
      const matrix = x.src === 'routematrix';
      circles.push({
        ...toLatLng(model, x.xy),
        radius: matrix ? 9 : 6,
        color: '#00000000',
        fillColor: matrix ? '#2468F2CC' : '#A27B47B3',
        strokeWidth: 0,
      });
    }
    for (const b of model.data.barriers ?? []) {
      polylines.push({ points: [toLatLng(model, b.a), toLatLng(model, b.b)], color: '#3F4A5ACC', width: 2 });
    }
  }

  /* ---------- the worst detour ---------- */
  if (s.detour && s.detour.length > 1) {
    polylines.push({
      points: s.detour.map((p) => toLatLng(model, p)),
      color: COL.pseudo,
      width: 4,
      dottedLine: true,
      borderColor: '#FFFFFF',
      borderWidth: 1.5,
      level: 'abovelabels',
    });
  }

  /* ---------- the walking route ---------- */
  if (s.route && s.route.path.length > 1) {
    polylines.push({
      points: s.route.path.map((p) => toLatLng(model, p)),
      color: COL.route,
      width: 4,
      dottedLine: true,
      borderColor: '#FFFFFF',
      borderWidth: 1.5,
      level: 'abovelabels',
    });
    const end = s.route.facility?.entrance_xy ?? s.route.path[s.route.path.length - 1]!;
    mark(
      {
        ...toLatLng(model, end),
        iconPath: markerImage('route-end'),
        width: 14,
        height: 14,
        anchor: { x: 0.5, y: 0.5 },
        zIndex: 25,
        ...(s.route.facility
          ? {
              label: {
                content: s.route.facility.name,
                color: COL.ink,
                bgColor: '#FFFFFF',
                borderColor: '#D9DEE5',
                borderWidth: 1,
                borderRadius: 4,
                fontSize: 11,
                padding: 4,
                anchorX: 10,
                anchorY: -24,
              },
            }
          : {}),
      },
      { kind: 'poi', uid: '', name: s.route.facility?.name ?? '' },
    );
  }

  /* ---------- 规划 ---------- */
  if (s.plan) {
    for (const pin of s.plan.pins) {
      if (pin.cat !== s.cat) continue;
      const hot = s.plan.hotSite === pin.key;
      mark(
        {
          ...toLatLng(model, pin.xy),
          iconPath: markerImage('site-sug'),
          width: hot ? 24 : 20,
          height: hot ? 24 : 20,
          anchor: { x: 0.5, y: 0.5 },
          zIndex: 26,
          label: {
            content: `建议 ${pin.rank}`,
            color: hot ? '#FFFFFF' : COL.cobalt,
            bgColor: hot ? COL.cobalt : '#FFFFFF',
            borderColor: COL.cobalt,
            borderWidth: 1,
            borderRadius: 4,
            fontSize: 11,
            padding: 3,
            anchorX: 12,
            anchorY: -22,
          },
          ariaLabel: `建议补点 ${pin.rank}${pin.label ? `：${pin.label}` : ''}`,
        },
        { kind: 'site', key: pin.key },
      );
    }
    if (s.plan.site) {
      mark(
        {
          ...toLatLng(model, s.plan.site),
          iconPath: markerImage('site'),
          width: 30,
          height: 30,
          anchor: { x: 0.5, y: 0.5 },
          zIndex: 40,
          ariaLabel: '你放的新设施',
        },
        { kind: 'own-site' },
      );
      // the walks the new site would make: straight hairlines to the communities it flips
      for (const f of s.plan.estimate?.flips ?? []) {
        polylines.push({
          points: [toLatLng(model, s.plan.site), toLatLng(model, f.unit.centroid)],
          color: '#1F9A8CB3',
          width: 1.5,
          dottedLine: true,
        });
      }
    }
  }

  /* ---------- a picked centre ---------- */
  if (s.pickAt) {
    mark(
      {
        ...s.pickAt,
        iconPath: markerImage('pick'),
        width: 34,
        height: 34,
        anchor: { x: 0.5, y: 0.5 },
        zIndex: 60,
      },
      { kind: 'here' },
    );
  }

  /* ---------- 你在这里 ---------- */
  mark(
    {
      ...toLatLng(model, [0, 0]),
      iconPath: markerImage('here'),
      width: 32,
      height: 32,
      anchor: { x: 0.5, y: 0.5 },
      zIndex: 50,
      ariaLabel: `分析中心 ${model.data.meta.center_label ?? ''}`,
    },
    { kind: 'here' },
  );

  return { circles, polygons, polylines, markers, hits };
}

/** The points the map frames on a new analysis: the 15′ circle's bounding box. */
export function framePoints(model: Model, scale = 1): LatLng[] {
  const r = Math.max(circleR(model, scale), 600) * 1.05;
  return [toLatLng(model, [-r, -r]), toLatLng(model, [r, r])];
}
