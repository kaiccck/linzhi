import { describe, expect, it } from 'vitest';

import { latLngList, readRaw, zjA, zjFrame } from '../test/fixtures.js';
import type { XY } from './coords.js';
import type { MatrixElement } from './coverage.js';
import { buildIsochrone } from './isochrone.js';
import type { SiteCandidate, SitingDemand } from './siting.js';
import {
  estimateRoute,
  fieldEstimator,
  siteCandidatesFromPaths,
  siteCoverage,
  suggestSites,
} from './siting.js';
import { TASK_CATEGORIES } from './standards.js';

const zj = zjA();
const iso = buildIsochrone(zj.samples, { loo: false });
const estimator = fieldEstimator(iso.rho);

/** The 132 measured community → facility walks of the research blind-spot calls. */
function measuredWalks(): { o: XY; q: XY; m: number }[] {
  const f = zjFrame();
  const out: { o: XY; q: XY; m: number }[] = [];
  // the research blind-spot calls of zj-a: the task's three categories
  for (const cat of TASK_CATEGORIES) {
    const raw = readRaw<{ result: MatrixElement[] }>(`research/zhangjiang/raw/bv_blind_A_${cat}_000.json`);
    const url = new URL(raw._meta.request);
    const O = latLngList(url.searchParams.get('origins')).map(([lng, lat]) => f.toXY(lng, lat));
    const D = latLngList(url.searchParams.get('destinations')).map(([lng, lat]) => f.toXY(lng, lat));
    O.forEach((o, oi) =>
      D.forEach((q, di) => {
        const m = raw.response.result[oi * D.length + di]?.distance?.value ?? 0;
        if (m > 0) out.push({ o, q, m });
      }),
    );
  }
  return out;
}

describe('route estimate L̂ for siting', () => {
  it('beats the site-only ρ̂ on the measured zj-a walks at the 1 km line', () => {
    const walks = measuredWalks();
    expect(walks).toHaveLength(132);
    const score = (est: (o: XY, q: XY) => number) => {
      let right = 0;
      let falseCover = 0;
      for (const w of walks) {
        const e = est(w.o, w.q) <= 1000;
        const t = w.m <= 1000;
        if (e === t) right++;
        else if (e) falseCover++;
      }
      return { acc: right / walks.length, falseCover };
    };
    const siteOnly = score((o, q) => estimator.rhoAt(q) * Math.hypot(o[0] - q[0], o[1] - q[1]));
    const ours = score((o, q) => estimateRoute(q, o, { estimator }));
    // measured: 0.856 / 15 false covers vs 0.924 / 5
    expect(ours.acc).toBeGreaterThanOrEqual(0.9);
    expect(ours.acc).toBeGreaterThan(siteOnly.acc);
    expect(ours.falseCover).toBeLessThan(siteOnly.falseCover);
    expect(ours.falseCover).toBeLessThanOrEqual(6);
  });

  it('never estimates below the straight line and uses the rough factor without a field', () => {
    expect(estimateRoute([0, 0], [300, 400])).toBeCloseTo(1.35 * 500, 9);
    expect(estimateRoute([0, 0], [300, 400], { defaultRho: 0.5 })).toBe(500);
    const rand = [
      [120, -40],
      [-600, 300],
      [800, 800],
    ] as XY[];
    for (const a of rand)
      for (const b of rand)
        expect(estimateRoute(a, b, { estimator })).toBeGreaterThanOrEqual(
          Math.hypot(a[0] - b[0], a[1] - b[1]),
        );
  });
});

describe('greedy maximal covering', () => {
  const cluster = (cx: number, n: number, prefix: string): SitingDemand[] =>
    Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, xy: [cx + i * 20, 0] as XY }));
  const west = cluster(-2000, 5, 'w');
  const east = cluster(2000, 3, 'e');
  const sites: SiteCandidate[] = [
    { id: 'W', xy: [-1960, 100] },
    { id: 'E', xy: [2020, 100] },
    { id: 'mid', xy: [0, 0] },
  ];
  const opts = { category: '药店' as const, defaultRho: 1.3 };

  it('ranks sites by newly covered demand and never counts a point twice', () => {
    const s = suggestSites(sites, [...west, ...east], opts);
    expect(s.map((x) => [x.site_id, x.gain, x.covers.length])).toEqual([
      ['W', 5, 5],
      ['E', 3, 3],
    ]);
    expect(s[0]!.covers).toEqual(west.map((d) => d.id));
    expect(s.every((x) => !x.verified && x.rank >= 1)).toBe(true);
    expect(suggestSites(sites, [...west, ...east], { ...opts, maxSites: 1 })).toHaveLength(1);
    expect(suggestSites([{ id: 'far', xy: [0, 5000] }], west, opts)).toEqual([]);
  });

  it('weights demand points', () => {
    const heavy = east.map((d) => ({ ...d, weight: 10 }));
    expect(suggestSites(sites, [...west, ...heavy], opts)[0]!.site_id).toBe('E');
  });

  it('re-ranks after verification when measured walks cover less than estimated', () => {
    const calls: string[] = [];
    const verify = (site: SiteCandidate, demands: readonly SitingDemand[]) => {
      calls.push(site.id);
      // a river nobody knew about: from W only two of the west points are walkable
      return Object.fromEntries(demands.map((d) => [d.id, site.id === 'W' && d.id > 'w1' ? 2400 : 700]));
    };
    const s = suggestSites(sites, [...west, ...east], { ...opts, verify });
    expect(s.map((x) => [x.site_id, x.gain, x.verified])).toEqual([
      ['E', 3, true],
      ['W', 2, true],
    ]);
    expect(s[1]!.covers).toEqual(['w0', 'w1']);
    expect(s[1]!.routes.every((r) => r.route_m === 700)).toBe(true);
    expect(calls).toEqual(['W', 'E']);
  });

  it('answers what-if questions for a single placed facility', () => {
    const c = siteCoverage({ id: 'x', xy: [-1990, 0] }, west, opts);
    expect(c.covers).toEqual(west.map((d) => d.id));
    expect(c.routes[0]!.est_m).toBe(Math.round(1.3 * 10));
    const measured = siteCoverage({ id: 'x', xy: [-1990, 0] }, west, opts, { w0: 900, w1: null });
    expect(measured.covers).toEqual(['w0', 'w2', 'w3', 'w4']);
    expect(measured.verified).toBe(true);
  });
});

describe('siting on the zj-a gaps', () => {
  const candidates = [
    ...siteCandidatesFromPaths(zj.paths, 50),
    ...zj.communities.map((c) => ({ id: `c:${c.name}`, xy: c.centroid, label: c.name })),
  ];

  it('finds one school site that would serve all six communities without a walkable 小学', () => {
    const gaps = zj.communities
      .filter((c) => c.checks.小学.status_main !== '覆盖')
      .map((c) => ({ id: c.name, xy: c.centroid }));
    expect(gaps).toHaveLength(6);
    const [top, ...rest] = suggestSites(candidates, gaps, { category: '小学', estimator });
    expect(rest).toEqual([]);
    expect(top!.covers.sort()).toEqual(gaps.map((g) => g.id).sort());
    expect(top!.routes.every((r) => r.est_m <= 1000 && r.est_m >= r.straight_m)).toBe(true);
    expect(top!.rho_local).toBeGreaterThanOrEqual(1);
  });

  it('samples candidate sites along the walked routes', () => {
    const along = siteCandidatesFromPaths(zj.paths, 50);
    const first = along.filter((c) => c.id.startsWith('path0@'));
    expect(first.length).toBeGreaterThan(zj.paths[0]!.pts[zj.paths[0]!.pts.length - 1]![3] / 50 - 5);
    for (let i = 1; i < first.length; i++) {
      const a = first[i - 1]!.xy;
      const b = first[i]!.xy;
      expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThanOrEqual(50 + 1e-9);
    }
  });
});
