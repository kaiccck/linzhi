import { describe, expect, it } from 'vitest';
import type { AnalysisResult } from '@zoudedao/core';
import raw from '../../../../data/samples/zj-a.json?raw';
import { frameFromMeta } from '../geo/frame.js';
import { deriveModel, profileScale, reachArea, splitName } from './derive.js';

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
  it('verdict: the circle finds 1 gap, walking finds 8', () => {
    expect(model.circleGaps).toBe(1);
    expect(model.walkGaps).toBe(8);
  });
  it('directory heads: 6/12, 10/12, 10/12 with 2 pending pharmacies', () => {
    expect(model.heads.map((h) => [h.cat, h.ok, h.pending])).toEqual([
      ['小学', 6, 0],
      ['菜市场', 10, 0],
      ['药店', 10, 2],
    ]);
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
    expect(Math.round((1 - data.stats.reach_share) * 100)).toBe(47);
    expect(model.eastReach15 && Math.round(model.eastReach15 / 10) * 10).toBe(470);
    expect(model.worstSchool?.unit.code).toBe('A-11');
    expect(Math.round(reachArea(model.raster, 900, 1) * 100) / 100).toBeCloseTo(1.86, 2);
  });
  it('elder profile slows every time by 1.17 / 0.9', () => {
    expect(profileScale('elder', model.vAdult)).toBeCloseTo(1.3, 6);
    expect(reachArea(model.raster, 900, 1.3)).toBeLessThan(reachArea(model.raster, 900, 1));
  });
  it('splits phase suffixes off community names', () => {
    expect(splitName('申城佳苑三期B块')).toEqual(['申城佳苑', '三期B块']);
    expect(splitName('川杨新苑四期')).toEqual(['川杨新苑', '四期']);
    expect(splitName('虹御公寓')).toEqual(['虹御公寓', '']);
  });
});
