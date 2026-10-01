/**
 * 规划: the analysis' suggestions become numbered pins, and a site the planner places is estimated
 * right in the browser with core's siteCoverage over the analysis' own detour field — no API call.
 */
import { describe, expect, it } from 'vitest';
import { siteCoverage, type AnalysisResult } from '@zoudedao/core';
import rawA from '../../../../data/samples/zj-a.json?raw';
import rawB from '../../../../data/samples/zj-b.json?raw';
import { deriveModel } from './derive.js';
import { estimatorFor, lacks, sitePins, whatIf } from './siting.js';

const b = deriveModel(JSON.parse(rawB) as AnalysisResult, 'zj-b');

describe('siting suggestions as pins', () => {
  it('lists every suggestion of the result, per category in display order, best first', () => {
    const pins = sitePins(b);
    const data = b.data.site_suggestions!;
    const engine = pins.filter((p) => p.origin === 'engine');
    expect(engine).toHaveLength(Object.values(data).reduce((n, l) => n + (l?.length ?? 0), 0));
    const order = b.cats as readonly string[];
    expect(pins.map((p) => p.cat)).toEqual(
      [...pins.map((p) => p.cat)].sort((x, y) => order.indexOf(x) - order.indexOf(y)),
    );
    const market = pins.filter((p) => p.cat === '菜市场');
    expect(market.map((p) => p.rank)).toEqual([1, 2, 3]);
    expect(market[0]!.covers.map((c) => c.name)).toEqual(data['菜市场']![0]!.covers);
    // the communities are the units on the map: each name finds its code
    expect(market[0]!.covers.every((c) => c.unit !== null)).toBe(true);
  });

  it('runs the engine’s search here, as an estimate, for a result made before siting existed', () => {
    const a = deriveModel(JSON.parse(rawA) as AnalysisResult, 'zj-a');
    expect(a.data.site_suggestions).toBeUndefined();
    const pins = sitePins(a);
    expect(pins.length).toBeGreaterThan(0);
    // never 已核验: nothing was measured
    expect(pins.every((p) => p.origin === 'local' && !p.verified)).toBe(true);
    for (const p of pins) {
      // every unit a site would serve lacks the category today, on foot (task rule)
      expect(p.covers.length).toBeGreaterThan(0);
      for (const c of p.covers) expect(c.unit && lacks(c.unit, p.cat)).toBeTruthy();
      // candidates lie on the walked routes, and say where
      expect(p.label).toMatch(/向步行路线约 \d+ 米处$/);
    }
    for (const cat of ['小学', '菜市场', '药店'] as const) {
      const ranks = pins.filter((p) => p.cat === cat).map((p) => p.rank);
      expect(ranks).toEqual(ranks.map((_, i) => i + 1));
    }
    // zj-b's own suggestions cover the task's three; 幼儿园 and 社区卫生, checked later, are estimated here
    const own = b.data.site_suggestions!;
    for (const p of sitePins(b)) expect(p.origin).toBe(own[p.cat] ? 'engine' : 'local');
    expect(sitePins(b).some((p) => p.cat === '社区卫生' && p.origin === 'local' && !p.verified)).toBe(true);
  });
});

describe('假如在这里开一家… (estimate)', () => {
  const at = b.data.site_suggestions!['菜市场']![0]!.xy;

  it('serves only units that lack the category today (measured 伪覆盖 or 盲区)', () => {
    const e = whatIf(b, '菜市场', at);
    expect(e.demand.every((u) => lacks(u, '菜市场'))).toBe(true);
    expect(e.flips.every((f) => e.demand.includes(f.unit))).toBe(true);
    expect(e.flips.every((f) => f.estM <= e.rule && f.estM >= f.straightM)).toBe(true);
  });

  it('agrees with core’s siteCoverage and the estimate the engine suggested the site on', () => {
    const e = whatIf(b, '菜市场', at);
    const cov = siteCoverage(
      { id: 's', xy: at },
      e.demand.map((u) => ({ id: u.code, xy: u.centroid })),
      { category: '菜市场', rule_m: 1000, estimator: estimatorFor(b) },
    );
    expect(e.flips.map((f) => f.unit.code)).toEqual(cov.covers);
    // the engine's own greedy pick covers 6 there; the browser's estimate sees the same place
    expect(e.flips.length).toBeGreaterThanOrEqual(4);
    expect(e.routable).toBeGreaterThanOrEqual(e.flips.length);
  });

  it('builds the detour estimator once per result', () => {
    expect(estimatorFor(b)).toBe(estimatorFor(b));
  });

  it('brings nobody within the rule from far away', () => {
    expect(whatIf(b, '菜市场', [5000, 5000]).flips).toEqual([]);
  });
});
