import { describe, expect, it } from 'vitest';
import type { AnalysisResult } from '@zoudedao/core';
import raw from '../../../../data/samples/zj-a.json?raw';
import rawB from '../../../../data/samples/zj-b.json?raw';
import rawC from '../../../../data/samples/zj-c.json?raw';
import { cellWords } from '../components/GapList.js';
import { deriveModel } from './derive.js';
import { freshLine, freshMarks, freshTally, freshText } from './fresh.js';

const A = deriveModel(JSON.parse(raw) as AnalysisResult, 'zj-a');
const C = deriveModel(JSON.parse(rawC) as AnalysisResult, 'zj-c');

describe('买菜替代', () => {
  it('counts the 菜市场 gaps that can still buy vegetables', () => {
    expect(freshTally(A)).toEqual({ gaps: 2, withAlt: 2, none: 0 });
    expect(freshLine(A)).toBe('缺菜市场的 2 个小区，2 个步行 1 公里内能买到菜。');
  });

  it('finds the shops the server search left out: 万科翡翠公园 buys vegetables at 联华超市 and 清美生鲜', () => {
    expect(freshTally(C)).toEqual({ gaps: 7, withAlt: 7, none: 0 });
    const shops = new Set(C.units.map((u) => u.checks['菜市场'].alt?.name));
    expect(shops).toEqual(new Set(['联华超市(川和路店)', '清美生鲜(荣科路店)']));
    // 联华 came from the browser's map search (the server's place search never returned it)
    expect(C.data.pois.find((p) => p.name === '联华超市(川和路店)')?.found_by).toBe('jsapi');
    // 清美 is tagged 美食 by Baidu, so it is no facility of the inventory; the brand rule still counts it
    expect(C.data.pois.some((p) => p.name === '清美生鲜(荣科路店)')).toBe(false);
  });

  it('says so when no gap has a shop either', () => {
    const data = JSON.parse(rawC) as AnalysisResult;
    for (const c of data.communities) if (c.checks['菜市场'].alt) c.checks['菜市场'].alt = null;
    const none = deriveModel(data, 'zj-c');
    expect(freshTally(none)).toEqual({ gaps: 7, withAlt: 0, none: 7 });
    expect(freshLine(none)).toBe('缺菜市场的 7 个小区，步行 1 公里内也没有超市或菜店。');
    expect(freshMarks(none)).toEqual([]);
  });

  it('never changes a verdict: the gaps and the heads stay', () => {
    const head = A.heads.find((h) => h.cat === '菜市场')!;
    expect(head.pseudo + head.blind).toBe(2);
  });

  it('puts each shop on the map once, where the walk ends', () => {
    const marks = freshMarks(deriveModel(JSON.parse(rawB) as AnalysisResult, 'zj-b'));
    expect(new Set(marks.map((m) => m.key)).size).toBe(marks.length);
    expect(marks.every((m) => m.fresh && m.key.startsWith('fresh:'))).toBe(true);
    expect(freshMarks(A).map((m) => m.face.name)).toEqual(['如海生鲜超市(中科路店)']);
  });

  it('rides along on the grid cell’s words, 菜市场 gaps only', () => {
    const a = A.units.find((u) => u.name === '川杨新苑三期')!;
    expect(freshText(a.checks['菜市场'].alt!)).toBe('可在 如海生鲜超市(中科路店) 买菜 · 步行 445 m');
    expect(cellWords('菜市场', a.checks['菜市场'], 1)).toContain(
      '；可在如海生鲜超市(中科路店)买菜，步行 445 米',
    );
    // other categories carry none
    expect(A.units.some((u) => u.checks['药店'].alt)).toBe(false);
  });
});
