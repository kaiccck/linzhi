/**
 * The three review rules in DESIGN.md, checked on the real sample at the capture sizes:
 * The Codes Win Rule, The Anchor Stays Visible Rule, and the narrow-map density tier.
 */
import { describe, expect, it } from 'vitest';
import type { AnalysisResult } from '@zoudedao/core';
import raw from '../../../../data/samples/zj-a.json?raw';
import { compositionFor, NARROW_PX, staticView } from '../geo/view.js';
import { deriveModel } from '../model/derive.js';
import { CARD_W, hereTagRect, layoutOverlay, planCallouts, textWidth, type Rect } from './layout.js';

const model = deriveModel(JSON.parse(raw) as AnalysisResult, 'zj-a');

const hit = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const centered = (x: number, y: number, w: number, h: number): Rect => ({ x: x - w / 2, y: y - h / 2, w, h });

// map boxes of the captures: 1440×900 desktop, 1920×1080 wide, 390-wide phone (stacked)
const SIZES = [
  { name: 'desktop 1440', W: 952, H: 872 },
  { name: 'wide 1920', W: 1338, H: 1052 },
  { name: 'phone 390', W: 370, H: 560 },
  { name: 'tablet 1024', W: 570, H: 872 },
];

for (const { name, W, H } of SIZES) {
  const narrow = W < NARROW_PX;
  const view = staticView(W, H, compositionFor(narrow));
  const rail = !narrow;
  const L = layoutOverlay({
    model,
    view,
    narrow,
    offline: true,
    playing: false,
    T: 900,
    scale: 1,
    circle: true,
    rail,
  });
  const codes = L.units.map((u) => u.rect);

  describe(`${name} (${narrow ? 'narrow' : 'full'} map)`, () => {
    it('keeps unit codes clear of each other and of the 你在这里 disc', () => {
      for (let i = 0; i < codes.length; i++) {
        for (let j = i + 1; j < codes.length; j++) expect(hit(codes[i]!, codes[j]!)).toBe(false);
        const c = codes[i]!;
        const nx = Math.max(c.x, Math.min(L.here.x, c.x + c.w));
        const ny = Math.max(c.y, Math.min(L.here.y, c.y + c.h));
        expect(Math.hypot(nx - L.here.x, ny - L.here.y)).toBeGreaterThanOrEqual(23);
      }
    });

    it('never lets the flag cover a code', () => {
      const { side, dx, dy } = L.here;
      if (side === 'none') return;
      const tag =
        side === 'free'
          ? centered(L.here.x + dx, L.here.y + dy, 86, 32)
          : hereTagRect(side, L.here.x + dx, L.here.y + dy);
      for (const c of codes) expect(hit(tag, c)).toBe(false);
      if (narrow) expect(side).not.toBe('none');
    });

    it('never lets tiles, labels, minute tags or the circle tag cover a code', () => {
      for (const p of L.pois) {
        const size = p.minor ? 18 : 26;
        for (const c of codes) expect(hit(centered(p.x, p.y, size, size), c)).toBe(false);
        if (p.show) {
          const lw = textWidth(p.label, 12) + 14;
          const r = { x: p.flip ? p.x - size / 2 - 6 - lw : p.x + size / 2 + 6, y: p.y - 11, w: lw, h: 22 };
          for (const c of codes) expect(hit(r, c)).toBe(false);
        }
      }
      for (const t of L.minuteTags)
        for (const c of codes) expect(hit(centered(t.x, t.y, 36, 24), c)).toBe(false);
      if (L.circleTag)
        for (const c of codes) expect(hit(centered(L.circleTag.x, L.circleTag.y, 200, 27), c)).toBe(false);
      if (narrow) {
        expect(L.circleTag).toBeNull();
        expect(L.minuteTags.map((t) => t.L)).toEqual([900]);
        expect(L.pois.every((p) => !p.minor && !p.show)).toBe(true);
      }
    });

    if (rail) {
      it('keeps every callout off its own anchor and off the codes', () => {
        const heights = { hatch: 70, east: 88, school: 88 };
        const plans = planCallouts(model.findings, heights, view, L.blockers);
        expect(plans).toHaveLength(3);
        for (const p of plans) {
          const card = { x: p.left, y: p.top, w: p.w, h: p.h };
          expect(p.w).toBe(CARD_W);
          // the anchor dot (r 5.5 + 2.5 ring) stays outside the card
          expect(hit(card, centered(p.ax, p.ay, 16, 16))).toBe(false);
          if (p.ax > W - 270) {
            // anchor inside the rail: the card parks 24px above (or below) it
            expect(p.top + p.h <= p.ay - 24 || p.top >= p.ay + 24).toBe(true);
          } else {
            expect(p.lx).toBe(p.left);
          }
          for (const c of codes) expect(hit(card, c)).toBe(false);
        }
        for (let i = 0; i < plans.length; i++) {
          for (let j = i + 1; j < plans.length; j++) {
            const a = plans[i]!;
            const b = plans[j]!;
            expect(
              hit({ x: a.left, y: a.top, w: a.w, h: a.h }, { x: b.left, y: b.top, w: b.w, h: b.h }),
            ).toBe(false);
          }
        }
      });
    }
  });
}

it('the east route endpoint sits inside the rail at 1440×900 (the case the rule was written for)', () => {
  const view = staticView(952, 872, compositionFor(false));
  const east = model.findings.find((f) => f.key === 'east')!;
  expect(view.x(east.anchor[0])).toBeGreaterThan(952 - 270);
});
