import { describe, expect, it } from 'vitest';
import {
  checkGrounding,
  completeCitations,
  extractNumbers,
  unitKey,
  type NumberSource,
} from '../src/grounding.js';

const tokens = (text: string) => extractNumbers(text).map((t) => [t.kind, t.value, t.unit]);

/** One tool result shaped like analyze_life_circle on zj-a. */
const T1: NumberSource = {
  id: 'T1',
  text: '15 分钟步行实际可达 1.857 km²，画圆高估 1.88 倍。',
  facts: [
    { label: '15 分钟步行可达面积', value: 1.857, unit: 'km²' },
    { label: '画圆高估倍数', value: 1.88, unit: '倍' },
    { label: '可达面积占直线圆的比例', value: 53.3, unit: '%' },
    { label: '直线 15 分钟圆半径', value: 1053, unit: 'm' },
    { label: '步行已核实缺口数', value: 10, unit: '个' },
    { label: '画圆漏掉的比例', value: 80, unit: '%' },
  ],
  data: {
    analysis_id: 'zj-a',
    generated: '2026-09-26T10:24:38.790Z',
    stats: { reach_share: 0.533, median_extra_s: 187.6, area_m2: 1861628 },
    gaps: [{ community: '申城佳苑三期B块', straight_m: 818.5, route_m: 1676, walk_min: 23.9 }],
    // geometry is never a source, even though it is full of numbers
    geometry: { coordinates: [[121.1, 31.1]] },
  },
};

const check = (text: string, sources: NumberSource[] = [T1]) => checkGrounding(text, sources);

describe('extractNumbers', () => {
  it('reads thousands separators, decimals, units and 万', () => {
    expect(tokens('直线 1,053 m，面积 1.857 km²，占 53.3%，共 12 个小区，约 185.7万平方米')).toEqual([
      ['number', 1053, 'm'],
      ['number', 1.857, 'km2'],
      ['number', 53.3, '%'],
      ['number', 12, 'count'],
      ['number', 1857000, 'm2'],
    ]);
  });

  it('carries a unit written once across ranges and lists', () => {
    expect(tokens('5、10、15 分钟等时圈；慢 3.5–6.6%')).toEqual([
      ['number', 5, 'min'],
      ['number', 10, 'min'],
      ['number', 15, 'min'],
      ['number', 3.5, '%'],
      ['number', 6.6, '%'],
    ]);
    // a word between the numbers stops the propagation
    expect(tokens('伪覆盖 8、盲区 2 个')).toEqual([
      ['number', 8, ''],
      ['number', 2, 'count'],
    ]);
  });

  it('keeps dates and standard codes whole', () => {
    expect(tokens('2026-09-26 实测，按 GB 12345-2020，2026年9月3日复核')).toEqual([
      ['date', 2026, ''],
      ['code', 0, ''],
      ['date', 2026, ''],
    ]);
    expect(extractNumbers('2026年9月3日').map((t) => t.text)).toEqual(['2026-09-03']);
  });

  it('skips identifiers, citations, clause numbers and list markers', () => {
    const text = [
      '1. 沿 S20 外环、BD-09 坐标、live-1a2b3c4d、3D 视图、5G 信号 [T1][T2, T3]',
      '（2）表3.0.4 规定 10:30 开放，见 https://lbs.baidu.com/docs?v=3',
    ].join('\n');
    expect(tokens(text)).toEqual([]);
  });

  it('maps fact units', () => {
    expect(['km²', 'm', '倍', '%', '个', '分钟', 'm/s', '', 'ratio'].map(unitKey)).toEqual([
      'km2',
      'm',
      'x',
      '%',
      'count',
      'min',
      'm/s',
      '',
      'ratio',
    ]);
  });
});

describe('checkGrounding', () => {
  it('accepts numbers exactly as the tools gave them, with citations', () => {
    const g = check(
      '15 分钟步行只能走到 1.857 km²，画圆高估 1.88 倍 [T1]。已核实缺口 10 个，漏掉 80% [T1]。',
    );
    expect(g).toMatchObject({ ok: true, unsupported: [], uncited: [] });
    expect(g.checked).toBe(5);
  });

  it('accepts presentation variants: separators, trailing zeros, ×100, m→km, s→min, m²→km²', () => {
    const g = check(
      [
        '直线圆半径 1053 m，也就是 1.053 km 或 1.05 km [T1]。',
        '面积 1.86 km²（1.862 km²，即 1,861,628 m²）[T1]。',
        '可达比例 53.3%，倍数 1.880 倍 [T1]。',
        '多走 3.13 分钟 [T1]。',
        '步行 1,676 米，约 23.9 分钟 [T1]。',
      ].join('\n'),
    );
    expect(g.unsupported).toEqual([]);
  });

  it('rejects rounding that drops precision: 1.9 or 2 for 1.88, 53% for 53.3%, 1.1 km for 1,053 m', () => {
    // documented rule: rounding must keep ≥ min(3, significant digits of the tool value)
    expect(check('画圆高估 1.9 倍 [T1]。').unsupported).toEqual(['1.9 倍']);
    expect(check('画圆高估约 2 倍 [T1]。').unsupported).toEqual(['2 倍']);
    expect(check('可达面积只有 53% [T1]。').unsupported).toEqual(['53%']);
    expect(check('半径 1.1 km [T1]。').unsupported).toEqual(['1.1 km']);
    expect(check('画圆高估 1.8 倍 [T1]。').unsupported).toEqual(['1.8 倍']);
    expect(check('面积 1.86 km² [T1]。').ok).toBe(true);
  });

  it('rejects hallucinated numbers and wrong units', () => {
    const g = check('有 11 个缺口，面积 1.875 km²，半径 1053 个 [T1]。');
    expect(g.ok).toBe(false);
    expect(g.unsupported).toEqual(['11 个', '1.875 km2', '1053 个']);
  });

  it('matches unitless tool values to counts only, never to quantities with units', () => {
    const src: NumberSource = { id: 'T1', data: { straight_gaps: 2, rho_median: 1.349 } };
    expect(check('画圆法找到 2 个缺口 [T1]。', [src]).ok).toBe(true);
    expect(check('绕行系数中位数 1.349 [T1]。', [src]).ok).toBe(true);
    expect(check('高估 2 倍，多走 2 m [T1]。', [src]).unsupported).toEqual(['2 倍', '2 m']);
  });

  it('allows the domain constants only with their units', () => {
    const ok = check('15 分钟生活圈按步行 1 km 判定，临界 50 m，百度按 1.17 m/s 计时，老年人按 0.9 m/s。');
    expect(ok.unsupported).toEqual([]);
    expect(ok.uncited).toEqual([]);
    expect(check('一共 15 项。', []).unsupported).toEqual(['15 项']);
    expect(check('依据 GB 12345-2020。', []).unsupported).toEqual(['GB 12345-2020']);
    expect(check('药店按 300 m 判定。', []).unsupported).toEqual(['300 m']);
  });

  it('accepts the user’s own numbers and dates found in tool data', () => {
    const g = check('海科路 1650 号附近，数据是 2026-09-26 的实测 [T1]。', [
      T1,
      { id: 'question', text: '海科路1650号怎么样' },
    ]);
    expect(g.unsupported).toEqual([]);
    expect(check('数据是 2026-09-27 的 [T1]。').unsupported).toEqual(['2026-09-27']);
  });

  it('ignores geometry: coordinates never support a number', () => {
    expect(check('坐标 121.1 [T1]。').unsupported).toEqual(['121.1']);
  });

  it('flags numbers whose sentence cites no result, or the wrong one', () => {
    const T2: NumberSource = { id: 'T2', facts: [{ label: '药店待核实数', value: 2, unit: '项' }] };
    const g = check('画圆高估 1.88 倍。另有 2 项待核实 [T1]。', [T1, T2]);
    expect(g.ok).toBe(true);
    expect(g.uncited).toEqual(['1.88 倍', '2 项']);
    // a marker right after the full stop belongs to that sentence; a table takes the citation beside it
    const table = ['| 指标 | 数值 |', '| --- | --- |', '| 高估 | 1.88 倍 |', '以上见 [T1]。'].join('\n');
    expect(check(`画圆高估 1.88 倍。[T1]\n${table}`).uncited).toEqual([]);
    // semicolons do not end a sentence
    expect(check('面积 1.857 km²；高估 1.88 倍 [T1]。').uncited).toEqual([]);
  });

  it('knows both walking speeds as constants, with their unit only', () => {
    expect(check('老年人按 0.9 m/s、成人按 1.17 m/s 计算。', [])).toMatchObject({ ok: true, uncited: [] });
    expect(check('约 0.9 倍。', []).unsupported).toEqual(['0.9 倍']);
  });

  it('offers the tool value a rounded number came from, and nothing for a computed one', () => {
    // real drafts: 23.9 → 24 分钟, 1,676 m → 1.7 公里, and a difference 1,676 − 1,000 = 676 m
    const g = check('步行约 24 分钟 [T1]。步行 1.7 公里 [T1]。多走了 676 m [T1]。高估约 1.9 倍 [T1]。');
    expect(g.unsupported).toEqual(['24 分钟', '1.7 公里', '676 m', '1.9 倍']);
    const near = Object.fromEntries(g.details.filter((d) => !d.supported).map((d) => [d.token, d.near]));
    expect(near).toEqual({
      '24 分钟': ['23.9 分钟（T1）'],
      '1.7 公里': ['1.676 公里（T1）'],
      '676 m': undefined,
      '1.9 倍': ['1.88 倍（T1）'],
    });
    // counts are exact or wrong: no hint
    expect(check('共 11 个缺口 [T1]。').details[0]!.near).toBeUndefined();
  });
});

describe('completeCitations', () => {
  const T2: NumberSource = { id: 'T2', facts: [{ label: '小学伪覆盖数', value: 5, unit: '个' }] };

  it('appends the id of the result that holds each uncited number, before the full stop', () => {
    const r = completeCitations(
      '结论：画圆高估 1.88 倍。[T2]\n- 漏掉的缺口里，5 个是小学伪覆盖 [T1]。\n- 面积 1.857 km²',
      [T1, T2],
    );
    expect(r.text).toBe(
      '结论：画圆高估 1.88 倍 [T1]。[T2]\n- 漏掉的缺口里，5 个是小学伪覆盖 [T1][T2]。\n- 面积 1.857 km² [T1]',
    );
    expect(r.added).toEqual(['1.88 倍 → T1', '5 个 → T2', '1.857 km2 → T1']);
    expect(checkGrounding(r.text, [T1, T2])).toMatchObject({ ok: true, uncited: [] });
  });

  it('leaves sentences with unsupported numbers, cited sentences and tables alone', () => {
    const text = ['高估 1.88 倍，另有 9 个。', '面积 1.857 km² [T1]。', '| 高估 | 1.88 倍 |'].join('\n');
    expect(completeCitations(text, [T1])).toEqual({ text, added: [] });
  });

  it('counts markers right after the full stop for the sentence before them', () => {
    const T2b: NumberSource = { id: 'T2', facts: [{ label: '缺口', value: 7, unit: '个' }] };
    expect(check('高估 1.88 倍，漏掉 7 个。[T1][T2]', [T1, T2b]).uncited).toEqual([]);
  });
});
