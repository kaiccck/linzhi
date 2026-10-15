import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AnalysisResult } from '@zoudedao/core';
import { deriveModel } from '@web/model/derive';
import { checkLook } from '@web/model/looks';
import { unitNo } from '../model/unitNo';
import { buildLayers, legendItems, reachRings, toLatLng, type LayerInput } from './layers';

const data = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../data/samples/zj-a.json', import.meta.url)), 'utf8'),
) as AnalysisResult;
const model = deriveModel(data, 'zj-a');
const base: LayerInput = {
  model,
  cat: '小学',
  T: 900,
  scale: 1,
  playing: false,
  circle: true,
  heat: true,
  gray: false,
  hot: null,
  selected: null,
  route: null,
  plan: null,
  places: null,
  lit: null,
};

describe('map layers', () => {
  it('puts the centre where Baidu’s BD-09 point is on the GCJ-02 basemap', () => {
    const c = toLatLng(model, [0, 0]);
    // 申城佳苑 centre, BD-09 121.644195, 31.19007 → GCJ-02 ≈ 121.6377, 31.1844
    expect(c.longitude).toBeCloseTo(121.6377, 3);
    expect(c.latitude).toBeCloseTo(31.1844, 3);
  });

  it('draws the reach, the circle, every community and its plate', () => {
    const L = buildLayers(base);
    const plates = [...L.hits.values()].filter((h) => h.kind === 'unit');
    expect(plates).toHaveLength(model.units.length);
    // the 15′ reach (outlined over the heat overlay) and the outlined communities
    expect(L.polygons.length).toBeGreaterThanOrEqual(model.units.filter((u) => u.pts.length >= 3).length + 1);
    expect(L.polylines).toHaveLength(1);
    expect(L.markers.every((m) => Number.isInteger(m.id) && m.iconPath.startsWith('/assets/markers/'))).toBe(
      true,
    );
    expect(new Set(L.markers.map((m) => m.id)).size).toBe(L.markers.length);
  });

  it('tints a 伪覆盖 community red and holds every verdict while 走一遍 plays', () => {
    const cat = model.cats.find((k) => model.units.some((u) => checkLook(u.checks[k]) === 'pseudo'))!;
    const pseudo = model.units.find((u) => checkLook(u.checks[cat]) === 'pseudo')!;
    const L = buildLayers({ ...base, cat });
    const plate = L.markers.find((m) => m.label?.content === unitNo(pseudo.code))!;
    expect(plate.label!.borderColor).toBe('#E0483E');
    const P = buildLayers({ ...base, cat, playing: true, T: 300 });
    expect(P.markers.find((m) => m.label?.content === unitNo(pseudo.code))!.label!.borderColor).toBe(
      '#C5CCD6',
    );
  });

  it('lists in the legend only the plate styles the map shows, then the drawn areas', () => {
    const cat = model.cats.find((k) => model.units.some((u) => checkLook(u.checks[k]) === 'pseudo'))!;
    const words = legendItems(model, cat, { gray: true, circle: true }).map((i) => i.word);
    expect(words[0]).toBe('绕路太远');
    expect(words.slice(-1)).toEqual(['直线圈']);
    const looks = new Set(model.units.map((u) => checkLook(u.checks[cat])));
    expect(words.includes('走得到')).toBe(looks.has('ok'));
    expect(legendItems(model, cat, { gray: false, circle: false }).map((i) => i.kind)).not.toContain('line');
  });

  it('numbers the plates, and names the chosen community on its plate', () => {
    const u = model.units[0]!;
    const L = buildLayers({ ...base, selected: u.code });
    const plates = L.markers.filter((m) => m.label).map((m) => m.label!.content);
    expect(plates).toContain(`${unitNo(u.code)} ${u.nameMain}`);
    expect(plates.filter((c) => /^\d+$/.test(c))).toHaveLength(model.units.length - 1);
  });

  it('grows the reach with time and shrinks it for a slower walker', () => {
    const area = (rings: [number, number][][]) =>
      rings.reduce((s, r) => {
        let a = 0;
        for (let i = 0; i < r.length; i++) {
          const [x1, y1] = r[i]!;
          const [x2, y2] = r[(i + 1) % r.length]!;
          a += x1 * y2 - x2 * y1;
        }
        return s + Math.abs(a / 2);
      }, 0);
    const a5 = area(reachRings(model, 300, 1));
    const a10 = area(reachRings(model, 600, 1));
    const a15 = area(reachRings(model, 900, 1));
    const elder = area(reachRings(model, 900, model.vAdult / 0.9));
    expect(a5).toBeLessThan(a10);
    expect(a10).toBeLessThan(a15);
    expect(elder).toBeLessThan(a15);
    // the stored 15′ area, km² (1.857 for 申城佳苑)
    expect(a15 / 1e6).toBeGreaterThan(1.6);
    expect(a15 / 1e6).toBeLessThan(2.1);
  });
});
