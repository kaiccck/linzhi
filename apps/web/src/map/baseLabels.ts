/**
 * Street, water and place names of the offline basemap (the sample's OpenStreetMap layers), drawn on
 * the canvas the way design/mockups/c-light/app.js draws them: water first (it explains the shape),
 * then the elevated roads that are the barriers, then streets by rank and length, then place names,
 * parks and the residential compounds that are not units themselves. Every name keeps clear of the
 * boxes the overlay already holds (codes, marks, cards, controls): collision is SAT on convex quads,
 * so names can follow their street at any angle; steep streets stack their characters upright.
 */
import type { BaseLayers, XY } from '@zoudedao/core';
import type { View } from '../geo/view.js';
import { LABEL_INK } from './signMapStyle.js';

type Road = BaseLayers['roads'][number];
/** Elevated roads and expressways: the grey band on the map, the barriers the findings name. */
export const isWall = (r: Road) => r.elevated || r.cls === 'motorway' || /高架|外环|中环/.test(r.name ?? '');

/** A convex quad in map px (four corners). */
export type Quad = [number, number][];

export const quad = (x0: number, y0: number, x1: number, y1: number): Quad => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

/** Separating-axis test for two convex polygons. */
export function overlaps(a: Quad, b: Quad): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]!;
      const q = poly[(i + 1) % poly.length]!;
      const nx = q[1] - p[1];
      const ny = p[0] - q[0];
      let amin = Infinity;
      let amax = -Infinity;
      let bmin = Infinity;
      let bmax = -Infinity;
      for (const [x, y] of a) {
        const d = x * nx + y * ny;
        amin = Math.min(amin, d);
        amax = Math.max(amax, d);
      }
      for (const [x, y] of b) {
        const d = x * nx + y * ny;
        bmin = Math.min(bmin, d);
        bmax = Math.max(bmax, d);
      }
      if (amax < bmin || bmax < amin) return false;
    }
  }
  return true;
}

function rotQuad(cx: number, cy: number, w: number, h: number, ang: number): Quad {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const hw = w / 2;
  const hh = h / 2;
  return (
    [
      [-hw, -hh],
      [hw, -hh],
      [hw, hh],
      [-hw, hh],
    ] as [number, number][]
  ).map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c]);
}

const FONT = {
  road: '400 12px "Noto Sans SC", "PingFang SC", sans-serif',
  water: '400 12px "Noto Sans SC", "PingFang SC", sans-serif',
  place: '500 13px "Noto Sans SC", "PingFang SC", sans-serif',
  area: '400 12px "Noto Sans SC", "PingFang SC", sans-serif',
};
/** the same muted inks as the Baidu style, so the offline map reads like the live one */
const INK = LABEL_INK;
/** How the elevated roads are called on the map (a known name reads shorter, as locals say it). */
const WALL_NAME: Record<string, string> = {
  华夏高架路: '华夏高架',
  外环高速: 'S20 外环',
  度假区高架路: '度假区高架',
};
const RANK: Record<string, number> = {
  trunk: 0,
  primary: 1,
  secondary: 2,
  tertiary: 3,
  residential: 4,
  other: 5,
  service: 6,
};

type Ctx = CanvasRenderingContext2D;

function drawText(
  c: Ctx,
  text: string,
  x: number,
  y: number,
  ang: number,
  font: string,
  color: string,
  spacing = 0,
) {
  c.save();
  c.translate(x, y);
  c.rotate(ang);
  c.font = font;
  c.letterSpacing = `${spacing}px`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.lineJoin = 'round';
  c.strokeStyle = 'rgba(255,255,255,0.92)';
  c.lineWidth = 3.2;
  c.strokeText(text, spacing / 2, 0.5);
  c.fillStyle = color;
  c.fillText(text, spacing / 2, 0.5);
  c.restore();
}

/** Steep streets: upright characters stacked along the road, the way Chinese street maps set them. */
function drawStacked(c: Ctx, text: string, x: number, y: number, ang: number, font: string, color: string) {
  const chars = [...text];
  const step = 13.5;
  const dx = Math.cos(ang);
  const dy = Math.sin(ang);
  const sgn = dy < 0 ? -1 : 1; // read top to bottom
  chars.forEach((ch, i) => {
    const o = (i - (chars.length - 1) / 2) * step * sgn;
    drawText(c, ch, x + dx * o, y + dy * o, 0, font, color);
  });
}

interface Cand {
  x: number;
  y: number;
  len: number;
  ang: number;
}

function candidates(v: View, lines: readonly { name: string | null; pts: XY[] }[], name: string): Cand[] {
  const out: Cand[] = [];
  for (const r of lines) {
    if (r.name !== name) continue;
    for (let i = 0; i < r.pts.length - 1; i++) {
      const [x1, y1] = r.pts[i]!;
      const [x2, y2] = r.pts[i + 1]!;
      const X1 = v.x(x1);
      const Y1 = v.y(y1);
      const X2 = v.x(x2);
      const Y2 = v.y(y2);
      const len = Math.hypot(X2 - X1, Y2 - Y1);
      if (len < 30) continue;
      out.push({ x: (X1 + X2) / 2, y: (Y1 + Y2) / 2, len, ang: Math.atan2(Y2 - Y1, X2 - X1) });
    }
  }
  return out.sort((a, b) => b.len - a.len);
}

function centroid(pts: readonly XY[]): [number, number, number] {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const f = pts[j]![0] * pts[i]![1] - pts[i]![0] * pts[j]![1];
    a += f;
    cx += (pts[j]![0] + pts[i]![0]) * f;
    cy += (pts[j]![1] + pts[i]![1]) * f;
  }
  return a ? [cx / (3 * a), cy / (3 * a), Math.abs(a / 2)] : [pts[0]![0], pts[0]![1], 0];
}

/**
 * Draws the names; returns how many were placed (tests). `taken` holds the overlay's boxes; `units`
 * names the studied communities (their codes and names are the overlay's).
 */
export function drawBaseLabels(
  c: Ctx,
  v: View,
  base: BaseLayers,
  taken0: readonly Quad[],
  units: ReadonlySet<string>,
): number {
  const W = v.width;
  const H = v.height;
  const taken: Quad[] = [...taken0];
  const inside = (q: Quad, pad = 6) => q.every(([x, y]) => x > pad && x < W - pad && y > pad && y < H - pad);
  const free = (q: Quad) => inside(q) && !taken.some((b) => overlaps(q, b));
  const textW = (text: string, font: string, spacing = 0) => {
    c.font = font;
    return c.measureText(text).width + spacing * Math.max(0, [...text].length - 1);
  };
  let placed = 0;

  const lineLabel = (
    lines: readonly { name: string | null; pts: XY[] }[],
    name: string,
    text: string,
    font: string,
    color: string,
    spacing = 0,
    maxOut = 1,
  ) => {
    let n = 0;
    const at: [number, number][] = [];
    const tw = textW(text, font, spacing);
    for (const cand of candidates(v, lines, name)) {
      if (n >= maxOut) break;
      let ang = cand.ang;
      if (ang > Math.PI / 2) ang -= Math.PI;
      if (ang < -Math.PI / 2) ang += Math.PI;
      const steep = Math.abs(ang) > (58 * Math.PI) / 180 && !/[A-Za-z0-9]/.test(text);
      const w = steep ? [...text].length * 13.5 : tw;
      if (cand.len < w + 10) continue;
      const q = steep ? rotQuad(cand.x, cand.y, 16, w + 2, 0) : rotQuad(cand.x, cand.y, w + 6, 16, ang);
      if (!free(q) || at.some(([x, y]) => Math.hypot(x - cand.x, y - cand.y) < 280)) continue;
      at.push([cand.x, cand.y]);
      if (steep) drawStacked(c, text, cand.x, cand.y, ang, font, color);
      else drawText(c, text, cand.x, cand.y, ang, font, color, spacing);
      taken.push(steep ? rotQuad(cand.x, cand.y, 22, w + 40, 0) : rotQuad(cand.x, cand.y, w + 40, 18, ang));
      n++;
      placed++;
    }
  };
  const pointLabel = (x: number, y: number, text: string, font: string, color: string, spacing = 0) => {
    const w = textW(text, font, spacing);
    const q = quad(x - w / 2 - 3, y - 9, x + w / 2 + 3, y + 9);
    if (!free(q)) return false;
    drawText(c, text, x, y, 0, font, color, spacing);
    taken.push(q);
    placed++;
    return true;
  };

  // water first (it explains the shape), then the elevated roads, then streets by rank and length
  const waterNames = [...new Set(base.waterways.flatMap((w) => (w.name ? [w.name] : [])))];
  for (const n of waterNames) lineLabel(base.waterways, n, n, FONT.water, INK.water, 3);
  const walls = [...new Set(base.roads.filter((r) => r.name && isWall(r)).map((r) => r.name!))];
  for (const n of walls) lineLabel(base.roads, n, WALL_NAME[n] ?? n, FONT.road, INK.wall, 1);
  const byName = new Map<string, { rank: number; len: number }>();
  for (const r of base.roads) {
    if (!r.name || /弄$/.test(r.name) || isWall(r)) continue;
    const len = r.pts.reduce(
      (s, p, i) => (i ? s + Math.hypot(p[0] - r.pts[i - 1]![0], p[1] - r.pts[i - 1]![1]) : 0),
      0,
    );
    const cur = byName.get(r.name) ?? { rank: 9, len: 0 };
    byName.set(r.name, { rank: Math.min(cur.rank, RANK[r.cls] ?? 7), len: cur.len + len });
  }
  [...byName.entries()]
    .sort((a, b) => a[1].rank - b[1].rank || b[1].len - a[1].len)
    .forEach(([n, info]) => lineLabel(base.roads, n, n, FONT.road, INK.road, 0, info.len > 1800 ? 2 : 1));

  // place names, parks, then the residential compounds and campuses that are not units themselves
  for (const p of base.places ?? []) pointLabel(v.x(p.xy[0]), v.y(p.xy[1]), p.name, FONT.place, INK.place, 4);
  const areas = base.landuse
    .filter(
      (l) =>
        l.name &&
        (l.kind === 'park' || l.kind === 'residential' || l.kind === 'school') &&
        !units.has(l.name),
    )
    .map((l) => {
      const [x, y, a] = centroid(l.pts);
      return { l, x, y, a };
    })
    .filter((o) => o.a * v.s * v.s > 1800)
    .sort((a, b) => Number(b.l.kind === 'park') - Number(a.l.kind === 'park') || b.a - a.a);
  const seen = new Set<string>();
  for (const o of areas) {
    if (seen.has(o.l.name!)) continue;
    const color = o.l.kind === 'park' ? INK.park : INK.place;
    if (pointLabel(v.x(o.x), v.y(o.y), o.l.name!, FONT.area, color)) seen.add(o.l.name!);
  }
  return placed;
}
