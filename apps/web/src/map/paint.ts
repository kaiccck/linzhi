/**
 * Canvas drawing of the sign map, ported from design/mockups/a-wayfinding/app.js (draw()).
 *
 * Two canvases around the basemap, in the mockup's print order:
 *  - `under`: Map Paper, the 250 m graticule and the time field. The Baidu layer sits on top of it with
 *    `mix-blend-mode: hard-light` (see signMapStyle.ts), so its white streets and dark labels print
 *    over the yellow exactly like the mockup's roads did. In offline mode this canvas also carries
 *    the self-drawn OSM basemap (land use and water under the field, streets over it).
 *  - `over`: the "inside the circle, not walkable in 15′" hatch, opaque community plates,
 *    isochrones, the moving front, the dashed straight circle and the measured east route.
 */
import type { BaseLayers, XY } from '@zoudedao/core';
import { isoSegments } from '../geo/field.js';
import type { View } from '../geo/view.js';
import type { Model } from '../model/derive.js';
import { PAPER } from './signMapStyle.js';

export const RED = '#e23a2e';
export const INK = '#101316';
const COBALT = '#1446b0';

/** Stepped signage yellow from #FFC400, one tint per walking minute; 15–19 fade to a warm neutral. */
const RAMP: [number, number, number, number][] = [];
for (let m = 0; m < 20; m++) {
  if (m < 15) {
    const k = m / 14;
    RAMP.push([255, 196 + 42 * k, 128 * k, 0.88 - 0.42 * k]);
  } else RAMP.push([232, 226, 206, 0.5]);
}

export interface PaintState {
  T: number;
  scale: number;
  circle: boolean;
  heat: boolean;
  hot: string | null;
  playing: boolean;
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

/** Plate stripe tile (135°, 7 px band + 3 px stripe at 1×), drawn at device resolution. */
function stripeTile(a: string, b: string, dpr: number): HTMLCanvasElement {
  // the approved mockup captures double this at 2× (its tile was scaled by the DPR transform);
  // keep that look but stop growing past 2× so phones do not get giant stripes
  const k = Math.min(dpr, 2);
  const size = Math.max(4, Math.round(10 * k * Math.SQRT2 * dpr));
  const p = document.createElement('canvas');
  p.width = p.height = size;
  const c = p.getContext('2d')!;
  c.fillStyle = a;
  c.fillRect(0, 0, size, size);
  c.strokeStyle = b;
  c.lineWidth = 3 * k * dpr;
  for (let s = -size; s <= size * 2; s += size) {
    c.beginPath();
    c.moveTo(s, size);
    c.lineTo(s + size, 0);
    c.stroke();
  }
  return p;
}

function hatchTile(color: string, spacing: number, width: number, dpr: number): HTMLCanvasElement {
  const size = Math.max(3, Math.round(spacing * dpr * Math.SQRT2));
  const p = document.createElement('canvas');
  p.width = p.height = size;
  const c = p.getContext('2d')!;
  c.strokeStyle = color;
  c.lineWidth = width * dpr;
  for (let s = -size; s <= size * 2; s += size) {
    c.beginPath();
    c.moveTo(s, size);
    c.lineTo(s + size, 0);
    c.stroke();
  }
  return p;
}

const LAND: Record<string, string> = {
  residential: '#dfe3de',
  commercial: '#e4ddd6',
  industrial: '#dcd8d1',
  school: '#e7e1cc',
  park: '#c7e0ba',
  green: '#c7e0ba',
  other: '#e2e4df',
};
const ROAD: Record<string, [number, string | null]> = {
  footway: [0.9, null],
  service: [1.6, '#fff'],
  other: [1.6, '#fff'],
  residential: [2.8, '#fff'],
  tertiary: [3.6, '#fff'],
  secondary: [4.4, '#fff'],
  primary: [5.2, '#fff'],
  trunk: [5.6, '#fff'],
  motorway: [6.2, '#fff'],
};
const ORDER = [
  'footway',
  'service',
  'other',
  'residential',
  'tertiary',
  'secondary',
  'primary',
  'trunk',
  'motorway',
];
type Road = BaseLayers['roads'][number];
export const isWall = (r: Road) => r.elevated || r.cls === 'motorway' || /高架|外环|中环/.test(r.name ?? '');

export class ScenePainter {
  private readonly rc: HTMLCanvasElement;
  private readonly rctx: Ctx;
  private readonly img: ImageData;
  private readonly mask: HTMLCanvasElement;
  private readonly hatch: HTMLCanvasElement;
  private fieldKey = '';
  private maskScale = -1;
  private dpr = 0;
  private red: HTMLCanvasElement | null = null;
  private black: HTMLCanvasElement | null = null;
  private hatchLines: HTMLCanvasElement | null = null;

  constructor(private readonly model: Model) {
    const { raster } = model;
    this.rc = document.createElement('canvas');
    this.rc.width = raster.w;
    this.rc.height = raster.h;
    this.rctx = this.rc.getContext('2d')!;
    this.img = this.rctx.createImageData(raster.w, raster.h);
    this.mask = document.createElement('canvas');
    this.mask.width = raster.w;
    this.mask.height = raster.h;
    this.hatch = document.createElement('canvas');
  }

  private ensureTiles(dpr: number) {
    if (this.dpr === dpr && this.red) return;
    this.dpr = dpr;
    this.red = stripeTile(RED, 'rgba(255,255,255,0.3)', dpr);
    this.black = stripeTile(INK, 'rgba(255,255,255,0.3)', dpr);
    this.hatchLines = hatchTile('rgba(74,81,87,0.55)', 7, 1.1, dpr);
  }

  /** Pattern pinned to the ground (moves with the map) and rendered 1:1 in device pixels. */
  private pattern(c: Ctx, tile: HTMLCanvasElement, v: View, dpr: number, userSpace: boolean): CanvasPattern {
    const p = c.createPattern(tile, 'repeat')!;
    const ox = v.x(0);
    const oy = v.y(0);
    p.setTransform(
      userSpace
        ? new DOMMatrix([1 / dpr, 0, 0, 1 / dpr, ox, oy])
        : new DOMMatrix([1, 0, 0, 1, ox * dpr, oy * dpr]),
    );
    return p;
  }

  private paintField(T: number, scale: number) {
    const key = `${T}|${scale}`;
    if (key === this.fieldKey) return;
    this.fieldKey = key;
    const d = this.img.data;
    const t = this.model.raster.t;
    for (let i = 0, n = t.length; i < n; i++) {
      const tv = t[i]!;
      const val = tv * scale;
      const o = i * 4;
      if (tv < 0 || val > T) {
        d[o + 3] = 0;
        continue;
      }
      const c = RAMP[Math.min(19, Math.floor(val / 60))]!;
      d[o] = c[0];
      d[o + 1] = c[1];
      d[o + 2] = c[2];
      d[o + 3] = c[3] * 255;
    }
    this.rctx.putImageData(this.img, 0, 0);
  }

  /** inside the straight 15′ circle but not walkable within 15′ */
  private paintMask(scale: number) {
    if (scale === this.maskScale) return;
    this.maskScale = scale;
    const { raster, r15 } = this.model;
    const m = this.mask.getContext('2d')!;
    const id = m.createImageData(raster.w, raster.h);
    const d = id.data;
    const lim = 900 / scale;
    for (let r = 0; r < raster.h; r++) {
      const y = raster.y1 - (r + 0.5) * raster.res;
      for (let q = 0; q < raster.w; q++) {
        const x = raster.x0 + (q + 0.5) * raster.res;
        const i = r * raster.w + q;
        const t = raster.t[i]!;
        if (x * x + y * y <= r15 * r15 && (t < 0 || t > lim)) d[i * 4 + 3] = 255;
      }
    }
    m.putImageData(id, 0, 0);
  }

  /** Paints both canvases. Canvas bitmaps must already be sized to v.width/height × dpr. */
  paint(under: Ctx, over: Ctx, v: View, st: PaintState, dpr: number, offline: boolean) {
    this.ensureTiles(dpr);
    const { data, raster, units, r15, eastPath } = this.model;
    const W = v.width;
    const H = v.height;
    const verdictShown = !st.playing;

    // ---------------- under ----------------
    const c = under;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, c.canvas.width, c.canvas.height);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (offline && data.base) this.paintBaseGround(c, v, data.base);
    else {
      // Map Paper under the hard-light Baidu layer (its 50% grey land shows this through)
      c.fillStyle = PAPER;
      c.fillRect(0, 0, W, H);
    }

    // 250 m graticule around the centre (measurement rings, very quiet)
    c.strokeStyle = 'rgba(74,81,87,0.16)';
    c.lineWidth = 1;
    for (let r = 250; r <= 1250; r += 250) {
      c.beginPath();
      c.ellipse(v.x(0), v.y(0), r * v.sx, r * v.sy, 0, 0, Math.PI * 2);
      c.stroke();
    }

    if (st.heat) {
      this.paintField(st.T, st.scale);
      c.imageSmoothingEnabled = true;
      c.drawImage(
        this.rc,
        v.x(raster.x0),
        v.y(raster.y1),
        (raster.x1 - raster.x0) * v.sx,
        (raster.y1 - raster.y0) * v.sy,
      );
    } else {
      c.fillStyle = 'rgba(255,196,0,0.45)';
      c.beginPath();
      for (const ring of data.contours['900']) trace(c, v, ring, true);
      c.fill('evenodd');
    }

    if (offline && data.base) this.paintBaseRoads(c, v, data.base);

    // ---------------- over ----------------
    const o = over;
    o.setTransform(1, 0, 0, 1, 0, 0);
    o.clearRect(0, 0, o.canvas.width, o.canvas.height);
    o.setTransform(dpr, 0, 0, dpr, 0, 0);
    o.lineJoin = 'round';
    o.lineCap = 'round';

    // what the circle claims but feet cannot reach within 15′: the last beat of the walk
    if (st.circle && st.T >= 900 && verdictShown) {
      this.paintMask(st.scale);
      const h = this.hatch;
      if (h.width !== o.canvas.width || h.height !== o.canvas.height) {
        h.width = o.canvas.width;
        h.height = o.canvas.height;
      }
      const hc = h.getContext('2d')!;
      hc.setTransform(1, 0, 0, 1, 0, 0);
      hc.globalCompositeOperation = 'source-over';
      hc.clearRect(0, 0, h.width, h.height);
      hc.fillStyle = this.pattern(hc, this.hatchLines!, v, dpr, false);
      hc.fillRect(0, 0, h.width, h.height);
      hc.globalCompositeOperation = 'destination-in';
      hc.imageSmoothingEnabled = true;
      hc.drawImage(
        this.mask,
        v.x(raster.x0) * dpr,
        v.y(raster.y1) * dpr,
        (raster.x1 - raster.x0) * v.sx * dpr,
        (raster.y1 - raster.y0) * v.sy * dpr,
      );
      hc.globalCompositeOperation = 'source-over';
      o.setTransform(1, 0, 0, 1, 0, 0);
      o.drawImage(h, 0, 0);
      o.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // communities: opaque enamel plates once the verdict lands; neutral outlines while walking
    const red = this.pattern(o, this.red!, v, dpr, true);
    const black = this.pattern(o, this.black!, v, dpr, true);
    for (const m of units) {
      o.beginPath();
      trace(o, v, m.pts, true);
      const hot = st.hot === m.code;
      const reached = st.playing && m.t >= 0 && m.t * st.scale <= st.T;
      if (verdictShown && m.blind) {
        o.fillStyle = black;
        o.fill();
      } else if (verdictShown && m.bad) {
        o.fillStyle = red;
        o.fill();
      } else if (reached) {
        o.fillStyle = 'rgba(255,255,255,0.35)';
        o.fill();
      }
      o.strokeStyle =
        verdictShown && m.blind ? INK : verdictShown && m.bad ? '#9e1f16' : 'rgba(16,19,22,0.55)';
      o.lineWidth = hot ? 3.2 : verdictShown && (m.blind || m.bad) ? 1.6 : 1;
      o.stroke();
    }

    // isochrones
    for (const L of [300, 600, 900] as const) {
      if (L > st.T + 1e-6) continue;
      o.strokeStyle = INK;
      o.lineWidth = L === 900 ? 2.6 : 1.3;
      o.beginPath();
      if (st.scale === 1) {
        for (const ring of data.contours[String(L) as '300' | '600' | '900']) trace(o, v, ring, true);
      } else {
        for (const s of isoSegments(data.field, L, st.scale)) {
          o.moveTo(v.x(s[0]), v.y(s[1]));
          o.lineTo(v.x(s[2]), v.y(s[3]));
        }
      }
      o.stroke();
    }
    if (![300, 600, 900].includes(st.T) && st.T > 0) {
      // the moving walking front
      o.strokeStyle = COBALT;
      o.lineWidth = 2.4;
      o.beginPath();
      for (const s of isoSegments(data.field, st.T, st.scale)) {
        o.moveTo(v.x(s[0]), v.y(s[1]));
        o.lineTo(v.x(s[2]), v.y(s[3]));
      }
      o.stroke();
    }

    // the straight-line claim
    if (st.circle) {
      o.setLineDash([11, 7]);
      o.strokeStyle = INK;
      o.lineWidth = 1.8;
      o.lineCap = 'butt';
      o.beginPath();
      o.ellipse(v.x(0), v.y(0), r15 * v.sx, r15 * v.sy, 0, 0, Math.PI * 2);
      o.stroke();
      o.setLineDash([]);
      o.lineCap = 'round';
    }

    // one measured Baidu walking route to the east — the route the east callout quotes
    if (verdictShown && st.T >= 900 && eastPath) {
      o.fillStyle = INK;
      let acc = 0;
      const pts = eastPath.pts;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1]!;
        const b = pts[i]!;
        const ax = v.x(a[0]);
        const ay = v.y(a[1]);
        const bx = v.x(b[0]);
        const by = v.y(b[1]);
        const seg = Math.hypot(bx - ax, by - ay);
        for (let d = acc ? 7 - acc : 0; d < seg; d += 7) {
          const f = d / seg;
          const X = ax + (bx - ax) * f;
          const Y = ay + (by - ay) * f;
          if (X < -4 || Y < -4 || X > W + 4 || Y > H + 4) continue;
          o.beginPath();
          o.arc(X, Y, 1.6, 0, Math.PI * 2);
          o.fill();
        }
        acc = (acc + seg) % 7;
      }
    }
  }

  /** Offline basemap, part 1: paper, land use, water (drawn under the time field). */
  private paintBaseGround(c: Ctx, v: View, base: BaseLayers) {
    c.fillStyle = '#eceee9';
    c.fillRect(0, 0, v.width, v.height);
    for (const l of base.landuse) {
      c.beginPath();
      trace(c, v, l.pts, true);
      c.fillStyle = LAND[l.kind] ?? LAND.other!;
      c.fill();
    }
    c.fillStyle = '#a8cbe6';
    for (const w of base.water_areas) {
      c.beginPath();
      trace(c, v, w.pts, true);
      c.fill();
    }
    c.strokeStyle = '#a8cbe6';
    c.lineCap = 'round';
    c.lineJoin = 'round';
    const width: Record<string, number> = { river: 9, canal: 5, stream: 3, ditch: 2 };
    for (const w of base.waterways) {
      c.lineWidth = width[w.kind] ?? 2.5;
      c.beginPath();
      trace(c, v, w.pts);
      c.stroke();
    }
  }

  /** Offline basemap, part 2: streets over the field; elevated expressways as charcoal walls. */
  private paintBaseRoads(c: Ctx, v: View, base: BaseLayers) {
    const k = Math.max(0.75, Math.min(1.25, v.s / 0.36));
    c.lineCap = 'round';
    c.lineJoin = 'round';
    for (const cls of ORDER) {
      for (const r of base.roads) {
        if (r.cls !== cls || isWall(r)) continue;
        const [w, fill] = ROAD[cls] ?? ROAD.other!;
        c.beginPath();
        trace(c, v, r.pts);
        if (!fill) {
          c.setLineDash([2, 3]);
          c.strokeStyle = 'rgba(74,81,87,0.5)';
          c.lineWidth = w;
          c.stroke();
          c.setLineDash([]);
          continue;
        }
        c.strokeStyle = '#b9c0bb';
        c.lineWidth = w * k + 1.6;
        c.stroke();
      }
    }
    for (const cls of ORDER) {
      for (const r of base.roads) {
        if (r.cls !== cls || isWall(r)) continue;
        const [w, fill] = ROAD[cls] ?? ROAD.other!;
        if (!fill) continue;
        c.beginPath();
        trace(c, v, r.pts);
        c.strokeStyle = fill;
        c.lineWidth = w * k;
        c.stroke();
      }
    }
    for (const r of base.roads) {
      if (!isWall(r)) continue;
      c.beginPath();
      trace(c, v, r.pts);
      c.strokeStyle = '#1f2429';
      c.lineWidth = 7.5 * k;
      c.stroke();
      c.strokeStyle = '#4a5058';
      c.lineWidth = 5.2 * k;
      c.stroke();
    }
  }
}
