/**
 * A citation's places on the map: the anchors of a real 问询 answer (zj-a, elder profile) resolve to
 * the units, facilities and gray areas of the analysis on screen; another area's anchors do not.
 */
import { describe, expect, it } from 'vitest';
import type { AnalysisResult } from '@zoudedao/core';
import rawA from '../../../../data/samples/zj-a.json?raw';
import rawB from '../../../../data/samples/zj-b.json?raw';
import type { AskCitation } from '../data/ask.js';
import { deriveModel } from './derive.js';
import { placeOf, spotOf, spotWords } from './spots.js';

const a = deriveModel(JSON.parse(rawA) as AnalysisResult, 'zj-a');
const b = deriveModel(JSON.parse(rawB) as AnalysisResult, 'zj-b');

/** T2 of a recorded answer to “申城佳苑片区的老人买菜方便吗？” */
const T2: AskCitation = {
  id: 'T2',
  tool: 'list_service_gaps',
  title: '服务缺口清单',
  summary: '…',
  anchors: [
    { type: 'community', analysis_id: 'zj-a~elder', name: '川杨新苑四期', code: 'A-01', xy: [-9, 528.5] },
    {
      type: 'poi',
      analysis_id: 'zj-a~elder',
      name: '浦商生鲜(申城佳苑店)',
      category: '菜市场',
      xy: [269.5, -150.3],
    },
    { type: 'community', analysis_id: 'zj-a~elder', name: '川杨新苑三期', code: 'A-02', xy: [-350.9, 468.6] },
  ],
};

describe('spotOf', () => {
  it('lights the units by code and the facilities where they stand (elder profile = same place)', () => {
    const s = spotOf(a, 'zj-a', T2, 'x1:T2')!;
    expect(s.codes).toEqual(['A-01', 'A-02']);
    expect(s.pois.map((p) => p.name)).toEqual(['浦商生鲜(申城佳苑店)']);
    expect(s.focus).toHaveLength(3);
    expect(s.label).toBe('T2 服务缺口清单');
    expect(spotWords(s)).toBe('2 个小区、1 处设施');
  });

  it('finds a unit by name when the code is another numbering', () => {
    const cite = {
      ...T2,
      anchors: [
        { type: 'community' as const, analysis_id: 'zj-a', name: '川杨新苑四期', code: 'A-99', xy: null },
      ],
    };
    expect(spotOf(a, 'zj-a', cite, 'k')?.codes).toEqual(['A-01']);
  });

  it('outlines a gray area by its index', () => {
    const cite: AskCitation = {
      ...T2,
      anchors: [
        { type: 'gray_area', analysis_id: 'zj-a', id: 'gap-1', kind: 'gap', min_missing: 1, index: 0 },
      ],
    };
    const s = spotOf(a, 'zj-a', cite, 'k')!;
    expect(s.gray).toEqual([0]);
    expect(s.focus.length).toBeGreaterThan(0);
    expect(spotWords(s)).toBe('1 片灰色区域');
  });

  it('places nothing from another analysis (its metres are another frame)', () => {
    expect(spotOf(b, 'zj-b', T2, 'k')).toBeNull();
    expect(placeOf('zj-a~elder')).toBe('zj-a');
  });
});
