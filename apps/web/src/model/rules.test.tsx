/**
 * The task rule (步行 1 公里), the only one; and the panel's pictures read off the model: the verdict in
 * communities (the circle's count against the walk's), the category buttons, the 体检单 list.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AnalysisResult } from '@zoudedao/core';
import rawA from '../../../../data/samples/zj-a.json?raw';
import rawB from '../../../../data/samples/zj-b.json?raw';
import { CategoryCards, worstCategory } from '../components/Categories.js';
import { cellWords, GapList } from '../components/GapList.js';
import { Verdict, verdictLines, verdictSentence } from '../components/Verdict.js';
import { deriveModel, isCircleGap, isWalkGap } from './derive.js';
import { checkLook } from './looks.js';
import { withPending } from './pending.test-data.js';

const dataA = JSON.parse(rawA) as AnalysisResult;
const task = deriveModel(dataA, 'zj-a');
const pendingA = deriveModel(withPending(dataA), 'zj-a');

describe('the task rule, the only one', () => {
  it('judges every checked category at the analysis’ own 1 km', () => {
    expect(task.cats.length).toBeGreaterThanOrEqual(3);
    for (const k of task.cats) expect(task.ruleOf[k]).toBe(1000);
  });

  it('reads each community’s own checks, never the GB 50180 ones an older result carries', () => {
    for (const u of task.units) {
      const c = dataA.communities.find((x) => x.name === u.name)!;
      for (const k of task.cats) expect(u.checks[k]).toEqual(c.checks[k]);
    }
  });

  it('splits the walk’s gaps into the circle’s (blind) and the ones it misses (pseudo)', () => {
    expect([task.circleGaps, task.walkGaps]).toEqual([0, 3]);
    expect(task.tally.blind + task.tally.pseudo).toBe(task.walkGaps);
    const pairs = task.units.flatMap((u) => task.cats.map((k) => ({ s: u.checks[k], r: task.ruleOf[k] })));
    expect(task.tally.blind).toBe(pairs.filter(({ s, r }) => isWalkGap(s, r) && isCircleGap(s, r)).length);
  });
});

describe('the verdict, in communities', () => {
  it('says how many communities lack a facility, and the circle’s count against the walk’s', () => {
    expect(task.tally.units).toBe(3);
    expect(task.tally.circleUnits).toBe(0);
    const html = renderToStaticMarkup(<Verdict model={task} />);
    expect(html).toContain('<b class="v-n">3</b>');
    expect(html).toContain('<span class="v-t1">个小区缺设施</span>');
    expect(html).toContain(
      '<span class="num">12</span> 个小区中，步行 <span class="num n">1</span> 公里内至少缺一类',
    );
    // two bars on one scale (the 12 communities): the circle's 1, the walk's 8 (1 + 7 伪覆盖)
    expect(html).toMatch(
      /画圈<\/span><span class="vc-track"><i class="vc-blind" style="width:0%"><\/i><\/span><span class="vc-n num">0<\/span>/,
    );
    expect(html).toMatch(
      /<i class="vc-pseudo" style="width:25%"><\/i><\/span><span class="vc-n num">3<\/span>/,
    );
    // under the bars, one line keys each colour once with what it means (the list's key too); the
    // counts are the bars' own, at their ends
    expect(html).toMatch(
      /<li><i class="sw s-pseudo"><\/i><span class="term" title="伪覆盖：[^"]*">伪覆盖<\/span><span>圈里有、走不到<\/span><\/li>/,
    );
    expect(html).not.toContain('<b>盲区</b><span>直线就超出</span>');
    expect(html).toContain('待核');
    expect(renderToStaticMarkup(<Verdict model={pendingA} />)).toContain(
      '<b>待核</b><span><span class="num">14</span> 项，不计入</span>',
    );
    expect(html).toContain('aria-live="polite"');
  });

  it('keys the borderline material only when a list shows it open (a walk just past the rule)', () => {
    // zj-a's borderline walks are within the rule (folded away): no key for them
    expect(renderToStaticMarkup(<Verdict model={task} />)).not.toContain('临界');
  });

  it('says so when the circle finds every one (直线就已超出)', () => {
    const all = { ...task, tally: { ...task.tally, circleUnits: task.tally.units } };
    const html = renderToStaticMarkup(<Verdict model={all} />);
    expect(html).toContain('<b>盲区</b><span>直线就超出</span>');
    expect(html).not.toContain('sw s-pseudo');
  });

  it('says it in words for screen readers: communities, then the gaps', () => {
    expect(verdictSentence(task)).toBe(
      '3 个小区步行 1 公里内至少缺一类设施，画圈只能发现其中 0 个。共 3 项缺口，画圈只找到 0 项，其中 3 项是画圈漏掉的伪覆盖。另有 12 项待核，不计入。',
    );
    expect(verdictSentence(pendingA)).toMatch(/另有 14 项待核，不计入。$/);
  });

  it('keeps the report’s two lines honest: no “only” when the walk finds nothing more', () => {
    const same = {
      ...task,
      circleGaps: 4,
      walkGaps: 4,
      tally: { blind: 4, pseudo: 0, pending: 0, units: 3, circleUnits: 3 },
    };
    expect(verdictLines(same)).toEqual({
      claim: ['画圈找到 ', { n: 3 }, ' 个小区缺设施，'],
      walk: ['走一遍也是 ', { n: 3 }, ' 个小区。'],
    });
    const none = {
      ...task,
      circleGaps: 0,
      walkGaps: 0,
      tally: { blind: 0, pseudo: 0, pending: 0, units: 0, circleUnits: 0 },
    };
    expect(verdictLines(none)).toEqual({ claim: ['画圈没有找到缺口，'], walk: ['走一遍也没有。'] });
  });

  it('compares communities even when one community has several facility gaps', () => {
    expect(verdictLines(task)).toEqual({
      claim: ['画圈没有找到缺口，'],
      walk: ['走一遍找到 ', { n: 3 }, ' 个小区。'],
    });
    // Extra facility gaps do not imply more affected communities.
    expect(verdictLines({ ...task, tally: { ...task.tally, units: 1, circleUnits: 1 } }).claim).toEqual([
      '画圈找到 ',
      { n: 1 },
      ' 个小区缺设施，',
    ]);
  });
});

describe('category buttons (规划)', () => {
  it('open on the category with the most gaps', () => {
    expect(worstCategory(task)).toBe('菜市场');
    const b = deriveModel(JSON.parse(rawB) as AnalysisResult, 'zj-b');
    // 玉兰香苑: 20 communities cannot walk to a 社区卫生服务中心/站 within 1 km, more than lack a market
    expect(worstCategory(b)).toBe('社区卫生');
  });

  it('are a radiogroup: the chosen category checked, its gaps as one number, the rest spoken', () => {
    const html = renderToStaticMarkup(<CategoryCards model={pendingA} cat="药店" onCat={() => {}} />);
    expect(html).toContain('role="radiogroup"');
    expect(html.match(/role="radio"/g)).toHaveLength(5);
    expect(html).toContain('style="--n:5"');
    expect(html).toMatch(/aria-checked="true"[^>]*aria-label="药店：12 个小区里 10 个步行 1 公里内走得到/);
    expect(html).toMatch(
      /<span class="cat-top" aria-hidden="true"><svg[^>]*><use href="#pg-school"><\/use><\/svg><b class="cat-n num pending">0<\/b><\/span><span class="cat-name" aria-hidden="true">小学<\/span>/,
    );
    // pending but no gap: a grey 0, not the tick (nothing is verified yet)
    expect(html).toMatch(
      /<b class="cat-n num pending">0<\/b><\/span><span class="cat-name" aria-hidden="true">药店<\/span>/,
    );
  });
});

describe('体检单: one category at a time', () => {
  const list = (
    model = task,
    cat: '小学' | '菜市场' | '药店' = '小学',
    selected: string | null = null,
    walking = false,
  ) =>
    renderToStaticMarkup(
      <GapList
        model={model}
        cat={cat}
        scale={1}
        hot={null}
        walking={walking}
        onHot={() => {}}
        onEvidence={() => {}}
        selected={selected}
      />,
    );
  const codes = (html: string) => [...html.matchAll(/data-code="([A-Z]-\d+)"/g)].map((m) => m[1]);

  it('lists the communities that cannot walk to the chosen category, the longest walk first', () => {
    const html = list();
    const open = task.units.filter((u) => !['ok', 'edge'].includes(checkLook(u.checks['小学'])));
    expect(codes(html)).toHaveLength(open.length);
    const walks = codes(html).map((c) => task.units.find((u) => u.code === c)!.checks['小学'].route_m);
    expect(walks).toEqual([...walks].sort((x, y) => y - x));
    expect(codes(html)[0]).toBe('A-01');
    expect(html).toContain('对口校区待核实');
    expect(html).not.toContain('个小区走得到');
  });

  it('says so in one line when every community walks there', () => {
    const html = list(task, '药店');
    expect(codes(html)).toEqual([]);
    expect(html).toContain('<span class="num">12</span> 个小区都走得到');
    expect(html).toContain('aria-label="12 个小区步行 1 公里内都走得到药店"');
  });

  it('opens the fold by itself for the unit whose route is on the map', () => {
    const passing = task.units.find((u) => checkLook(u.checks['药店']) === 'ok')!.code;
    const html = list(task, '药店', passing);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toMatch(new RegExp(`class="gl-row sel"[^>]*data-code="${passing}"`));
  });

  it('gives each walk in metres on its verdict’s tint, an upper bound where it is pending', () => {
    const html = list();
    expect(html).toContain('<span class="gl-v s-pending">待核</span>');
    expect(html).not.toContain('-1<small>');
    expect(list(pendingA, '药店')).toMatch(
      /<span class="gl-v num s-pending"><svg class="le"[^>]*>[\s\S]*?<\/svg>1,031<small>m<\/small><\/span>/,
    );
    // while 走一遍 plays, no verdict colour
    expect(list(task, '小学', null, true)).not.toContain('s-pseudo');
  });

  it('names the assigned school and the route on the map in the row’s spoken label', () => {
    expect(list(task, '小学', 'A-11')).toContain('2026 年对口：孙桥小学 · 校区待核实');
    expect(list()).not.toContain('地图上已画出到小学');
  });

  it('words each state the way the route card does', () => {
    const a11 = task.units.find((u) => u.code === 'A-11')!;
    expect(cellWords('小学', a11.checks['小学'], 1.3)).toBe('对口校区待核实，暂不计算步行时间');
  });
});
