/**
 * 问询's answer as the page reads it from a mocked event stream: the citations keep their anchors
 * (the places the map lights), broken anchors are dropped, and sources the server added are kept.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ask, parseAnchors } from './ask.js';

const sse = (events: [string, unknown][]) =>
  events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('') + ': ping\n\n';

const ANSWER = {
  answer: '结论：12 个小区中 7 个能在 15 分钟内走到菜市场，2 个是伪覆盖 [T2]。',
  mode: 'llm',
  model: 'deepseek-flash',
  citations: [
    {
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
        { type: 'gray_area', analysis_id: 'zj-a~elder', id: 'gap-1', kind: 'gap', min_missing: 1, index: 0 },
        { type: 'site', analysis_id: 'zj-a', label: '新设施位置', xy: [10, 20] },
        { type: 'poi', analysis_id: 'zj-a', name: '没有坐标' },
        { type: 'road', analysis_id: 'zj-a' },
      ],
    },
    { id: 'T1', tool: 'analyze_life_circle', title: '生活圈体检', summary: '…' },
  ],
  grounding: { ok: true, checked: 5, unsupported: [], uncited: [] },
  analysis_id: 'zj-a~elder',
  citations_added: ['1.88 倍 → T1', 3],
};

describe('ask: citations with their places', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps each citation’s anchors and the sources the server added', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            sse([
              ['tool_call', { tool: 'list_service_gaps', title: '服务缺口清单' }],
              ['tool_result', { tool: 'list_service_gaps', title: '服务缺口清单', id: 'T2', summary: '…' }],
              ['answer', ANSWER],
            ]),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          ),
      ),
    );
    const steps: unknown[] = [];
    const a = await ask(
      { question: '老人买菜方便吗？', analysis_id: 'zj-a', history: [] },
      (s) => steps.push(s),
      new AbortController().signal,
    );
    expect(steps).toHaveLength(2);
    const t2 = a.citations.find((c) => c.id === 'T2')!;
    expect(t2.anchors.map((x) => x.type)).toEqual(['community', 'poi', 'gray_area', 'site']);
    expect(t2.anchors[0]).toEqual({
      type: 'community',
      analysis_id: 'zj-a~elder',
      name: '川杨新苑四期',
      code: 'A-01',
      xy: [-9, 528.5],
    });
    // a tool about no place has none
    expect(a.citations.find((c) => c.id === 'T1')!.anchors).toEqual([]);
    expect(a.citations_added).toEqual(['1.88 倍 → T1']);
  });

  it('drops anchors it cannot place', () => {
    expect(parseAnchors([{ type: 'poi', name: 'x' }, { type: 'gray_area' }, null, 'x'])).toEqual([]);
    expect(parseAnchors('nope')).toEqual([]);
  });
});
