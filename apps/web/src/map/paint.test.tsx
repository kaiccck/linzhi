/**
 * The map's print: the order of the layers, the community tints following the category chosen in
 * the panel, the straight circle at the profile's radius, the 灰色区域 layer and its key, the multiplied
 * field over Baidu, and the Baidu style itself (plain tokens, crisp names, no POI icons).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AnalysisResult } from '@zoudedao/core';
import rawA from '../../../../data/samples/zj-a.json?raw';
import raw from '../../../../data/samples/zj-b.json?raw';
import { LayerOptions, MapLegend } from '../components/Controls.js';
import { staticView } from '../geo/view.js';
import { circleR, deriveModel, profileScale } from '../model/derive.js';
import { grayLevels, grayRuleText, hasGray, insideRings } from '../model/gray.js';
import { categoryLook, neutralLook, worstLook } from '../model/looks.js';
import { COL, multiplied, paintPlan, rampAt, ScenePainter, TINT, type PlanInput } from './paint.js';
import { BLOCK_NAMES, GROUND, LIGHT_MAP_STYLE, PLACE_NAMES, QUIET } from './signMapStyle.js';

const data = JSON.parse(raw) as AnalysisResult;
const withGray = deriveModel(data, 'zj-b');
const a = deriveModel(JSON.parse(rawA) as AnalysisResult, 'zj-a');

const base: PlanInput = {
  T: 900,
  circle: true,
  playing: false,
  gray: true,
  hasGray: true,
  offline: false,
  hasBase: false,
  route: true,
};

describe('paint plan', () => {
  it('prints the field and the gray tint under everything, the offline streets over them', () => {
    expect(paintPlan({ ...base, offline: true, hasBase: true }).under).toEqual([
      'ground',
      'field',
      'gray-fill',
      'streets',
    ]);
    expect(paintPlan(base).under).toEqual(['ground', 'field', 'gray-fill']);
  });

  it('closes the gray areas under the community tints, isochrones, circle and route; names last offline', () => {
    expect(paintPlan(base).over).toEqual(['gray-edge', 'plates', 'isochrones', 'circle', 'route']);
    expect(paintPlan({ ...base, offline: true, hasBase: true }).over.at(-1)).toBe('labels');
  });

  it('holds the gray areas and the route back while 走一遍 plays (The Verdict Waits)', () => {
    for (const p of [{ gray: false }, { hasGray: false }, { playing: true, T: 420 }]) {
      const plan = paintPlan({ ...base, ...p });
      expect(plan.under).not.toContain('gray-fill');
      expect(plan.over).not.toContain('gray-edge');
    }
    expect(paintPlan({ ...base, playing: true, T: 420 }).over).toContain('front');
    expect(paintPlan({ ...base, playing: true, T: 420 }).over).not.toContain('route');
    expect(paintPlan({ ...base, T: 300 }).under).toContain('gray-fill');
  });
});

/* ---------------- a recording canvas: what the painter asks for ---------------- */

interface Op {
  op: string;
  args: unknown[];
  fillStyle: unknown;
  strokeStyle: unknown;
}
function recorder(log: Op[]) {
  const state: Record<string, unknown> = { fillStyle: '#000', strokeStyle: '#000', lineWidth: 1 };
  const canvas = { width: 1040, height: 840 };
  return new Proxy(state, {
    get(t, key: string) {
      if (key in t) return t[key];
      if (key === 'canvas') return canvas;
      if (key === 'createImageData')
        return (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
      if (key === 'measureText') return (s: string) => ({ width: s.length * 12 });
      if (key === 'createPattern') return () => ({ setTransform() {} });
      return (...args: unknown[]) => {
        log.push({ op: key, args, fillStyle: t.fillStyle, strokeStyle: t.strokeStyle });
      };
    },
    set(t, key: string, v) {
      t[key] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

describe('the painter', () => {
  let under: Op[];
  let over: Op[];
  beforeEach(() => {
    vi.stubGlobal('document', {
      createElement: () => ({ width: 0, height: 0, getContext: () => recorder([]) }),
    });
    under = [];
    over = [];
  });
  afterEach(() => vi.unstubAllGlobals());

  const view = staticView(1040, 840, { cx: 300, cy: -20, span: 2500 });
  const paint = (look: typeof neutralLook | ReturnType<typeof categoryLook>, scale = 1, offline = false) =>
    new ScenePainter(a).paint(
      recorder(under),
      recorder(over),
      view,
      { T: 900, scale, circle: true, heat: true, hot: null, playing: false, gray: false, look, route: false },
      1,
      offline,
    );
  const plateFills = () => over.filter((o) => o.op === 'fill').map((o) => o.fillStyle);

  it('tints every community by the category chosen in the panel', () => {
    for (const cat of ['小学', '菜市场', '药店'] as const) {
      over = [];
      paint(categoryLook(cat));
      const look = categoryLook(cat);
      const want = a.units.map((u) => {
        const l = look(u);
        return l === 'edge' ? TINT.ok : l === 'edge-over' ? TINT.pseudo : TINT[l];
      });
      expect(plateFills()).toEqual(want);
    }
    // 小学 and 菜市场 differ for this sample: the map really follows the choice
    over = [];
    paint(categoryLook('小学'));
    const school = plateFills();
    over = [];
    paint(categoryLook('菜市场'));
    expect(plateFills()).not.toEqual(school);
    // 伪覆盖 plates wear the red edge
    expect(over.some((o) => o.op === 'stroke' && o.strokeStyle === COL.pseudo)).toBe(true);
  });

  it('keeps every plate neutral on the 圈内设施 map', () => {
    paint(neutralLook);
    expect(new Set(plateFills())).toEqual(new Set([TINT.neutral]));
  });

  it('draws the straight circle at the profile’s radius (810 m for the elder)', () => {
    const elder = profileScale('elder', a.vAdult);
    for (const [scale, r] of [
      [1, a.r15],
      [elder, 810],
    ] as const) {
      over = [];
      paint(worstLook, scale);
      const e = over.find((o) => o.op === 'ellipse')!;
      expect(e.args[2]).toBeCloseTo(circleR(a, scale) * view.sx, 6);
      expect(circleR(a, scale)).toBeCloseTo(r, 6);
    }
  });

  it('leaves the canvas under Baidu clear (the map is the ground); offline it lays the ground itself', () => {
    paint(worstLook);
    expect(under.some((o) => o.op === 'fillRect')).toBe(false);
    under = [];
    paint(worstLook, 1, true);
    expect(under.find((o) => o.op === 'fillRect')?.fillStyle).toBe(GROUND);
  });
});

describe('the field over Baidu', () => {
  it('is multiplied in with the mockup’s tones divided by the ground', () => {
    const g = [1, 3, 5].map((i) => parseInt(GROUND.slice(i, i + 2), 16));
    const c = rampAt(0);
    const s = multiplied(c);
    // multiply over the ground at alpha a lands where source-over of the mockup colour did
    for (let i = 0; i < 3; i++) {
      const over = g[i]! * (1 - c[3]) + c[i]! * c[3];
      const mult = g[i]! * (1 - c[3] + (c[3] * s[i]!) / 255);
      expect(Math.abs(over - mult)).toBeLessThan(0.6);
    }
    expect(s[3]).toBe(c[3]);
  });
});

describe('the Baidu style: plain tokens, names on in a muted voice, no POI icons', () => {
  const rules = LIGHT_MAP_STYLE;
  it('writes plain opaque colours (the layer is never blended)', () => {
    expect(rules.find((r) => r.featureType === 'land')?.stylers.color).toBe(`${GROUND}ff`);
    for (const r of rules)
      if (typeof r.stylers.color === 'string') expect(r.stylers.color).toMatch(/^#[0-9a-f]{8}$/);
  });
  it('keeps the place names, turns the icons, the clutter and Baidu’s compound names off', () => {
    for (const t of PLACE_NAMES)
      expect(rules.some((r) => r.featureType === t && r.elementType === 'labels.text.fill')).toBe(true);
    // Baidu's compound names and the names it prints on the blocks: every label part off, at every
    // level (the map names the compounds it checks)
    for (const t of BLOCK_NAMES)
      for (const part of ['labels', 'labels.text', 'labels.text.fill', 'labels.text.stroke']) {
        const off = rules.filter(
          (r) => r.featureType === t && r.elementType === part && r.stylers.visibility === 'off',
        );
        expect(off.length).toBeGreaterThan(0);
        expect(off.every((r) => r.stylers.level === undefined)).toBe(true);
      }
    expect(
      rules.find((r) => r.featureType === 'poilabel' && r.elementType === 'labels.icon')?.stylers.visibility,
    ).toBe('off');
    for (const t of QUIET) expect(rules.find((r) => r.featureType === t)?.stylers.visibility).toBe('off');
    // firms and hamlets are clutter, not places
    expect(QUIET).toEqual(expect.arrayContaining(['companylabel', 'village']));
  });
});

describe('gray levels of a live result', () => {
  const levels = grayLevels(withGray);
  it('orders the nested gap levels by severity, then the 伪覆盖 part', () => {
    // five checked categories: a place can lack up to five
    expect(levels.map((g) => `${g.kind}${g.min}`)).toEqual([
      'gap1',
      'gap2',
      'gap3',
      'gap4',
      'gap5',
      'pseudo1',
    ]);
    const gaps = levels.filter((g) => g.kind === 'gap');
    for (let i = 1; i < gaps.length; i++) expect(gaps[i]!.areaKm2).toBeLessThanOrEqual(gaps[i - 1]!.areaKm2);
  });
  it('finds the communities inside (even-odd, holes respected)', () => {
    const outer = levels[0]!;
    expect(outer.units.length).toBeGreaterThan(0);
    for (const u of outer.units) expect(insideRings(outer.rings, u.centroid[0], u.centroid[1])).toBe(true);
    const square = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ] as [number, number][];
    const hole = [
      [3, 3],
      [3, 7],
      [7, 7],
      [7, 3],
    ] as [number, number][];
    expect(insideRings([square, hole], 1, 1)).toBe(true);
    expect(insideRings([square, hole], 5, 5)).toBe(false);
  });
});

describe('legend and layer switch', () => {
  it('adds the gray entry, in the rule’s own words, only when the layer is on', () => {
    expect(grayRuleText({ ruleM: 1000, cats: ['小学', '菜市场', '药店'] })).toBe(
      '步行 1 公里内缺少小学、菜市场或药店',
    );
    expect(grayRuleText({ ruleM: 1000, cats: ['幼儿园', '小学', '菜市场', '药店', '社区卫生'] })).toBe(
      '步行 1 公里内缺少幼儿园、小学、菜市场、药店或社区卫生',
    );
    const legend = (gray: boolean) =>
      renderToStaticMarkup(
        <MapLegend
          legend={{
            kind: 'category',
            cat: '菜市场',
            rule: 1000,
            looks: new Set(['ok', 'pseudo']),
            sites: false,
          }}
          gray={gray}
          grayRule={grayRuleText({ ruleM: 1000, cats: ['小学', '菜市场', '药店'] })}
        />,
      );
    expect(legend(true)).toContain('title="灰色区域：步行 1 公里内缺少小学、菜市场或药店"');
    expect(legend(true)).toContain('sw s-gray');
    expect(legend(false)).not.toContain('灰色区域');
    // only the states present on the map get a key
    expect(legend(false)).toContain('伪覆盖');
    expect(legend(false)).not.toContain('盲区');
  });

  it('offers the 灰色区域 toggle beside the other layers, only when there is a layer to toggle', () => {
    const plate = (gray: boolean | null) =>
      renderToStaticMarkup(
        <LayerOptions
          circle
          onCircle={() => {}}
          heat
          onHeat={() => {}}
          gray={gray}
          onGray={() => {}}
          method={false}
          onMethod={() => {}}
          profile="adult"
          onProfile={() => {}}
          vAdult={1.17}
          vElder={0.9}
          crossing={false}
          onCrossing={() => {}}
        />,
      );
    expect(plate(true)).toMatch(/aria-pressed="true"[^>]*>.*灰色区域/);
    expect(plate(false)).toMatch(/l-gray" aria-pressed="false"/);
    expect(plate(null)).not.toContain('灰色区域');
    expect(hasGray(withGray)).toBe(true);
    expect(hasGray(deriveModel({ ...data, gray_areas: [] }, 'zj-b'))).toBe(false);
  });
});
