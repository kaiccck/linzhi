/**
 * Engine options for isochrone-only runs and the accuracy–quota evaluation (packages/eval): scope,
 * budget basis, barrier detection and the refinement stop share.
 */
import { BaiduClient, MemoryStore, QuotaLedger, replayConfig, Scheduler } from '@zoudedao/baidu';
import { buildIsochrone, type AnalysisResult } from '@zoudedao/core';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  analyze,
  CONVERGED_SHARE,
  planQuota,
  resolveBudget,
  scopedBudget,
  serviceCaps,
  stepCaps,
  type Emit,
  type EngineInput,
  type EngineOptions,
  type LiveMeta,
} from '../src/index.js';
import { Meter } from '../src/meter.js';
import { City, CITY_ORIGIN } from './city.js';
import { FakeClient, type FakeOptions } from './fakeClient.js';
import { cityTransport } from './transport.js';

const city = new City();
const NOW = () => new Date('2026-09-27T02:00:00Z');
const INPUT: EngineInput = { center_bd09: CITY_ORIGIN, label: '河西路 × 滨河路', profile: 'adult' };

async function run(opts: EngineOptions = {}, fake: FakeOptions = {}) {
  const client = new FakeClient({ city, ...fake });
  const stages: string[] = [];
  const emit: Emit = (event, data) => {
    if (event === 'stage') stages.push((data as { stage: string }).stage);
  };
  const result = await analyze(INPUT, { client, now: NOW }, emit, opts);
  return { client, result, stages: stages.filter((s, i) => i === 0 || s !== stages[i - 1]) };
}

describe('scope: isochrone', () => {
  let full: Awaited<ReturnType<typeof run>>;
  let iso: Awaited<ReturnType<typeof run>>;
  beforeAll(async () => {
    full = await run();
    iso = await run({ scope: 'isochrone', budget: { reverse_geocoding: 0 } });
  });

  it('stops after the reach stage: no place search, no coverage or siting routes', () => {
    expect(iso.stages).toEqual(['locate', 'seed', 'paths', 'refine', 'reach', 'report']);
    expect(iso.client.count('place')).toBe(0);
    expect(iso.client.count('reverse_geocoding')).toBe(0);
    const r = iso.result;
    expect(r.pois).toEqual([]);
    expect(r.communities).toEqual([]);
    expect(r.gray_areas).toEqual([]);
    expect(r.site_suggestions).toEqual({});
    expect(r.stats).toMatchObject({ scope: 'isochrone', barrier_segments: r.barriers!.length });
    expect(r.stats.quota_by_step).toMatchObject({ facilities: 0, residential: 0, coverage: 0, siting: 0 });
    expect((r.meta as LiveMeta).notes.join('\n')).toMatch(/只生成等时圈/);
    expect(r.baseline).toEqual(full.result.baseline);
  });

  it('produces exactly the full run’s isochrone', () => {
    const f = full.result;
    const i = iso.result;
    expect(i.samples).toEqual(f.samples);
    expect(i.field).toEqual(f.field);
    expect(i.contours).toEqual(f.contours);
    expect(i.barriers).toEqual(f.barriers);
    expect(i.stats.refine_rounds).toBe(f.stats.refine_rounds);
    // the isochrone's routes are the full run's seed and refinement routes, nothing more
    const steps = f.stats.quota_by_step as Record<string, number>;
    expect(iso.client.billed.routematrix_walking).toBe(steps.seed! + steps.refine!);
  });

  it('reserves no place quota, so a day without place searches left can still draw isochrones', async () => {
    const ledger = () => new QuotaLedger({ tier: 'personal', limits: { place: 1 } });
    await expect(run({}, { ledger: ledger() })).rejects.toMatchObject({ code: 'quota_exhausted' });
    const ok = await run({ scope: 'isochrone' }, { ledger: ledger() });
    expect(ok.result.contours['900'].length).toBeGreaterThan(0);
    expect(ok.client.count('place')).toBe(0);
    const plan = planQuota(INPUT, { scope: 'isochrone' });
    expect(plan.max).toEqual({
      reverse_geocoding: 1,
      place: 0,
      directionlite_walking: 6,
      routematrix_walking: 240,
    });
    expect(plan.expected).toMatchObject({ place: 0, routematrix_walking: 48 + 144 });
    expect(scopedBudget(resolveBudget('personal'), 'full')).toEqual(resolveBudget('personal'));
  });
});

describe('budget basis', () => {
  it('counts cache hits against the budget with basis requested, not with billed', async () => {
    const b = resolveBudget('personal');
    const onQuota = () => {};
    const cached = async () => 'cached';
    const billed = new Meter(stepCaps(b), serviceCaps(b), { onQuota });
    await billed.run('seed', 48, cached, () => 0);
    expect(billed.room('seed')).toBe(48);
    const requested = new Meter(stepCaps(b), serviceCaps(b), { onQuota, basis: 'requested' });
    await requested.run('seed', 48, cached, () => 0);
    expect(requested.room('seed')).toBe(0);
    expect(requested.requestedByStep.seed).toBe(48);
    expect(requested.used.routematrix_walking).toBe(0);
    // `asked` reports what a call fetched when it may stop early (place pages)
    await requested.run(
      'facilities',
      3,
      async () => ({ pages: 1 }),
      () => 1,
      (r) => r.pages,
    );
    expect(requested.room('facilities')).toBe(3);
  });

  it('keeps a budget-bound run the same warm or cold with basis requested (real client, shared cache)', async () => {
    const store = new MemoryStore();
    const transport = cityTransport(city);
    const client = new BaiduClient({
      config: replayConfig('personal'),
      transport,
      store,
      ledger: new QuotaLedger({ tier: 'personal', store }),
      scheduler: new Scheduler({ tier: 'personal', sleep: () => Promise.resolve(), random: () => 0 }),
    });
    // no ledger on the engine's side: nothing reserved, cache hits cost nothing
    const engineClient = {
      reverseGeocode: client.reverseGeocode.bind(client),
      placeAround: client.placeAround.bind(client),
      routeMatrixWalking: client.routeMatrixWalking.bind(client),
      walkingRoute: client.walkingRoute.bind(client),
    };
    const opts = (budgetBasis: 'billed' | 'requested'): EngineOptions => ({
      scope: 'isochrone',
      budgetBasis,
      convergeShare: 0,
      budget: { reverse_geocoding: 0, refine: 52, refineRounds: 2 },
    });
    const go = (o: EngineOptions) => analyze(INPUT, { client: engineClient, now: NOW }, () => {}, o);
    const cold = await go(opts('requested'));
    const sent = transport.paths.length;
    const warm = await go(opts('requested'));
    expect(transport.paths.length).toBe(sent);
    expect(warm.field).toEqual(cold.field);
    for (const r of [cold, warm]) {
      expect(r.stats.budget_basis).toBe('requested');
      expect(r.stats.quota_requested).toMatchObject({
        routematrix_walking: 100,
        directionlite_walking: 4,
        place: 0,
      });
      expect(r.stats.quota_requested_by_step).toMatchObject({ seed: 48, refine: 52 });
    }
    expect(warm.stats.quota_used).toMatchObject({ routematrix_walking: 0, directionlite_walking: 0 });
    // with the billed basis the cached rounds leave budget, so the warm run refines further than asked
    const billed: AnalysisResult = await go(opts('billed'));
    expect(transport.paths.length).toBeGreaterThan(sent);
    expect(billed.stats.quota_requested).toBeUndefined();
    expect(billed.samples.filter((s) => s.src === 'routematrix').length).toBeGreaterThan(
      cold.samples.filter((s) => s.src === 'routematrix').length,
    );
  });
});

describe('barrier detection off (ablation)', () => {
  it('finds no barriers and builds every field by plain detrended IDW, within the same budget', async () => {
    const { result, client } = await run({ scope: 'isochrone', barriers: false });
    expect(result.barriers).toEqual([]);
    expect(result.stats.barrier_segments).toBe(0);
    const plain = buildIsochrone(result.samples, { extent_m: 1600, cell_m: 20, loo: false });
    expect(plain.field.t_s).toEqual(result.field.t_s);
    expect(client.billed.routematrix_walking).toBeLessThanOrEqual(48 + 192);
    const on = await run({ scope: 'isochrone' });
    expect(on.result.stats.barrier_segments).toBeGreaterThan(0);
    // refinement no longer steers towards barriers: it samples other points
    const refineXY = (r: AnalysisResult) =>
      new Set(r.samples.filter((s) => s.set?.startsWith('refine')).map((s) => s.xy.join(',')));
    const a = refineXY(result);
    const b = refineXY(on.result);
    expect([...a].filter((k) => !b.has(k)).length).toBeGreaterThan(0);
  });
});

describe('refinement stop share', () => {
  it('stops early at the default share and spends the whole budget at 0', async () => {
    const budget = { reverse_geocoding: 0, refine: 480, refineRounds: 10 };
    const def = await run({ scope: 'isochrone', budget });
    expect(def.result.stats.refine_converged).toBe(true);
    expect(def.result.stats.refine_last_change as number).toBeLessThan(CONVERGED_SHARE);
    expect(def.result.stats.refine_rounds as number).toBeLessThan(10);
    const all = await run({ scope: 'isochrone', budget, convergeShare: 0 });
    expect(all.result.stats).toMatchObject({ refine_rounds: 10, refine_converged: false });
    expect((all.result.stats.quota_by_step as Record<string, number>).refine).toBe(480);
    // a loose share stops after the first round; nonsense falls back to the default
    const loose = await run({ scope: 'isochrone', budget, convergeShare: 1 });
    expect(loose.result.stats).toMatchObject({ refine_rounds: 1, refine_converged: true });
    const nan = await run({ scope: 'isochrone', budget, convergeShare: Number.NaN });
    expect(nan.result.stats.refine_rounds).toBe(def.result.stats.refine_rounds);
    const negative = await run({ scope: 'isochrone', budget, convergeShare: -1 });
    expect(negative.result.stats).toMatchObject({ refine_rounds: 10, refine_converged: false });
  });
});
