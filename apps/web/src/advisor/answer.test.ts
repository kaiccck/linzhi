import { describe, expect, it } from 'vitest';
import type { AnalysisResult } from '@zoudedao/core';
import raw from '../../../../data/samples/zj-a.json?raw';
import { deriveModel } from '../model/derive.js';
import type { AskAnswer } from '../data/ask.js';
import {
  fmtBytes,
  formatName,
  historyOf,
  makeInliner,
  parseAnswer,
  stripFooter,
  suggestionsFor,
  tokenizeBlocks,
  worstCategory,
} from './answer.js';

const model = deriveModel(JSON.parse(raw) as AnalysisResult, 'zj-a');
const units = model.units.map((u) => ({ code: u.code, name: u.name }));

// the template advisor's answer to 申城佳苑片区的老人买菜方便吗？ (apps/server test/ask.test.ts)
const TEMPLATE = [
  '结论：不太方便：申城佳苑片区 12 个小区中，有 2 个步行 1,000 m 内走不到菜市场（伪覆盖 2、盲区 0）[T2]。',
  '',
  '- 按老年人步速 0.9 m/s，15 分钟最多走 810 m，整个片区 12 个小区里有 7 个能在 15 分钟内走到菜市场 [T2]。',
  '- 川杨新苑四期：到菜市场直线 733.7 m，实际步行 1,281 m，约 23.7 分钟（伪覆盖）[T2]。',
  '',
  '（未配置大模型：以上回答由模板根据工具结果生成，[T#] 是工具结果编号。）',
].join('\n');

describe('parseAnswer', () => {
  it('turns the template answer into a tagged lead and a list, dropping the footer', () => {
    const blocks = parseAnswer(TEMPLATE);
    expect(blocks.map((b) => b.t)).toEqual(['p', 'list']);
    expect(blocks[0]).toMatchObject({
      t: 'p',
      tag: 'conclusion',
      text: expect.stringMatching(/^不太方便：/),
    });
    expect(blocks[1]).toMatchObject({
      t: 'list',
      ordered: false,
      items: [expect.any(String), expect.any(String)],
    });
    expect(stripFooter(TEMPLATE)).not.toContain('未配置大模型');
  });

  it('labels estimates, keeps model tables and headings', () => {
    const blocks = parseAnswer(
      [
        '估算（未经实测核验）：在“孙环路口”新增 1 家药店 [T1]。',
        '### 各类设施',
        '| 设施 | 覆盖 |',
        '| --- | --- |',
        '| 小学 | 6 |',
        '1. 第一条',
        '2. 第二条',
        '（大模型没有按时完成回答：以上改由模板根据工具结果生成，[T#] 是工具结果编号。）',
      ].join('\n'),
    );
    expect(blocks).toEqual([
      { t: 'p', tag: 'estimate', text: '在“孙环路口”新增 1 家药店 [T1]。' },
      { t: 'h', text: '各类设施' },
      {
        t: 'table',
        rows: [
          ['设施', '覆盖'],
          ['小学', '6'],
        ],
      },
      { t: 'list', ordered: true, items: ['第一条', '第二条'] },
    ]);
  });
});

describe('makeInliner', () => {
  const inline = makeInliner(units, ['T1', 'T2']);
  const a01 = model.units.find((u) => u.name === '川杨新苑四期')!.code;

  it('sets numbers in the numeral face, citations and community names as plates', () => {
    expect(inline('川杨新苑四期：到菜市场直线 1,084.1 m，约 31.7 分钟（盲区）[T2]。')).toEqual([
      { t: 'unit', code: a01, name: '川杨新苑四期' },
      { t: 'text', s: '：到菜市场直线 ' },
      { t: 'num', s: '1,084.1 m' },
      { t: 'text', s: '，约 ' },
      { t: 'num', s: '31.7' },
      { t: 'text', s: ' 分钟（盲区）' },
      { t: 'cite', ids: ['T2'] },
      { t: 'text', s: '。' },
    ]);
    // Latin units travel with their number; minutes and counts stay in the sign face
    expect(inline('0.9 m/s，1.113 km²，54%，5 min').filter((p) => p.t === 'num')).toEqual([
      { t: 'num', s: '0.9 m/s' },
      { t: 'num', s: '1.113 km²' },
      { t: 'num', s: '54%' },
      { t: 'num', s: '5' },
    ]);
    expect(inline('L\u0302 ≈ 682 m')).toEqual([
      { t: 'lhat' },
      { t: 'text', s: ' ≈ ' },
      { t: 'num', s: '682 m' },
    ]);
  });

  it('keeps a code and the name after it as one unit, and leaves unknown codes as text', () => {
    expect(inline(`在“${a01} 川杨新苑四期”附近`)).toEqual([
      { t: 'text', s: '在“' },
      { t: 'unit', code: a01, name: '川杨新苑四期' },
      { t: 'text', s: '”附近' },
    ]);
    expect(inline(`${a01} 和 A-99`)).toEqual([
      { t: 'unit', code: a01, name: null },
      { t: 'text', s: ' 和 A-99' },
    ]);
  });

  it('reads grouped and full-width citations, and bare ids only when cited', () => {
    expect(inline('见 [T1, T2] 与【T2】')).toEqual([
      { t: 'text', s: '见 ' },
      { t: 'cite', ids: ['T1', 'T2'] },
      { t: 'text', s: ' 与' },
      { t: 'cite', ids: ['T2'] },
    ]);
    expect(inline('与工具结果 T1 相同，T9 不是')).toEqual([
      { t: 'text', s: '与工具结果 ' },
      { t: 'cite', ids: ['T1'] },
      { t: 'text', s: ' 相同，T9 不是' },
    ]);
  });

  it('plates a unit on its first mention only', () => {
    const blocks = tokenizeBlocks(
      parseAnswer(`在“${a01} 川杨新苑四期”（靠近川杨新苑四期）。\n\n- 川杨新苑四期旁；${a01} 以北`),
      inline,
    );
    const units = JSON.stringify(blocks).match(/"t":"unit"[^}]*/g);
    expect(units).toEqual([
      `"t":"unit","code":"${a01}","name":"川杨新苑四期"`,
      `"t":"unit","code":"${a01}","name":"川杨新苑四期","repeat":true`,
      `"t":"unit","code":"${a01}","name":"川杨新苑四期","repeat":true`,
      // a code alone always keeps its plate: without it nothing would be shown
      `"t":"unit","code":"${a01}","name":null`,
    ]);
  });

  it('turns **bold** into strong', () => {
    expect(inline('**不太方便**：4 个')).toEqual([
      { t: 'strong', parts: [{ t: 'text', s: '不太方便' }] },
      { t: 'text', s: '：' },
      { t: 'num', s: '4' },
      { t: 'text', s: ' 个' },
    ]);
  });
});

describe('suggestions and history', () => {
  it('derives the three questions from the analysis on screen', () => {
    const worst = model.boardOrder[0]!;
    expect(worstCategory(worst)).toBe('小学');
    expect(suggestionsFor(model).map((s) => s.question)).toEqual([
      '申城佳苑片区的老人买菜方便吗？',
      `如果在 ${worst.code} ${worst.name}附近开一所小学呢？`,
      '导出体检报告',
    ]);
  });

  it('sends the last 8 turns without footers, 2,000 characters at most', () => {
    const answer = (text: string) => ({ answer: text }) as AskAnswer;
    const done = Array.from({ length: 5 }, (_, k) => ({ question: `问题 ${k}`, answer: answer(TEMPLATE) }));
    done.push({ question: '长', answer: answer('字'.repeat(2500)) });
    const h = historyOf(done);
    expect(h).toHaveLength(8);
    expect(h[0]).toEqual({ role: 'user', content: '问题 2' });
    expect(h.every((t) => !t.content.includes('未配置大模型'))).toBe(true);
    expect([...h.at(-1)!.content]).toHaveLength(2000);
  });

  it('formats attachment sizes and kinds', () => {
    expect(fmtBytes(5088)).toBe('5.0 KB');
    expect(formatName('text/markdown', 'a.md')).toBe('Markdown');
    expect(formatName('application/geo+json', 'a.geojson')).toBe('GeoJSON');
  });
});
