import { createBaiduClient, MemoryStore, replayConfig, type BaiduClient } from '@zoudedao/baidu';
import { describe, expect, it } from 'vitest';
import { createLiveAnalyzer } from '../src/live.js';
import { ANALYZE_BODY, makeApp, parseSse } from './helpers.js';

/** Real client with fake keys and an in-memory store: nothing touches the network or data/cache. */
function offlineClient(): BaiduClient {
  return createBaiduClient({ config: replayConfig('personal'), store: new MemoryStore(), mode: 'replay' });
}

describe('live analyzer (@zoudedao/engine)', () => {
  it('is reported by /api/health', async () => {
    const baidu = offlineClient();
    const app = await makeApp({ mode: 'live' }, { baidu, analyzer: createLiveAnalyzer(baidu) });
    expect((await app.inject('/api/health')).json()).toMatchObject({ mode: 'live', analyzer: 'engine' });
    await app.close();
  });

  it('turns an exhausted daily quota into a quota_exhausted event before any Baidu call', async () => {
    const baidu = offlineClient();
    baidu.ledger.acquire('routematrix_walking', 4500).commit(); // up to the 90 % soft limit
    const app = await makeApp({ mode: 'live' }, { baidu, analyzer: createLiveAnalyzer(baidu) });
    const res = await app.inject({ method: 'POST', url: '/api/analyze', payload: ANALYZE_BODY });
    const events = parseSse(res.body);
    const error = events.find((e) => e.event === 'error');
    expect(error?.data).toMatchObject({ code: 'quota_exhausted' });
    expect((error?.data as { message: string }).message).toMatch(/[一-鿿]/);
    expect(events.some((e) => e.event === 'result')).toBe(false);
    await app.close();
  });
});
