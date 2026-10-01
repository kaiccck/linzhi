/**
 * The new shell: the top bar's four modes and its area switcher, the panel per mode, the finding
 * cards per view, and the gates that keep 实测核验 off unless the server can really measure.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AnalysisResult } from '@zoudedao/core';
import rawA from '../../../../data/samples/zj-a.json?raw';
import rawB from '../../../../data/samples/zj-b.json?raw';
import type { Health } from '../data/api.js';
import { analysisIdOf, askGate, measureGate } from '../data/gates.js';
import { emptyStream } from '../data/stream.js';
import { findingItems } from '../map/findings.js';
import { deriveModel } from '../model/derive.js';
import { facilityMarks } from '../model/facilities.js';
import { categoryLook, lookClass, worstLook } from '../model/looks.js';
import { sitePins } from '../model/siting.js';
import { initialPlan, type Mode } from '../state.js';
import { Inlines, type RenderCtx } from './Advisor.js';
import { Panel, type PanelProps } from './Panel.js';
import { TopBar, type TopTab } from './TopBar.js';

const a = deriveModel(JSON.parse(rawA) as AnalysisResult, 'zj-a');
const b = deriveModel(JSON.parse(rawB) as AnalysisResult, 'zj-b');
const noop = () => {};

describe('the top bar', () => {
  const bar = (tab: TopTab, live = false) =>
    renderToStaticMarkup(
      <TopBar
        tab={tab}
        onTab={noop}
        samples={[
          { id: 'zj-a', name: '申城佳苑片区', center_label: '孙环路 × 高木桥路' },
          { id: 'zj-v', name: 'AI小镇服务中心周边' },
        ]}
        activeSample={live ? null : 'zj-a'}
        current={
          live
            ? { code: '实时', name: '地图点选 121.64420, 31.19007', live: true }
            : { code: 'A', name: '申城佳苑片区', live: false }
        }
        sourceNote="数据：服务端 /api/analysis/zj-a"
        onOpenSample={noop}
        centre={null}
      />,
    );

  it('offers the four modes, the current one marked', () => {
    const html = bar('plan');
    for (const w of ['体检', '规划', '报告', '问询']) expect(html).toContain(`>${w}</button>`);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-current="page">规划</);
    expect(bar('report')).toMatch(/aria-current="page">报告</);
  });

  it('shows the area by its letter and NAME, and a live result as 实时', () => {
    expect(bar('check')).toContain(
      '<span class="area-code num">A</span><span class="area-name">申城佳苑片区</span>',
    );
    expect(bar('check')).toContain('aria-haspopup="listbox"');
    expect(bar('check', true)).toContain('<span class="area-code num live">实时</span>');
  });
});

describe('the panel per mode', () => {
  const props = (mode: Mode, over: Partial<PanelProps> = {}): PanelProps => ({
    model: a,
    mode,
    sub: 'sheet',
    onSub: noop,
    cat: '小学',
    onCat: noop,
    scale: 1,
    profile: 'adult',
    hot: null,
    walking: false,
    onHot: noop,
    facCats: ['小学', '菜市场', '药店'],
    onFacCat: noop,
    sourceTag: null,
    sourceNote: '',
    dataNote: null,
    samples: [],
    analysisId: 'zj-a',
    askBlocked: null,
    advisor: { mode: 'llm', model: 'deepseek-flash' },
    resultKey: 'zj-a#0',
    pins: sitePins(a),
    plan: initialPlan,
    estimate: null,
    measureBlocked: null,
    onPlace: noop,
    onClearSite: noop,
    onMeasure: noop,
    onHotSite: noop,
    run: null,
    onCancelRun: noop,
    onEvidence: noop,
    selected: null,
    onSpot: noop,
    branches: null,
    onRestoreBranch: noop,
    onPlan: noop,
    ...over,
  });

  it('体检: the place, the answer, one category at a time, the next step, the way into 中心周边设施', () => {
    const html = renderToStaticMarkup(<Panel {...props('check')} />);
    expect(html).toContain('<h1>申城佳苑片区</h1>');
    // the task rule only: no 口径 switch
    expect(html).not.toContain('aria-label="口径"');
    expect(html).toContain('<b class="v-n">7</b>');
    // the category buttons choose the list and the map; the list holds that category's gaps
    expect(html).toContain('class="cats" role="radiogroup" aria-label="设施类别"');
    expect(html).toContain('<ol class="gl" aria-label="步行 1 公里内走不到小学的 6 个小区，由远到近">');
    expect(html).toContain('其余 <span class="num">6</span> 个小区步行 1 公里内走得到小学');
    expect(html).toContain('为这 <span class="num">6</span> 个小区找补点 →');
    // the fresh-food line waits for 菜市场
    expect(html).not.toContain('fresh-line');
    expect(renderToStaticMarkup(<Panel {...props('check', { cat: '菜市场' })} />)).toContain(
      'class="fresh-line"',
    );
    expect(html).toContain('<span class="fe-t">中心周边设施</span>');
    // 中心周边设施 waits behind its row
    expect(html).toMatch(/id="panel-fac"[^>]*hidden/);
    // the advisor keeps its log while hidden
    expect(html).toMatch(/id="panel-ask"[^>]*hidden/);
  });

  it('中心周边设施: its own page, a way back, and the circle’s claim against the walk’s count', () => {
    const html = renderToStaticMarkup(<Panel {...props('check', { sub: 'fac' })} />);
    expect(html).toContain('class="fac-back"');
    expect(html).not.toContain('class="mx"');
    expect(html).toContain('处设施 <span class="num">15′</span> 走得到');
    expect(html).not.toMatch(/id="panel-fac"[^>]*hidden/);
  });

  it('规划: the cards and what a new site would fix, no verdict sentence', () => {
    const html = renderToStaticMarkup(
      <Panel {...props('plan', { model: b, pins: sitePins(b), cat: '菜市场' })} />,
    );
    expect(html).toContain('假如在这里开一家菜市场');
    expect(html).toContain('建议选址 · 菜市场');
    expect(html).not.toContain('class="verdict"');
  });

  it('问询: the verdict in one line above the desk, the model named', () => {
    const html = renderToStaticMarkup(<Panel {...props('ask')} />);
    expect(html).toContain('class="v-brief"');
    expect(html).toContain('大模型 deepseek-flash 组织语言');
    expect(html).not.toContain('aria-label="口径"');
  });

  it('shows the measuring instead of a verdict while a live check streams', () => {
    const run = {
      label: '玉兰香苑 · 实时体检',
      stream: emptyStream(),
      model: {
        frame: a.frame,
        center: a.data.meta.center_bd09,
        field: null,
        contours: null,
        r15: a.r15,
        dots: [],
        paths: [],
        pois: [],
        counts: { seed: 48, path: 0, refine: 0 },
        pathCount: 0,
        areaKm2: null,
      },
      note: null,
    };
    const html = renderToStaticMarkup(<Panel {...props('check', { run })} />);
    expect(html).toContain('玉兰香苑 · 实时体检');
    expect(html).toContain('每个点是一条百度实测的步行路线。');
    expect(html).not.toContain('class="verdict"');
  });
});

describe('the finding cards', () => {
  const marks = facilityMarks(a, 1);
  it('体检单 pins nothing unasked: a picked community’s route card is its finding', () => {
    expect(findingItems(a, { view: 'sheet', marks })).toEqual([]);
  });

  it('圈内设施: one facility the circle claims and the walk misses', () => {
    const f = findingItems(a, { view: 'fac', marks });
    expect(f).toHaveLength(1);
    const html = renderToStaticMarkup(
      <>
        {f[0]!.title}
        {f[0]!.body}
      </>,
    );
    expect(html).toContain('孙桥小学');
    expect(html).toContain('圈里只有这一所小学');
  });
});

describe('unit looks', () => {
  it('follow the chosen category (A-11: 伪覆盖 for 小学) and the worst of three on paper', () => {
    const u = a.units.find((x) => x.code === 'A-11')!;
    expect(categoryLook('小学')(u)).toBe('pseudo');
    expect(lookClass(categoryLook('小学')(u))).toBe('s-pseudo');
    const blind = a.units.find((x) => x.code === 'A-10')!;
    expect(worstLook(blind)).toBe('blind');
  });
});

describe('gates', () => {
  const live = (analyzer: string): Health => ({ ok: true, mode: 'live', analyzer });
  it('open 实测核验 only on a live server running the Baidu engine', () => {
    expect(measureGate('api', live('engine'), 'zj-a')).toBeNull();
    expect(measureGate('api', live('replay'), 'zj-a')).toMatch(/样例回放/);
    expect(measureGate('api', { ok: true, mode: 'sample' }, 'zj-a')).toMatch(/样例模式/);
    expect(measureGate('api', null, 'zj-a')).toMatch(/服务端/);
    expect(measureGate('bundled', live('engine'), null)).toMatch(/服务端/);
    expect(measureGate('live', live('engine'), null)).toMatch(/编号/);
  });
  it('name the analysis the server knows, and say why 问询 cannot', () => {
    expect(analysisIdOf('api', 'zj-b', undefined)).toBe('zj-b');
    expect(analysisIdOf('live', 'live', 'live-7f3a')).toBe('live-7f3a');
    expect(analysisIdOf('bundled', 'zj-a', undefined)).toBeNull();
    expect(askGate('bundled', null)).toMatch(/内置样例/);
    expect(askGate('api', 'zj-a')).toBeNull();
  });
});

describe('the advisor answer', () => {
  it('keeps the full stop after a citation plate on the plate’s line', () => {
    const ctx: RenderCtx = {
      prefix: 'a0',
      cites: new Map(),
      units: new Map(),
      show() {},
      hide() {},
      onHot() {},
    };
    const html = renderToStaticMarkup(
      <Inlines
        parts={[
          { t: 'text', s: '约 25.3 分钟' },
          { t: 'cite', ids: ['T2'] },
          { t: 'text', s: '。另有一处' },
        ]}
        ctx={ctx}
      />,
    );
    expect(html).toMatch(/<span class="nw"><span class="cites">.*T2<\/span><\/span>。<\/span>另有一处$/);
  });
});
