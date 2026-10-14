/**
 * The second pass's pieces as they render: the 方法 layer toggle and its legend, the 图层 menu (the
 * layers, the walker and 含过街等待 — an estimate, marked ≈ on the 走一遍 card), rows that draw a unit's
 * route, the saved what-if branches in 规划, the help panel's facts, the 路演 card, and where the method
 * layer sits in the print order.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AnalysisResult } from '@zoudedao/core';
import rawA from '../../../../data/samples/zj-a.json?raw';
import rawB from '../../../../data/samples/zj-b.json?raw';
import type { WhatIfBranch } from '../data/history.js';
import { paintPlan } from '../map/paint.js';
import { deriveModel } from '../model/derive.js';
import { sitePins } from '../model/siting.js';
import { tourSteps } from '../model/tour.js';
import { initialPlan } from '../state.js';
import { withNames } from './Advisor.js';
import { GapList } from './GapList.js';
import { LayerMenu, LayerOptions, MapLegend, WalkCard, type LayerProps } from './Controls.js';
import { helpFacts, officialLists } from './Help.js';
import { Planning } from './Planning.js';
import { TopBar } from './TopBar.js';
import { TourCard } from './Tour.js';

const a = deriveModel(JSON.parse(rawA) as AnalysisResult, 'zj-a');
const b = deriveModel(JSON.parse(rawB) as AnalysisResult, 'zj-b');
const noop = () => {};
const layers = (over: Partial<LayerProps> = {}): LayerProps => ({
  circle: true,
  onCircle: noop,
  heat: true,
  onHeat: noop,
  gray: false,
  onGray: noop,
  method: false,
  onMethod: noop,
  profile: 'adult',
  onProfile: noop,
  vAdult: 1.17,
  vElder: 0.9,
  crossing: false,
  onCrossing: noop,
  ...over,
});

describe('方法 layer', () => {
  it('is a toggle beside the other layers, off by default', () => {
    const html = renderToStaticMarkup(<LayerOptions {...layers()} />);
    expect(html).toMatch(/l-method" aria-pressed="false"[^>]*>.*采样点与阻隔/);
  });

  it('adds its samples by source and its barriers to the legend, counted', () => {
    const legend = (barriers: number) =>
      renderToStaticMarkup(
        <MapLegend
          legend={{ kind: 'category', cat: '小学', rule: 1000, looks: new Set(['ok']), sites: false }}
          gray={false}
          grayRule=""
          method={{ matrix: 240, vertex: 146, barriers }}
        />,
      );
    expect(legend(170)).toContain('批量算路 <span class="num">240</span>');
    expect(legend(170)).toContain('步行路线 <span class="num">146</span>');
    expect(legend(170)).toContain('阻隔 <span class="num">170</span> 段');
    expect(legend(0)).toContain('未检出阻隔');
  });

  it('prints above the isochrones and stays out of 走一遍', () => {
    const plan = (playing: boolean) =>
      paintPlan({
        T: 900,
        circle: true,
        playing,
        gray: false,
        hasGray: true,
        offline: false,
        hasBase: false,
        route: false,
        method: true,
      }).over;
    expect(plan(false)).toEqual(['iso-minor', 'plates', 'isochrones', 'method', 'circle']);
    expect(plan(true)).not.toContain('method');
  });
});

describe('图层: the layers and the walker behind one button', () => {
  it('is one closed button on the map; the menu names what each layer draws', () => {
    const html = renderToStaticMarkup(<LayerMenu {...layers()} />);
    expect(html).toMatch(/<button[^>]*class="layers-btn" aria-expanded="false" aria-controls="layer-pop"/);
    expect(html).toMatch(/id="layer-pop" role="group" aria-label="图层与步速" hidden=""/);
    expect(html).toContain('<small>越近越浓；关掉只留 15′ 等时圈</small>');
    expect(html.match(/class="layer-btn /g)).toHaveLength(4);
    expect(html).toMatch(/role="radiogroup" aria-label="步行人群"/);
  });

  it('lays the same choices flat under a phone’s map, their lines as titles', () => {
    const html = renderToStaticMarkup(<LayerOptions {...layers({ gray: null })} flat />);
    expect(html).not.toContain('<small>越近越浓');
    expect(html).toContain('title="越近越浓；关掉只留 15′ 等时圈"');
    expect(html).not.toContain('灰色区域');
  });
});

describe('含过街等待', () => {
  const card = (crossing: boolean, profile: 'adult' | 'elder' = 'adult') =>
    renderToStaticMarkup(
      <WalkCard
        T={900}
        playing={false}
        walked={false}
        onPlay={noop}
        onScrub={noop}
        area={1.71}
        circleKm2={3.48}
        missShare={0.51}
        profile={profile}
        crossing={crossing}
      />,
    );
  it('is a labelled sensitivity estimate that never touches a verdict', () => {
    expect(renderToStaticMarkup(<LayerOptions {...layers()} />)).toMatch(
      /class="crossing" aria-pressed="false" title="敏感性估算：步行时间加 5%[^"]*不改变任何判定。"/,
    );
    expect(renderToStaticMarkup(<LayerOptions {...layers()} />)).toContain('<span class="est">估算</span>');
    // the 走一遍 card keeps only 走一遍, the scrubber and the readout
    expect(card(false)).not.toContain('class="crossing"');
    expect(card(false)).not.toContain('步行人群');
  });
  it('marks the readouts as estimates while on', () => {
    expect(card(true)).toContain('<span class="num">≈1.71</span>');
    expect(card(true)).toContain('<span class="num">≈51%</span>');
    expect(card(false)).not.toContain('≈');
  });
  it('says whose walk the readout is when it is the elder’s', () => {
    expect(card(false, 'elder')).toContain('老人走得到');
    expect(card(false)).not.toContain('老人');
  });
});

describe('体检单 rows draw a unit’s route', () => {
  it('say so, name the assigned school, and mark the unit on the map', () => {
    const html = renderToStaticMarkup(
      <GapList
        model={a}
        cat="小学"
        scale={1}
        hot={null}
        walking={false}
        onHot={noop}
        onEvidence={noop}
        selected="A-11"
      />,
    );
    expect(html).toContain('2026 年对口：孙桥小学 · 校区待核实');
    expect(html).toMatch(/class="gl-row sel"[^>]*data-code="A-11"/);
    expect(html).not.toContain('已画出到小学');
  });
});

describe('规划 lists the saved what-if measurements', () => {
  const branch: WhatIfBranch = {
    id: 'wi-5c1d2e3f',
    branch_id: 'wi-5c1d2e3f',
    created_at: '2026-09-28T12:40:00.000Z',
    category: '药店',
    site_bd09: [121.645361, 31.19485],
    measured: [{ community: '川杨新苑四期', route_m: 132, dur_s: 111, before: '待核实', after: '覆盖' }],
    newly_covered: ['川杨新苑四期'],
    quota: { routes: 12, cached: 0 },
  };
  const render = (plan = initialPlan, cat: '小学' | '药店' | '菜市场' = '药店') =>
    renderToStaticMarkup(
      <Planning
        model={a}
        cat={cat}
        pins={sitePins(a)}
        plan={plan}
        estimate={null}
        measureBlocked={null}
        onPlace={noop}
        onClear={noop}
        onMeasure={noop}
        onHot={noop}
        onHotSite={noop}
        branches={[branch]}
        onRestoreBranch={noop}
      />,
    );
  it('each with what it brought within the rule, when, and 已核验', () => {
    const html = render();
    expect(html).toContain('已保存的实测模拟 <span class="num">1</span>');
    expect(html).toContain('新增药店 · <span class="num">1</span> 个小区因此走得到');
    expect(html).toContain('实测 <span class="num">1</span> 条路线');
    expect(html).toContain('已核验');
  });
  it('and marks the browser’s own suggestions as estimates', () => {
    const html = render(initialPlan, '菜市场');
    // the category is on the tile and in the answer above: the heading does not repeat it
    expect(html).toContain('建议选址</h2>');
    expect(html).toContain('<span class="badge est"');
    // no unit lacks a pharmacy on foot: nothing to suggest, and it says so
    expect(render()).toContain('这次体检没有需要新增药店的小区。');
  });
});

describe('the top bar’s help and 演示', () => {
  it('offers both; 演示 keeps its place, disabled and saying why, while it cannot run', () => {
    const bar = (withTour: boolean) =>
      renderToStaticMarkup(
        <TopBar
          tab="check"
          onTab={noop}
          samples={[]}
          activeSample="zj-a"
          current={{ code: 'A', name: '申城佳苑片区', live: false }}
          sourceNote=""
          onOpenSample={noop}
          centre={null}
          help={a}
          {...(withTour ? { onTour: noop } : {})}
        />,
      );
    expect(bar(true)).toContain('aria-label="说明：判定、规则、数据来源与用法"');
    expect(bar(true)).toContain('<span>演示</span>');
    expect(bar(true)).not.toMatch(/class="tool-btn tour-btn" disabled/);
    expect(bar(false)).toMatch(/class="tool-btn tour-btn" disabled="" title="数据载入后可以演示"/);
  });

  it('reads the data’s own sources and dates', () => {
    const f = helpFacts(a);
    expect(f.measuredOn).toBe(a.measuredOn);
    expect(f.osm).toBe('2026-09-26');
    expect(f.lists).toContain('《2026年浦东新区小学招生地段公示》（2026-04-07）');
    expect(helpFacts(b).outlines).toBe(false);
    expect(officialLists(['《一》（2026-01-01）', '《一》（2026-01-01）；《二》（2025-02-02）'])).toEqual([
      '《一》（2026-01-01）',
      '《二》（2025-02-02）',
    ]);
  });
});

describe('the 路演 card', () => {
  it('sets the step in large type with its numbers, and the six steps as a progress row', () => {
    const steps = tourSteps(a, { scale: 1, pins: sitePins(a) });
    const html = renderToStaticMarkup(
      <TourCard
        steps={steps}
        at={2}
        onGo={noop}
        onExit={noop}
        place="申城佳苑片区"
        code="A"
        evidence={null}
      />,
    );
    // the step's name rides on the step bar; the kicker carries it for a narrow map only
    expect(html).toContain(
      '<span class="num">3</span> / <span class="num">6</span><span class="tk-name"> · 伪覆盖一例</span>',
    );
    expect(html).toContain('实际要走');
    expect(html).not.toContain('孙桥小学');
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="退出演示（Esc）"');
  });
});

describe('问询 sends the community behind a code', () => {
  it('names a bare code, and leaves one that already carries its name', () => {
    const name = a.units.find((u) => u.code === 'A-11')!.name;
    expect(withNames('A-11 为什么走不到小学？', a)).toBe(`A-11（${name}） 为什么走不到小学？`);
    expect(withNames(`A-11 ${name}为什么走不到小学？`, a)).toBe(`A-11 ${name}为什么走不到小学？`);
    expect(withNames('Z-99 在哪', a)).toBe('Z-99 在哪');
  });
});
