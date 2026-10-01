/**
 * Where every HTML atom on the map goes, as pure functions of the view (rules from DESIGN.md, tested
 * in layout.test.ts):
 *  - The Codes Win Rule: nothing covers a unit code. Marks, labels, tags, names and cards move or
 *    drop; the only thing a code yields to is the 你在这里 disc itself (the code is nudged off it).
 *  - The Anchor Stays Visible Rule: a finding card never covers its own anchor, a code or the marker;
 *    it is placed near its anchor by a cost search (design/mockups/c-light placeCallouts) and joined
 *    to it by a leader.
 *  - Nothing sits under the map's floating controls (legend, layer switch, 走一遍 card, the meta line
 *    and Baidu's logo): they are hard boxes for cards, tags and names.
 *  - Density follows the map box: `narrow` (< 700 px) drops the cards, minor marks, labels and names.
 */
import type { HardCategory, XY } from '@zoudedao/core';
import type { View } from '../geo/view.js';
import { circleR, poiName, spotOf, type IconId, type Model, type Unit } from '../model/derive.js';
import type { FacilityMark, StatCategory } from '../model/facilities.js';

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
const grow = (r: Rect, p: number): Rect => ({ x: r.x - p, y: r.y - p, w: r.w + 2 * p, h: r.h + 2 * p });

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

/** A facility mark on the map: the chosen category's (named), or every facility of 圈内设施. */
export interface PoiPos {
  key: string;
  cat: StatCategory;
  name: string;
  icon: IconId;
  x: number;
  y: number;
  /** a non-hard category (幼儿园, 超市 …): a smaller mark */
  small: boolean;
  /** 圈内设施: in the straight circle, not reached on foot in 15′ (dashed) */
  far: boolean;
  /** a 买菜替代 shop beside the 菜市场 marks (smaller, dashed teal) */
  fresh: boolean;
  /** walking seconds at the profile's speed (Infinity outside the field) */
  t: number;
  /** its name beside it: on the right, the left, or not at all */
  label: 'right' | 'left' | null;
  text: string;
}

/**
 * A name in the map's quiet voice: a unit's name beside its code (`left` when it sits on the code's
 * west side), or a group of units sharing one name (`group`: 申城佳苑 over its phases). `x`, `y` is
 * the label's box, left and vertical centre.
 */
export interface NamePos {
  key: string;
  text: string;
  kind: 'unit' | 'group';
  x: number;
  y: number;
  left?: boolean;
}

/** A site on the 规划 map: a suggestion (numbered) or the planner's own (`whatif`). */
export interface SiteInput {
  key: string;
  xy: XY;
  kind: 'site' | 'whatif';
  cat: HardCategory;
  icon: IconId;
  /** suggestions are numbered like the 规划 list */
  rank?: number;
  /** the words beside the pin (its 估算 / 已核验 tag follows them) */
  label: string;
  verified: boolean;
  /** what a screen reader hears for the pin */
  aria: string;
}
export interface SitePos extends SiteInput {
  /** where the pin sits (moved off codes when it has to be) and the point it names */
  x: number;
  y: number;
  px: number;
  py: number;
  /** label box (left, vertical centre) or null when there is no room for it */
  lx: number | null;
  ly: number;
}

/** A finding to pin on the map: its anchor and the directions it would rather go. */
export type Dir = 'right' | 'left' | 'up' | 'down' | 'up-right' | 'down-right' | 'up-left' | 'down-left';
export interface CardSpec {
  key: string;
  anchor: XY;
  tone: 'ink' | 'pseudo' | 'blind';
  /** the unit the card is about (its own code costs more to cover than any other) */
  code?: string;
  /** the facility the card is about */
  poi?: string;
  prefer: Dir[];
  /** what covering a dot of the route costs (the route evidence keeps its own route in sight) */
  routeCost?: number;
}
export interface CardPlan {
  key: string;
  tone: CardSpec['tone'];
  left: number;
  top: number;
  w: number;
  h: number;
  /** anchor and where the leader meets the card */
  ax: number;
  ay: number;
  lx: number;
  ly: number;
}

export interface OverlayLayout {
  units: UnitPos[];
  sites: SitePos[];
  /** flag placement; `dx`/`dy` slide the flag along its side (it stays beside the disc) */
  here: {
    x: number;
    y: number;
    side: Side | 'free' | 'none';
    dx: number;
    dy: number;
    stem?: [number, number, number, number];
  };
  pois: PoiPos[];
  cards: CardPlan[];
  minuteTags: { L: number; x: number; y: number }[];
  circleTag: { x: number; y: number; text: string } | null;
  /** unit and group names: last in line, they take only the room nothing else wants */
  names: NamePos[];
  /** where Baidu's logo goes (left, top), when there is one */
  logo: { x: number; y: number } | null;
  /** codes and the marker: what a confirmation plate must stay off */
  blockers: Rect[];
  /** everything placed (the offline basemap's canvas names keep clear of all of it) */
  taken: Rect[];
}

export interface LayoutInput {
  model: Model;
  view: View;
  narrow: boolean;
  playing: boolean;
  T: number;
  scale: number;
  /** the time field's multiplier (the minute tags sit on its isochrones); defaults to `scale` */
  timeScale?: number;
  circle: boolean;
  /**
   * Facility marks: `category` — the chosen category's facilities, named (体检单 and 规划); `all` —
   * every facility the circle claims or the walk reaches (圈内设施); null — none.
   */
  marks:
    | { kind: 'category'; cat: HardCategory; list: FacilityMark[] }
    | { kind: 'all'; list: FacilityMark[] }
    | null;
  /** print unit names beside their codes (the screen map; the report leaves them to its tables) */
  names?: boolean;
  /** 规划: sites to pin (the planner's own first) */
  sites?: SiteInput[];
  /** the map's floating controls (legend, layer switch, 走一遍 card, meta line, logo), in map px */
  floats?: Rect[];
  /** findings to pin, with their measured sizes (cards are left out on narrow maps) */
  cards?: (CardSpec & { w: number; h: number })[];
  /** the measured route a card quotes: its dots are soft obstacles */
  route?: readonly (readonly number[])[] | null;
  /**
   * Baidu's logo: the band it sits in (its top edge, above the 走一遍 card) and its size. The layout
   * slides it along that band to the first stretch no unit code covers — the logo must stay visible
   * and codes never move for anything — and keeps everything else off it. `x0`: where the band
   * starts (right of a card that covers the map's left side).
   */
  logo?: { y: number; w: number; h: number; x0?: number } | null;
}

const SITE_BOX = 34; // 28px pin, 2px ring, the rank badge's overhang
const SITE_TAG_W = 42;

/** Name label metrics: 12px for units, 13px for a group's shared name. */
const NAME_PX = { unit: 12, group: 13 } as const;
export const nameRect = (text: string, kind: NamePos['kind'], x: number, y: number): Rect => {
  const px = NAME_PX[kind];
  const w = textWidth(text, px) * (kind === 'group' ? 1.08 : 1) + 4;
  return { x, y: y - (px + 6) / 2, w, h: px + 6 };
};

/**
 * Names for the units, beside their codes: a unit whose main name is its own gets it whole
 * (虹御公寓); units sharing a main name get their phase (一期B块) and the shared name is printed once
 * over the group (申城佳苑), where there is room.
 */
export function unitNameTexts(units: readonly Unit[]): {
  own: Map<string, string>;
  groups: { name: string; codes: string[] }[];
} {
  const byMain = new Map<string, Unit[]>();
  for (const u of units) byMain.set(u.nameMain, [...(byMain.get(u.nameMain) ?? []), u]);
  const own = new Map<string, string>();
  const groups: { name: string; codes: string[] }[] = [];
  for (const [main, list] of byMain) {
    const shared = list.length > 1 && list.every((u) => u.nameSub);
    for (const u of list) own.set(u.code, shared ? u.nameSub : u.nameMain + u.nameSub);
    if (shared) groups.push({ name: main, codes: list.map((u) => u.code) });
  }
  return { own, groups };
}

/**
 * The phases a shared name can stand over: the group's own centre must be nearer to every one of them
 * than to any other unit, or the name reads as the neighbours' (玉兰香苑's phases lie across the whole
 * area, with other compounds between them). The phase farthest from the centre drops out until that
 * holds; what drops out carries its full name. Fewer than two left: no shared name.
 */
export function sharedNameMembers<T>(
  members: readonly T[],
  others: readonly T[],
  at: (t: T) => [number, number],
): T[] {
  let list = [...members];
  while (list.length >= 2) {
    const cx = list.reduce((s, t) => s + at(t)[0], 0) / list.length;
    const cy = list.reduce((s, t) => s + at(t)[1], 0) / list.length;
    const d = (t: T) => Math.hypot(at(t)[0] - cx, at(t)[1] - cy);
    const far = list.reduce((a, t) => (d(t) > d(a) ? t : a));
    const rest = [...others, ...members.filter((t) => !list.includes(t))];
    if (!rest.length || d(far) < Math.min(...rest.map(d))) return list;
    list = list.filter((t) => t !== far);
  }
  return [];
}

/** The 你在这里 disc (30 px with its white ring, and a little shadow room) and its flag. */
const DOT_R = 17;
const TAG = { w: 66, h: 22, gap: 6 };

export function hereTagRect(side: Side, x: number, y: number): Rect {
  switch (side) {
    case 'left':
      return { x: x - 15 - TAG.gap - TAG.w, y: y - TAG.h / 2, w: TAG.w, h: TAG.h };
    case 'right':
      return { x: x + 15 + TAG.gap, y: y - TAG.h / 2, w: TAG.w, h: TAG.h };
    case 'above':
      return { x: x - TAG.w / 2, y: y - 15 - TAG.gap - TAG.h, w: TAG.w, h: TAG.h };
    case 'below':
      return { x: x - TAG.w / 2, y: y + 15 + TAG.gap, w: TAG.w, h: TAG.h };
  }
}

/** A unit code: 12px numerals in a 20px pill, at least 40px wide, 1px ring (and a pixel of room). */
export function unitRect(code: string, x: number, y: number): Rect {
  return centered(x, y, Math.max(40, textWidth(code, 12) + 12) + 2, 22);
}

/** distance from a point to the nearest point of a rect */
function distToRect(px: number, py: number, r: Rect) {
  const cx = Math.max(r.x, Math.min(px, r.x + r.w));
  const cy = Math.max(r.y, Math.min(py, r.y + r.h));
  return Math.hypot(px - cx, py - cy);
}

/** First point along a bearing where walking time (× scale) exceeds T: the reach's edge there. */
function pointAlong(model: Model, bearing: number, T: number, scale: number): XY | null {
  const a = (bearing * Math.PI) / 180;
  let last: XY | null = null;
  for (let r = 20; r <= 1600; r += 5) {
    const x = Math.sin(a) * r;
    const y = Math.cos(a) * r;
    const t = model.timeAt(x, y);
    if (t < 0) break;
    if (t * scale > T) return last ?? [x, y];
    last = [x, y];
  }
  return last;
}

export function layoutOverlay(inp: LayoutInput): OverlayLayout {
  const { model, view: v, narrow, playing, T, scale, circle } = inp;
  const W = v.width;
  const H = v.height;
  const hx = v.x(0);
  const hy = v.y(0);
  const floats = inp.floats ?? [];

  // 1 · unit codes at their centroids. Codes that overlap each other (dense blocks on narrow maps and
  //     on the printed report) are eased apart; a code moved off its own point is tied back to it by a
  //     tick (codeTicks). A code the disc would clip is nudged off it.
  const units: UnitPos[] = model.units.map((unit) => {
    const [ux, uy] = spotOf(unit);
    const x = v.x(ux);
    const y = v.y(uy);
    return { unit, x, y, rect: unitRect(unit.code, x, y) };
  });
  for (let pass = 0; pass < 40; pass++) {
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
    for (const deg of [0, 20, -20, 40, -40, 60, -60, 80, -80, 100, -100, 120, -120, 145, -145, 180]) {
      const a = base + (deg * Math.PI) / 180;
      let { x, y, rect } = u;
      const clearDisc = () => distToRect(hx, hy, rect) >= DOT_R + 3;
      const clearCodes = () => !others.some((o) => hit(rect, o, 2));
      for (let step = 0; step < 110 && !(clearDisc() && clearCodes()); step++) {
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

  // 2 · the flag takes the first side of the marker that is clear of codes (west first, as on the
  //     mockup; sliding along that side if it has to); with no clear place it stands off on a short
  //     stem, and with none at all it folds — the disc alone still says 你在这里
  const prefs: Side[] = narrow ? ['above', 'left', 'right', 'below'] : ['left', 'right', 'above', 'below'];
  let here: OverlayLayout['here'] = { x: hx, y: hy, side: 'none', dx: 0, dy: 0 };
  search: for (const side of prefs) {
    const shifts = side === 'above' || side === 'below' ? [0, -14, 14, -28, 28] : [0, -8, 8];
    for (const d of shifts) {
      const [dx, dy] = side === 'above' || side === 'below' ? [d, 0] : [0, d];
      const r = hereTagRect(side, hx + dx, hy + dy);
      if (inside(r, W, H, 6) && !codeHit(r) && !floats.some((f) => hit(r, f, 2))) {
        here = { x: hx, y: hy, side, dx, dy };
        break search;
      }
    }
  }
  if (here.side === 'none') {
    const order = [
      -90, -67.5, -112.5, -45, -135, -22.5, -157.5, 0, 180, 22.5, 157.5, 45, 135, 67.5, 112.5, 90,
    ];
    free: for (const R of [52, 64, 76, 90, 106, 124]) {
      for (const deg of order) {
        const a = (deg * Math.PI) / 180;
        const cx = hx + Math.cos(a) * R;
        const cy = hy + Math.sin(a) * R;
        const r = centered(cx, cy, TAG.w, TAG.h);
        if (!inside(r, W, H, 6) || codeHit(r) || floats.some((f) => hit(r, f, 2))) continue;
        const gap = distToRect(hx, hy, r);
        if (gap < DOT_R + 8) continue;
        const nx = Math.max(r.x, Math.min(hx, r.x + r.w));
        const ny = Math.max(r.y, Math.min(hy, r.y + r.h));
        const len = Math.hypot(nx - hx, ny - hy);
        const sx = hx + ((nx - hx) / len) * (DOT_R - 3);
        const sy = hy + ((ny - hy) / len) * (DOT_R - 3);
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
  /** codes, the marker and its flag, the floating controls: nothing may cover them */
  const hard: Rect[] = [...codeRects, ...hereRects, ...floats];

  // Baidu's logo: the first stretch of its band, from the left, that no code or the marker covers
  let logo: OverlayLayout['logo'] = null;
  if (inp.logo) {
    const { y, w, h } = inp.logo;
    const x0 = inp.logo.x0 ?? 12;
    const clearOf = [...codeRects, ...hereRects];
    for (let x = x0; x + w <= W - 12; x += 8) {
      const r = { x, y, w, h };
      if (!clearOf.some((c) => hit(r, c, 3))) {
        logo = { x, y };
        break;
      }
    }
    logo ??= { x: x0, y };
    hard.push({ x: logo.x - 4, y: y - 4, w: w + 8, h: h + 8 });
  }
  const taken: Rect[] = [...hard];

  // 2½ · 规划 sites: a pin stays on its point unless a code or the flag is there, then it moves to
  //      the nearest clear spot (a tick ties it back); its words go beside it where there is room
  const sites: SitePos[] = [];
  for (const site of inp.sites ?? []) {
    const px = v.x(site.xy[0]);
    const py = v.y(site.xy[1]);
    if (px < 14 || py < 14 || px > W - 14 || py > H - 14) continue;
    let at: { x: number; y: number } | null = null;
    rings: for (const R of [0, 26, 38, 52, 68, 86, 104]) {
      for (let k = 0; k < (R ? 12 : 1); k++) {
        const a = (k * Math.PI) / 6 - Math.PI / 2;
        const x = px + Math.cos(a) * R;
        const y = py + Math.sin(a) * R;
        const r = centered(x, y, SITE_BOX, SITE_BOX);
        if (!inside(r, W, H, 6) || taken.some((t) => hit(r, t, 2))) continue;
        at = { x, y };
        break rings;
      }
    }
    const { x, y } = at ?? { x: px, y: py };
    taken.push(centered(x, y, SITE_BOX, SITE_BOX));
    const lw = textWidth(site.label, 12) + SITE_TAG_W + 16;
    let lx: number | null = null;
    if (!narrow) {
      for (const right of [true, false]) {
        const r: Rect = {
          x: right ? x + SITE_BOX / 2 + 4 : x - SITE_BOX / 2 - 4 - lw,
          y: y - 12,
          w: lw,
          h: 24,
        };
        if (!inside(r, W, H, 6) || taken.some((t) => hit(r, t, 2))) continue;
        lx = r.x;
        taken.push(r);
        break;
      }
    }
    sites.push({ ...site, x, y, px, py, lx, ly: y });
  }

  // 3 · facility marks: the chosen category's facilities (named where there is room), or every
  //     facility of 圈内设施. A mark is nudged a few pixels off a code or the flag, never far from its
  //     true spot; one that still collides is dropped (codes win).
  const pois: PoiPos[] = [];
  if (inp.marks) {
    const all = inp.marks.kind === 'all';
    const hardCats = new Set<StatCategory>(['小学', '菜市场', '药店']);
    const list = inp.marks.list
      .filter((m) =>
        all ? m.inCircle || m.reach : m.fresh || m.cat === (inp.marks as { cat: HardCategory }).cat,
      )
      .filter((m) => !(narrow && all && !hardCats.has(m.cat)))
      .sort(
        (a, b) =>
          Number(!!a.fresh) - Number(!!b.fresh) ||
          Number(hardCats.has(b.cat)) - Number(hardCats.has(a.cat)) ||
          a.straight - b.straight,
      );
    const poiBoxes: Rect[] = [];
    for (const m of list) {
      const [mx, my] = m.face.navi_xy ?? m.face.xy;
      let x = v.x(mx);
      let y = v.y(my);
      if (x < 14 || x > W - 14 || y < 14 || y > H - 14) continue;
      const small = (all && !hardCats.has(m.cat)) || !!m.fresh;
      const r = small ? 9 : 11;
      const box = (cx: number, cy: number) => centered(cx, cy, r * 2 + 2, r * 2 + 2);
      let q = box(x, y);
      const blocked = (b: Rect) => hard.some((t) => hit(b, t)) || poiBoxes.some((t) => hit(b, t));
      if (blocked(q)) {
        let found = false;
        for (const d of [8, 12, 16]) {
          for (let k = 0; k < 8 && !found; k++) {
            const a = (k * Math.PI) / 4;
            const q2 = box(x + Math.cos(a) * d, y + Math.sin(a) * d);
            if (!blocked(q2)) {
              x += Math.cos(a) * d;
              y += Math.sin(a) * d;
              q = q2;
              found = true;
            }
          }
          if (found) break;
        }
        if (!found && hard.some((t) => hit(q, t))) continue;
      }
      poiBoxes.push(q);
      taken.push(q);
      pois.push({
        key: m.key,
        cat: m.cat,
        name: m.face.name,
        icon: iconOf(m.cat),
        x,
        y,
        small,
        far: all && !m.reach,
        fresh: !!m.fresh,
        t: m.t,
        label: null,
        text: poiName(m.face.name),
      });
    }
    // names of the chosen category's facilities (the ones under discussion); not on narrow maps
    if (!all && !narrow) {
      for (const p of pois) {
        const w = textWidth(p.text, 12);
        const right: Rect = { x: p.x + 14, y: p.y - 9, w: w + 4, h: 18 };
        const left: Rect = { x: p.x - 18 - w, y: p.y - 9, w: w + 4, h: 18 };
        for (const [side, r] of [
          ['right', right],
          ['left', left],
        ] as const) {
          if (!inside(r, W, H, 6) || taken.some((t) => hit(r, t, 1))) continue;
          p.label = side;
          taken.push(r);
          break;
        }
      }
    }
  }

  // 4 · finding cards (wide maps only): near their anchors, never over a code, the marker, a control
  //     or their own anchor; their leaders avoid codes and marks
  const cards: CardPlan[] = [];
  if (!narrow && !playing && T >= 900 && inp.cards?.length) {
    const soft: Rect[] = [];
    if (inp.route) {
      for (let i = 0; i < inp.route.length; i += 6) {
        const p = inp.route[i]!;
        soft.push(centered(v.x(p[0]!), v.y(p[1]!), 8, 8));
      }
    }
    const unitBoxes = model.units.map((u) => {
      if (u.pts.length < 3) return { code: u.code, b: units.find((p) => p.unit.code === u.code)!.rect };
      const xs = u.pts.map((p) => v.x(p[0]));
      const ys = u.pts.map((p) => v.y(p[1]));
      const x0 = Math.min(...xs);
      const y0 = Math.min(...ys);
      return { code: u.code, b: { x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 } };
    });
    const placedCards: Rect[] = [];
    for (const f of inp.cards) {
      const ax = v.x(f.anchor[0]);
      const ay = v.y(f.anchor[1]);
      if (ax < 8 || ay < 8 || ax > W - 8 || ay > H - 8) continue;
      const own = f.code
        ? units.find((u) => u.unit.code === f.code)?.rect
        : f.poi
          ? (() => {
              const p = pois.find((q) => q.key === f.poi);
              return p ? centered(p.x, p.y, 24, 24) : undefined;
            })()
          : undefined;
      const anchorBox = centered(ax, ay, 16, 16);
      const plan = placeCard(f, ax, ay, W, H, {
        // its own code too: a card never covers a code, not even the one it is about
        hard: [...hard, anchorBox],
        own: own ?? null,
        boxes: taken.filter((r) => !hard.includes(r)),
        soft,
        cards: placedCards,
        unitBoxes,
      });
      if (!plan) continue;
      cards.push(plan);
      const box = { x: plan.left, y: plan.top, w: plan.w, h: plan.h };
      placedCards.push(box);
      taken.push(grow(box, 6));
      // the leader itself: tags and names keep off it
      const len = Math.hypot(plan.lx - ax, plan.ly - ay);
      for (let t = 0; t < len; t += 8) {
        const px = ax + ((plan.lx - ax) * t) / len;
        const py = ay + ((plan.ly - ay) * t) / len;
        taken.push(centered(px, py, 6, 6));
      }
      taken.push(anchorBox);
    }
  }

  // 5 · minute tags on the isochrones, south-west where the map is quiet (narrow maps keep only 15′)
  const minuteTags: OverlayLayout['minuteTags'] = [];
  if (!playing) {
    const levels: [number, number[]][] = [
      [300, [212, 200, 225, 190, 240, 175, 255, 160]],
      [600, [218, 205, 232, 195, 248, 180, 262, 165]],
      [900, [224, 210, 238, 200, 252, 190, 268, 175]],
    ];
    for (const [L, bearings] of levels) {
      if (L > T || (narrow && L < 900)) continue;
      for (const b of bearings) {
        const p = pointAlong(model, b, L, inp.timeScale ?? scale);
        if (!p) continue;
        const x = v.x(p[0]);
        const y = v.y(p[1]);
        const w = L >= 600 ? 30 : 24;
        const r = centered(x, y, w + 6, 22);
        if (!inside(r, W, H, 8) || taken.some((t) => hit(r, t))) continue;
        minuteTags.push({ L, x, y });
        taken.push(r);
        break;
      }
    }
  }

  // 6 · the circle's own tag, on its north-west arc, at the profile's radius
  let circleTag: OverlayLayout['circleTag'] = null;
  if (circle && !narrow && !playing) {
    const R = circleR(model, scale);
    const text = `直线 15′ 圈 · 半径 ${Math.round(R).toLocaleString('en-US')} m`;
    const w = textWidth(text, 12) + 18;
    for (const b of [312, 322, 302, 332, 292, 238, 228, 248, 45, 58, 135, 148, 20]) {
      const a = (b * Math.PI) / 180;
      const x = v.x(Math.sin(a) * R);
      const y = v.y(Math.cos(a) * R);
      const r = centered(x, y, w, 22);
      if (!inside(r, W, H, 8) || taken.some((t) => hit(r, t))) continue;
      circleTag = { x, y, text };
      taken.push(r);
      break;
    }
  }

  // 7 · names, in the map's quiet voice: a group's shared name over its units, then each unit's
  //     name beside its code (east first). Codes, marks, cards, tags and controls win.
  const names: NamePos[] = [];
  if ((inp.names ?? true) && !narrow) {
    const free = (r: Rect) => inside(r, W, H, 6) && !taken.some((t) => hit(r, t, 2));
    const { own, groups } = unitNameTexts(model.units);
    const full = new Set<string>();
    for (const g of groups) {
      const all = units.filter((u) => g.codes.includes(u.unit.code));
      // a shared name only over phases that sit together around it (sharedNameMembers); the others
      // carry their full names — "一期" beside nothing it belongs to names nothing
      const members = sharedNameMembers(
        all,
        units.filter((u) => !g.codes.includes(u.unit.code)),
        (u) => [v.x(spotOf(u.unit)[0]), v.y(spotOf(u.unit)[1])],
      );
      for (const u of all) if (!members.includes(u)) full.add(u.unit.code);
      if (members.length < 2) {
        for (const u of members) full.add(u.unit.code);
        continue;
      }
      const gx = members.reduce((s, u) => s + v.x(spotOf(u.unit)[0]), 0) / members.length;
      const gy = members.reduce((s, u) => s + v.y(spotOf(u.unit)[1]), 0) / members.length;
      const probe = nameRect(g.name, 'group', 0, 0);
      let placed = false;
      for (const [dx, dy] of [
        [0, 0],
        [0, -18],
        [0, 18],
        [-40, 0],
        [40, 0],
        [0, -36],
        [0, 36],
      ] as const) {
        const r = nameRect(g.name, 'group', gx + dx - probe.w / 2, gy + dy);
        if (!free(r)) continue;
        taken.push(r);
        names.push({ key: `g:${g.name}`, text: g.name, kind: 'group', x: r.x, y: gy + dy });
        placed = true;
        break;
      }
      if (!placed) for (const u of members) full.add(u.unit.code);
    }
    for (const u of units) {
      const text = full.has(u.unit.code) ? u.unit.nameMain + u.unit.nameSub : own.get(u.unit.code);
      if (!text) continue;
      for (const left of [false, true]) {
        const probe = nameRect(text, 'unit', 0, u.y);
        const x = left ? u.rect.x - 3 - probe.w : u.rect.x + u.rect.w + 3;
        const r = nameRect(text, 'unit', x, u.y);
        if (!free(r)) continue;
        taken.push(r);
        names.push({ key: `u:${u.unit.code}`, text, kind: 'unit', x, y: u.y, ...(left ? { left } : {}) });
        break;
      }
    }
  }

  return {
    units,
    sites,
    here,
    pois,
    cards,
    minuteTags,
    circleTag,
    names,
    logo,
    blockers: [...codeRects, ...hereRects],
    taken,
  };
}

/**
 * Every box the overlay's own text and marks take on the map (codes, names, facility marks and their
 * names, minute and circle tags, cards, pins), in rows at most 16 px tall — the places Baidu's own
 * labels must give way to (BaiduBasemap.setLabelBlockers). The floating controls are left out: they
 * stay put while the map moves under them.
 */
export function labelBoxes(L: OverlayLayout): Rect[] {
  const boxes: Rect[] = L.units.map((u) => u.rect);
  // 你在这里: the disc and its flag
  const { here } = L;
  boxes.push(centered(here.x, here.y, DOT_R * 2, DOT_R * 2));
  if (here.side === 'free') boxes.push(centered(here.x + here.dx, here.y + here.dy, TAG.w, TAG.h));
  else if (here.side !== 'none') boxes.push(hereTagRect(here.side, here.x + here.dx, here.y + here.dy));
  for (const n of L.names) boxes.push(nameRect(n.text, n.kind, n.x, n.y));
  for (const p of L.pois) {
    boxes.push(centered(p.x, p.y, p.small ? 20 : 24, p.small ? 20 : 24));
    if (!p.label) continue;
    const w = textWidth(p.text, 12) + 4;
    boxes.push({ x: p.label === 'left' ? p.x - 15 - w : p.x + 15, y: p.y - 9, w, h: 18 });
  }
  for (const t of L.minuteTags) boxes.push(centered(t.x, t.y, t.L >= 600 ? 36 : 30, 20));
  if (L.circleTag)
    boxes.push(centered(L.circleTag.x, L.circleTag.y, textWidth(L.circleTag.text, 12) + 18, 22));
  for (const s of L.sites) {
    boxes.push(centered(s.x, s.y, 34, 34));
    if (s.lx !== null) boxes.push({ x: s.lx, y: s.ly - 12, w: textWidth(s.label, 12) + 58, h: 24 });
  }
  for (const c of L.cards) boxes.push({ x: c.left, y: c.top, w: c.w, h: c.h });
  // rows no taller than a glyph: a tall box becomes a stack of rows
  return boxes.flatMap((b) => {
    const rows = Math.max(1, Math.ceil(b.h / 16));
    const h = b.h / rows;
    return Array.from({ length: rows }, (_, i) => ({ x: b.x, y: b.y + i * h, w: b.w, h }));
  });
}

const ICON: Record<StatCategory, IconId> = {
  小学: 'pg-school',
  幼儿园: 'pg-kinder',
  菜市场: 'pg-market',
  生鲜超市: 'pg-fresh',
  超市: 'pg-super',
  药店: 'pg-pharmacy',
  社区卫生: 'pg-clinic',
  养老: 'pg-elder',
  公交: 'pg-bus',
  地铁: 'pg-metro',
  公园: 'pg-park',
};
const iconOf = (cat: StatCategory) => ICON[cat];

/* ---------------- finding cards ---------------- */

const DIRS: Record<Dir, (ax: number, ay: number, w: number, h: number, d: number) => [number, number]> = {
  right: (ax, ay, _w, h, d) => [ax + d, ay - h / 2],
  left: (ax, ay, w, h, d) => [ax - d - w, ay - h / 2],
  up: (ax, ay, w, h, d) => [ax - w / 2, ay - d - h],
  down: (ax, ay, w, _h, d) => [ax - w / 2, ay + d],
  'up-right': (ax, ay, _w, h, d) => [ax + d * 0.6, ay - d * 0.6 - h],
  'down-right': (ax, ay, _w, _h, d) => [ax + d * 0.6, ay + d * 0.6],
  'up-left': (ax, ay, w, h, d) => [ax - d * 0.6 - w, ay - d * 0.6 - h],
  'down-left': (ax, ay, w, _h, d) => [ax - d * 0.6 - w, ay + d * 0.6],
};

interface CardWorld {
  /** never covered: codes, the marker and its flag, the controls, the card's own anchor */
  hard: Rect[];
  /** the card's own code or mark: covering it costs the most */
  own: Rect | null;
  /** marks, labels: covering them costs */
  boxes: Rect[];
  /** the route's dots: a card may pass over them, cheaply */
  soft: Rect[];
  /** cards already placed */
  cards: Rect[];
  unitBoxes: { code: string; b: Rect }[];
}

/** Where a leader from (ax, ay) meets a card box, and what it would cut through on the way. */
function leaderFor(
  ax: number,
  ay: number,
  box: Rect,
  world: CardWorld,
): { ex: number; ey: number; cost: number } {
  const x0 = box.x;
  const y0 = box.y;
  const x1 = box.x + box.w;
  const y1 = box.y + box.h;
  const clamp = (a: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, a));
  const nx = clamp(ax, x0 + 12, x1 - 12);
  const ny = clamp(ay, y0 + 12, y1 - 12);
  const ends: [number, number, number][] = [];
  if (ay < y0 || ay > y1) {
    const ey = ay < y0 ? y0 : y1;
    for (const o of [0, -40, 40, -80, 80, -120, 120])
      ends.push([clamp(nx + o, x0 + 12, x1 - 12), ey, Math.abs(o)]);
  } else {
    const ex = ax < x0 ? x0 : x1;
    for (const o of [0, -20, 20, -40, 40]) ends.push([ex, clamp(ny + o, y0 + 12, y1 - 12), Math.abs(o)]);
  }
  let best: { ex: number; ey: number; cost: number } | null = null;
  for (const [ex, ey, off] of ends) {
    const len = Math.hypot(ex - ax, ey - ay);
    const crossed = new Set<Rect>();
    let cardHits = 0;
    for (let t = 14; t < len - 4; t += 4) {
      const px = ax + ((ex - ax) * t) / len;
      const py = ay + ((ey - ay) * t) / len;
      const dot = centered(px, py, 3, 3);
      for (const b of [...world.hard, ...world.boxes]) if (b !== world.own && hit(dot, b)) crossed.add(b);
      for (const c of world.cards) if (hit(dot, c)) cardHits++;
    }
    const cost = crossed.size * 150 + cardHits * 60 + off * 0.3;
    if (!best || cost < best.cost) best = { ex, ey, cost };
  }
  return best!;
}

function placeCard(
  f: CardSpec & { w: number; h: number },
  ax: number,
  ay: number,
  W: number,
  H: number,
  world: CardWorld,
): CardPlan | null {
  const { w, h } = f;
  const cover = (a: Rect, b: Rect) =>
    Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  let best: { x: number; y: number; cost: number; ex: number; ey: number } | null = null;
  const dirs = [...f.prefer, ...(Object.keys(DIRS) as Dir[]).filter((k) => !f.prefer.includes(k))];
  dirs.forEach((dir, rank) => {
    for (const d of [30, 48, 70, 96, 130]) {
      for (const sh of [0, -50, 50, -100, 100]) {
        let [x, y] = DIRS[dir](ax, ay, w, h, d);
        if (sh && (dir === 'up' || dir === 'down')) x += sh;
        else if (sh && (dir === 'left' || dir === 'right')) y += sh * 0.6;
        else if (sh) continue;
        const r: Rect = { x, y, w, h };
        if (!inside(r, W, H, 10)) continue;
        if (world.hard.some((b) => hit(r, b, 2))) continue;
        let cost = rank * 40 + d + Math.abs(sh) * 0.6;
        if (world.own && hit(r, world.own, 2)) cost += 400;
        for (const b of world.boxes) if (hit(r, b)) cost += 260;
        for (const b of world.soft) if (hit(r, b)) cost += f.routeCost ?? 40;
        const lead = leaderFor(ax, ay, r, world);
        cost += lead.cost;
        for (const c of world.cards) if (hit(grow(c, 10), r)) cost += 5000;
        for (const ub of world.unitBoxes) {
          const a = cover(r, ub.b);
          if (a) cost += (a / Math.max(1, ub.b.w * ub.b.h)) * (ub.code === f.code ? 900 : 220);
        }
        if (!best || cost < best.cost) best = { x, y, cost, ex: lead.ex, ey: lead.ey };
      }
    }
  });
  const b = best as { x: number; y: number; cost: number; ex: number; ey: number } | null;
  if (!b || b.cost > 1200) return null;
  return { key: f.key, tone: f.tone, left: b.x, top: b.y, w, h, ax, ay, lx: b.ex, ly: b.ey };
}

/* ---------------- a new centre, picked on the map ---------------- */

/** The confirmation plate ("以此为中心体检" + 取消) and the pending-centre marker around its point. */
export const CONFIRM = { w: 236, h: 84 };
export const PIN_R = 16; // 26px target disc + 3px white ring

export interface ConfirmPlan {
  left: number;
  top: number;
  /** stem from the marker's edge to the plate (marker-relative px), when the plate stands off */
  stem: [number, number, number, number] | null;
}

/**
 * Where the confirmation plate goes: the nearest spot around the picked point that stays inside the
 * map between the control bands and covers no unit code (The Codes Win Rule), the 你在这里 marker or
 * the point itself. Sides are tried right, left, below, above, sliding along each; if every ring
 * around the point is taken, the nearest clear spot anywhere on the map wins, joined by a stem.
 * Null when nothing is clear: the plate then docks over the 走一遍 card (as it always does on narrow
 * maps), where it cannot cover a code the card does not already cover.
 */
export function placeConfirm(
  x: number,
  y: number,
  W: number,
  H: number,
  blockers: Rect[],
  band: { top: number; bottom: number },
  size: { w: number; h: number } = CONFIRM,
): ConfirmPlan | null {
  const { w, h } = size;
  const pin = centered(x, y, PIN_R * 2 + 6, PIN_R * 2 + 6);
  const ok = (r: Rect) =>
    r.x >= 8 &&
    r.x + r.w <= W - 8 &&
    r.y >= band.top &&
    r.y + r.h <= H - band.bottom &&
    !hit(r, pin, 2) &&
    !blockers.some((b) => hit(r, b, 3));
  const plan = (r: Rect): ConfirmPlan => {
    const nx = Math.max(r.x, Math.min(x, r.x + r.w));
    const ny = Math.max(r.y, Math.min(y, r.y + r.h));
    const len = Math.hypot(nx - x, ny - y);
    const stem: ConfirmPlan['stem'] =
      len > PIN_R + 12
        ? [((nx - x) / len) * (PIN_R - 1), ((ny - y) / len) * (PIN_R - 1), nx - x, ny - y]
        : null;
    return { left: r.x, top: r.y, stem };
  };
  const slides = [0, -22, 22, -44, 44, -70, 70];
  for (const d of [8, 24, 44, 70, 100, 140]) {
    const cands: Rect[] = [];
    for (const s of slides) {
      cands.push({ x: x + PIN_R + d, y: y - h / 2 + s, w, h }); // right
      cands.push({ x: x - PIN_R - d - w, y: y - h / 2 + s, w, h }); // left
    }
    for (const s of slides) {
      cands.push({ x: x - w / 2 + s * 2, y: y + PIN_R + d, w, h }); // below
      cands.push({ x: x - w / 2 + s * 2, y: y - PIN_R - d - h, w, h }); // above
    }
    const found = cands.find(ok);
    if (found) return plan(found);
  }
  let best: { r: Rect; d: number } | null = null;
  for (let top = band.top; top + h <= H - band.bottom; top += 10) {
    for (let left = 8; left + w <= W - 8; left += 10) {
      const r = { x: left, y: top, w, h };
      if (!ok(r)) continue;
      const d = distToRect(x, y, r);
      if (!best || d < best.d) best = { r, d };
    }
  }
  return best ? plan(best.r) : null;
}

/**
 * Codes the layout had to move (off the 你在这里 disc, or apart in a dense block) keep a tick back to
 * the point they name: a dot on the true position and a short line to the code's nearest edge.
 */
export function codeTicks(
  units: UnitPos[],
  v: View,
  min = 9,
): { code: string; x1: number; y1: number; x2: number; y2: number }[] {
  const out: { code: string; x1: number; y1: number; x2: number; y2: number }[] = [];
  for (const u of units) {
    const tx = v.x(spotOf(u.unit)[0]);
    const ty = v.y(spotOf(u.unit)[1]);
    const nx = Math.max(u.rect.x, Math.min(tx, u.rect.x + u.rect.w));
    const ny = Math.max(u.rect.y, Math.min(ty, u.rect.y + u.rect.h));
    if (Math.hypot(nx - tx, ny - ty) < min) continue;
    out.push({ code: u.unit.code, x1: tx, y1: ty, x2: nx, y2: ny });
  }
  return out;
}

/** Axis-aligned rects as the canvas labels' quads. */
export const rectQuads = (rects: readonly Rect[]) =>
  rects.map((r): [number, number][] => [
    [r.x, r.y],
    [r.x + r.w, r.y],
    [r.x + r.w, r.y + r.h],
    [r.x, r.y + r.h],
  ]);
