/**
 * Canvas drawing of the map, ported from design/mockups/c-light/app.js (drawMap).
 *
 * Two canvases over the basemap, in the mockup's print order:
 *  - `under`: the walking-time field and the 灰色区域 tint. Over Baidu this canvas is transparent and
 *    multiplied in (`mix-blend-mode: multiply`, styles.css): the Baidu layer itself is never blended, so
 *    its streets and label glyphs stay crisp, and the warm reach tints the ground, the blocks and the
 *    streets alike. Its colours are the mockup's divided by the ground (`multiplied`), so on the bare
 *    ground the reach prints exactly the mockup's tones. Offline, this canvas carries the self-drawn
 *    OpenStreetMap basemap too (ground, land use and water under the field, streets over it).
 *  - `over`: the 灰色区域 edge, the community tints, the isochrones, the moving front, the dashed
 *    straight circle and the measured route the finding quotes; offline, the street and place names.
 *
 * Everything with a verdict is held back while 走一遍 plays and lands at 15′ (The Verdict Waits).
 * The order is `paintPlan`, which the tests read.
 */
import type { BaseLayers, GrayArea, XY } from '@zoudedao/core';
import { isoSegments } from '../geo/field.js';
import type { View } from '../geo/view.js';
import { circleR, type Model, type Unit } from '../model/derive.js';
import type { Look } from '../model/looks.js';
import { drawBaseLabels, isWall, type Quad } from './baseLabels.js';
import { GROUND } from './signMapStyle.js';

export { isWall };

export const COL = {
  pseudo: '#e0483e',
  blind: '#3f4a5a',
  ok: '#1f9a8c',
  edge: '#b98010',
  pending: '#98a2b0',
  cobalt: '#1446b0',
  ink: '#1f2a37',
  ink2: '#5b6675',
  /** the reach's 15′ edge and its 5′ / 10′ hairlines */
  iso: '#a27b47',
  circle: '#7b8594',
  route: '#56616f',
} as const;

/** Community tints: flat, nearly opaque, with a 1.5 px edge in the status colour. */
export const TINT: Record<Exclude<Look, 'edge' | 'edge-over'>, string> = {
  ok: 'rgba(212,237,231,0.94)',
  pseudo: 'rgba(250,214,210,0.96)',
  blind: 'rgba(212,218,227,0.97)',
  pending: 'rgba(255,255,255,0.78)',
  none: 'rgba(212,218,227,0.97)',
  neutral: 'rgba(255,255,255,0.3)',
};
const EDGE: Record<Exclude<Look, 'edge' | 'edge-over'>, string> = {
  ok: '#62b6ab',
  pseudo: COL.pseudo,
  blind: COL.blind,
  pending: COL.pending,
  none: COL.blind,
  neutral: '#a4adb9',
};

/**
 * The walk, one warm hue family: sand at the centre, paler towards 15′ (alpha over the ground), a
 * quiet warm grey from 15′ to 20′. The ramp is continuous; the isochrones carry the minute steps.
 */
export const RAMP: [number, number, number, number, number][] = [
  [0, 234, 196, 124, 0.56],
  [300, 238, 207, 148, 0.5],
  [600, 242, 219, 172, 0.46],
  [900, 245, 229, 194, 0.44],
];
export const BEYOND: [number, number, number, number] = [214, 210, 200, 0.4];
/** The 15′ reach with 耗时色阶 off: one flat sand. */
export const FLAT: [number, number, number, number] = [240, 216, 168, 0.46];

const GROUND_RGB = [1, 3, 5].map((i) => parseInt(GROUND.slice(i, i + 2), 16));

/**
 * A colour as the multiply source that prints it over the ground: with an opaque ground G, source-over
 * of C at alpha a gives G(1 − a) + Ca, and multiply of S at alpha a gives G(1 − a) + GSa — equal when
 * S = C / G. So the field drawn over Baidu keeps the mockup's tones on the bare ground.
 */
export function multiplied(c: readonly number[]): [number, number, number, number] {
  return [
    Math.min(255, (c[0]! / GROUND_RGB[0]!) * 255),
    Math.min(255, (c[1]! / GROUND_RGB[1]!) * 255),
    Math.min(255, (c[2]! / GROUND_RGB[2]!) * 255),
    c[3]!,
  ];
}

export function rampAt(t: number): [number, number, number, number] {
  if (t <= 0) return RAMP[0]!.slice(1) as [number, number, number, number];
  for (let i = 1; i < RAMP.length; i++) {
    const b = RAMP[i]!;
    if (t <= b[0]) {
      const a = RAMP[i - 1]!;
      const k = (t - a[0]) / (b[0] - a[0]);
      return [
        a[1] + (b[1] - a[1]) * k,
        a[2] + (b[2] - a[2]) * k,
        a[3] + (b[3] - a[3]) * k,
        a[4] + (b[4] - a[4]) * k,
      ];
    }
  }
  return RAMP[RAMP.length - 1]!.slice(1) as [number, number, number, number];
}

/** 方法 layer inks: two muted dot tones (batch routing, route vertices), the paths, the barriers. */
export const METHOD = {
  matrix: 'rgba(86,97,111,0.8)',
  vertex: 'rgba(162,123,71,0.95)',
  path: 'rgba(162,123,71,0.55)',
  barrier: 'rgba(31,42,55,0.85)',
} as const;

/** 灰色区域: a flat grey, deeper where two or more hard categories are missing on foot; no screen. */
export const GRAY = {
  /** washes the warm reach back to the ground first, so grey over sand never turns olive */
  wash: 'rgba(238,240,242,0.78)',
  /** the same wash on the multiplied canvas: back to white, which multiplies to nothing */
  washMultiply: 'rgba(255,255,255,0.8)',
  tint: 'rgba(96,108,124,0.16)',
  deeper: 'rgba(84,96,112,0.12)',
  edge: 'rgba(84,96,112,0.55)',
} as const;

/** Layers of the `under` canvas, bottom first. */
export type UnderStep = 'ground' | 'field' | 'gray-fill' | 'streets';
/** Layers of the `over` canvas, bottom first; the HTML codes, marks and cards sit above both. */
export type OverStep =
  'gray-edge' | 'plates' | 'isochrones' | 'method' | 'front' | 'circle' | 'route' | 'labels';

export interface PlanInput {
  T: number;
  circle: boolean;
  playing: boolean;
  /** the 灰色区域 toggle */
  gray: boolean;
  hasGray: boolean;
  offline: boolean;
  hasBase: boolean;
  /** the route a finding quotes is on screen */
  route: boolean;
  /** 方法: the samples, the walking paths and the detected barriers */
  method?: boolean;
}

/** What gets painted, in print order (The Verdict Waits: gray areas and the route wait for 15′). */
export function paintPlan(p: PlanInput): { under: UnderStep[]; over: OverStep[] } {
  const verdict = !p.playing;
  const gray = p.gray && p.hasGray && verdict;
  const base = p.offline && p.hasBase;
  const under: UnderStep[] = ['ground', 'field'];
  if (gray) under.push('gray-fill');
  if (base) under.push('streets');
  const over: OverStep[] = [];
  if (gray) over.push('gray-edge');
  over.push('plates', 'isochrones');
  // the method layer is data, not a verdict, but it keeps out of the one authored moment
  if (p.method && !p.playing) over.push('method');
  if (![300, 600, 900].includes(p.T) && p.T > 0) over.push('front');
  if (p.circle) over.push('circle');
  if (verdict && p.T >= 900 && p.route) over.push('route');
  if (base) over.push('labels');
  return { under, over };
}

export interface PaintState {
  T: number;
  /** the profile's walking-time multiplier (the straight circle's radius follows it) */
  scale: number;
  /**
   * the time field's multiplier: the profile's, times 1.05 with 含过街等待 (a sensitivity estimate on
   * the field and its isochrones only); defaults to `scale`
   */
  timeScale?: number;
  circle: boolean;
  heat: boolean;
  hot: string | null;
  /** further units drawn lit: the one whose route is shown, a citation's units */
  lit?: ReadonlySet<string>;
  playing: boolean;
  /** 灰色区域 layer on */
  gray: boolean;
  /** 方法 layer on */
  method?: boolean;
  /** each unit's look: the chosen category's verdict, the worst of three, or neutral */
  look(u: Unit): Look;
  /** the measured route a finding quotes */
  route: boolean;
  /** units a planned site would bring within the rule (a teal edge on their outline: they would be 覆盖) */
  flips?: ReadonlySet<string> | undefined;
  /** offline only: boxes the basemap's names must stay clear of (codes, marks, cards, controls) */
  taken?: readonly Quad[];
}

type Ctx = CanvasRenderingContext2D;

function trace(c: Ctx, v: View, pts: readonly (XY | readonly number[])[], close = false) {
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const X = v.x(p[0]!);
    const Y = v.y(p[1]!);
    if (i === 0) c.moveTo(X, Y);
    else c.lineTo(X, Y);
  }
  if (close) c.closePath();
}

const LAND: Record<string, string> = {
  residential: '#e6e9ec',
  commercial: '#ebe7e8',
  industrial: '#e5e6ea',
  school: '#ebe9e3',
  park: '#d9e9d4',
  green: '#d9e9d4',
  other: '#e8eaeb',
};
const WATER = '#c9dcec';
const ROAD_CASE = '#d3d9e0';
/** street width and casing (px at the reference scale), by class */
const ROAD: Record<string, [number, number]> = {
  footway: [0, 0],
  service: [1.3, 0],
  other: [1.3, 0],
  residential: [2.6, 1.1],
  tertiary: [3.4, 1.2],
  secondary: [4.4, 1.3],
  primary: [5.2, 1.3],
  trunk: [5.6, 1.4],
  motorway: [6, 1.4],
};
const ORDER = ['service', 'other', 'residential', 'tertiary', 'secondary', 'primary', 'trunk', 'motorway'];

export class ScenePainter {
  private readonly rc: HTMLCanvasElement;
  private readonly rctx: Ctx;
  private readonly img: ImageData;
  private fieldKey = '';
  /** 'gap' gray areas, fewest missing categories first (each level nests inside the one before) */
  private readonly grayGaps: GrayArea[];

  constructor(private readonly model: Model) {
    const { raster } = model;
    this.rc = document.createElement('canvas');
    this.rc.width = raster.w;
    this.rc.height = raster.h;
    this.rctx = this.rc.getContext('2d')!;
    this.img = this.rctx.createImageData(raster.w, raster.h);
    this.grayGaps = (model.data.gray_areas ?? [])
      .filter((g) => g.kind === 'gap' && g.rings.length > 0)
      .sort((a, b) => a.min_missing - b.min_missing);
  }

  private paintField(T: number, scale: number, heat: boolean, multiply: boolean) {
    const key = `${T}|${scale}|${heat}|${multiply}`;
    if (key === this.fieldKey) return;
    this.fieldKey = key;
    const d = this.img.data;
    const t = this.model.raster.t;
    for (let i = 0, n = t.length; i < n; i++) {
      const t0 = t[i]!;
      const o = i * 4;
      const tv = t0 * scale;
      if (t0 < 0 || tv > T) {
        d[o + 3] = 0;
        continue;
      }
      const c0 = tv > 900 ? BEYOND : heat ? rampAt(tv) : FLAT;
      const c = multiply ? multiplied(c0) : c0;
      d[o] = c[0];
      d[o + 1] = c[1];
      d[o + 2] = c[2];
      d[o + 3] = c[3] * 255;
    }
    this.rctx.putImageData(this.img, 0, 0);
  }

  /** Paints both canvases. Canvas bitmaps must already be sized to v.width/height × dpr. */
  paint(under: Ctx, over: Ctx, v: View, st: PaintState, dpr: number, offline: boolean) {
    const { data, raster, units, detour } = this.model;
    const W = v.width;
    const H = v.height;
    const plan = paintPlan({
      T: st.T,
      circle: st.circle,
      playing: st.playing,
      gray: st.gray,
      hasGray: this.grayGaps.length > 0,
      offline,
      hasBase: !!data.base,
      route: st.route && !!detour,
      method: !!st.method,
    });
    const ts = st.timeScale ?? st.scale;

    // ---------------- under ----------------
    const c = under;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, c.canvas.width, c.canvas.height);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const step of plan.under) {
      switch (step) {
        case 'ground':
          // over Baidu the canvas stays clear: the map is the ground
          if (!offline) break;
          c.fillStyle = GROUND;
          c.fillRect(0, 0, W, H);
          if (data.base) this.paintBaseGround(c, v, data.base);
          break;
        case 'field':
          if (st.T <= 0) break;
          this.paintField(st.T, ts, st.heat, !offline);
          c.imageSmoothingEnabled = true;
          c.imageSmoothingQuality = 'high';
          c.drawImage(
            this.rc,
            v.x(raster.x0),
            v.y(raster.y1),
            (raster.x1 - raster.x0) * v.sx,
            (raster.y1 - raster.y0) * v.sy,
          );
          break;
        case 'gray-fill':
          this.paintGrayFill(c, v, !offline);
          break;
        case 'streets':
          if (data.base) this.paintBaseRoads(c, v, data.base);
          break;
      }
    }

    // ---------------- over ----------------
    const o = over;
    o.setTransform(1, 0, 0, 1, 0, 0);
    o.clearRect(0, 0, o.canvas.width, o.canvas.height);
    o.setTransform(dpr, 0, 0, dpr, 0, 0);
    o.lineJoin = 'round';
    o.lineCap = 'round';

    for (const step of plan.over) {
      switch (step) {
        case 'gray-edge':
          this.paintGrayEdge(o, v);
          break;
        case 'plates':
          for (const u of units) {
            if (u.pts.length < 3) continue; // live results carry no outlines (Baidu AOI is paid)
            const look = st.playing ? 'neutral' : st.look(u);
            const hot = st.hot === u.code || !!st.lit?.has(u.code);
            o.beginPath();
            trace(o, v, u.pts, true);
            if (look === 'neutral') {
              const reached = st.playing && u.t >= 0 && u.t * ts <= st.T;
              o.fillStyle = reached ? 'rgba(255,255,255,0.72)' : TINT.neutral;
            } else if (look === 'edge') o.fillStyle = TINT.ok;
            else if (look === 'edge-over') o.fillStyle = TINT.pseudo;
            else o.fillStyle = TINT[look];
            o.fill();
            const flip = st.flips?.has(u.code);
            o.lineWidth = hot ? 3 : flip ? 2 : look === 'neutral' ? 1 : 1.5;
            o.strokeStyle = flip ? COL.ok : look === 'edge' || look === 'edge-over' ? COL.edge : EDGE[look];
            if (!flip && (look === 'edge' || look === 'edge-over')) o.setLineDash([1.5, 3]);
            else if (!flip && look === 'pending') o.setLineDash([4, 3]);
            o.stroke();
            o.setLineDash([]);
          }
          break;
        case 'isochrones':
          // 5′ and 10′ as hairlines, 15′ as the clear edge of the reach
          for (const L of [300, 600, 900] as const) {
            if (L > st.T + 1e-6) continue;
            o.beginPath();
            if (ts === 1) {
              for (const ring of data.contours[String(L) as '300' | '600' | '900']) trace(o, v, ring, true);
            } else {
              for (const s of isoSegments(data.field, L, ts)) {
                o.moveTo(v.x(s[0]), v.y(s[1]));
                o.lineTo(v.x(s[2]), v.y(s[3]));
              }
            }
            o.strokeStyle = L === 900 ? COL.iso : 'rgba(162,123,71,0.5)';
            o.lineWidth = L === 900 ? 1.8 : 1;
            o.stroke();
          }
          break;
        case 'front':
          // the moving walking front (the one cobalt line: the walk being walked)
          o.strokeStyle = COL.cobalt;
          o.lineWidth = 2;
          o.beginPath();
          for (const s of isoSegments(data.field, st.T, ts)) {
            o.moveTo(v.x(s[0]), v.y(s[1]));
            o.lineTo(v.x(s[2]), v.y(s[3]));
          }
          o.stroke();
          break;
        case 'method':
          this.paintMethod(o, v);
          break;
        case 'circle': {
          // the straight 15′ claim, at the profile's own radius
          const R = circleR(this.model, st.scale);
          o.setLineDash([6, 5]);
          o.strokeStyle = COL.circle;
          o.lineWidth = 1.4;
          o.lineCap = 'butt';
          o.beginPath();
          o.ellipse(v.x(0), v.y(0), R * v.sx, R * v.sy, 0, 0, Math.PI * 2);
          o.stroke();
          o.setLineDash([]);
          o.lineCap = 'round';
          break;
        }
        case 'route': {
          // the measured Baidu walking route the finding quotes: dots on a white casing
          if (!detour) break;
          o.beginPath();
          trace(o, v, detour.path.pts);
          o.strokeStyle = 'rgba(255,255,255,0.95)';
          o.lineWidth = 5;
          o.stroke();
          o.setLineDash([0.1, 5.2]);
          o.strokeStyle = COL.route;
          o.lineWidth = 2.4;
          o.stroke();
          o.setLineDash([]);
          break;
        }
        case 'labels':
          if (data.base) drawBaseLabels(o, v, data.base, st.taken ?? [], new Set(units.map((u) => u.name)));
          break;
      }
    }
  }

  /**
   * 方法 (for judges): how the time field was measured — the walking routes Baidu returned (thin warm
   * lines), their vertices and the batch-routing samples as tiny dots in two muted tones, and the
   * barriers found from contradictory times (thin dark strokes).
   */
  private paintMethod(o: Ctx, v: View) {
    const { paths, samples, barriers } = this.model.data;
    o.lineCap = 'round';
    o.lineJoin = 'round';
    o.beginPath();
    for (const p of paths) trace(o, v, p.pts);
    o.strokeStyle = METHOD.path;
    o.lineWidth = 1.1;
    o.stroke();
    for (const [src, color, r] of [
      ['routematrix', METHOD.matrix, 1.7],
      ['directionlite_path', METHOD.vertex, 1.5],
    ] as const) {
      o.beginPath();
      for (const s of samples) {
        if (s.src !== src) continue;
        const X = v.x(s.xy[0]);
        const Y = v.y(s.xy[1]);
        o.moveTo(X + r, Y);
        o.arc(X, Y, r, 0, Math.PI * 2);
      }
      o.fillStyle = color;
      o.fill();
    }
    if (barriers?.length) {
      o.beginPath();
      for (const b of barriers) {
        o.moveTo(v.x(b.a[0]), v.y(b.a[1]));
        o.lineTo(v.x(b.b[0]), v.y(b.b[1]));
      }
      o.strokeStyle = 'rgba(255,255,255,0.7)';
      o.lineWidth = 2.8;
      o.stroke();
      o.strokeStyle = METHOD.barrier;
      o.lineWidth = 1.3;
      o.stroke();
    }
  }

  /** 灰色区域, part 1 (under): wash, then the grey tint, deeper for each further missing category. */
  private paintGrayFill(c: Ctx, v: View, multiply: boolean) {
    this.grayGaps.forEach((g, i) => {
      c.beginPath();
      for (const ring of g.rings) trace(c, v, ring, true);
      if (i === 0) {
        c.fillStyle = multiply ? GRAY.washMultiply : GRAY.wash;
        c.fill('evenodd');
      }
      c.fillStyle = i === 0 ? GRAY.tint : GRAY.deeper;
      c.fill('evenodd');
    });
  }

  /** 灰色区域, part 2 (over, under the tints): a dashed grey edge around the outer level. */
  private paintGrayEdge(o: Ctx, v: View) {
    const outer = this.grayGaps[0];
    if (!outer) return;
    o.beginPath();
    for (const ring of outer.rings) trace(o, v, ring, true);
    o.strokeStyle = GRAY.edge;
    o.lineWidth = 1;
    o.setLineDash([3, 3]);
    o.stroke();
    o.setLineDash([]);
  }

  /** Offline basemap, part 1: land use and water (drawn under the time field). */
  private paintBaseGround(c: Ctx, v: View, base: BaseLayers) {
    for (const l of base.landuse) {
      c.beginPath();
      trace(c, v, l.pts, true);
      c.fillStyle = LAND[l.kind] ?? LAND.other!;
      c.fill();
    }
    c.fillStyle = WATER;
    for (const w of base.water_areas) {
      c.beginPath();
      trace(c, v, w.pts, true);
      c.fill();
    }
    c.strokeStyle = WATER;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    const width: Record<string, number> = { river: 7, canal: 4, stream: 2.5, ditch: 1.6 };
    for (const w of base.waterways) {
      c.lineWidth = width[w.kind] ?? 2.5;
      c.beginPath();
      trace(c, v, w.pts);
      c.stroke();
    }
  }

  /** Offline basemap, part 2: white streets over the field; elevated roads and the S20 a grey band. */
  private paintBaseRoads(c: Ctx, v: View, base: BaseLayers) {
    const k = Math.max(0.8, Math.min(1.25, v.s / 0.33));
    c.lineCap = 'round';
    c.lineJoin = 'round';
    for (const cls of ORDER) {
      const [w, cw] = ROAD[cls]!;
      if (!cw) continue;
      c.strokeStyle = ROAD_CASE;
      c.lineWidth = w * k + cw * 2;
      c.beginPath();
      for (const r of base.roads) if (r.cls === cls && !isWall(r)) trace(c, v, r.pts);
      c.stroke();
    }
    for (const cls of ORDER) {
      const [w] = ROAD[cls]!;
      c.strokeStyle = '#ffffff';
      c.lineWidth = w * k;
      c.beginPath();
      for (const r of base.roads) if (r.cls === cls && !isWall(r)) trace(c, v, r.pts);
      c.stroke();
    }
    // elevated roads and the S20: a quiet grey band (they are the barriers the findings name)
    c.beginPath();
    for (const r of base.roads) if (isWall(r)) trace(c, v, r.pts);
    c.strokeStyle = '#b3bcc7';
    c.lineWidth = 8.6 * k;
    c.stroke();
    c.strokeStyle = '#dde2e8';
    c.lineWidth = 6.2 * k;
    c.stroke();
  }
}
