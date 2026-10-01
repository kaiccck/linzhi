import { describe, expect, it } from 'vitest';
import type { AnalysisResult } from '@zoudedao/core';
import raw from '../../../../data/samples/zj-a.json?raw';
import rawV from '../../../../data/samples/zj-v.json?raw';
import { frameFromMeta } from '../geo/frame.js';
import { withPending } from './pending.test-data.js';
import {
  circleKm2,
  circleMissShare,
  circleR,
  compass,
  deriveModel,
  detourReach,
  profileScale,
  reachArea,
  splitName,
  towards,
  worstUnit,
} from './derive.js';

const data = JSON.parse(raw) as AnalysisResult;
const model = deriveModel(data, 'zj-a');

describe('frame', () => {
  it('parses meta.frame_formula and inverts it', () => {
    const f = frameFromMeta(data.meta);
    expect(f.fromFormula).toBe(true);
    expect(f.lng0).toBeCloseTo(121.644195, 9);
    expect(f.lat0).toBeCloseTo(31.19007, 9);
    const [lng, lat] = f.toLngLat(996.1, 23.4);
    const [x, y] = f.toXY(lng, lat);
    expect(x).toBeCloseTo(996.1, 6);
    expect(y).toBeCloseTo(23.4, 6);
  });
});

describe('derived sign numbers (every number is computed, none typed in)', () => {
  it('verdict: the circle finds 1 gap, walking finds 9 (8 of them among 小学, 菜市场, 药店)', () => {
    expect(model.cats).toEqual(['幼儿园', '小学', '菜市场', '药店', '社区卫生']);
    expect(model.circleGaps).toBe(1);
    expect(model.walkGaps).toBe(9);
    const task = model.heads.filter((h) => ['小学', '菜市场', '药店'].includes(h.cat));
    expect(task.reduce((n, h) => n + h.pseudo + h.blind, 0)).toBe(8);
  });
  it('directory heads: five categories side by side, nothing pending since every nearer pharmacy was routed', () => {
    expect(model.heads.map((h) => [h.cat, h.ok, h.pending])).toEqual([
      ['幼儿园', 12, 0],
      ['小学', 6, 0],
      ['菜市场', 10, 0],
      ['药店', 12, 0],
      ['社区卫生', 11, 0],
    ]);
    // a pending check counts neither as covered nor as a gap
    const p = deriveModel(withPending(data), 'zj-a');
    expect(p.heads.find((h) => h.cat === '药店')).toMatchObject({ ok: 10, pending: 2 });
    expect(p.walkGaps).toBe(model.walkGaps);
  });
  it('codes run north to south, the board runs worst first', () => {
    expect(model.units.map((u) => u.code).sort()).toEqual(
      Array.from({ length: 12 }, (_, i) => `A-${String(i + 1).padStart(2, '0')}`),
    );
    // A-10 申城佳苑三期A块 holds the one blind spot left (no primary school within 1 km even by straight line)
    expect(model.boardOrder[0]?.code).toBe('A-10');
    expect(model.boardOrder.at(-1)?.code).toBe('A-12');
  });
  it('findings quote the measured facts of the mockup', () => {
    // the route the data names its barriers for: due east, 996 m straight, 2,102 m on foot
    expect(model.detour && compass(model.detour.bearing)).toBe('正东');
    expect(Math.round(model.detour!.straight)).toBe(996);
    expect(Math.round(model.detour!.route)).toBe(2102);
    expect(model.barrierNames).toEqual(['河道', 'S20 外环']);
    const reach = detourReach(model, 1);
    expect(reach && Math.round(reach / 10) * 10).toBe(470);
    expect(towards(model.detour!.bearing)).toBe('向东');
    expect(worstUnit(model, '小学')?.unit.code).toBe('A-11');
    expect(worstUnit(model, '小学')?.kind).toBe('pseudo');
    expect(Math.round(reachArea(model.raster, 900, 1) * 100) / 100).toBeCloseTo(1.86, 2);
    // the readout: the circle's 3.48 km², 47 % of it not walkable in 15′
    expect(circleKm2(model, 1)).toBeCloseTo(data.stats.area_circle15_km2, 2);
    expect(Math.round(circleMissShare(model, 1) * 100)).toBe(47);
  });
  it('elder profile slows every time by 1.17 / 0.9 and shrinks the circle to 810 m', () => {
    const elder = profileScale('elder', model.vAdult);
    expect(elder).toBeCloseTo(1.3, 6);
    expect(reachArea(model.raster, 900, elder)).toBeLessThan(reachArea(model.raster, 900, 1));
    expect(circleR(model, elder)).toBeCloseTo(810, 6);
    expect(circleKm2(model, elder)).toBeCloseTo((Math.PI * 810 ** 2) / 1e6, 6);
    // the slower walk reaches less, the smaller circle claims less: both move together
    expect(circleMissShare(model, elder)).toBeGreaterThan(0.3);
    expect(detourReach(model, elder)!).toBeLessThan(detourReach(model, 1)!);
  });
  it('picks the most roundabout route when the data names no barrier', () => {
    const v = deriveModel(JSON.parse(rawV) as AnalysisResult, 'zj-v');
    const ratios = v.data.paths.map((p) => {
      const e = p.pts.at(-1)!;
      return e[3] / Math.hypot(e[0], e[1]);
    });
    expect(v.detour!.route / v.detour!.straight).toBeCloseTo(Math.max(...ratios), 6);
    expect(v.code).toBe('V');
  });
  it('splits phase suffixes off community names', () => {
    expect(splitName('申城佳苑三期B块')).toEqual(['申城佳苑', '三期B块']);
    expect(splitName('川杨新苑四期')).toEqual(['川杨新苑', '四期']);
    expect(splitName('虹御公寓')).toEqual(['虹御公寓', '']);
  });
});
