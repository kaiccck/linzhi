/**
 * The map while a live check streams in (data/stream.ts): the same print as the finished map, minus
 * every verdict. `under` holds the reach so far in the sand ramp (multiplied over Baidu, on our own
 * ground offline, as paint.ts does); `over` the isochrones
 * so far, the straight 15′ circle, the walked paths as route dots and every measured sample as a dot —
 * seed discs, refinement squares, the batch just measured larger and in full ink, the earlier ones grey.
 * The Verdict Waits: no community tints, no gray areas.
 */
import type { XY } from '@zoudedao/core';
import { rasterize, type Raster } from '../geo/field.js';
import type { View } from '../geo/view.js';
import type { StreamModel } from '../data/stream.js';
import { COL, multiplied, rampAt } from './paint.js';
import { GROUND } from './signMapStyle.js';

type Ctx = CanvasRenderingContext2D;

function trace(c: Ctx, v: View, pts: readonly (XY | readonly number[])[], close = false) {
  pts.forEach((p, i) => (i ? c.lineTo(v.x(p[0]!), v.y(p[1]!)) : c.moveTo(v.x(p[0]!), v.y(p[1]!))));
  if (close) c.closePath();
}

export class StreamPainter {
  private raster: Raster | null = null;
  private field: StreamModel['field'] = null;
  private multiply = false;
  private readonly rc = document.createElement('canvas');

  /** The reach so far as an image, re-rastered only when the stream sends a new field. */
  private fieldImage(m: StreamModel, multiply: boolean): Raster | null {
    if (!m.field) return null;
    if (m.field === this.field && this.raster && multiply === this.multiply) return this.raster;
    this.field = m.field;
    this.multiply = multiply;
    const r = rasterize(m.field, 10);
    this.raster = r;
    this.rc.width = r.w;
    this.rc.height = r.h;
    const ctx = this.rc.getContext('2d')!;
    const img = ctx.createImageData(r.w, r.h);
    for (let i = 0; i < r.t.length; i++) {
      const t = r.t[i]!;
      if (t < 0 || t > 900) continue;
      const c = multiply ? multiplied(rampAt(t)) : rampAt(t);
      img.data.set([c[0], c[1], c[2], c[3] * 255], i * 4);
    }
    ctx.putImageData(img, 0, 0);
    return r;
  }

  /** `offline`: our own ground under the field; over Baidu the canvas stays clear and is multiplied in. */
  paint(under: Ctx, over: Ctx, v: View, m: StreamModel, dpr: number, offline = false) {
    const W = v.width;
    const H = v.height;
    const c = under;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, c.canvas.width, c.canvas.height);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (offline) {
      c.fillStyle = GROUND;
      c.fillRect(0, 0, W, H);
    }
    const r = this.fieldImage(m, !offline);
    if (r) {
      c.imageSmoothingEnabled = true;
      c.drawImage(this.rc, v.x(r.x0), v.y(r.y1), (r.x1 - r.x0) * v.sx, (r.y1 - r.y0) * v.sy);
    }

    const o = over;
    o.setTransform(1, 0, 0, 1, 0, 0);
    o.clearRect(0, 0, o.canvas.width, o.canvas.height);
    o.setTransform(dpr, 0, 0, dpr, 0, 0);
    o.lineJoin = 'round';
    o.lineCap = 'round';

    // isochrones so far: 5′ and 10′ hairlines, the 15′ edge
    for (const L of ['300', '600', '900'] as const) {
      const rings = m.contours?.[L];
      if (!rings?.length) continue;
      o.strokeStyle = L === '900' ? COL.iso : 'rgba(162,123,71,0.5)';
      o.lineWidth = L === '900' ? 1.8 : 1;
      o.beginPath();
      for (const ring of rings) trace(o, v, ring, true);
      o.stroke();
    }
    // the claim, as on the finished map
    o.setLineDash([6, 5]);
    o.strokeStyle = COL.circle;
    o.lineWidth = 1.4;
    o.lineCap = 'butt';
    o.beginPath();
    o.ellipse(v.x(0), v.y(0), m.r15 * v.sx, m.r15 * v.sy, 0, 0, Math.PI * 2);
    o.stroke();
    o.setLineDash([]);
    o.lineCap = 'round';

    // walked paths: dots on a white casing (the map's material for a measured route)
    for (const p of m.paths) {
      o.beginPath();
      trace(o, v, p.pts);
      o.strokeStyle = 'rgba(255,255,255,0.95)';
      o.lineWidth = 5;
      o.stroke();
      o.setLineDash([0.1, 5.2]);
      o.strokeStyle = COL.route;
      o.lineWidth = 2.4;
      o.stroke();
      o.setLineDash([]);
    }
    // samples: seed discs and refinement squares on a white keyline, the newest batch larger, in ink
    for (const pass of [false, true]) {
      for (const d of m.dots) {
        if (d.stage === 'path' || d.fresh !== pass) continue;
        const x = v.x(d.xy[0]);
        const y = v.y(d.xy[1]);
        if (x < -6 || y < -6 || x > W + 6 || y > H + 6) continue;
        const k = d.fresh ? 1.25 : 1;
        o.beginPath();
        if (d.stage === 'refine') o.rect(x - 2.6 * k, y - 2.6 * k, 5.2 * k, 5.2 * k);
        else o.arc(x, y, 3 * k, 0, Math.PI * 2);
        o.fillStyle = d.fresh ? COL.ink : '#8a94a3';
        o.strokeStyle = '#fff';
        o.lineWidth = 1.5;
        o.stroke();
        o.fill();
      }
    }
  }
}
