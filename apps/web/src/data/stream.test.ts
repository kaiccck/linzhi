/**
 * Progressive rendering of a live check: POST /api/analyze read from a fake event stream (never the
 * real endpoint), the partials merged as docs/api.md says, and what the map draws from them — the
 * samples by stage with the newest batch marked, the coarse field, the reach tightening round by round.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisResult, TimeSample } from '@zoudedao/core';
import rawB from '../../../../data/samples/zj-b.json?raw';
import { analyze, type StageEvent } from './api.js';
import { fakeAnalyzer } from './fakeStream.js';
import { emptyStream, mergePartial, sampleStage, streamModel, type StreamState } from './stream.js';

const data = JSON.parse(rawB) as AnalysisResult;
const seed = data.samples.filter((s) => s.set === 'seed');
const traced = data.samples.filter((s) => s.set?.startsWith('dl_'));

/** An SSE body: one `event` line, one single-line JSON `data` line, a blank line; pings between. */
function sse(events: [string, unknown][]): Response {
  const text = events.map(([e, d]) => `: ping\n\nevent: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
  // split mid-event, as a network would
  const chunks = [text.slice(0, 37), text.slice(37, 2000), text.slice(2000)];
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const k of chunks) c.enqueue(new TextEncoder().encode(k));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const EVENTS: [string, unknown][] = [
  ['stage', { stage: 'locate', message: '定位', progress: 0.03 }],
  ['partial', { meta: data.meta }],
  ['stage', { stage: 'seed', message: '粗采样', progress: 0.12 }],
  ['quota', { service: 'routematrix_walking', used: 1048, limit: 5000 }],
  [
    'partial',
    { samples: seed, field: data.field, contours: data.contours, contours_meta: data.contours_meta },
  ],
  ['stage', { stage: 'paths', message: '路径', progress: 0.18 }],
  ['partial', { paths: data.paths, samples: [...seed, ...traced] }],
  ['result', data],
];

describe('analyze() over a fake event stream', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reports stages, merged partials and quota, and resolves with the result', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sse(EVENTS)),
    );
    const stages: StageEvent[] = [];
    const partials: Partial<AnalysisResult>[] = [];
    const quota: number[] = [];
    const result = await analyze(
      { center_bd09: data.meta.center_bd09, label: '玉兰香苑', profile: 'adult' },
      {
        onStage: (s) => stages.push(s),
        onPartial: (p) => partials.push(p),
        onQuota: (q) => quota.push(q.used),
      },
      new AbortController().signal,
    );
    expect(stages.map((s) => s.stage)).toEqual(['locate', 'seed', 'paths']);
    expect(quota).toEqual([1048]);
    expect(partials).toHaveLength(3);
    // { ...prev, ...partial }: the meta stays, samples are replaced by their full current value
    expect(partials[2]!.meta).toBe(partials[0]!.meta);
    expect(partials[2]!.samples).toHaveLength(seed.length + traced.length);
    expect(result.communities).toHaveLength(data.communities.length);
  });

  it('throws the stream’s Chinese error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sse([['error', { code: 'quota_exhausted', message: '今日百度配额已用尽' }]])),
    );
    await expect(
      analyze({ center_bd09: [121.6, 31.2], label: 'x', profile: 'adult' }, {}, new AbortController().signal),
    ).rejects.toThrow('今日百度配额已用尽');
  });
});

describe('what the map draws while it streams', () => {
  it('waits for the centre: nothing to draw before `meta`', () => {
    expect(streamModel({})).toBeNull();
    expect(streamModel({ samples: seed })).toBeNull();
  });

  it('sorts samples by stage and marks the batch just measured', () => {
    expect(sampleStage({ src: 'routematrix', set: 'seed' })).toBe('seed');
    expect(sampleStage({ src: 'directionlite_path', set: 'dl_b090' })).toBe('path');
    expect(sampleStage({ src: 'routematrix', set: 'refine3' })).toBe('refine');
    // samples of older results (rays_A …) count as the seed
    expect(sampleStage({ src: 'routematrix', set: 'rays_A' } as Pick<TimeSample, 'src' | 'set'>)).toBe(
      'seed',
    );

    let s: StreamState = emptyStream();
    s = mergePartial(s, { meta: data.meta });
    s = mergePartial({ ...s, stage: { stage: 'seed', message: '', progress: 0.1 } }, { samples: seed });
    s = mergePartial(
      { ...s, stage: { stage: 'paths', message: '', progress: 0.2 } },
      { samples: [...seed, ...traced] },
    );
    const m = streamModel(s.partial, s.seen)!;
    expect(m.counts).toEqual({ seed: seed.length, path: traced.length, refine: 0 });
    expect(m.dots.filter((d) => d.fresh)).toHaveLength(traced.length);
    expect(m.dots.slice(0, seed.length).every((d) => !d.fresh)).toBe(true);
    expect(m.field).toBeNull();
    expect(m.r15).toBeCloseTo(900 * data.meta.walk_speed_mps, 6);
  });

  it('records the reach after every field, labelled by its round', () => {
    let s: StreamState = { ...emptyStream(), stage: { stage: 'refine', message: '', progress: 0.3 } };
    s = mergePartial(s, { meta: data.meta, contours_meta: data.contours_meta });
    s = mergePartial(s, { samples: seed }); // no new field: no new step
    s = mergePartial(s, { contours_meta: { ...data.contours_meta! } });
    expect(s.areas.map((a) => a.label)).toEqual(['加密 1', '加密 2']);
    expect(s.areas[0]!.km2).toBeCloseTo(data.stats.area_iso15_km2, 1);
  });
});

describe('the dev-only fake stream (never touches /api/analyze)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('streams a sample round by round with coarse fields, then its result', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const go = fakeAnalyzer(async () => data, { pace: 0 });
    let s = emptyStream();
    const result = await go(
      { center_bd09: data.meta.center_bd09, label: 'x', profile: 'adult' },
      {
        onStage: (stage) => (s = { ...s, stage }),
        onPartial: (p) => (s = mergePartial(s, p)),
      },
      new AbortController().signal,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toBe(data);
    const m = streamModel(s.partial, s.seen)!;
    expect(m.counts.seed + m.counts.path + m.counts.refine).toBe(data.samples.length);
    // a coarse field after the seed, the paths and each refinement round, then the final one
    expect(s.areas.length).toBeGreaterThanOrEqual(4);
    expect(s.areas.at(-1)!.km2).toBeCloseTo(data.stats.area_iso15_km2, 1);
  });

  it('holds at a stage until cancelled', async () => {
    const ctl = new AbortController();
    const go = fakeAnalyzer(async () => data, { pace: 0, hold: 'seed' });
    let stage = '';
    const run = go(
      { center_bd09: data.meta.center_bd09, label: 'x', profile: 'adult' },
      { onStage: (e) => (stage = e.stage) },
      ctl.signal,
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(stage).toBe('seed');
    ctl.abort();
    await expect(run).rejects.toThrow();
  });
});
