/**
 * The map's layout rules (DESIGN.md), checked on every sample at the capture sizes: The Codes Win
 * Rule, the finding cards (never over a code, the marker, a control or their own anchor; at most two,
 * apart), names in the quiet voice, the narrow-map density tier, and the elder profile's circle.
 */
import { describe, expect, it } from 'vitest';
import type { AnalysisResult } from '@zoudedao/core';
import raw from '../../../../data/samples/zj-a.json?raw';
import rawB from '../../../../data/samples/zj-b.json?raw';
import rawC from '../../../../data/samples/zj-c.json?raw';
import rawV from '../../../../data/samples/zj-v.json?raw';
import { compositionFor, focusedComposition, NARROW_PX, staticView, type View } from '../geo/view.js';
import { circleR, deriveModel, profileScale, worstUnit, type Model } from '../model/derive.js';
import { evidenceBase } from '../model/evidence.js';
import { facilityMarks } from '../model/facilities.js';
import { MAP_H, MAP_W } from '../report/ReportMap.js';
import { evidenceItem } from './evidenceCard.js';
import {
  CONFIRM,
  codeTicks,
  hereTagRect,
  layoutOverlay,
  nameRect,
  placeConfirm,
  PIN_R,
  sharedNameMembers,
  textWidth,
  type LayoutInput,
  type Rect,
} from './layout.js';

const hit = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const centered = (x: number, y: number, w: number, h: number): Rect => ({ x: x - w / 2, y: y - h / 2, w, h });

const SAMPLES = { 'zj-a': raw, 'zj-b': rawB, 'zj-c': rawC, 'zj-v': rawV } as const;
const models = Object.entries(SAMPLES).map(([id, text]) =>
  deriveModel(JSON.parse(text) as AnalysisResult, id),
);
const model = models[0]!;

// map boxes of the captures: 1440×900 desktop, 1920×1080 wide, 1024 laptop, 390-wide phone
const SIZES = [
  { name: 'desktop 1440', W: 1040, H: 840 },
  { name: 'wide 1920', W: 1520, H: 1020 },
  { name: 'laptop 1024', W: 664, H: 708 },
  { name: 'phone 390', W: 390, H: 540 },
];

/** The floating controls as MapPanel measures them (grown by 8 px): legend, layers, 走一遍, meta, logo. */
function floatsFor(W: number, H: number): Rect[] {
  const narrow = W < NARROW_PX;
  if (narrow)
    return [
      { x: 4, y: 4, w: W - 8, h: 56 },
      { x: 4, y: H - 136, w: W - 8, h: 132 },
      { x: 8, y: H - 176, w: 92, h: 40 },
    ];
  return [
    { x: 8, y: 8, w: 380, h: 56 },
    { x: W - 384, y: 8, w: 376, h: 56 },
    { x: 8, y: H - 94, w: Math.min(790, W - 250), h: 86 },
    { x: W - 258, y: H - 110, w: 250, h: 102 },
    { x: 8, y: H - 138, w: 92, h: 40 },
  ];
}

/** The free band of a narrow map as MapPanel measures it: under the legend, over the 走一遍 card. */
const bandOf = (H: number) => ({ top: 62, bottom: H - 128 });

/** The framing MapPanel asks for: the mockup's composition on a wide map; on a narrow one the codes
 * and 你在这里, centred in the free band. */
function frame(m: Model, W: number, H: number): View {
  if (W >= NARROW_PX) return staticView(W, H, compositionFor(false));
  const { top, bottom } = bandOf(H);
  const c = focusedComposition(
    compositionFor(true),
    m.units.map((u) => u.centroid),
  );
  return staticView(W, H, c, Math.round((top + bottom) / 2 - H / 2));
}

function layout(m: Model, view: View, over: Partial<LayoutInput> = {}) {
  const narrow = view.width < NARROW_PX;
  const scale = over.scale ?? 1;
  const cat = worstOf(m);
  const marks = facilityMarks(m, scale);
  // the one card the 体检单 pins: a picked community's route (the worst unit's, its route loading)
  const w = worstUnit(m, cat);
  const base = w ? evidenceBase(m, w.unit.code, cat) : null;
  const cards = base
    ? [
        {
          ...evidenceItem(
            { status: 'loading', base, facts: null, message: null },
            { scale, crossing: false, onClose() {} },
          ).spec,
          w: 226,
          h: 112,
        },
      ]
    : [];
  return layoutOverlay({
    model: m,
    view,
    narrow,
    playing: false,
    T: 900,
    scale,
    circle: true,
    marks: { kind: 'category', cat, list: marks },
    floats: floatsFor(view.width, view.height),
    cards,
    route: m.detour?.path.pts ?? null,
    ...over,
  });
}
const worstOf = (m: Model) => m.heads.reduce((a, h) => (h.pseudo + h.blind > a.pseudo + a.blind ? h : a)).cat;

for (const m of models) {
  for (const { name, W, H } of SIZES) {
    const narrow = W < NARROW_PX;
    const view = frame(m, W, H);
    const L = layout(m, view);
    const codes = L.units.map((u) => u.rect);
    const floats = floatsFor(W, H);

    describe(`${m.id} · ${name} (${narrow ? 'narrow' : 'full'} map)`, () => {
      it('keeps unit codes clear of each other and of the 你在这里 disc', () => {
        for (let i = 0; i < codes.length; i++) {
          for (let j = i + 1; j < codes.length; j++) expect(hit(codes[i]!, codes[j]!)).toBe(false);
          const c = codes[i]!;
          const nx = Math.max(c.x, Math.min(L.here.x, c.x + c.w));
          const ny = Math.max(c.y, Math.min(L.here.y, c.y + c.h));
          expect(Math.hypot(nx - L.here.x, ny - L.here.y)).toBeGreaterThanOrEqual(17);
        }
      });

      it('never lets the flag cover a code', () => {
        const { side, dx, dy } = L.here;
        if (side === 'none') return;
        const tag =
          side === 'free'
            ? centered(L.here.x + dx, L.here.y + dy, 66, 22)
            : hereTagRect(side, L.here.x + dx, L.here.y + dy);
        for (const c of codes) expect(hit(tag, c)).toBe(false);
      });

      it('never lets a mark, a label, a tag or a name cover a code', () => {
        for (const p of L.pois) {
          const r = p.small ? 10 : 12;
          for (const c of codes) expect(hit(centered(p.x, p.y, r * 2, r * 2), c)).toBe(false);
          if (p.label) {
            const w = textWidth(p.text, 12);
            const lr =
              p.label === 'right'
                ? { x: p.x + 14, y: p.y - 9, w: w + 4, h: 18 }
                : { x: p.x - 18 - w, y: p.y - 9, w: w + 4, h: 18 };
            for (const c of codes) expect(hit(lr, c)).toBe(false);
          }
        }
        for (const t of L.minuteTags)
          for (const c of codes) expect(hit(centered(t.x, t.y, 30, 22), c)).toBe(false);
        if (L.circleTag)
          for (const c of codes)
            expect(
              hit(centered(L.circleTag.x, L.circleTag.y, textWidth(L.circleTag.text, 12) + 18, 22), c),
            ).toBe(false);
        const boxes = L.names.map((n) => nameRect(n.text, n.kind, n.x, n.y));
        const marks = L.pois.map((p) => centered(p.x, p.y, 22, 22));
        for (const [i, r] of boxes.entries()) {
          for (const c of [...codes, ...marks]) expect(hit(r, c)).toBe(false);
          for (const o of boxes.slice(i + 1)) expect(hit(r, o)).toBe(false);
        }
      });

      it('pins the picked community’s card over no code, marker, control or anchor', () => {
        if (narrow) {
          expect(L.cards).toEqual([]);
          return;
        }
        // one card at a time
        expect(L.cards).toHaveLength(1);
        const here = centered(L.here.x, L.here.y, 34, 34);
        for (const p of L.cards) {
          const card = { x: p.left, y: p.top, w: p.w, h: p.h };
          expect(hit(card, centered(p.ax, p.ay, 16, 16))).toBe(false);
          expect(hit(card, here)).toBe(false);
          for (const c of codes) expect(hit(card, c)).toBe(false);
          for (const f of floats) expect(hit(card, f)).toBe(false);
          expect(card.x).toBeGreaterThanOrEqual(10);
          expect(card.y + card.h).toBeLessThanOrEqual(H - 10);
          // the leader lands on the card's edge
          const onEdge =
            Math.abs(p.lx - p.left) < 0.5 ||
            Math.abs(p.lx - (p.left + p.w)) < 0.5 ||
            Math.abs(p.ly - p.top) < 0.5 ||
            Math.abs(p.ly - (p.top + p.h)) < 0.5;
          expect(onEdge).toBe(true);
        }
        const [a, b] = L.cards;
        if (a && b)
          expect(hit({ x: a.left, y: a.top, w: a.w, h: a.h }, { x: b.left, y: b.top, w: b.w, h: b.h })).toBe(
            false,
          );
      });

      if (narrow) {
        it('drops names, labels, the circle tag and all but the 15′ tag on a narrow map', () => {
          expect(L.names).toEqual([]);
          expect(L.circleTag).toBeNull();
          expect(L.minuteTags.every((t) => t.L === 900)).toBe(true);
          expect(L.pois.every((p) => p.label === null)).toBe(true);
        });
      }
    });
  }
}

describe('facility marks follow the view', () => {
  const view = staticView(1040, 840, compositionFor(false));
  it('体检单: the chosen category only, named where there is room', () => {
    for (const cat of model.cats) {
      const L = layout(model, view, { marks: { kind: 'category', cat, list: facilityMarks(model, 1) } });
      expect(L.pois.length).toBeGreaterThan(0);
      expect(L.pois.every((p) => p.cat === cat)).toBe(true);
      expect(L.pois.some((p) => p.label !== null)).toBe(true);
    }
  });
  it('圈内设施: every facility the circle claims or the walk reaches; the missed ones dashed', () => {
    const marks = facilityMarks(model, 1);
    const L = layout(model, view, { marks: { kind: 'all', list: marks } });
    expect(new Set(L.pois.map((p) => p.cat)).size).toBeGreaterThan(3);
    const far = L.pois.filter((p) => p.far);
    expect(far.length).toBeGreaterThan(0);
    for (const p of far) {
      const m = marks.find((x) => x.key === p.key)!;
      expect(m.inCircle && !m.reach).toBe(true);
    }
    expect(L.pois.every((p) => p.label === null)).toBe(true);
  });
});

describe('the elder profile: one circle everywhere', () => {
  const elder = profileScale('elder', model.vAdult);
  const view = staticView(1040, 840, compositionFor(false));
  it('names and places the circle at 900 s × 0.9 m/s = 810 m', () => {
    expect(circleR(model, 1)).toBeCloseTo(model.r15, 6);
    expect(circleR(model, elder)).toBeCloseTo(810, 6);
    const L = layout(model, view, { scale: elder });
    expect(L.circleTag?.text).toBe('片区中心 · 直线 15′ 圈 · 810 m');
    const d = Math.hypot(view.mx(L.circleTag!.x), view.my(L.circleTag!.y));
    expect(d).toBeCloseTo(810, 0);
    expect(layout(model, view).circleTag?.text).toBe('片区中心 · 直线 15′ 圈 · 1,053 m');
  });
});

/* ---------------- the printed report ---------------- */

describe('the report map keeps codes apart and ties moved ones back', () => {
  for (const m of models) {
    it(m.id, () => {
      const view = staticView(MAP_W, MAP_H, { cx: 0, cy: 0, span: m.r15 * 2.2 });
      const L = layoutOverlay({
        model: m,
        view,
        narrow: false,
        playing: false,
        T: 900,
        scale: 1,
        circle: true,
        marks: {
          kind: 'all',
          list: facilityMarks(m, 1).filter((x) => ['小学', '菜市场', '药店'].includes(x.cat)),
        },
        names: false,
      });
      const codes = L.units.map((u) => u.rect);
      for (let i = 0; i < codes.length; i++)
        for (let j = i + 1; j < codes.length; j++) expect(hit(codes[i]!, codes[j]!)).toBe(false);
      expect(L.names).toEqual([]);
      const ticks = codeTicks(L.units, view);
      for (const t of ticks) expect(Math.hypot(t.x2 - t.x1, t.y2 - t.y1)).toBeGreaterThanOrEqual(9);
    });
  }
});

/* ---------------- a new centre, picked on the map ---------------- */

describe('the map-click confirmation card covers no unit code (The Codes Win Rule)', () => {
  for (const { name, W, H } of SIZES.filter((sz) => sz.W >= NARROW_PX)) {
    it(`${name}: a grid of clicks over zj-a and zj-b`, () => {
      for (const m of [models[0]!, models[1]!]) {
        const view = staticView(W, H, compositionFor(false));
        const L = layout(m, view, { cards: [] });
        const band = { top: 72, bottom: 104 };
        for (let y = band.top + 10; y < H - band.bottom; y += 37) {
          for (let x = 20; x < W - 20; x += 41) {
            const p = placeConfirm(x, y, W, H, L.blockers, band);
            if (!p) continue;
            const plate = { x: p.left, y: p.top, w: CONFIRM.w, h: CONFIRM.h };
            for (const c of L.units.map((u) => u.rect)) expect(hit(plate, c)).toBe(false);
            expect(plate.x).toBeGreaterThanOrEqual(8);
            expect(plate.x + plate.w).toBeLessThanOrEqual(W - 8);
            expect(plate.y).toBeGreaterThanOrEqual(band.top);
            expect(plate.y + plate.h).toBeLessThanOrEqual(H - band.bottom);
            expect(hit(plate, centered(x, y, PIN_R * 2, PIN_R * 2))).toBe(false);
          }
        }
      }
    });
  }

  it('sits right beside the point when there is room, and joins it with a stem when it cannot', () => {
    const p = placeConfirm(200, 300, 952, 872, [], { top: 76, bottom: 104 });
    expect(p?.left).toBe(200 + PIN_R + 8);
    expect(p?.stem).toBeNull();
    const walled = placeConfirm(200, 300, 952, 872, [{ x: 0, y: 150, w: 952, h: 300 }], {
      top: 76,
      bottom: 104,
    });
    expect(walled?.stem).not.toBeNull();
    expect(
      placeConfirm(200, 300, 952, 872, [{ x: 0, y: 0, w: 952, h: 872 }], { top: 76, bottom: 104 }),
    ).toBeNull();
  });
});

/* ---------------- names and 规划 pins ---------------- */

describe('names in the quiet voice', () => {
  it('shares one name over a group of phases (申城佳苑, 川杨新苑) where there is room', () => {
    const view = staticView(1040, 840, compositionFor(false));
    const L = layout(model, view);
    const groups = L.names.filter((n) => n.kind === 'group').map((n) => n.text);
    expect(groups.length).toBeGreaterThan(0);
    // a unit's name sits right beside its own code
    for (const n of L.names.filter((x) => x.kind === 'unit')) {
      const u = L.units.find((x) => `u:${x.unit.code}` === n.key)!;
      expect(Math.abs(n.y - u.y)).toBeLessThan(1);
    }
  });

  it('shares a name only over phases gathered round it: an outlying phase carries its full name', () => {
    const at = (p: { xy: [number, number] }) => p.xy;
    const a = { xy: [0, 0] as [number, number] };
    const b = { xy: [40, 0] as [number, number] };
    const far = { xy: [400, 0] as [number, number] };
    const neighbour = { xy: [120, 0] as [number, number] };
    // the far phase makes the centre a neighbour's: it drops out, the two close phases keep the name
    expect(sharedNameMembers([a, b, far], [neighbour], at)).toEqual([a, b]);
    // phases spread among other compounds (玉兰香苑): no shared name at all
    expect(sharedNameMembers([a, far], [neighbour], at)).toEqual([]);
    expect(sharedNameMembers([a, b], [], at)).toEqual([a, b]);
  });

  it('the printed report leaves names to its tables', () => {
    const report = staticView(MAP_W, MAP_H, { cx: 0, cy: 0, span: model.r15 * 2.2 });
    expect(layout(model, report, { names: false }).names).toEqual([]);
  });
});

describe('规划 pins yield to the codes and keep a tick back to their point', () => {
  const b = models[1]!;
  const view = staticView(1040, 840, compositionFor(false));
  const sites = (b.data.site_suggestions?.['菜市场'] ?? []).map((s) => ({
    key: `菜市场#${s.rank}`,
    xy: s.xy,
    kind: 'site' as const,
    cat: '菜市场' as const,
    icon: 'pg-market' as const,
    rank: s.rank,
    label: `新增后可覆盖 ${s.covers.length} 个小区`,
    verified: s.verified,
    aria: '',
  }));
  const L = layout(b, view, { sites, cards: [] });

  it('places every suggestion, off every code', () => {
    expect(L.sites).toHaveLength(sites.length);
    for (const p of L.sites) {
      const moved = Math.hypot(p.x - p.px, p.y - p.py) > 0;
      if (moved) for (const u of L.units) expect(hit(centered(p.x, p.y, 34, 34), u.rect)).toBe(false);
      if (p.lx !== null)
        for (const u of L.units)
          expect(hit({ x: p.lx, y: p.ly - 12, w: textWidth(p.label, 12) + 58, h: 24 }, u.rect)).toBe(false);
    }
  });
});

describe('Baidu’s logo stays visible', () => {
  it('slides along its band to a stretch no code covers, and everything else keeps off it', () => {
    for (const m of models) {
      for (const { W, H } of SIZES) {
        const view = frame(m, W, H);
        const band = { y: H - 150, w: 66, h: 26 };
        const L = layout(m, view, { logo: band });
        expect(L.logo).not.toBeNull();
        const r = { x: L.logo!.x, y: band.y, w: band.w, h: band.h };
        for (const u of L.units) expect(hit(r, u.rect)).toBe(false);
        for (const p of L.pois) expect(hit(r, centered(p.x, p.y, 22, 22))).toBe(false);
        for (const n of L.names) expect(hit(r, nameRect(n.text, n.kind, n.x, n.y))).toBe(false);
      }
    }
  });
});

describe('a narrow map frames the homes, not a fixed point', () => {
  it('keeps every unit and 你在这里 inside the band between the legend and the 走一遍 card', () => {
    for (const m of models) {
      for (const { W, H } of SIZES.filter((z) => z.W < NARROW_PX)) {
        const view = frame(m, W, H);
        const { top, bottom } = bandOf(H);
        for (const [x, y] of [[0, 0] as const, ...m.units.map((u) => u.centroid)]) {
          expect(view.x(x)).toBeGreaterThan(0);
          expect(view.x(x)).toBeLessThan(W);
          expect(view.y(y)).toBeGreaterThan(top + 11);
          expect(view.y(y)).toBeLessThan(bottom - 11);
        }
      }
    }
  });

  it('centres the bounding box of the codes and the origin', () => {
    const c = focusedComposition({ cx: 0, cy: 30, span: 2150 }, [
      [-800, -900],
      [900, 200],
    ]);
    expect(c).toEqual({ cx: 50, cy: -350, span: 2150 });
    expect(focusedComposition({ cx: 0, cy: 30, span: 2150 }, [[400, 300]])).toEqual({
      cx: 200,
      cy: 150,
      span: 2150,
    });
  });
});
