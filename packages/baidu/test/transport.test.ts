import { describe, expect, it } from 'vitest';
import {
  BaiduUpstreamError,
  createFetchTransport,
  ReplayTransport,
  sameParam,
  type BaiduJson,
} from '../src/index.js';
import { fixture, PROBE_RAW, ZJ_RAW } from './helpers.js';

const RM = 'https://api.map.baidu.com/routematrix/v2/walking';

describe('ReplayTransport', () => {
  it('loads every recording from the research dirs and skips non-recordings', async () => {
    const replay = await ReplayTransport.fromDirs([PROBE_RAW, ZJ_RAW]);
    // 54 probe recordings + 25 Zhangjiang Baidu recordings (OSM/Valhalla files have no _meta.request)
    expect(replay.size).toBeGreaterThanOrEqual(75);
  });

  it('matches on path + key params, ignoring ak/sn and coordinate formatting', async () => {
    const replay = new ReplayTransport([fixture('api-probe/raw/04g_routematrix_walking_poi_plain.json')]);
    const plain = new URL(fixture('api-probe/raw/04g_routematrix_walking_poi_plain.json').request);
    // The recording has 15-digit coordinates; the client sends 6 decimals, other ak, extra coord_type.
    const dests = (plain.searchParams.get('destinations') ?? '')
      .split('|')
      .map((p) =>
        p
          .split(',')
          .map((x) => Number(x).toFixed(6))
          .join(','),
      )
      .join('%7C');
    const url = `${RM}?origins=31.190070,121.644195&destinations=${dests}&coord_type=bd09ll&output=json&ak=OTHER`;
    const res = await replay.send({ url, timeoutMs: 1000 });
    expect(res.httpStatus).toBe(200);
    expect((res.json as BaiduJson).status).toBe(0);
    expect(replay.served).toEqual(['api-probe/raw/04g_routematrix_walking_poi_plain.json']);
  });

  it('serves repeated matches in sequence: a recorded 401, then the recorded success', async () => {
    const d401 = fixture('api-probe/raw/04d1_routematrix_walking_1x50_concurrent.json');
    const ok = fixture('api-probe/raw/04c_1x50_routematrix_walking.json');
    const replay = new ReplayTransport([d401, ok]);
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await replay.send({ url: ok.request, timeoutMs: 1000 });
      statuses.push((res.json as BaiduJson).status);
    }
    expect(statuses).toEqual([401, 0, 0]);
    const firstOk = new ReplayTransport([d401, ok], { order: 'first-ok' });
    expect(((await firstOk.send({ url: ok.request, timeoutMs: 1000 })).json as BaiduJson).status).toBe(0);
  });

  it('throws a non-retryable replay_miss for unknown requests and logs it masked', async () => {
    const replay = new ReplayTransport([fixture('api-probe/raw/01_geocoding_venue.json')]);
    const url = 'https://api.map.baidu.com/geocoding/v3/?address=nowhere&output=json&ak=SECRETKEY123';
    const err = await replay.send({ url, timeoutMs: 1000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BaiduUpstreamError);
    expect(err).toMatchObject({ kind: 'replay_miss', retryable: false });
    expect(replay.misses[0]).toContain('ak=***');
    expect(replay.misses[0]).not.toContain('SECRETKEY123');
  });

  it('compares coordinate lists within 1e-6 and everything else exactly', () => {
    expect(sameParam('31.19007,121.644195', '31.190070,121.6441950')).toBe(true);
    expect(sameParam('31.1900701,121.644195', '31.190070,121.644195')).toBe(true);
    expect(sameParam('31.19009,121.644195', '31.190070,121.644195')).toBe(false);
    expect(sameParam('1.0,2.0;uidA', '1,2;uidB')).toBe(false);
    expect(sameParam('药店$药房', '药店$药房')).toBe(true);
    expect(sameParam(undefined, '0')).toBe(false);
  });
});

describe('createFetchTransport', () => {
  const okFetch = (body: string, status = 200) =>
    (async () => new Response(body, { status })) as unknown as typeof fetch;

  it('returns HTTP status and parsed JSON', async () => {
    const t = createFetchTransport({ fetch: okFetch('{"status":0,"result":[]}') });
    expect(await t({ url: 'https://x/y', timeoutMs: 1000 })).toEqual({
      httpStatus: 200,
      json: { status: 0, result: [] },
    });
  });

  it('returns json: null for a non-JSON body', async () => {
    const t = createFetchTransport({ fetch: okFetch('<html>bad gateway</html>', 502) });
    expect(await t({ url: 'https://x/y', timeoutMs: 1000 })).toEqual({ httpStatus: 502, json: null });
  });

  it('turns connection failures into retryable network errors', async () => {
    const failing = (async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
    }) as unknown as typeof fetch;
    const err = await createFetchTransport({ fetch: failing })({ url: 'https://x', timeoutMs: 1000 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BaiduUpstreamError);
    expect(err).toMatchObject({ kind: 'network', retryable: true });
    expect((err as Error).message).toContain('ECONNRESET');
  });

  it('times out hung requests', async () => {
    const hang = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    const err = await createFetchTransport({ fetch: hang })({ url: 'https://x', timeoutMs: 20 }).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ kind: 'network', retryable: true });
    expect((err as Error).message).toContain('超时');
  });

  it('propagates a caller abort as-is', async () => {
    const hang = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    const ac = new AbortController();
    const p = createFetchTransport({ fetch: hang })({ url: 'https://x', timeoutMs: 5000, signal: ac.signal });
    ac.abort(new Error('user cancelled'));
    await expect(p).rejects.toThrow('user cancelled');
  });
});
