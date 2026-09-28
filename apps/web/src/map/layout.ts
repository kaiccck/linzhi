/**
 * Where every HTML atom on the map goes, as pure functions of the view (tested by eye in the
 * captures, rules from DESIGN.md):
 *  - The Codes Win Rule: nothing covers a unit code. POIs, labels, tags and cards move or drop; the
 *    only thing a code yields to is the 你在这里 disc itself (the code is nudged off it).
 *  - The Anchor Stays Visible Rule: a callout never covers its own anchor; if the anchor falls in the
 *    rail the card sits above (or below) it with a short leader to its nearest edge.
 *  - Density follows the map box: `narrow` (< 700 px) drops the rail, minor POIs, labels and tags.
 */
import type { BaseLayers, XY } from '@zoudedao/core';
import { ringPointAt, roadLabelAnchor } from '../geo/field.js';
import type { View } from '../geo/view.js';
import { poiName, type Finding, type Model, type Unit } from '../model/derive.js';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
const hit = (a: Rect, b: Rect, pad = 0) =>
  a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
const inside = (r: Rect, W: number, H: number, pad = 2) =>
  r.x >= pad && r.y >= pad && r.x + r.w <= W - pad && r.y + r.h <= H - pad;
const centered = (x: number, y: number, w: number, h: number): Rect => ({ x: x - w / 2, y: y - h / 2, w, h });

/** Rough text width at a font size: CJK and full-width forms are square, the rest about 0.58em. */
export function textWidth(s: string, px: number): number {
  let w = 0;
  for (const ch of s) w += /[⺀-鿿＀-￯]/.test(ch) ? px : px * 0.58;
  return w;
}

export type Side = 'left' | 'right' | 'above' | 'below';

export interface UnitPos {
  unit: Unit;
  x: number;
  y: number;
  rect: Rect;
}
export interface PoiPos {
  key: string;
  name: string;
  label: string;
  icon: Model['pois'][number]['icon'];
  x: number;
  y: number;
  minor: boolean;
  /** label shown without hover */
  show: boolean;
  flip: boolean;
}
export interface RoadLabelPos {
  key: string;
  text: string;
  cls: '' | 'xway' | 'water';
  x: number;
  y: number;
  deg: number;
}
export interface OverlayLayout {
  units: UnitPos[];
  /** flag placement; `dx`/`dy` slide the flag along its side (its arrow stays on the disc) */
  here: {
    x: number;
    y: number;
    side: Side | 'free' | 'none';
    dx: number;
    dy: number;
    stem?: [number, number, number, number];
  };
  pois: PoiPos[];
  roadLabels: RoadLabelPos[];
  minuteTags: { L: number; x: number; y: number }[];
  circleTag: { x: number; y: number; angle: number } | null;
  /** obstacles the callout rail must respect (codes, the here flag, anchors) */
  blockers: Rect[];
}

export interface LayoutInput {
  model: Model;
  view: View;
  narrow: boolean;
  offline: boolean;
  playing: boolean;
  T: number;
  scale: number;
  circle: boolean;
  rail: boolean;
}

const DOT_R = 23; // 19px disc + 4px white collar
const TAG = { w: 86, h: 32, gap: 27 };

export function hereTagRect(side: Side, x: number, y: number): Rect {
  switch (side) {
    case 'left':
      return { x: x - 29 - TAG.w + 2, y: y - TAG.h / 2, w: TAG.w, h: TAG.h };
    case 'right':
      return { x: x + 29 - 2, y: y - TAG.h / 2, w: TAG.w, h: TAG.h };
    case 'above':
      return { x: x - TAG.w / 2, y: y - TAG.gap - TAG.h + 2, w: TAG.w, h: TAG.h };
    case 'below':
      return { x: x - TAG.w / 2, y: y + TAG.gap - 2, w: TAG.w, h: TAG.h };
  }
}

function unitRect(code: string, x: number, y: number): Rect {
  // 12px numerals, 3px × 5px padding, 1.5px ring
  return centered(x, y, textWidth(code, 12) + 13, 21);
}

/** distance from a point to the nearest point of a rect */
function distToRect(px: number, py: number, r: Rect) {
  const cx = Math.max(r.x, Math.min(px, r.x + r.w));
  const cy = Math.max(r.y, Math.min(py, r.y + r.h));
  return Math.hypot(px - cx, py - cy);
}

export function layoutOverlay(inp: LayoutInput): OverlayLayout {
  const { model, view: v, narrow, offline, playing, T, scale, circle, rail } = inp;
  const W = v.width;
  const H = v.height;
  const hx = v.x(0);
  const hy = v.y(0);

  // 1 · unit codes at their centroids. A code the disc would clip is nudged off it — radially if that
  //     is clear of the other codes, otherwise in the nearest direction that is.
  const units: UnitPos[] = model.units.map((unit) => {
    const x = v.x(unit.centroid[0]);
    const y = v.y(unit.centroid[1]);
    return { unit, x, y, rect: unitRect(unit.code, x, y) };
  });
  // codes that overlap each other (dense blocks on narrow maps) are eased apart a few pixels
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    for (let i = 0; i < units.length; i++) {
      for (let j = i + 1; j < units.length; j++) {
        const a = units[i]!;
        const b = units[j]!;
        if (!hit(a.rect, b.rect, 2)) continue;
        const ox = Math.min(a.rect.x + a.rect.w, b.rect.x + b.rect.w) - Math.max(a.rect.x, b.rect.x) + 3;
        const oy = Math.min(a.rect.y + a.rect.h, b.rect.y + b.rect.h) - Math.max(a.rect.y, b.rect.y) + 3;
        const [dx, dy] =
          oy <= ox ? [0, (b.y >= a.y ? 1 : -1) * (oy / 2)] : [(b.x >= a.x ? 1 : -1) * (ox / 2), 0];
        for (const [u, k] of [
          [a, -1],
          [b, 1],
        ] as const) {
          u.x += k * dx;
          u.y += k * dy;
          u.rect = unitRect(u.unit.code, u.x, u.y);
        }
        moved = true;
      }
    }
    if (!moved) break;
  }
  units.forEach((u, i) => {
    if (distToRect(hx, hy, u.rect) >= DOT_R + 3) return;
    const others = units.filter((_, j) => j !== i).map((o) => o.rect);
    const base = u.x === hx && u.y === hy ? -Math.PI / 2 : Math.atan2(u.y - hy, u.x - hx);
    let best: { x: number; y: number; rect: Rect; cost: number } | null = null;
    for (const deg of [0, 25, -25, 50, -50, 75, -75, 100, -100, 135, -135]) {
      const a = base + (deg * Math.PI) / 180;
      let { x, y, rect } = u;
      const clearDisc = () => distToRect(hx, hy, rect) >= DOT_R + 3;
      const clearCodes = () => !others.some((o) => hit(rect, o, 2));
      // march until the code is off the disc and off its neighbours (or give up after 60px)
      for (let step = 0; step < 60 && !(clearDisc() && clearCodes()); step++) {
        x += Math.cos(a);
        y += Math.sin(a);
        rect = unitRect(u.unit.code, x, y);
      }
      const cost = Math.hypot(x - u.x, y - u.y) + (clearDisc() ? 0 : 2000) + (clearCodes() ? 0 : 1000);
      if (!best || cost < best.cost) best = { x, y, rect, cost };
    }
    if (best) Object.assign(u, { x: best.x, y: best.y, rect: best.rect });
  });
  const codeRects = units.map((u) => u.rect);
  const codeHit = (r: Rect, pad = 2) => codeRects.some((c) => hit(r, c, pad));

  // 2 · the flag takes the first side of the marker that is clear of codes (sliding along that side
  //     if it has to, its arrow still on the disc); with no clear place it stays folded — the disc
  //     alone still says 你在这里, and codes are never covered
  const prefs: Side[] = narrow ? ['above', 'left', 'right', 'below'] : ['left', 'above', 'right', 'below'];
  let here: OverlayLayout['here'] = { x: hx, y: hy, side: 'none', dx: 0, dy: 0 };
  search: for (const side of prefs) {
    const shifts = side === 'above' || side === 'below' ? [0, -16, 16, -30, 30] : [0, -8, 8];
    for (const d of shifts) {
      const [dx, dy] = side === 'above' || side === 'below' ? [d, 0] : [0, d];
      const r = hereTagRect(side, hx + dx, hy + dy);
      if (inside(r, W, H, 6) && !codeHit(r)) {
        here = { x: hx, y: hy, side, dx, dy };
        break search;
      }
    }
  }
  if (here.side === 'none') {
    // no side is clear (dense blocks on a narrow map): take the nearest free spot around the marker,
    // pinned to the disc by a short cobalt stem that also stays off every code
    const top = narrow ? 132 : 72; // below the search and settings plates
    const order = [
      -90, -67.5, -112.5, -45, -135, -22.5, -157.5, 0, 180, 22.5, 157.5, 45, 135, 67.5, 112.5, 90,
    ];
    free: for (const R of [62, 74, 86, 98, 112, 128]) {
      for (const deg of order) {
        const a = (deg * Math.PI) / 180;
        const cx = hx + Math.cos(a) * R;
        const cy = hy + Math.sin(a) * R;
        const r = centered(cx, cy, TAG.w, TAG.h);
        if (!inside(r, W, H, 6) || r.y < top || codeHit(r)) continue;
        const gap = distToRect(hx, hy, r);
        if (gap < DOT_R + 8) continue;
        // stem: from the disc's edge towards the tag's nearest point
        const nx = Math.max(r.x, Math.min(hx, r.x + r.w));
        const ny = Math.max(r.y, Math.min(hy, r.y + r.h));
        const len = Math.hypot(nx - hx, ny - hy);
        const sx = hx + ((nx - hx) / len) * (DOT_R - 2);
        const sy = hy + ((ny - hy) / len) * (DOT_R - 2);
        let clear = true;
        for (let t = 0; t <= 1 && clear; t += 0.1) {
          const px = sx + (nx - sx) * t;
          const py = sy + (ny - sy) * t;
          clear = !codeRects.some(
            (c) => px > c.x - 2 && px < c.x + c.w + 2 && py > c.y - 2 && py < c.y + c.h + 2,
          );
        }
        if (!clear) continue;
        here = {
          x: hx,
          y: hy,
          side: 'free',
          dx: cx - hx,
          dy: cy - hy,
          stem: [sx - hx, sy - hy, nx - hx, ny - hy],
        };
        break free;
      }
    }
  }
  const hereRects: Rect[] = [centered(hx, hy, DOT_R * 2, DOT_R * 2)];
  if (here.side === 'free') hereRects.push(centered(hx + here.dx, hy + here.dy, TAG.w, TAG.h));
  else if (here.side !== 'none') hereRects.push(hereTagRect(here.side, hx + here.dx, hy + here.dy));
  const taken: Rect[] = [...codeRects, ...hereRects];
  const clearOfCodes = (r: Rect, pad = 2) => !codeHit(r, pad);

  // 3 · street and water names (offline basemap only; Baidu labels its own streets)
  const roadLabels: RoadLabelPos[] = [];
  if (offline && model.data.base) {
    const base = model.data.base;
    const bounds: [number, number, number, number] = [v.mx(60), v.my(H - 110), v.mx(W - 300), v.my(150)];
    const add = (
      lines: BaseLayers['waterways'] | BaseLayers['roads'],
      name: string,
      text: string,
      cls: RoadLabelPos['cls'],
    ) => {
      const a = roadLabelAnchor(lines as { name: string | null; pts: XY[] }[], name, bounds);
      if (!a) return;
      let deg = (-a.ang * 180) / Math.PI;
      if (deg > 90) deg -= 180;
      if (deg < -90) deg += 180;
      const x = v.x(a.x);
      const y = v.y(a.y);
      const r = centered(x, y, textWidth(text, 12) * (cls === 'water' ? 1.4 : 1.1) + 12, 18);
      if (!clearOfCodes(r, 0)) return;
      roadLabels.push({ key: `${cls}:${name}`, text, cls, x, y, deg });
    };
    add(base.waterways, '川杨河', '川杨河', 'water');
    add(base.waterways, '横沔港', '横沔港', 'water');
    add(base.roads, '华夏高架路', '华夏高架', 'xway');
    add(base.roads, '外环高速', 'S20 外环', 'xway');
    if (!narrow)
      for (const n of ['高木桥路', '孙环路', '孙耀路', '张东路', '孙桥路', '孙建路'])
        add(base.roads, n, n, '');
  }

  // 4 · pictogram tiles: codes win, the rail stays clear, narrow maps keep only the major ones.
  //     Major tiles (with their labels) are placed first; a minor tile yields to anything already placed.
  const pois: PoiPos[] = [];
  const ordered = [...model.pois].sort((a, b) => Number(a.minor) - Number(b.minor));
  for (const p of ordered) {
    if (narrow && p.minor) continue;
    const [px, py] = p.navi_xy ?? p.xy;
    const x = v.x(px);
    const y = v.y(py);
    if (x < 14 || y < 14 || x > W - 14 || y > H - 14) continue;
    if (rail && x > W - 300) continue;
    if (narrow && y < 120) continue;
    const size = p.minor ? 18 : 26;
    const tile = centered(x, y, size, size);
    if (narrow && units.some((u) => Math.abs(u.x - x) < 34 && Math.abs(u.y - y) < 34 * 0.6)) continue; // clearance from codes
    if ((p.minor ? taken : [...codeRects, ...hereRects]).some((t) => hit(tile, t, 1))) continue;
    const label = poiName(p.name);
    const wantLabel =
      !narrow && (p.cat === '小学' || p.cat === '菜市场' || p.cat === '地铁') && Math.hypot(px, py) < 1150;
    let flip = x > W - 260;
    let show = false;
    if (wantLabel) {
      const lw = textWidth(label, 12) + 14;
      const labelRect = (f: boolean): Rect => ({
        x: f ? x - size / 2 - 6 - lw : x + size / 2 + 6,
        y: y - 11,
        w: lw,
        h: 22,
      });
      for (const f of flip ? [true, false] : [false, true]) {
        const r = labelRect(f);
        if (inside(r, W, H, 4) && !taken.some((t) => hit(r, t, 1)) && !(rail && r.x + r.w > W - 290)) {
          flip = f;
          show = true;
          taken.push(r);
          break;
        }
      }
    }
    taken.push(tile);
    pois.push({ key: p.uid, name: p.name, label, icon: p.icon, x, y, minor: p.minor, show, flip });
  }

  // 5 · minute tags on the isochrones (narrow maps keep only 15′); they slide along the ring to stay off codes
  const minuteTags: OverlayLayout['minuteTags'] = [];
  if (!playing && scale === 1) {
    for (const [L, b] of [
      [300, 206],
      [600, 214],
      [900, 222],
    ] as const) {
      if (L > T || (narrow && L < 900)) continue;
      const rings = model.data.contours[String(L) as '300' | '600' | '900'];
      for (const db of [0, 8, -8, 16, -16, 24, -24, 32, -32]) {
        const p = ringPointAt(rings, b + db);
        if (!p) break;
        const x = v.x(p[0]);
        const y = v.y(p[1]);
        const r = centered(x, y, textWidth(`${L / 60}′`, 14) + 18, 24);
        if (!inside(r, W, H, 4) || taken.some((t) => hit(r, t, 1))) continue;
        taken.push(r);
        minuteTags.push({ L, x, y });
        break;
      }
    }
  }

  // 6 · the circle's own tag, on its north-west arc
  let circleTag: OverlayLayout['circleTag'] = null;
  if (circle && !narrow && !playing) {
    const text = `直线画的 15′ 圈 · 半径 ${Math.round(model.r15).toLocaleString('en-US')} m`;
    const w = textWidth(text, 13) + 22;
    for (const deg of [-128, -120, -136, -112, -144, -104, -152]) {
      const a = (deg * Math.PI) / 180;
      const x = v.x(Math.cos(a) * model.r15);
      const y = v.y(-Math.sin(a) * model.r15);
      const r = centered(x, y, w, 27);
      if (!inside(r, W, H, 8) || taken.some((t) => hit(r, t, 1))) continue;
      taken.push(r);
      circleTag = { x, y, angle: deg };
      break;
    }
  }

  return { units, here, pois, roadLabels, minuteTags, circleTag, blockers: [...codeRects, ...hereRects] };
}

/* ---------------- callout rail ---------------- */

export interface CardPlan {
  key: Finding['key'];
  tone: Finding['tone'];
  left: number;
  top: number;
  w: number;
  h: number;
  ax: number;
  ay: number;
  /** where the leader meets the card */
  lx: number;
  ly: number;
}

export const CARD_W = 248;
const RAIL_MARGIN = 22;
const RAIL_TOP = 84;
const RAIL_BOTTOM = 150;
const ANCHOR_CLEAR = 24;

/**
 * Cards sit in a rail on the map's east edge near their preferred slot, leaders landing on the card's
 * left edge. A card whose anchor falls inside the rail parks above (or below) the anchor instead, so
 * the anchor dot and a run of leader stay visible; everything else then moves around the fixed cards
 * and around unit codes.
 */
export function planCallouts(
  findings: Finding[],
  heights: Record<string, number>,
  v: View,
  blockers: Rect[],
): CardPlan[] {
  const W = v.width;
  const H = v.height;
  const left = W - CARD_W - RAIL_MARGIN;
  const anchors = findings
    .map((f) => ({ f, ax: v.x(f.anchor[0]), ay: v.y(f.anchor[1]) }))
    .filter(({ ax, ay }) => ax > 8 && ax < W - 8 && ay > 8 && ay < H - 8);
  const dots = anchors.map(({ f, ax, ay }) => ({ key: f.key, r: centered(ax, ay, 18, 18) }));
  const plans = anchors.map(({ f, ax, ay }) => {
    const h = heights[f.key] ?? 88;
    return {
      f,
      key: f.key,
      tone: f.tone,
      left,
      top: 0,
      w: CARD_W,
      h,
      ax,
      ay,
      lx: left,
      ly: 0,
      fixed: ax + 8 > left,
    };
  });

  const placed: Rect[] = [];
  const blocked = (r: Rect, key: string) =>
    placed.some((p) => hit(r, p, 10)) ||
    blockers.some((b) => hit(r, b, 2)) ||
    dots.some((d) => d.key !== key && hit(r, d.r, 2));
  // cards pinned above/below an anchor inside the rail go first; the others flow around them
  for (const p of [...plans].sort((a, b) => Number(b.fixed) - Number(a.fixed))) {
    const tops: number[] = [];
    if (p.fixed) {
      const lowest = H - p.h - 100;
      const above: number[] = [];
      for (let t = p.ay - ANCHOR_CLEAR - p.h; t >= RAIL_TOP; t -= 6) above.push(t);
      const below: number[] = [];
      for (let t = p.ay + ANCHOR_CLEAR; t <= lowest; t += 6) below.push(t);
      tops.push(...above, ...below);
    } else {
      const lo = RAIL_TOP;
      const hi = Math.max(lo, H - p.h - RAIL_BOTTOM);
      const pref = Math.max(lo, Math.min(hi, Math.round(H * p.f.slot)));
      tops.push(pref);
      for (let d = 6; pref + d <= hi || pref - d >= lo; d += 6) {
        if (pref + d <= hi) tops.push(pref + d);
        if (pref - d >= lo) tops.push(pref - d);
      }
    }
    const rectAt = (t: number): Rect => ({ x: p.left, y: t, w: p.w, h: p.h });
    p.top = tops.find((t) => !blocked(rectAt(t), p.key)) ?? tops[0] ?? RAIL_TOP;
    placed.push(rectAt(p.top));
  }

  return plans.map(({ f: _f, fixed, ...p }) => {
    if (fixed) {
      // the leader meets the card's nearest horizontal edge, right above or below the anchor
      p.lx = Math.max(p.left + 14, Math.min(p.left + p.w - 14, p.ax));
      p.ly = p.top + p.h <= p.ay ? p.top + p.h : p.top;
    } else {
      p.lx = p.left;
      p.ly = Math.max(p.top + 14, Math.min(p.top + p.h - 14, p.ay));
    }
    return p;
  });
}
