import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  backoffDelay,
  BaiduConfigError,
  BaiduQuotaError,
  BaiduUpstreamError,
  Scheduler,
  statusRule,
  STATUS_TABLE,
  type TransportResponse,
} from '../src/index.js';
import { responseOf } from './helpers.js';

const R211 = responseOf('api-probe/raw/04x_routematrix_walking_1x1_server_ak_sn_blocked.json');
const R240 = responseOf('api-probe/raw/07a_official_isochrone_foot_900s_server_ak_disabled.json');
const R401 = responseOf('api-probe/raw/04e2_routematrix_walking_1x3_burst.json');
const R401_50 = responseOf('api-probe/raw/04d1_routematrix_walking_1x50_concurrent.json');
const R2 = responseOf('api-probe/raw/04g_routematrix_walking_poi_uid.json');
const OK_50 = responseOf('api-probe/raw/04c_1x50_routematrix_walking.json');
// No 302 was recorded (the research budget never hit the daily cap); this is Baidu's documented reply.
const R302 = { status: 302, message: '天配额超限，限制访问' };

const reply = (json: Record<string, unknown>): TransportResponse => ({
  httpStatus: 200,
  json: structuredClone(json),
});

/** send() that answers from a script and logs the (fake) time of every attempt. */
function scripted(...script: (Record<string, unknown> | Error | TransportResponse)[]) {
  const times: number[] = [];
  let i = 0;
  const send = async (): Promise<TransportResponse> => {
    times.push(Date.now());
    const next = script[Math.min(i++, script.length - 1)];
    if (next instanceof Error) throw next;
    if (next && 'httpStatus' in next) return next as TransportResponse;
    return reply(next as Record<string, unknown>);
  };
  return { send, times };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('status policy', () => {
  it('covers the documented table', () => {
    for (const s of [3, 4, 5, 9, 101, 102, 200, 210, 211, 220, 240]) {
      expect(STATUS_TABLE[s]?.action.kind, `status ${s}`).toBe('config');
    }
    expect(statusRule(0).action).toEqual({ kind: 'ok' });
    expect(statusRule(1).action).toEqual({ kind: 'retry', maxRetries: 2, throttle: false });
    expect(statusRule(2).action.kind).toBe('bad_request');
    expect(statusRule(302).action.kind).toBe('quota');
    expect(statusRule(401).action).toEqual({ kind: 'retry', maxRetries: 5, throttle: true });
    expect(statusRule(402).action).toEqual({ kind: 'retry', maxRetries: 5, throttle: true });
    expect(statusRule(7).action.kind).toBe('empty');
    expect(statusRule(1, 'Internal Service Error:无相关结果').action.kind).toBe('empty');
    expect(statusRule(233).action.kind).toBe('config');
    expect(statusRule(399).action.kind).toBe('quota');
    expect(statusRule(999).action.kind).toBe('unknown');
  });

  it('211 (recorded) → BaiduConfigError at once, with the SK / matrix-key hint', async () => {
    const s = new Scheduler();
    const { send, times } = scripted(R211);
    const err = await s.execute({ service: 'routematrix_walking', send }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BaiduConfigError);
    expect(err).toMatchObject({ status: 211, attempts: 1, apiCode: 'auth' });
    expect((err as BaiduConfigError).hint).toBe(
      'SN 校验失败：检查 BAIDU_SERVER_SK，或批量算路改用 BAIDU_MATRIX_AK',
    );
    expect((err as Error).message).toContain('APP SN校验失败');
    expect(times).toHaveLength(1);
  });

  it('240 (recorded) → BaiduConfigError naming the key variable', async () => {
    const s = new Scheduler();
    const err = await s
      .execute({ service: 'place', send: scripted(R240).send, akVar: 'BAIDU_SERVER_AK' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BaiduConfigError);
    expect((err as BaiduConfigError).hint).toContain('BAIDU_SERVER_AK 没有开通该服务');
    expect((err as BaiduConfigError).toJSON()).toMatchObject({
      error: 'auth',
      status: 240,
      service: 'place',
    });
  });

  it('302 → BaiduQuotaError (daily), no retry', async () => {
    const { send, times } = scripted(R302);
    const err = await new Scheduler().execute({ service: 'place', send }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BaiduQuotaError);
    expect(err).toMatchObject({ scope: 'daily', apiCode: 'quota_exhausted' });
    expect(times).toHaveLength(1);
  });

  it('status 2 (recorded "destinations is empty") → bad_request, no retry', async () => {
    const { send, times } = scripted(R2);
    const err = await new Scheduler()
      .execute({ service: 'routematrix_walking', send })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BaiduUpstreamError);
    expect(err).toMatchObject({ kind: 'bad_request', status: 2 });
    expect(times).toHaveLength(1);
  });

  it('status 1 is retried twice; "无相关结果" is an empty answer', async () => {
    const s = new Scheduler({ random: () => 0 });
    const a = scripted({ status: 1, message: '服务器内部错误' });
    const pa = s.execute({ service: 'geocoding', send: a.send }).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    expect(await pa).toMatchObject({ kind: 'server', attempts: 3 });
    expect(a.times).toEqual([0, 1000, 3000]);

    const b = scripted({ status: 1, msg: 'Internal Service Error:无相关结果', results: [] });
    const pb = s.execute({ service: 'geocoding', send: b.send });
    await vi.runAllTimersAsync();
    expect((await pb).empty).toBe(true);
    expect(b.times).toHaveLength(1);
  });
});

describe('401 backoff', () => {
  it('retries the same chunk after 1, 2, 4, 8, 16 s, then gives up', async () => {
    const s = new Scheduler({ random: () => 0 });
    const { send, times } = scripted(R401);
    const p = s.execute({ service: 'routematrix_walking', units: 3, send }).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await p;
    expect(times).toEqual([0, 1000, 3000, 7000, 15000, 31000]);
    expect(err).toBeInstanceOf(BaiduUpstreamError);
    expect(err).toMatchObject({ kind: 'rate_limited', status: 401, attempts: 6 });
    expect(s.stats().routematrix_walking).toMatchObject({ throttled: 6, retries: 5, concurrency: 1 });
  });

  it('succeeds on retry: recorded 401 then the recorded 1×50 success', async () => {
    const s = new Scheduler({ random: () => 0 });
    const { send, times } = scripted(R401_50, OK_50);
    const p = s.execute({ service: 'routematrix_walking', units: 50, send });
    await vi.advanceTimersByTimeAsync(999);
    expect(times).toEqual([0]);
    await vi.runAllTimersAsync();
    const res = await p;
    // 1 s back-off, then the route bucket (45 routes/s) still needs 112 ms for the next 50 routes.
    expect(times).toEqual([0, 1112]);
    expect(res.json.status).toBe(0);
    expect(res.attempts).toBe(2);
  });

  it('adds jitter on top of the base schedule', () => {
    expect([1, 2, 3, 4, 5].map((r) => backoffDelay(r, 1000, 0.25, () => 0))).toEqual([
      1000, 2000, 4000, 8000, 16000,
    ]);
    expect(backoffDelay(1, 1000, 0.25, () => 1)).toBe(1250);
    expect(backoffDelay(5, 1000, 0.25, () => 0.5)).toBe(18000);
  });

  it('pauses the whole lane during the back-off window and halves concurrency', async () => {
    const s = new Scheduler({
      random: () => 0,
      increaseAfter: 1,
      limits: { geocoding: { ratePerSecond: 100, burst: 10 } },
    });
    const ok = { status: 0, result: {} };
    await s.execute({ service: 'geocoding', send: scripted(ok).send });
    await s.execute({ service: 'geocoding', send: scripted(ok).send });
    expect(s.concurrency('geocoding')).toBe(3);

    const a = scripted({ status: 401, message: '并发超限' }, ok);
    const pa = s.execute({ service: 'geocoding', send: a.send });
    await vi.advanceTimersByTimeAsync(10);
    expect(s.concurrency('geocoding')).toBe(1);
    const b = scripted(ok);
    const pb = s.execute({ service: 'geocoding', send: b.send });
    await vi.advanceTimersByTimeAsync(2000);
    await Promise.all([pa, pb]);
    expect(a.times).toEqual([0, 1000]);
    expect(b.times[0]).toBeGreaterThanOrEqual(1000);
  });
});

describe('network errors', () => {
  it('retries requests that never reached Baidu, then succeeds', async () => {
    const s = new Scheduler({ random: () => 0 });
    const boom = new TypeError('fetch failed');
    const { send, times } = scripted(boom, boom, boom, { status: 0, result: {} });
    const p = s.execute({ service: 'geocoding', send });
    await vi.runAllTimersAsync();
    expect((await p).attempts).toBe(4);
    expect(times).toEqual([0, 1000, 3000, 7000]);
  });

  it('gives up after 3 retries with a network error', async () => {
    const s = new Scheduler({ random: () => 0 });
    const p = s
      .execute({ service: 'geocoding', send: scripted(new Error('ECONNRESET')).send })
      .catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    expect(await p).toMatchObject({ kind: 'network', attempts: 4 });
  });

  it('does not retry non-retryable transport errors (replay miss)', async () => {
    const miss = new BaiduUpstreamError('回放数据中没有这个请求', { kind: 'replay_miss' });
    const { send, times } = scripted(miss);
    await expect(new Scheduler().execute({ service: 'geocoding', send })).rejects.toBe(miss);
    expect(times).toHaveLength(1);
  });

  it('retries HTTP 5xx, fails fast on other HTTP errors and on non-JSON', async () => {
    const s = new Scheduler({ random: () => 0, limits: { geoconv: { ratePerSecond: 1000, burst: 100 } } });
    const a = scripted({ httpStatus: 502, json: null }, { status: 0 });
    const pa = s.execute({ service: 'geoconv', send: a.send });
    await vi.runAllTimersAsync();
    expect((await pa).attempts).toBe(2);

    const b = scripted({ httpStatus: 403, json: null });
    await expect(s.execute({ service: 'geoconv', send: b.send })).rejects.toMatchObject({ kind: 'http' });
    const c = scripted({ httpStatus: 200, json: 'not json' });
    await expect(s.execute({ service: 'geoconv', send: c.send })).rejects.toMatchObject({
      kind: 'bad_response',
    });
  });
});

describe('pacing and AIMD', () => {
  it('spaces requests at the tier rate minus headroom (personal: 2/s)', async () => {
    const s = new Scheduler();
    const { send, times } = scripted({ status: 0 });
    const all = Promise.all([0, 1, 2].map(() => s.execute({ service: 'geocoding', send })));
    await vi.runAllTimersAsync();
    await all;
    expect(times).toEqual([0, 500, 1000]);
  });

  it('enterprise tier runs at 20/s', async () => {
    const s = new Scheduler({ tier: 'enterprise' });
    const { send, times } = scripted({ status: 0 });
    const all = Promise.all([0, 1, 2].map(() => s.execute({ service: 'place', send })));
    await vi.runAllTimersAsync();
    await all;
    expect(times).toEqual([0, 50, 100]);
  });

  it('meters routematrix by routes: two 1×50 batches ≈ 1.1 s apart', async () => {
    const s = new Scheduler();
    const { send, times } = scripted({ status: 0, result: [] });
    const all = Promise.all([0, 1].map(() => s.execute({ service: 'routematrix_walking', units: 50, send })));
    await vi.runAllTimersAsync();
    await all;
    expect(times).toEqual([0, 1112]);
  });

  it('starts at concurrency 1, adds 1 per 4 successes up to 3 (personal) and halves on 401', async () => {
    const s = new Scheduler({ limits: { reverse_geocoding: { ratePerSecond: 1000, burst: 100 } } });
    const ok = scripted({ status: 0 });
    expect(s.concurrency('reverse_geocoding')).toBe(1);
    for (let i = 0; i < 4; i++) await s.execute({ service: 'reverse_geocoding', send: ok.send });
    expect(s.concurrency('reverse_geocoding')).toBe(2);
    for (let i = 0; i < 20; i++) await s.execute({ service: 'reverse_geocoding', send: ok.send });
    expect(s.concurrency('reverse_geocoding')).toBe(3);
    const p = s.execute({
      service: 'reverse_geocoding',
      send: scripted({ status: 401 }, { status: 0 }).send,
    });
    await vi.runAllTimersAsync();
    await p;
    expect(s.concurrency('reverse_geocoding')).toBe(1);
  });

  it('enterprise concurrency grows to 10', async () => {
    const s = new Scheduler({
      tier: 'enterprise',
      increaseAfter: 1,
      limits: { geocoding: { ratePerSecond: 1000, burst: 100 } },
    });
    const ok = scripted({ status: 0 });
    for (let i = 0; i < 20; i++) await s.execute({ service: 'geocoding', send: ok.send });
    expect(s.concurrency('geocoding')).toBe(10);
  });

  it('queues beyond the concurrency limit and honours abort while queued', async () => {
    const s = new Scheduler({ limits: { geocoding: { ratePerSecond: 1000, burst: 10 } } });
    let release: () => void = () => undefined;
    const slow = () =>
      new Promise<TransportResponse>((resolve) => {
        release = () => resolve({ httpStatus: 200, json: { status: 0 } });
      });
    const first = s.execute({ service: 'geocoding', send: slow });
    const ac = new AbortController();
    const second = s.execute({ service: 'geocoding', send: slow, signal: ac.signal });
    await vi.advanceTimersByTimeAsync(0);
    expect(s.stats().geocoding).toMatchObject({ active: 1, queued: 1 });
    ac.abort(new Error('cancelled'));
    await expect(second).rejects.toThrow('cancelled');
    release();
    await first;
    expect(s.stats().geocoding).toMatchObject({ active: 0, queued: 0 });
  });
});
