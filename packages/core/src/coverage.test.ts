import { describe, expect, it } from 'vitest';

import { latLngList, readJson, readRaw, zjA, zjFrame } from '../test/fixtures.js';
import type { XY } from './coords.js';
import type { DemandPoint, MatrixElement, OdPoint, RoutedPair } from './coverage.js';
import {
  classifyCheck,
  gapCount,
  grayAreaPolygons,
  matrixPairs,
  mergeMatrixResults,
  planCoverageRound,
  planMatrixBatches,
  pruneCandidates,
  rankCandidates,
  statusRaster,
} from './coverage.js';
import { pointInRing, ringSignedArea } from './geom.js';
import { facilitiesFor, routingPoint } from './poi.js';
import { HARD_CATEGORIES } from './standards.js';
import type { HardCategory, Poi } from './types.js';

const zj = zjA();
const baiduPois = zj.pois.filter((p) => p.source === 'baidu');
const demand: DemandPoint[] = zj.communities.map((c) => ({ id: c.name, name: c.name, xy: c.centroid }));
const facilitiesByCategory = Object.fromEntries(
  HARD_CATEGORIES.map((c) => [c, facilitiesFor(baiduPois, [c])]),
) as Record<HardCategory, Poi[]>;

describe('four-state rule', () => {
  it('reproduces all 36 stored zj-a statuses from their own straight/route numbers', () => {
    let n = 0;
    for (const c of zj.communities) {
      for (const cat of HARD_CATEGORIES) {
        const k = c.checks[cat];
        const v = classifyCheck({ straight_m: k.straight_m, route_m: k.route_m });
        expect([c.name, cat, v.status, v.status_main, v.borderline]).toEqual([
          c.name,
          cat,
          k.status,
          k.status_main,
          k.borderline,
        ]);
        n++;
      }
    }
    expect(n).toBe(36);
  });

  it('draws the lines where the design doc does', () => {
    expect(classifyCheck({ straight_m: 900, route_m: 1000 })).toMatchObject({
      status: '临界',
      status_main: '覆盖',
    });
    expect(classifyCheck({ straight_m: 900, route_m: 1050 })).toMatchObject({
      status: '临界',
      status_main: '伪覆盖',
    });
    expect(classifyCheck({ straight_m: 900, route_m: 1051 })).toMatchObject({
      status: '伪覆盖',
      borderline: false,
    });
    expect(classifyCheck({ straight_m: 1000.1, route_m: 1200 })).toMatchObject({
      status: '盲区',
      status_main: '盲区',
    });
    // the entrance can be nearer than the POI point: walking 218 m to a school 250 m away is fine
    expect(classifyCheck({ straight_m: 249.6, route_m: 218 }).status).toBe('覆盖');
    expect(classifyCheck({ straight_m: 300, route_m: 500, rule_m: 300, edge_m: 20 }).status).toBe('伪覆盖');
  });

  it('never concludes coverage from a lower bound', () => {
    expect(classifyCheck({ straight_m: 1200, route_m: 1030, lowerBound: true })).toMatchObject({
      status: '盲区',
      borderline: false,
      verified: true,
    });
    expect(classifyCheck({ straight_m: 900, route_m: 950, lowerBound: true })).toMatchObject({
      status_main: '伪覆盖',
      verified: false,
    });
    expect(classifyCheck({ straight_m: 100, route_m: 900, verified: false, upperBound: true })).toMatchObject(
      {
        verified: false,
        route_upper_bound: true,
      },
    );
  });
});

/** The research call: routematrix from the 12 community centroids to 3–4 facility entrances per category. */
function researchRoutes(cat: HardCategory): RoutedPair[] {
  const raw = readRaw<{ status: number; result: MatrixElement[] }>(
    `research/zhangjiang/raw/bv_blind_A_${cat}_000.json`,
  );
  const url = new URL(raw._meta.request);
  const f = zjFrame();
  const near = (a: XY, b: XY, tol: number) => Math.hypot(a[0] - b[0], a[1] - b[1]) < tol;
  const origins = latLngList(url.searchParams.get('origins')).map(([lng, lat]) => {
    const xy = f.toXY(lng, lat);
    return { id: demand.find((d) => near(d.xy, xy, 0.2))!.id };
  });
  const destinations = latLngList(url.searchParams.get('destinations')).map(([lng, lat]) => {
    const xy = f.toXY(lng, lat);
    return { id: baiduPois.find((p) => near(routingPoint(p), xy, 1.5))!.uid };
  });
  const batch = { origins, destinations, routes: origins.length * destinations.length, wanted: 0 };
  return matrixPairs(batch, raw.response.result);
}

/**
 * The official-list correction (research/zhangjiang/official_markets_patch.py): routematrix from the same 12
 * centroids to the two listed markets Baidu does not tag 菜市场, 浦商生鲜(申城佳苑店) and 浦商生鲜(环西店).
 */
function officialMarketRoutes(): RoutedPair[] {
  const raw = readJson<{
    markets: { uid: string; name: string }[];
    routes: {
      community: string;
      to: { market: string; status: string; distance_m: number; duration_s: number }[];
    }[];
  }>('research/zhangjiang/raw/bv_official_markets_A.json');
  const uid = new Map(raw.markets.map((m) => [m.name, m.uid]));
  return raw.routes.flatMap((r) =>
    r.to.map((t) => {
      const ok = t.status === 'ok';
      return {
        origin_id: demand.find((d) => d.id === r.community)!.id,
        dest_id: uid.get(t.market)!,
        route_m: ok ? t.distance_m : null,
        dur_s: ok ? t.duration_s : null,
      };
    }),
  );
}

describe('merging routematrix answers into FacilityChecks', () => {
  it('rebuilds the 36 zj-a checks from the raw Baidu answers, flags included', () => {
    for (const cat of HARD_CATEGORIES) {
      const routes =
        cat === '菜市场' ? [...researchRoutes(cat), ...officialMarketRoutes()] : researchRoutes(cat);
      const checks = mergeMatrixResults(demand, facilitiesByCategory[cat], routes);
      for (const c of zj.communities) {
        const got = checks.get(c.name)!;
        const want = c.checks[cat];
        expect(Math.abs(got.straight_m - want.straight_m)).toBeLessThanOrEqual(0.15);
        expect(Math.abs(got.via_straight_m! - want.via_straight_m!)).toBeLessThanOrEqual(0.15);
        const pick = (k: typeof got) => [
          k.nearest_straight,
          k.route_m,
          k.dur_s,
          k.via,
          k.via_uid,
          k.via_stall_of,
          k.status,
          k.status_main,
          k.borderline,
          k.route_upper_bound,
          k.verified,
          (k.unrouted_nearer ?? []).map((u) => u.uid),
        ];
        expect([c.name, cat, ...pick(got)]).toEqual([c.name, cat, ...pick(want)]);
        expect(got.route_basis).toBe('routed');
      }
    }
  });

  it('marks a community unverified when a nearer candidate was never routed and the route misses the rule', () => {
    const checks = mergeMatrixResults(demand, facilitiesByCategory.药店, researchRoutes('药店'));
    // 川杨新苑四期: 益丰大药房(川杨店) is 178 m away but the research only routed the centre's 4 nearest
    const c = checks.get('川杨新苑四期')!;
    expect(c).toMatchObject({ route_m: 1031, status: '临界', verified: false, route_upper_bound: true });
    expect(c.unrouted_nearer![0]!.name).toBe('益丰大药房(川杨店)');
  });

  it('decides blind spots without an API call when every entrance is beyond the rule', () => {
    const checks = mergeMatrixResults(demand, facilitiesByCategory.小学, []);
    const c = checks.get('申城佳苑三期A块')!;
    expect(c).toMatchObject({
      status: '盲区',
      verified: true,
      route_basis: 'lower_bound',
      route_upper_bound: false,
    });
    expect(c.route_m).toBeGreaterThan(1000);
    expect(c.via).toBeUndefined();
    // the others have candidates in range but nothing routed yet: an estimate, never a verdict
    const open = checks.get('申城佳苑二期A块')!;
    expect(open).toMatchObject({ verified: false, route_basis: 'estimated' });
  });

  it('handles empty inventories and failed routes honestly', () => {
    const none = mergeMatrixResults(demand.slice(0, 1), [], []).get(demand[0]!.id)!;
    expect(none).toMatchObject({ status: '盲区', route_basis: 'none', straight_m: -1, verified: true });
    const pharmacy = facilitiesByCategory.药店;
    const nearest = rankCandidates(demand[0]!.xy, pharmacy)[0]!;
    const failed: RoutedPair[] = [
      { origin_id: demand[0]!.id, dest_id: nearest.poi.uid, route_m: null, dur_s: null },
    ];
    const c = mergeMatrixResults(demand.slice(0, 1), pharmacy, failed).get(demand[0]!.id)!;
    expect(c.verified).toBe(false);
    // a failed pair is not planned again
    const next = planCoverageRound(demand.slice(0, 1), { 药店: pharmacy }, failed, { k: 1 });
    expect(next.get(demand[0]!.id)!.map((d) => d.id)).not.toContain(nearest.poi.uid);
  });
});

describe('candidate pruning, rounds and early stop', () => {
  // stand-in for Baidu: a walk 30 % longer than the straight line to the entrance
  const walk = (o: XY, p: XY) => Math.round(1.3 * Math.hypot(o[0] - p[0], o[1] - p[1]));
  const route = (batch: { origins: DemandPoint[]; destinations: OdPoint[] }): MatrixElement[] =>
    batch.origins.flatMap((o) =>
      batch.destinations.map((d) => {
        const m = walk(o.xy, d.xy);
        return { distance: { value: m }, duration: { value: Math.round(m / 1.17) } };
      }),
    );

  it('prunes by the entrance distance: walking is never shorter than the straight line', () => {
    const ranked = rankCandidates(demand[0]!.xy, facilitiesByCategory.小学);
    expect(ranked.map((c) => c.straight_m)).toEqual(
      [...ranked.map((c) => c.straight_m)].sort((a, b) => a - b),
    );
    const kept = pruneCandidates(ranked, 1000);
    expect(kept.every((c) => c.bound_m <= 1000)).toBe(true);
    expect(ranked.filter((c) => c.bound_m > 1000).every((c) => !kept.includes(c))).toBe(true);
  });

  it('routes nearest candidates first, stops as soon as a point is covered, and ends fully verified', () => {
    let routes: RoutedPair[] = [];
    const resolvedAt = new Map<string, number>();
    let round = 0;
    let billed = 0;
    for (;;) {
      const want = planCoverageRound(demand, facilitiesByCategory, routes, { k: 2 });
      if (!want.size) break;
      round++;
      for (const id of want.keys()) expect(resolvedAt.has(id)).toBe(false);
      for (const batch of planMatrixBatches(demand, want)) {
        expect(batch.routes).toBeLessThanOrEqual(50);
        billed += batch.routes;
        routes = routes.concat(matrixPairs(batch, route(batch)));
      }
      for (const d of demand) {
        if (resolvedAt.has(d.id)) continue;
        const done = HARD_CATEGORIES.every((cat) => {
          const c = mergeMatrixResults([d], facilitiesByCategory[cat], routes).get(d.id)!;
          return c.verified;
        });
        if (done) resolvedAt.set(d.id, round);
      }
      expect(round).toBeLessThan(10);
    }
    expect(resolvedAt.size).toBe(demand.length);
    // naive alternative: route every candidate within the rule
    const naive = demand.reduce(
      (s, d) =>
        s +
        HARD_CATEGORIES.reduce(
          (t, cat) => t + pruneCandidates(rankCandidates(d.xy, facilitiesByCategory[cat])).length,
          0,
        ),
      0,
    );
    expect(billed).toBeLessThan(naive);
    for (const cat of HARD_CATEGORIES) {
      for (const c of mergeMatrixResults(demand, facilitiesByCategory[cat], routes).values()) {
        expect(c.verified).toBe(true);
        if (c.route_basis === 'routed') expect(c.route_m).toBeGreaterThanOrEqual(c.via_straight_m! * 0.8);
      }
    }
  });
});

describe('routematrix batches', () => {
  const O = (id: string): OdPoint => ({ id, xy: [0, 0] });
  const D = (n: number, from = 0): OdPoint[] =>
    Array.from({ length: n }, (_, i) => ({ id: `d${from + i}`, xy: [i, 0] }));

  it('shares a request only between origins with the same destinations (no paid waste)', () => {
    const origins = ['a', 'b', 'c', 'e'].map(O);
    const want = new Map<string, OdPoint[]>([
      ['a', D(10)],
      ['b', D(10)],
      ['c', D(10)],
      ['e', D(3, 20)],
    ]);
    const batches = planMatrixBatches(origins, want);
    expect(
      batches.map((b) => [b.origins.map((o) => o.id), b.destinations.length, b.routes, b.wanted]),
    ).toEqual([
      [['a', 'b', 'c'], 10, 30, 30],
      [['e'], 3, 3, 3],
    ]);
    // a batch never exceeds 50 routes: a fifth identical origin opens a new request
    const five = planMatrixBatches(
      ['a', 'b', 'c', 'e', 'f', 'g'].map(O),
      Object.fromEntries(['a', 'b', 'c', 'e', 'f', 'g'].map((id) => [id, D(10)])),
    );
    expect(five.map((b) => b.routes)).toEqual([50, 10]);
  });

  it('splits long destination lists and can trade a little quota for fewer requests', () => {
    const long = planMatrixBatches([O('a')], { a: D(120) });
    expect(long.map((b) => b.destinations.length)).toEqual([50, 50, 20]);
    const similar = { a: D(8), b: D(9) };
    expect(planMatrixBatches([O('a'), O('b')], similar)).toHaveLength(2);
    const merged = planMatrixBatches([O('a'), O('b')], similar, 50, { maxWaste: 1 });
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ routes: 18, wanted: 17 });
  });

  it('unpacks answers origin-major and treats Baidu zeros as missing', () => {
    const batch = planMatrixBatches([O('a'), O('b')], { a: D(2), b: D(2) })[0]!;
    const pairs = matrixPairs(batch, [
      { distance: { value: 100 }, duration: { value: 85 } },
      { distance: { value: 0 }, duration: { value: 0 } },
      { distance: { value: 300 }, duration: { value: 256 } },
      null,
    ]);
    expect(pairs).toEqual([
      { origin_id: 'a', dest_id: 'd0', route_m: 100, dur_s: 85 },
      { origin_id: 'a', dest_id: 'd1', route_m: null, dur_s: null },
      { origin_id: 'b', dest_id: 'd0', route_m: 300, dur_s: 256 },
      { origin_id: 'b', dest_id: 'd1', route_m: null, dur_s: null },
    ]);
    expect(() => matrixPairs(batch, [])).toThrow(/2 × 2/);
  });
});

describe('灰色区域', () => {
  const points = zj.communities.map((c) => ({ xy: c.centroid, ...gapCount(c.checks) }));

  it('counts only verified gaps', () => {
    const c = zj.communities.find((x) => x.name === '川杨新苑四期')!;
    // 小学 伪覆盖 and 菜市场 盲区 are verified; the 药店 伪覆盖 is not
    expect(gapCount(c.checks)).toEqual({ missing: 2, pseudo: true });
    // 虹御公寓's only gap (药店) is unverified, so 7 of the 12 communities show up
    expect(points.filter((p) => p.missing > 0)).toHaveLength(7);
  });

  it('draws nested polygons per number of missing categories plus a 伪覆盖 layer', () => {
    const raster = statusRaster(points, { cell_m: 25, maxDist_m: 200 });
    const layers = grayAreaPolygons(raster);
    const gap1 = layers.find((l) => l.kind === 'gap' && l.min_missing === 1)!;
    const gap2 = layers.find((l) => l.kind === 'gap' && l.min_missing === 2)!;
    const pseudo = layers.find((l) => l.kind === 'pseudo')!;
    expect(gap1.area_m2).toBeGreaterThan(gap2.area_m2);
    expect(gap2.area_m2).toBeGreaterThan(0);
    expect(pseudo.area_m2).toBeGreaterThan(0);
    expect(layers.some((l) => l.min_missing === 3)).toBe(false);
    for (const l of layers) {
      l.rings.forEach((r, i) => {
        expect(r[0]).toEqual(r[r.length - 1]);
        expect(Math.sign(ringSignedArea(r))).toBe(l.meta[i]!.hole ? -1 : 1);
      });
    }
    // every 2-gap outline lies inside some 1-gap outer ring
    const outers1 = gap1.rings.filter((_, i) => !gap1.meta[i]!.hole);
    for (const [i, r] of gap2.rings.entries()) {
      if (gap2.meta[i]!.hole) continue;
      const [x, y] = r[0]!;
      expect(outers1.some((o) => pointInRing(x, y, o))).toBe(true);
    }
    // the gaps sit around the communities that have them
    const worst = zj.communities.find((c) => c.name === '川杨新苑四期')!.centroid;
    expect(gap2.rings.some((r) => pointInRing(worst[0], worst[1], r))).toBe(true);
    const fine = zj.communities.find((c) => c.name === '孙桥花苑')!.centroid;
    expect(gap1.rings.some((r) => pointInRing(fine[0], fine[1], r))).toBe(false);
  });

  it('respects a land-use mask', () => {
    const raster = statusRaster(points, { cell_m: 25, maxDist_m: 200, inside: (x) => x < 0 });
    for (let i = 0; i < raster.missing.values.length; i++) {
      const x = raster.missing.x0 + (i % raster.missing.nx) * raster.missing.cell;
      if (x >= 0) expect(raster.missing.values[i]).toBeNaN();
    }
  });
});
