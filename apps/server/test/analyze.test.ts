import type { AddressInfo } from 'node:net';
import { BaiduConfigError, BaiduUpstreamError } from '@zoudedao/baidu';
import type { AnalysisResult } from '@zoudedao/core';
import { describe, expect, it } from 'vitest';
import {
  AnalyzeError,
  type AnalyzeInput,
  type Analyzer,
  type PartialResult,
  type QuotaEvent,
  type StageEvent,
} from '../src/analyzer.js';
import { SampleReplayAnalyzer } from '../src/replay.js';
import { ANALYZE_BODY, makeApp, parseSse, STUB_RESULT } from './helpers.js';

const post = (payload: unknown) => ({
  method: 'POST' as const,
  url: '/api/analyze',
  payload: payload as object,
});

/** Enough of a result for the replay to walk through its stages. */
const REPLAY_STUB = {
  meta: { name: '测试', center_bd09: [121.6, 31.2] },
  samples: [],
  pois: [],
  paths: [],
  communities: [],
  contours: { '300': [], '600': [], '900': [] },
} as unknown as AnalysisResult;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('POST /api/analyze in sample mode', () => {
  it('answers 409 live_mode_disabled', async () => {
    const app = await makeApp();
    const res = await app.inject(post(ANALYZE_BODY));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'live_mode_disabled', message: expect.stringContaining('样例模式') });
    await app.close();
  });

  it('answers 409 before looking at the body', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/analyze',
      payload: 'not json',
      headers: { 'content-type': 'text/plain' },
    });
    expect(res.statusCode).toBe(409);
    await app.close();
  });
});

describe('POST /api/analyze with the sample replay analyzer', () => {
  it('streams the zj-a stages as well-formed SSE and ends with the full result', async () => {
    const app = await makeApp({ mode: 'live' });
    const res = await app.inject(post(ANALYZE_BODY));

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-cache, no-transform');
    expect(res.headers['x-accel-buffering']).toBe('no');

    // Framing: blocks of exactly one `event:` line and one single-line JSON `data:` line.
    expect(res.payload.endsWith('\n\n')).toBe(true);
    for (const block of res.payload.slice(0, -2).split('\n\n')) {
      expect(block).toMatch(/^event: (stage|partial|quota|result)\ndata: \{.*\}$/);
    }

    const events = parseSse(res.payload);
    expect(events[0]?.event).toBe('stage');
    const stages = events.filter((e) => e.event === 'stage').map((e) => e.data as StageEvent);
    expect([...new Set(stages.map((s) => s.stage))]).toEqual([
      'locate',
      'facilities',
      'seed',
      'paths',
      'refine',
      'reach',
      'coverage',
      'report',
    ]);
    stages.forEach((s, i) => {
      expect(s.message).toMatch(/\S/);
      expect(s.progress).toBeGreaterThan(i === 0 ? 0 : (stages[i - 1]?.progress ?? 0));
      expect(s.progress).toBeLessThan(1);
    });

    const partialKeys = new Set(
      events.filter((e) => e.event === 'partial').flatMap((e) => Object.keys(e.data as PartialResult)),
    );
    for (const key of [
      'meta',
      'pois',
      'samples',
      'paths',
      'field',
      'contours',
      'communities',
      'gray_areas',
      'stats',
    ]) {
      expect(partialKeys).toContain(key);
    }

    const quota = events.filter((e) => e.event === 'quota').map((e) => e.data as QuotaEvent);
    const routes = quota.filter((q) => q.service === 'routematrix_walking');
    expect(routes.length).toBeGreaterThan(1);
    routes.forEach((q, i) => expect(q.used).toBeGreaterThan(routes[i - 1]?.used ?? 0));
    quota.forEach((q) => expect(q.used).toBeLessThanOrEqual(q.limit));

    expect(events.filter((e) => e.event === 'result')).toHaveLength(1);
    const last = events.at(-1);
    expect(last?.event).toBe('result');
    expect((last?.data as AnalysisResult).meta.name).toBe('申城佳苑片区');

    // The health quota block and the streamed quota events come from the same ledger.
    const health = (await app.inject('/api/health')).json<{
      analyzer: string;
      quota: Record<string, QuotaEvent>;
    }>();
    expect(health).toMatchObject({ mode: 'live', analyzer: 'replay' });
    expect(health.quota.routematrix_walking?.used).toBe(routes.at(-1)?.used);
    await app.close();
  });

  it('replays with realistic pacing and stops at the next pause when aborted', async () => {
    const load = async () => REPLAY_STUB;
    const input = { center_bd09: [121.6, 31.2] as [number, number], profile: 'adult' as const };

    const paced = new SampleReplayAnalyzer({ load, pace: 0.01 });
    const started = Date.now();
    await paced.analyze(input, () => {}, new AbortController().signal);
    expect(Date.now() - started).toBeGreaterThanOrEqual(90); // ≈ 10 s at pace 1

    const controller = new AbortController();
    const seen: string[] = [];
    const run = new SampleReplayAnalyzer({ load, pace: 1 }).analyze(
      input,
      (event) => {
        seen.push(event);
        controller.abort(new Error('stop'));
      },
      controller.signal,
    );
    await expect(run).rejects.toThrow();
    expect(seen).toEqual(['stage']);
  });
});

describe('POST /api/analyze body validation', () => {
  it.each([
    [{ center_bd09: [200, 31] }, 'center_bd09'],
    [{ center_bd09: [-74.006, 40.7128] }, 'center_bd09'],
    [{ center_bd09: [121.6, 31.2, 0] }, 'center_bd09'],
    [{ center_bd09: [121.6] }, 'center_bd09'],
    [{ center_bd09: ['121.6', '31.2'] }, 'center_bd09'],
    [{}, 'center_bd09'],
    [{ center_bd09: [121.6, 31.2], profile: 'child' }, 'profile'],
    [{ center_bd09: [121.6, 31.2], label: 'x'.repeat(81) }, 'label'],
    [[121.6, 31.2], 'JSON 对象'],
  ])('rejects %j with 400 invalid_input', async (body, hint) => {
    const app = await makeApp({ mode: 'live' }, { analyzer: { analyze: async () => STUB_RESULT } });
    const res = await app.inject(post(body));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_input', message: expect.stringContaining(hint) });
    await app.close();
  });

  it('maps malformed, non-JSON and oversized bodies to the unified error format', async () => {
    const app = await makeApp({ mode: 'live' }, { analyzer: { analyze: async () => STUB_RESULT } });
    const bad = await app.inject({
      method: 'POST',
      url: '/api/analyze',
      payload: '{"center_bd09":',
      headers: { 'content-type': 'application/json' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: 'invalid_input', message: '请求体不是合法的 JSON' });

    const text = await app.inject({
      method: 'POST',
      url: '/api/analyze',
      payload: 'hello',
      headers: { 'content-type': 'text/plain' },
    });
    expect(text.statusCode).toBe(400);
    expect(text.json()).toEqual({ error: 'invalid_input', message: expect.stringContaining('JSON 对象') });

    const xml = await app.inject({
      method: 'POST',
      url: '/api/analyze',
      payload: '<center/>',
      headers: { 'content-type': 'application/xml' },
    });
    expect(xml.statusCode).toBe(415);
    expect(xml.json()).toMatchObject({ error: 'unsupported_media_type' });

    const huge = await app.inject(post({ ...ANALYZE_BODY, label: 'x'.repeat(200_000) }));
    expect(huge.statusCode).toBe(413);
    expect(huge.json()).toMatchObject({ error: 'payload_too_large' });
    await app.close();
  });

  it('fills in the default profile before calling the analyzer', async () => {
    let seen: unknown;
    const app = await makeApp(
      { mode: 'live' },
      {
        analyzer: {
          analyze: async (input) => {
            seen = input;
            return STUB_RESULT;
          },
        },
      },
    );
    await app.inject(post({ center_bd09: [121.644195, 31.19007], extra: 'dropped' }));
    expect(seen).toEqual({ center_bd09: [121.644195, 31.19007], profile: 'adult' });
    await app.close();
  });

  it('passes the valid browser POIs on and drops the invalid ones without failing', async () => {
    let seen: AnalyzeInput | undefined;
    const app = await makeApp(
      { mode: 'live' },
      {
        analyzer: {
          analyze: async (input) => {
            seen = input;
            return STUB_RESULT;
          },
        },
      },
    );
    const hema = {
      uid: '8EE16C67BBAA20C4220262DE',
      name: '盒马鲜生(陆悦天地店)',
      keyword: '生鲜超市',
      bd09: [121.62276604445195, 31.18876182784504],
    };
    const res = await app.inject(
      post({
        ...ANALYZE_BODY,
        browser_pois: [
          hema,
          { ...hema, uid: 'short' },
          { ...hema, uid: '0123456789abcdef01234567', name: 'x'.repeat(61) },
          { ...hema, uid: '0123456789abcdef01234568', keyword: '超过十个字符的关键词啊' },
          { ...hema, uid: '0123456789abcdef01234569', bd09: [2.35, 48.85] },
          { ...hema, uid: '0123456789abcdef0123456a', bd09: 'nope' },
          'not an object',
          null,
        ],
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(seen?.browser_pois).toEqual([{ ...hema, uid: '8ee16c67bbaa20c4220262de' }]);

    // nothing valid: the field is left out
    await app.inject(post({ ...ANALYZE_BODY, browser_pois: [{ uid: 'bad' }] }));
    expect(seen).not.toHaveProperty('browser_pois');

    // not an array at all: the request is wrong
    const bad = await app.inject(post({ ...ANALYZE_BODY, browser_pois: 'none' }));
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: 'invalid_input', message: expect.stringContaining('browser_pois') });

    // 400 items with long names fit the body limit; more are cut at 400
    const many = Array.from({ length: 450 }, (_, i) => ({
      ...hema,
      uid: i.toString(16).padStart(24, '0'),
      name: `${'超'.repeat(50)}(${i}店)`,
    }));
    const full = await app.inject(post({ ...ANALYZE_BODY, browser_pois: many.slice(0, 400) }));
    expect(full.statusCode).toBe(200);
    expect(seen?.browser_pois).toHaveLength(400);
    await app.inject(post({ ...ANALYZE_BODY, browser_pois: many }));
    expect(seen?.browser_pois).toHaveLength(400);
    await app.close();
  });
});

describe('POST /api/analyze failure handling', () => {
  it('passes AnalyzeError codes through as the closing error event', async () => {
    const analyzer: Analyzer = {
      analyze: async (_input, emit) => {
        emit('stage', { stage: 'seed', message: '粗采样', progress: 0.2 });
        throw new AnalyzeError('quota_exhausted', '今日批量算路配额已用尽，请明天再试或查看样例');
      },
    };
    const app = await makeApp({ mode: 'live' }, { analyzer });
    const events = parseSse((await app.inject(post(ANALYZE_BODY))).payload);
    expect(events.map((e) => e.event)).toEqual(['stage', 'error']);
    expect(events[1]?.data).toEqual({
      code: 'quota_exhausted',
      message: '今日批量算路配额已用尽，请明天再试或查看样例',
    });
    await app.close();
  });

  it('reports unexpected failures as internal, without details', async () => {
    const analyzer: Analyzer = {
      analyze: async () => {
        throw new Error('boom https://api.map.baidu.com/?ak=SECRET');
      },
    };
    const app = await makeApp({ mode: 'live' }, { analyzer });
    const res = await app.inject(post(ANALYZE_BODY));
    expect(parseSse(res.payload)).toEqual([
      { event: 'error', data: { code: 'internal', message: '分析出错，请稍后重试' } },
    ]);
    expect(res.payload).not.toMatch(/SECRET|boom/);
    await app.close();
  });

  it('maps Baidu errors that reach the route unwrapped to their own codes, cleaned for clients', async () => {
    const failWith = (err: Error): Analyzer => ({
      analyze: async () => {
        throw err;
      },
    });
    const upstream = await makeApp(
      { mode: 'live' },
      {
        analyzer: failWith(
          new BaiduUpstreamError(
            '批量算路请求失败：https://api.map.baidu.com/routematrix/v2/walking?ak=SECRETAK',
            {
              kind: 'network',
            },
          ),
        ),
      },
    );
    const res = await upstream.inject(post(ANALYZE_BODY));
    expect(parseSse(res.payload)).toEqual([
      { event: 'error', data: { code: 'upstream', message: expect.stringContaining('批量算路请求失败') } },
    ]);
    expect(res.payload).not.toMatch(/SECRETAK|https?:\/\//);
    await upstream.close();

    const auth = await makeApp(
      { mode: 'live' },
      { analyzer: failWith(new BaiduConfigError('批量算路（步行）没有可用的 Key')) },
    );
    expect(parseSse((await auth.inject(post(ANALYZE_BODY))).payload)[0]?.data).toEqual({
      code: 'auth',
      message: '批量算路（步行）没有可用的 Key',
    });
    await auth.close();
  });

  it('ends the stream with a timeout error even if the analyzer ignores its signal', async () => {
    const app = await makeApp(
      { mode: 'live', analyzeTimeoutMs: 50 },
      { analyzer: { analyze: () => new Promise<AnalysisResult>(() => {}) } },
    );
    const events = parseSse((await app.inject(post(ANALYZE_BODY))).payload);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      event: 'error',
      data: { code: 'timeout', message: expect.stringContaining('超时') },
    });
    await app.close();
  });

  it('turns away work beyond the concurrency cap with 503 busy', async () => {
    const started = deferred();
    const release = deferred();
    const analyzer: Analyzer = {
      analyze: async () => {
        started.resolve();
        await release.promise;
        return STUB_RESULT;
      },
    };
    const app = await makeApp({ mode: 'live', maxConcurrentAnalyses: 1 }, { analyzer });
    const first = app.inject(post(ANALYZE_BODY));
    await started.promise;

    const second = await app.inject(post(ANALYZE_BODY));
    expect(second.statusCode).toBe(503);
    expect(second.json()).toEqual({ error: 'busy', message: '当前分析任务较多，请稍后再试' });

    release.resolve();
    expect(parseSse((await first).payload).at(-1)?.event).toBe('result');
    expect((await app.inject(post(ANALYZE_BODY))).statusCode).toBe(200);
    await app.close();
  });

  it('closes open streams with an error event on shutdown', async () => {
    const started = deferred();
    const analyzer: Analyzer = {
      analyze: (_input, emit, signal) =>
        new Promise<AnalysisResult>((_resolve, reject) => {
          emit('stage', { stage: 'locate', message: '定位中心点', progress: 0.03 });
          signal.addEventListener('abort', () => reject(signal.reason as Error));
          started.resolve();
        }),
    };
    const app = await makeApp({ mode: 'live' }, { analyzer });
    const pending = app.inject(post(ANALYZE_BODY));
    await started.promise;
    await app.close();

    const events = parseSse((await pending).payload);
    expect(events.map((e) => e.event)).toEqual(['stage', 'error']);
    expect(events[1]?.data).toEqual({ code: 'internal', message: '服务正在重启，请稍后重试' });
  });

  it('aborts the analysis when the client disconnects', async () => {
    const aborted = deferred<unknown>();
    const analyzer: Analyzer = {
      analyze: (_input, emit, signal) =>
        new Promise<AnalysisResult>((_resolve, reject) => {
          emit('stage', { stage: 'locate', message: '定位中心点', progress: 0.03 });
          signal.addEventListener('abort', () => {
            aborted.resolve(signal.reason);
            reject(signal.reason as Error);
          });
        }),
    };
    const app = await makeApp({ mode: 'live' }, { analyzer });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as AddressInfo;

    const client = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ANALYZE_BODY),
      signal: client.signal,
    });
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    const reader = res.body?.getReader();
    const chunk = await reader?.read();
    expect(new TextDecoder().decode(chunk?.value)).toContain('event: stage');

    client.abort();
    expect(((await aborted.promise) as Error).message).toBe('client disconnected');
    await app.close();
  });
});
