import { describe, expect, it } from 'vitest';
import { AnalysisStore, BackendError, HttpBackend, LocalBackend, type ZddBackend } from '../src/backend.js';
import { readSse } from '../src/sse.js';
import type { AnalyzeEvent } from '../src/types.js';
import { SAMPLES_DIR, zjA } from './helpers.js';

const enc = new TextEncoder();

/** A body stream that delivers `chunks` one by one (to split events across reads). */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe('readSse', () => {
  it('parses events split across chunks, comments, CRLF and multi-line data', async () => {
    const out = [];
    for await (const m of readSse(
      streamOf([
        ': ping\n\nevent: sta',
        'ge\r\ndata: {"a":',
        '1}\r\n\r\ndata: line1\ndata: line2\n\n',
        'event: result\ndata: {}',
      ]),
    )) {
      out.push(m);
    }
    expect(out).toEqual([
      { event: 'stage', data: '{"a":1}' },
      { event: 'message', data: 'line1\nline2' },
      { event: 'result', data: '{}' },
    ]);
  });
});

describe('HttpBackend', () => {
  it('lists samples and reads analyses; accepts a base URL ending in /api', async () => {
    const { fetch, calls } = stubFetch((url) =>
      url.endsWith('/api/samples')
        ? Response.json([
            { id: 'zj-a', name: '申城佳苑片区', center_bd09: [121.644195, 31.19007] },
            { id: 7 },
          ])
        : Response.json(zjA()),
    );
    const b = new HttpBackend('http://localhost:8787/api/', { fetch });
    expect(await b.listSamples()).toEqual([
      { id: 'zj-a', name: '申城佳苑片区', center_bd09: [121.644195, 31.19007] },
    ]);
    expect((await b.getAnalysis('zj-a')).meta.name).toBe('申城佳苑片区');
    expect(calls.map((c) => c.url)).toEqual([
      'http://localhost:8787/api/samples',
      'http://localhost:8787/api/analysis/zj-a',
    ]);
  });

  it('turns HTTP errors into Chinese BackendErrors', async () => {
    const { fetch } = stubFetch(() =>
      Response.json({ error: 'not_found', message: '样例不存在' }, { status: 404 }),
    );
    const err = await new HttpBackend('http://x', { fetch }).getAnalysis('nope').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackendError);
    expect(err).toMatchObject({ code: 'not_found', status: 404 });
    expect((err as Error).message).toContain('找不到分析 nope');
  });

  it('streams a live analysis: stage / quota / partial events, then the result', async () => {
    const result = JSON.stringify(zjA());
    const sse = [
      'event: stage\ndata: {"stage":"seed","message":"粗采样：48 条步行路线","progress":0.2}\n\n',
      ': ping\n\n',
      'event: quota\ndata: {"service":"routematrix_walking","used":48,"limit":5000}\n\n',
      'event: partial\ndata: {"samples":[]}\n\n',
      `event: result\ndata: ${result.slice(0, 1000)}`,
      `${result.slice(1000)}\n\n`,
    ];
    const { fetch, calls } = stubFetch(
      () => new Response(streamOf(sse), { headers: { 'content-type': 'text/event-stream' } }),
    );
    const events: AnalyzeEvent[] = [];
    const r = await new HttpBackend('http://x', { fetch }).analyze(
      { center_bd09: [121.61, 31.2], label: '测试', profile: 'elder' },
      (e) => events.push(e),
    );
    expect(r.meta.name).toBe('申城佳苑片区');
    expect(events.map((e) => e.type)).toEqual(['stage', 'quota', 'partial']);
    expect(events[0]).toMatchObject({ stage: 'seed', progress: 0.2 });
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({
      center_bd09: [121.61, 31.2],
      label: '测试',
      profile: 'elder',
    });
  });

  it('reports the SSE error event, the 409 of sample mode and a stream that ends early', async () => {
    const errorStream = stubFetch(
      () =>
        new Response(
          streamOf(['event: error\ndata: {"code":"quota_exhausted","message":"今日批量算路配额已用尽"}\n\n']),
        ),
    );
    await expect(
      new HttpBackend('http://x', { fetch: errorStream.fetch }).analyze({ center_bd09: [121.6, 31.2] }),
    ).rejects.toMatchObject({ code: 'quota_exhausted', message: '今日批量算路配额已用尽' });

    const sample = stubFetch(() => Response.json({ error: 'live_mode_disabled' }, { status: 409 }));
    await expect(
      new HttpBackend('http://x', { fetch: sample.fetch }).analyze({ center_bd09: [121.6, 31.2] }),
    ).rejects.toMatchObject({
      code: 'live_mode_disabled',
      status: 409,
      message: expect.stringContaining('样例模式'),
    });

    const cut = stubFetch(() => new Response(streamOf(['event: stage\ndata: {"stage":"seed"}\n\n'])));
    await expect(
      new HttpBackend('http://x', { fetch: cut.fetch }).analyze({ center_bd09: [121.6, 31.2] }),
    ).rejects.toMatchObject({ code: 'upstream' });
  });

  it('times out and reports an unreachable server in Chinese', async () => {
    const slow = stubFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        }),
    );
    await expect(
      new HttpBackend('http://x', { fetch: slow.fetch, timeoutMs: 20 }).listSamples(),
    ).rejects.toMatchObject({
      code: 'timeout',
    });
    const down = stubFetch(() => {
      throw new TypeError('fetch failed');
    });
    await expect(new HttpBackend('http://x', { fetch: down.fetch }).listSamples()).rejects.toMatchObject({
      code: 'unreachable',
      message: expect.stringContaining('无法连接走得到服务'),
    });
  });

  it('reads /api/locate with needs_confirmation, and the older camelCase spelling', async () => {
    const body = {
      query: 'AI小镇服务中心',
      city: '上海市',
      best: {
        name: 'AI小镇服务中心',
        center_bd09: [121.624269, 31.19307],
        source: 'place_region',
        confidence: 0.75,
      },
      candidates: [
        {
          name: 'AI小镇服务中心',
          center_bd09: [121.624269, 31.19307],
          source: 'place_region',
          confidence: 0.75,
        },
      ],
      needs_confirmation: false,
      warnings: [],
    };
    const snake = stubFetch(() => Response.json(body));
    const r = await new HttpBackend('http://x', { fetch: snake.fetch }).locate('AI小镇服务中心', '上海市');
    expect(r).toMatchObject({ needs_confirmation: false, best: { name: 'AI小镇服务中心' } });
    expect(snake.calls[0]!.url).toBe(
      `http://x/api/locate?q=${encodeURIComponent('AI小镇服务中心')}&city=${encodeURIComponent('上海市')}`,
    );
    const { needs_confirmation: _drop, ...rest } = body;
    const camel = stubFetch(() => Response.json({ ...rest, needsConfirmation: true }));
    expect((await new HttpBackend('http://x', { fetch: camel.fetch }).locate('x')).needs_confirmation).toBe(
      true,
    );
  });
});

describe('LocalBackend', () => {
  const b = new LocalBackend({ samplesDir: SAMPLES_DIR });

  it('lists and reads the samples, never outside the directory', async () => {
    const list = await b.listSamples();
    expect(list.find((s) => s.id === 'zj-a')).toEqual({
      id: 'zj-a',
      name: '申城佳苑片区',
      center_bd09: [121.644195, 31.19007],
      center_label: '孙环路 × 高木桥路',
    });
    for (const s of list) expect(s.center_bd09).toHaveLength(2);
    expect((await b.getAnalysis('zj-a')).communities).toHaveLength(12);
    await expect(b.getAnalysis('../samples/zj-a')).rejects.toMatchObject({ code: 'not_found' });
    expect((b as ZddBackend).analyze).toBeUndefined();
    expect(await new LocalBackend({ samplesDir: '/nonexistent/zdd' }).listSamples()).toEqual([]);
  });

  it('locates sample names, centre labels and communities', async () => {
    expect(await b.locate('申城佳苑')).toMatchObject({
      needs_confirmation: false,
      best: { sample_id: 'zj-a', source: 'sample', confidence: 1 },
    });
    expect((await b.locate('高木桥路')).best?.sample_id).toBe('zj-a');
    const community = await b.locate('申城佳苑三期B块');
    expect(community.needs_confirmation).toBe(false);
    expect(community.best).toMatchObject({ name: '申城佳苑片区', sample_id: 'zj-a' });
    const inside = await b.locate('孙桥花苑');
    expect(inside).toMatchObject({
      needs_confirmation: false,
      best: { name: '孙桥花苑', sample_id: 'zj-a', confidence: 0.8 },
    });
    expect(inside.best!.center_bd09[0]).toBeCloseTo(121.636, 2);
    const none = await b.locate('陆家嘴');
    expect(none).toMatchObject({ candidates: [], best: null, needs_confirmation: true });
  });
});

describe('AnalysisStore', () => {
  it('gives live results stable ids and evicts the least recently used', () => {
    const store = new AnalysisStore({ maxEntries: 2 });
    const a = zjA();
    const id = store.put(a);
    expect(id).toMatch(/^live-[0-9a-f]{8}$/);
    expect(AnalysisStore.liveId(a)).toBe(id);
    store.put(a, { id: 'b', source: 'sample' });
    store.get(id); // refresh
    store.put(a, { id: 'c', source: 'sample' });
    expect(store.has(id)).toBe(true);
    expect(store.has('b')).toBe(false);
    expect(store.list().map((s) => s.id)).toEqual(['c', id]);
  });
});
