import { describe, expect, it } from 'vitest';
import type { Analyzer } from '../src/analyzer.js';
import { formatWait } from '../src/rate-limit.js';
import { ANALYZE_BODY, makeApp, STUB_RESULT } from './helpers.js';

const instant: Analyzer = { analyze: async () => STUB_RESULT };

describe('rate limiting', () => {
  it('allows each IP a few analyses per hour', async () => {
    const app = await makeApp(
      { mode: 'live', rateLimit: { globalPerMinute: 1000, analyzePerHour: 2, locatePerMinute: 30 } },
      { analyzer: instant },
    );
    const analyze = (remoteAddress = '127.0.0.1') =>
      app.inject({ method: 'POST', url: '/api/analyze', payload: ANALYZE_BODY, remoteAddress });

    expect((await analyze()).statusCode).toBe(200);
    expect((await analyze()).statusCode).toBe(200);
    const limited = await analyze();
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({
      error: 'rate_limited',
      message: expect.stringMatching(/每小时 2 次.*请 \d+ (小时|分钟|秒)后再试/),
    });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);

    // Other clients and the other endpoints keep their own budget.
    expect((await analyze('10.0.0.9')).statusCode).toBe(200);
    expect((await app.inject('/api/health')).statusCode).toBe(200);
    await app.close();
  });

  it('applies a lighter global limit to every other route, unknown paths included', async () => {
    const app = await makeApp({ rateLimit: { globalPerMinute: 3, analyzePerHour: 6, locatePerMinute: 30 } });
    expect((await app.inject('/api/health')).statusCode).toBe(200);
    expect((await app.inject('/api/samples')).statusCode).toBe(200);
    expect((await app.inject('/api/nope')).statusCode).toBe(404);
    const limited = await app.inject('/api/health');
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: 'rate_limited', message: expect.stringContaining('后再试') });
    expect(limited.headers['x-ratelimit-limit']).toBe('3');
    await app.close();
  });

  it('keys clients by X-Forwarded-For only when a proxy is trusted', async () => {
    const forwarded = (app: Awaited<ReturnType<typeof makeApp>>, ip: string) =>
      app.inject({ url: '/api/health', headers: { 'x-forwarded-for': ip } });

    const behindProxy = await makeApp({
      trustProxy: true,
      rateLimit: { globalPerMinute: 1, analyzePerHour: 6, locatePerMinute: 30 },
    });
    expect((await forwarded(behindProxy, '1.1.1.1')).statusCode).toBe(200);
    expect((await forwarded(behindProxy, '1.1.1.1')).statusCode).toBe(429);
    expect((await forwarded(behindProxy, '2.2.2.2')).statusCode).toBe(200);
    await behindProxy.close();

    // Without trustProxy a spoofed header must not buy a fresh budget.
    const direct = await makeApp({
      rateLimit: { globalPerMinute: 1, analyzePerHour: 6, locatePerMinute: 30 },
    });
    expect((await forwarded(direct, '1.1.1.1')).statusCode).toBe(200);
    expect((await forwarded(direct, '2.2.2.2')).statusCode).toBe(429);
    await direct.close();
  });

  it('formats retry hints in Chinese units', () => {
    expect(formatWait(400)).toBe('1 秒');
    expect(formatWait(42_000)).toBe('42 秒');
    expect(formatWait(5 * 60_000)).toBe('5 分钟');
    expect(formatWait(59 * 60_000 + 1)).toBe('1 小时');
    expect(formatWait(90 * 60_000)).toBe('2 小时');
  });
});
