/**
 * 步行路线证据: the numbers the card quotes come from the route and the analysis — A-11's walk to 孙桥小学
 * (申江校区) reads "直线 819 m · 实际步行 1,676 m · 约 24′", re-read at the elder's speed and with
 * 含过街等待 — and a check with no route says why before any request is made.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AnalysisResult } from '@zoudedao/core';
import rawA from '../../../../data/samples/zj-a.json?raw';
import rawB from '../../../../data/samples/zj-b.json?raw';
import routesA from '../../../../data/samples/routes/zj-a.json?raw';
import type { RouteEvidence } from '../data/route.js';
import { evidenceItem, type EvidenceView } from '../map/evidenceCard.js';
import { deriveModel, profileScale } from './derive.js';
import { catchmentText, evidenceBase, evidenceFacts, noRouteReason } from './evidence.js';
import { withPending } from './pending.test-data.js';

const a = deriveModel(JSON.parse(rawA) as AnalysisResult, 'zj-a');
const b = deriveModel(JSON.parse(rawB) as AnalysisResult, 'zj-b');

/** A-11's stored route, in the analysis' frame, as the page would read it */
const stored = (
  JSON.parse(routesA) as {
    routes: {
      community: string;
      category: string;
      rules: string[];
      distance_m: number;
      duration_s: number;
      path_bd09: [number, number][];
    }[];
  }
).routes.find((r) => r.community === '申城佳苑三期B块' && r.category === '小学' && r.rules.includes('task'))!;
const route: RouteEvidence = {
  analysis_id: 'zj-a',
  community: { name: '申城佳苑三期B块', code: 'A-11', xy: [-30.4, -410.2] },
  facility: {
    name: '孙桥小学(申江校区)',
    category: '小学',
    xy: [-779.2, -740.8],
    entrance_xy: [-848.9, -738.1],
  },
  path: stored.path_bd09.map(([lng, lat]) => a.frame.toXY(lng, lat)),
  distance_m: stored.distance_m,
  duration_s: stored.duration_s,
  source: 'stored',
  fetched_at: null,
};

describe('the route evidence of A-11 → 小学', () => {
  const base = evidenceBase(a, 'A-11', '小学')!;

  it('starts from what the check knows: the unit, the facility it routed to, the straight line', () => {
    expect(base.unit.name).toBe('申城佳苑三期B块');
    expect(base.facility).toBe('孙桥小学(申江校区)');
    expect(base.look).toBe('pseudo');
    expect(Math.round(base.straightM)).toBe(819);
    expect(noRouteReason(base.check, '小学', a.ruleOf['小学'])).toBeNull();
  });

  it('quotes the route’s own length and the minutes at the walker’s speed', () => {
    const f = evidenceFacts(a, base, route, { scale: 1, crossing: false });
    expect(f.routeM).toBe(1676);
    expect(f.minutes).toBe(24);
    // the check was judged on this very distance: nothing more to say
    expect(f.checkRouteM).toBeNull();
    expect(f.path.length).toBe(stored.path_bd09.length);
    const elder = evidenceFacts(a, base, route, { scale: profileScale('elder', a.vAdult), crossing: false });
    expect(elder.minutes).toBe(31);
    // 含过街等待: 5 % more time, never another distance
    const waits = evidenceFacts(a, base, route, { scale: 1, crossing: true });
    expect(waits.minutes).toBe(25);
    expect(waits.routeM).toBe(1676);
  });

  it('says which batch-routed distance the verdict used when the route differs from it', () => {
    const f = evidenceFacts(a, base, { ...route, distance_m: 1720 }, { scale: 1, crossing: false });
    expect(f.checkRouteM).toBe(1676);
  });

  it('prints the card: the two distances, then the minutes and where they come from', () => {
    const view: EvidenceView = {
      status: 'done',
      base,
      facts: evidenceFacts(a, base, route, { scale: 1, crossing: false }),
      message: null,
    };
    const item = evidenceItem(view, { scale: 1, crossing: false, onClose() {} });
    const html = renderToStaticMarkup(
      <>
        {item.title}|{item.body}|{item.foot}
      </>,
    );
    expect(html).toContain('<span class="tag s-pseudo">伪覆盖</span>A-11 三期B块');
    expect(html).toContain('→ 孙桥小学(申江校区)');
    expect(html).toContain(
      '直线 <span class="nw"><span class="num">819</span> m</span> · 实际步行 <span class="nw"><span class="num">1,676</span> m</span><br/>',
    );
    expect(html).toContain('约 <span class="num">24′</span>（百度步行路线）');
    // the assigned school is the one the check routed to: said so, not named twice
    expect(html).toContain('这所就是对口小学');
    expect(item.spec).toMatchObject({
      key: 'evidence',
      code: 'A-11',
      tone: 'pseudo',
      anchor: base.unit.centroid,
    });
  });

  it('says it is loading, or why it failed, and still quotes the check’s own walk', () => {
    const loading = evidenceItem(
      { status: 'loading', base, facts: null, message: null },
      { scale: 1, crossing: false, onClose() {} },
    );
    expect(renderToStaticMarkup(<>{loading.body}</>)).toContain('正在取百度步行路线…');
    const failed = evidenceItem(
      {
        status: 'failed',
        base,
        facts: null,
        message: '这条步行路线还没有保存过；查询新的路线需要服务端配置百度 Key（live 模式）。',
      },
      { scale: 1, crossing: false, onClose() {} },
    );
    const html = renderToStaticMarkup(
      <>
        {failed.body}
        {failed.foot}
      </>,
    );
    expect(html).toContain('需要服务端配置百度 Key');
    expect(html).toContain('判定距离 ');
  });
});

describe('a check with no route to draw says why, without asking the server', () => {
  it('a pending check (待核) has not been routed on its own', () => {
    const p = deriveModel(withPending(JSON.parse(rawA) as AnalysisResult), 'zj-a');
    const pending = p.units.flatMap((u) => Object.entries(u.checks)).find(([, c]) => c.verified === false);
    expect(pending).toBeDefined();
    expect(noRouteReason(pending![1], '药店', 1000)).toMatch(/待核/);
  });

  it('a 盲区 beyond the rule by straight line was never routed (a lower bound)', () => {
    const blind = b.units
      .flatMap((u) => Object.values(u.checks))
      .find((c) => c.route_basis === 'lower_bound')!;
    expect(noRouteReason(blind, '小学', 1000)).toMatch(/不需要算路：步行至少/);
  });

  it('an inventory without the category has nothing to route to', () => {
    const none = { ...a.units[0]!.checks['小学'], route_basis: 'none' as const, straight_m: -1, route_m: -1 };
    expect(noRouteReason(none, '小学', 1000)).toBe('设施清单里没有小学，没有可画的步行路线。');
  });
});

describe('对口小学', () => {
  it('names the assigned school and its measured walk', () => {
    const u = a.units.find((x) => x.code === 'A-01')!;
    expect(catchmentText(u.catchment!)).toBe('对口：孙桥小学（张江校区） · 步行 1,102 m');
    expect(catchmentText({ ...u.catchment!, route_m: null })).toMatch(/步行未测$/);
  });
});
