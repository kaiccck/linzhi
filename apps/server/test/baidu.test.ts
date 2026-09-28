import {
  BAIDU_SERVICES,
  createBaiduClient,
  MemoryStore,
  replayConfig,
  type BaiduClient,
  type ServiceQuota,
} from '@zoudedao/baidu';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { makeApp, REPO_ROOT, testConfig } from './helpers.js';

/** Real client with fake keys and an in-memory store: nothing touches the network or data/cache. */
function offlineClient(): BaiduClient {
  return createBaiduClient({ config: replayConfig('personal'), store: new MemoryStore(), mode: 'replay' });
}

describe('@zoudedao/baidu wiring', () => {
  it('reports the Baidu quota ledger in /api/health and closes the client with the app', async () => {
    const baidu = offlineClient();
    const close = vi.spyOn(baidu, 'close');
    baidu.ledger.acquire('place', 1).commit();
    const app = await makeApp({ mode: 'live' }, { baidu });

    const health = (await app.inject('/api/health')).json<{ quota: Record<string, ServiceQuota> }>();
    expect(Object.keys(health.quota).sort()).toEqual([...BAIDU_SERVICES].sort());
    expect(health.quota.place).toMatchObject({
      used: 1,
      limit: 100,
      remaining: 99,
      soft_limit: 90,
      reserved: 0,
      in_flight: 0,
      exhausted: false,
    });
    expect(health.quota.routematrix_walking).toMatchObject({ used: 0, limit: 5000 });

    await app.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it('keeps simulated replay usage out of the real ledger', async () => {
    const baidu = offlineClient();
    const app = await makeApp({ mode: 'live' }, { baidu });
    const stream = await app.inject({
      method: 'POST',
      url: '/api/analyze',
      payload: { center_bd09: [121.644195, 31.19007] },
    });
    expect(stream.payload).toContain('event: quota');
    const health = (await app.inject('/api/health')).json<{ quota: Record<string, ServiceQuota> }>();
    expect(health.quota.routematrix_walking?.used).toBe(0);
    await app.close();
  });

  it('logs Baidu config issues at their level without key material', async () => {
    const ak = 'TestServerAk0000000000000000abcd';
    const lines: string[] = [];
    const config = {
      ...testConfig({ logLevel: 'warn' }),
      baidu: loadConfig({ BAIDU_SERVER_AK: ak, BAIDU_SERVER_AUTH: 'sn', BAIDU_TIER: 'gold' }, REPO_ROOT)
        .baidu,
    };
    const app = await buildApp({ config, logStream: { write: (line) => void lines.push(line) } });
    await app.ready();

    const logged = lines.map((line) => JSON.parse(line) as { level: number; key?: string; msg: string });
    expect(logged).toContainEqual(expect.objectContaining({ level: 50, key: 'BAIDU_SERVER_SK' }));
    expect(logged).toContainEqual(
      expect.objectContaining({ level: 40, key: 'BAIDU_TIER', msg: expect.stringContaining('personal') }),
    );
    expect(lines.join('\n')).not.toContain(ak);
    await app.close();
  });
});
