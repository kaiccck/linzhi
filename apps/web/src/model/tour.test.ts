/**
 * 路演模式 on every sample: six steps in the story's order, each number read from the analysis, the
 * example of step 3 a real 伪覆盖 (its route stored with the sample) or, where there is none, a 盲区
 * that needs no route; a step with nothing to show says so.
 */
import { describe, expect, it } from 'vitest';
import type { AnalysisResult } from '@zoudedao/core';
import rawA from '../../../../data/samples/zj-a.json?raw';
import rawB from '../../../../data/samples/zj-b.json?raw';
import rawC from '../../../../data/samples/zj-c.json?raw';
import rawV from '../../../../data/samples/zj-v.json?raw';
import routesA from '../../../../data/samples/routes/zj-a.json?raw';
import routesB from '../../../../data/samples/routes/zj-b.json?raw';
import routesV from '../../../../data/samples/routes/zj-v.json?raw';
import { tourKey } from '../components/Tour.js';
import { deriveModel, fmtInt } from './derive.js';
import { noRouteReason } from './evidence.js';
import { sitePins } from './siting.js';
import { partsText, tourSteps } from './tour.js';

const samples = { 'zj-a': rawA, 'zj-b': rawB, 'zj-c': rawC, 'zj-v': rawV };
const stored: Record<string, string> = { 'zj-a': routesA, 'zj-b': routesB, 'zj-v': routesV };

describe.each(Object.entries(samples))('the tour of %s', (id, raw) => {
  const model = deriveModel(JSON.parse(raw) as AnalysisResult, id);
  const steps = tourSteps(model, { scale: 1, pins: sitePins(model) });

  it('tells the six steps in order', () => {
    expect(steps.map((s) => s.id)).toEqual(['circle', 'walk', 'example', 'facilities', 'gray', 'plan']);
    expect(steps[0]!.map).toMatchObject({ T: 0, hold: true });
    expect(steps[1]!.map.T).toBe('play');
    expect(steps[3]!.map.sub).toBe('fac');
    expect(steps[5]!.map.mode).toBe('plan');
  });

  it('reads its numbers from the analysis', () => {
    const circle = partsText(steps[0]!.head);
    expect(circle).toContain(`半径 ${fmtInt(model.r15)} m`);
    const walk = partsText(steps[1]!.body);
    if (model.walkGaps) expect(walk).toContain(`找到 ${model.walkGaps} 项缺口`);
    if (model.tally.pseudo) expect(walk).toContain(`画圈漏掉 ${model.tally.pseudo} 项`);
  });

  it('shows a real 伪覆盖 with its stored route, or a 盲区 that needs none', () => {
    const ex = steps[2]!;
    const ev = ex.map.evidence!;
    expect(ev).not.toBeNull();
    const unit = model.units.find((u) => u.code === ev.code)!;
    const check = unit.checks[ev.cat];
    if (ex.kicker === '伪覆盖一例') {
      expect(check.status_main).toBe('伪覆盖');
      expect(partsText(ex.head)).toBe(
        `直线 ${fmtInt(check.straight_m)} m，实际要走 ${fmtInt(check.route_m)} m`,
      );
      // the demo never asks Baidu: the route is stored with the sample
      const routes = (
        JSON.parse(stored[id]!) as { routes: { community: string; category: string; rules: string[] }[] }
      ).routes;
      expect(
        routes.some((r) => r.community === unit.name && r.category === ev.cat && r.rules.includes('task')),
      ).toBe(true);
    } else {
      expect(ex.kicker).toBe('盲区一例');
      // nothing to fetch: the reason is said instead
      expect(noRouteReason(check, ev.cat, model.ruleOf[ev.cat])).not.toBeNull();
    }
  });

  it('suggests a site, or says why there is none', () => {
    const plan = steps[5]!;
    const text = partsText(plan.head) + partsText(plan.body);
    if (plan.map.site)
      expect(text).toMatch(/新增一(所|家|处)(幼儿园|小学|菜市场|药店|社区卫生服务站)：可让 \d+ 个小区/);
    else expect(text).toMatch(/没有/);
  });
});

describe('the tour’s keys', () => {
  it('turn with the arrows, PageUp/PageDown and Space, jump with Home/End, leave with Esc', () => {
    expect(['ArrowRight', 'PageDown', ' '].map(tourKey)).toEqual(['next', 'next', 'next']);
    expect(['ArrowLeft', 'PageUp'].map(tourKey)).toEqual(['prev', 'prev']);
    expect([tourKey('Home'), tourKey('End'), tourKey('Escape'), tourKey('a')]).toEqual([
      'first',
      'last',
      'exit',
      null,
    ]);
  });
});
