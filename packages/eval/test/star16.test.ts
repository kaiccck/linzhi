/**
 * The 16-bearing ray method against the synthetic city's exact walking times: interpolating time along
 * a ray that crosses the river (x = 450 m, one bridge at y = −300 m) puts the reach point beyond the
 * river on some rays (claiming ground that is a long detour away) and short of it on others (missing
 * ground that is walkable); the engine with a large budget follows the river instead.
 */
import { gridFromField, sampleGrid, type XY } from '@zoudedao/core';
import { beforeAll, describe, expect, it } from 'vitest';

import type { MethodArtefact } from '../src/artefacts.js';
import { runEngineMethod } from '../src/engineRun.js';
import { EVAL_GRID, insideRings, maskOf } from '../src/lattice.js';
import { engineMethod } from '../src/methods.js';
import { regionMetrics } from '../src/metrics.js';
import { runStar16 } from '../src/star16.js';
import { CITY_AREA, cityClient, MATRIX_PATH, NOW, truthTime } from './fixtures.js';

/** Straight distance at which the city's walking time first reaches 900 s along a bearing. */
function truthReach(bearing: number): number {
  const rad = (bearing * Math.PI) / 180;
  for (let r = 2; r <= 1100; r += 2) if (truthTime([r * Math.sin(rad), r * Math.cos(rad)]) >= 900) return r;
  return NaN;
}

describe('16-bearing ray method in the river city', () => {
  let star: MethodArtefact;
  let engine: MethodArtefact;
  let c: ReturnType<typeof cityClient>;
  beforeAll(async () => {
    c = cityClient();
    star = (await runStar16({ client: c.client, area: CITY_AREA, now: NOW })).artefact!;
    engine = (
      await runEngineMethod({
        spec: engineMethod(700),
        client: c.client,
        ledger: c.ledger,
        area: CITY_AREA,
        now: NOW,
      })
    ).artefact!;
  });

  it('measures its own 48 points in one call, the engine seed reuses them from the cache', () => {
    expect(star.cost).toMatchObject({ routes: 48, routes_billed: 48, requests: 1, calls: 1, walks: 0 });
    expect(star.star16!.rays).toHaveLength(16);
    expect(star.samples).toHaveLength(48);
    expect(star.field).toBeNull();
    expect(star.region.rings).toHaveLength(1);
    // engine@700: 48 seed routes from the cache, 652 new
    expect(engine.cost).toMatchObject({ routes: 700, routes_billed: 652, walks: 4, walks_billed: 4 });
    expect(c.transport.count(MATRIX_PATH)).toBe(1 + 14);
  });

  it('overestimates across the river and underestimates on the near bank', () => {
    const reach = new Map(star.star16!.rays.map((r) => [r.bearing_deg, r.reach_m!]));
    // due east the river is 450 m out; the ray's time jumps from ≈ 300 s to ≈ 1,100 s across it
    expect(truthReach(90)).toBeGreaterThan(440);
    expect(truthReach(90)).toBeLessThan(460);
    expect(reach.get(90)!).toBeGreaterThan(truthReach(90) + 100);
    // north-east the walk reaches the river bank (636 m) but the interpolated reach stops ~100 m short
    expect(truthReach(45)).toBeGreaterThan(620);
    expect(reach.get(45)!).toBeLessThan(truthReach(45) - 80);
    // on open streets (west, north, south) the ray method is exact
    for (const b of [0, 180, 270]) expect(Math.abs(reach.get(b)! - truthReach(b))).toBeLessThan(3);

    const inStar = insideRings(star.region.rings);
    const g = gridFromField(engine.field!);
    const inEngine = (x: number, y: number) => sampleGrid(g, x, y) < 900;
    const count = (f: (x: number, y: number, truth: boolean) => boolean) => {
      let n = 0;
      maskOf(EVAL_GRID, (x, y) => {
        if (Math.hypot(x, y) <= 1100 && f(x, y, truthTime([x, y] as XY) < 900)) n++;
        return false;
      });
      return (n * EVAL_GRID.cell * EVAL_GRID.cell) / 1e6;
    };
    const starAcross = count((x, y, t) => x > 450 && inStar(x, y) && !t);
    const starNear = count((x, y, t) => x <= 450 && !inStar(x, y) && t);
    const engAcross = count((x, y, t) => x > 450 && inEngine(x, y) && !t);
    const engNear = count((x, y, t) => x <= 450 && !inEngine(x, y) && t);
    // km²: star16 claims ≈ 0.05 km² across the river that is a detour away and misses ≈ 0.07 km² on this side
    expect(starAcross).toBeGreaterThan(0.04);
    expect(starNear).toBeGreaterThan(0.05);
    expect(engAcross).toBeLessThan(starAcross / 2);
    expect(engNear).toBeLessThan(starNear / 4);
  });

  it('is beaten by the engine with a large budget on IoU against the exact region', () => {
    const truth = maskOf(EVAL_GRID, (x, y) => Math.hypot(x, y) <= 1600 && truthTime([x, y]) < 900);
    const s = regionMetrics(maskOf(EVAL_GRID, insideRings(star.region.rings)), truth, EVAL_GRID);
    const g = gridFromField(engine.field!);
    const e = regionMetrics(
      maskOf(EVAL_GRID, (x, y) => sampleGrid(g, x, y) < 900),
      truth,
      EVAL_GRID,
    );
    expect(s.iou).toBeGreaterThan(0.85);
    expect(e.iou).toBeGreaterThan(s.iou + 0.03);
    expect(e.sym_diff_km2).toBeLessThan(s.sym_diff_km2 / 2);
  });
});
