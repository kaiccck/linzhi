/**
 * The whole evaluation on the fake transport: plan → run → score. Plan counts match what the run asks
 * for; the ceiling is never exceeded and a stopped run resumes where it stopped; score needs nothing
 * but the artefacts.
 */
import { existsSync, readFileSync } from 'node:fs';
import { EngineError } from '@zoudedao/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { areaPaths, methodFile, readJson, readMethod, type MethodArtefact } from '../src/artefacts.js';
import { EvalCeilingError, type Ceilings } from '../src/ceiling.js';
import { planArea, type AreaPlan } from '../src/plan.js';
import { isCeilingStop, runArea, type RunReport } from '../src/run.js';
import { scoreArea, type Results } from '../src/score.js';
import {
  CITY_AREA,
  cityClient,
  MATRIX_PATH,
  NOW,
  tempRoot,
  WALK_PATH,
  cleanupTempRoots,
} from './fixtures.js';

/** The CLI's caps: the plan's expected billing, nothing for the scarce services. */
const capsOf = (routes: number, walks: number): Ceilings => ({
  routematrix_walking: routes,
  directionlite_walking: walks,
  place: 0,
  reverse_geocoding: 0,
  geocoding: 0,
  geoconv: 0,
});

afterAll(cleanupTempRoots);

describe('plan, run and score on the fake transport', () => {
  const root = tempRoot();
  const paths = areaPaths(root, CITY_AREA.id);
  let plan: AreaPlan;
  let report: RunReport;
  let c: ReturnType<typeof cityClient>;
  let results: Results;

  beforeAll(async () => {
    plan = planArea({ root, area: CITY_AREA });
    c = cityClient({ caps: capsOf(plan.totals.billed, plan.totals.walks_billed_max) });
    report = await runArea({ client: c.client, ledger: c.ledger, root, area: CITY_AREA, now: NOW });
    results = readJson<Results>(paths.results)!;
  });

  it('plans the full evaluation: 796 reference points, star16, and the engine budgets', () => {
    expect(plan.steps.map((s) => s.id)).toEqual([
      'reference',
      'star16',
      'seed48',
      'engine@48',
      'engine@100',
      'engine@200',
      'engine@400',
      'engine@700',
      'engine-default',
      'engine@700-nobarrier',
    ]);
    expect(plan.totals).toEqual({
      routes: 3280,
      billed: 2148,
      requests: 48,
      walks_billed: 4,
      walks_billed_max: 6,
    });
    expect(plan.steps.every((s) => !s.done)).toBe(true);
  });

  it('runs every step; the routes each step asks for are exactly the plan, billing stays within it', () => {
    expect(report.stopped).toBeNull();
    expect(report.scored).toBe(true);
    expect(report.steps.map((s) => [s.id, s.status])).toEqual(plan.steps.map((s) => [s.id, 'done']));
    for (const p of plan.steps) {
      const r = report.steps.find((s) => s.id === p.id)!;
      if (p.mayStopEarly) expect(r.routes, p.id).toBeLessThanOrEqual(p.routes);
      else expect(r.routes, p.id).toBe(p.routes);
      expect(r.walks, p.id).toBe(p.walks);
      expect(r.walks_billed, p.id).toBe(p.walks_billed);
      expect(r.routes_billed, p.id).toBeLessThanOrEqual(p.billed);
      expect(r.requests, p.id).toBeLessThanOrEqual(p.requests);
    }
    // steps whose points are known in advance are billed exactly as planned
    for (const id of ['reference', 'star16', 'seed48', 'engine@48']) {
      const p = plan.steps.find((s) => s.id === id)!;
      const r = report.steps.find((s) => s.id === id)!;
      expect([r.routes_billed, r.requests], id).toEqual([p.billed, p.requests]);
    }
    // what the process billed, at the wire and in the ledger, is within the plan and the ceiling
    expect(report.billed.routes).toBe(report.steps.reduce((a, s) => a + s.routes_billed, 0));
    expect(report.billed.routes).toBeLessThanOrEqual(plan.totals.billed);
    expect(c.transport.routesSent).toBe(report.billed.routes);
    expect(report.billed.walks).toBe(4);
    expect(c.transport.count(WALK_PATH)).toBe(4);
    // the evaluation never touches place search, reverse geocoding or geocoding
    expect(new Set(c.transport.paths)).toEqual(new Set([MATRIX_PATH, WALK_PATH]));
  });

  it('keeps each engine variant inside its budget, cold or warm', () => {
    for (const id of ['engine@100', 'engine@200', 'engine@400', 'engine@700', 'engine@700-nobarrier']) {
      const a = readMethod(paths, id)!;
      const b = Number(/@(\d+)/.exec(id)![1]);
      expect(a.cost.routes, id).toBe(b);
      expect(a.engine!.quota_requested_by_step).toMatchObject({
        seed: 48,
        refine: b - 48,
        coverage: 0,
        siting: 0,
      });
      expect(a.engine!.refine_converged, id).toBe(false);
      expect(a.params).toMatchObject({ scope: 'isochrone', budgetBasis: 'requested', convergeShare: 0 });
    }
    const def = readMethod(paths, 'engine-default')!;
    expect(def.engine!.refine_converged).toBe(true);
    expect(def.cost.routes).toBe(48 + 48 * def.engine!.refine_rounds);
    // its rounds are the first rounds of engine@400: all from the cache
    expect(def.cost.routes_billed).toBe(0);
    expect(readMethod(paths, 'engine@700-nobarrier')!.engine!.barrier_segments).toBe(0);
    expect(readMethod(paths, 'engine@700')!.engine!.barrier_segments).toBeGreaterThan(0);
    expect(readMethod(paths, 'seed48')!.cost).toMatchObject({ routes: 48, routes_billed: 0, walks: 0 });
  });

  it('scores every method against the reference: the engine beats star16, the circle overstates', () => {
    const by = new Map(results.methods.map((m) => [m.id, m]));
    expect([...by.keys()]).toEqual(['circle', ...plan.steps.slice(1).map((s) => s.id)]);
    const circle = by.get('circle')!;
    const star = by.get('star16')!;
    const e700 = by.get('engine@700')!;
    expect(circle.region.area_ratio).toBeGreaterThan(1.6);
    expect(circle.points.false_inside_rate!).toBeGreaterThan(0.3);
    expect(circle.cost.routes).toBe(0);
    expect(e700.region.iou).toBeGreaterThan(star.region.iou + 0.02);
    expect(e700.region.iou).toBeGreaterThan(by.get('engine@48')!.region.iou);
    expect(e700.points.accuracy).toBeGreaterThan(star.points.accuracy);
    expect(e700.points.time!.mae_s).toBeLessThan(circle.points.time!.mae_s / 2);
    expect(star.points.time).toBeNull();
    // points the engine measured itself are left out of its own check
    expect(e700.points.n_used).toBeGreaterThan(0);
    expect(e700.points.n + e700.points.n_used).toBe(results.reference.domain_points);
    expect(results.reference).toMatchObject({ spacing_m: 100, radius_m: 1600 });
    expect(results.reference.counts.ok).toBe(796);
    // IoU against the dense reference agrees with the region areas
    for (const m of results.methods) {
      expect(m.region.iou).toBeGreaterThan(0);
      expect(m.region.iou).toBeLessThanOrEqual(1);
      expect(m.region.area_km2).toBeCloseTo(m.region.area_ratio * m.region.ref_area_km2, 3);
    }
  });

  it('writes the report and two clean SVG figures', () => {
    const md = readFileSync(paths.resultsMd, 'utf8');
    for (const h of [
      '## 结论速览',
      '## 15 分钟区域：与参考区域比较',
      '## 参考点逐点检验',
      '## 调用成本',
      '## 指标定义',
    ])
      expect(md).toContain(h);
    expect(md).toContain('| 16 方位射线法 |');
    for (const f of [paths.chart, paths.overlay]) {
      const svg = readFileSync(f, 'utf8');
      expect(svg.startsWith('<svg')).toBe(true);
      expect(svg.trim().endsWith('</svg>')).toBe(true);
      expect(svg).not.toMatch(/NaN|undefined|Infinity/);
      for (const color of ['#1446B0', '#ECEEE9']) expect(svg).toContain(color);
    }
    const overlay = readFileSync(paths.overlay, 'utf8');
    expect(overlay).toContain('#FFC400');
    expect(overlay).toContain('#E23A2E');
    expect(overlay).toContain('本方法 400 条');
    expect(readFileSync(paths.chart, 'utf8')).toContain('16 方位射线法');
  });

  it('score needs only the artefacts and gives the same numbers every time', () => {
    const again = scoreArea({ root, area: CITY_AREA, now: () => new Date('2026-10-02T00:00:00Z') });
    const strip = (r: Results) => ({ ...r, generated: null });
    expect(strip(again.results)).toEqual(strip(results));
    expect(again.results.generated).toBe('2026-10-02T00:00:00.000Z');
  });

  it('a second run asks nothing and bills nothing, even with an empty cache; the plan shows it done', async () => {
    const fresh = cityClient({ caps: capsOf(0, 0) });
    const second = await runArea({
      client: fresh.client,
      ledger: fresh.ledger,
      root,
      area: CITY_AREA,
      now: NOW,
    });
    expect(second.stopped).toBeNull();
    expect(second.steps.every((s) => s.status === 'skipped')).toBe(true);
    expect(fresh.transport.paths).toHaveLength(0);
    const after = planArea({ root, area: CITY_AREA });
    expect(after.steps.every((s) => s.done)).toBe(true);
    expect(after.totals).toMatchObject({ routes: 0, billed: 0, requests: 0, walks_billed: 0 });
  });
});

describe('the ceiling', () => {
  it('is never exceeded, whatever its value; the reference resumes from where it stopped', async () => {
    const root = tempRoot();
    let measured = 0;
    for (const cap of [0, 1, 49, 50, 99, 777]) {
      const c = cityClient({ caps: capsOf(cap, 0) });
      const r = await runArea({
        client: c.client,
        ledger: c.ledger,
        root,
        area: CITY_AREA,
        steps: ['reference'],
        now: NOW,
      });
      expect(c.ledger.billed('routematrix_walking'), `cap ${cap}`).toBeLessThanOrEqual(cap);
      expect(c.transport.routesSent, `cap ${cap}`).toBeLessThanOrEqual(cap);
      // whole calls of 50 fit: floor(cap / 50) of them (the last may be short)
      expect(c.ledger.billed('routematrix_walking')).toBe(
        Math.min(796 - measured, Math.floor(cap / 50) * 50),
      );
      measured += c.ledger.billed('routematrix_walking');
      if (measured < 796) expect(r.stopped).toMatch(/上限/);
    }
    expect(measured).toBe(796);
  });

  it('stops an engine variant mid-refinement without an artefact, and finishes it on the rerun', async () => {
    const root = tempRoot();
    const paths = areaPaths(root, CITY_AREA.id);
    const steps = ['star16', 'engine'] as const;
    // star16 48 + engine@100 52 + 50: engine@200's second round (44 new) fits, its third (48) does not
    const c = cityClient({ caps: capsOf(150, 6) });
    const r = await runArea({
      client: c.client,
      ledger: c.ledger,
      root,
      area: CITY_AREA,
      steps: [...steps],
      now: NOW,
    });
    expect(r.stopped).toMatch(/^engine@200：/);
    expect(c.ledger.billed('routematrix_walking')).toBeLessThanOrEqual(150);
    expect(c.transport.routesSent).toBe(c.ledger.billed('routematrix_walking'));
    expect(r.steps.map((s) => [s.id, s.status])).toEqual([
      ['star16', 'done'],
      ['seed48', 'done'],
      ['engine@48', 'done'],
      ['engine@100', 'done'],
      ['engine@200', 'stopped'],
    ]);
    expect(existsSync(methodFile(paths, 'engine@200'))).toBe(false);
    expect(r.scored).toBe(false);

    // the rerun (same cache) pays only for what engine@200 did not get to, then continues
    const plan = planArea({ root, area: CITY_AREA, steps: [...steps] });
    expect(plan.steps.filter((s) => s.done).map((s) => s.id)).toEqual([
      'star16',
      'seed48',
      'engine@48',
      'engine@100',
    ]);
    const c2 = cityClient({ caps: capsOf(plan.totals.billed, plan.totals.walks_billed_max), store: c.store });
    const r2 = await runArea({
      client: c2.client,
      ledger: c2.ledger,
      root,
      area: CITY_AREA,
      steps: [...steps],
      now: NOW,
    });
    expect(r2.stopped).toBeNull();
    const e200: MethodArtefact = readMethod(paths, 'engine@200')!;
    expect(e200.cost.routes).toBe(200);
    // everything billed before the stop is engine@200's own history (seed = star16's points, round 1 and
    // 4 of round 2 from engine@100, the rest of round 2 from the aborted run): the rerun pays the remainder
    expect(c.ledger.billed('routematrix_walking')).toBe(144);
    expect(e200.cost.routes_billed).toBe(200 - 144);
    expect(c2.ledger.billed('routematrix_walking')).toBeLessThanOrEqual(plan.totals.billed);
    // no reference: nothing to score against
    expect(r2.scored).toBe(false);
  });

  it('turns a refused walk into a clean stop too (EngineError from the evaluation ceiling)', async () => {
    const root = tempRoot();
    const c = cityClient({ caps: capsOf(1000, 2) });
    const r = await runArea({
      client: c.client,
      ledger: c.ledger,
      root,
      area: CITY_AREA,
      steps: ['star16', 'engine'],
      now: NOW,
    });
    expect(r.stopped).toMatch(/^engine@48：.*轻量步行路线.*上限 2/);
    expect(c.ledger.billed('directionlite_walking')).toBe(2);
    expect(c.transport.count(WALK_PATH)).toBe(2);
    // the engine error carries the evaluation's refusal as its cause
    const err = new EngineError('quota_exhausted', 'x', {
      cause: new EvalCeilingError('y', { scope: 'hard', service: 'directionlite_walking' }),
    });
    expect(isCeilingStop(err)).toBe(true);
    expect(isCeilingStop(new EngineError('quota_exhausted', 'daily'))).toBe(false);
  });
});
