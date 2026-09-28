import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  BaiduCache,
  cacheKey,
  DAY_MS,
  DEFAULT_TTL_MS,
  MemoryStore,
  normalizeParam,
  openStore,
} from '../src/index.js';
import { baiduJson, spyTransport, testClient } from './helpers.js';

const tmp = mkdtempSync(join(tmpdir(), 'zdd-cache-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('cache keys', () => {
  it('round coordinates to 1e-5°, sort params and drop ak/sn/timestamp/output', () => {
    const a = cacheKey('place', [
      ['query', '药店'],
      ['location', '31.190070,121.644190'],
      ['ak', 'AAA'],
      ['sn', 'abc'],
      ['timestamp', 123],
      ['output', 'json'],
    ]);
    const b = cacheKey('place', { location: '31.1900702,121.6441904', query: '药店', ak: 'BBB' });
    expect(a).toBe(b);
    expect(a).toBe('place?location=31.19007,121.64419&query=药店');
  });

  it('keeps anything that changes the answer', () => {
    const base = { query: '药店', location: '31.19007,121.644195', page_num: 0 };
    expect(cacheKey('place', base)).not.toBe(cacheKey('place', { ...base, page_num: 1 }));
    expect(cacheKey('place', base)).not.toBe(cacheKey('place', { ...base, location: '31.19008,121.644195' }));
    expect(cacheKey('place', base)).not.toBe(cacheKey('place', { ...base, query: '药房' }));
  });

  it('normalizes numbers, [lng, lat] lists and numeric strings alike', () => {
    expect(normalizeParam(121.6441951)).toBe('121.6442');
    expect(normalizeParam(1500)).toBe('1500');
    expect(normalizeParam([[121.6441951, 31.1900701]])).toBe('121.6442,31.19007');
    expect(normalizeParam('31.190070,121.644195|31.19,121.64;x')).toBe('31.190070,121.644195|31.19,121.64;x');
    expect(normalizeParam('31.190070,121.644196|31.19,121.64')).toBe('31.19007,121.6442|31.19,121.64');
    expect(normalizeParam(-0.000001)).toBe('0');
  });
});

describe('BaiduCache', () => {
  it('uses the design TTLs: routes 30 d, place 7 d, geocode 30 d', () => {
    expect(DEFAULT_TTL_MS.routematrix_walking).toBe(30 * DAY_MS);
    expect(DEFAULT_TTL_MS.directionlite_walking).toBe(30 * DAY_MS);
    expect(DEFAULT_TTL_MS.place).toBe(7 * DAY_MS);
    expect(DEFAULT_TTL_MS.geocoding).toBe(30 * DAY_MS);
  });

  it('expires entries after their TTL', () => {
    let now = 0;
    const cache = new BaiduCache({ now: () => now });
    cache.set('place', 'k', { a: 1 });
    now = 7 * DAY_MS - 1;
    expect(cache.get('place', 'k')).toEqual({ a: 1 });
    now = 7 * DAY_MS;
    expect(cache.get('place', 'k')).toBeUndefined();
    expect(cache.stats().place).toMatchObject({ hits: 1, misses: 1, writes: 1 });
  });

  it('returns copies, so callers cannot corrupt the cache', () => {
    const cache = new BaiduCache();
    cache.set('geocoding', 'k', { list: [1] });
    (cache.get<{ list: number[] }>('geocoding', 'k') as { list: number[] }).list.push(2);
    expect(cache.get('geocoding', 'k')).toEqual({ list: [1] });
  });

  it('falls back from the memory LRU to the store', () => {
    const store = new MemoryStore();
    const cache = new BaiduCache({ store, maxMemoryEntries: 2 });
    for (const k of ['a', 'b', 'c']) cache.set('geoconv', k, k);
    expect(store.count()).toBe(3);
    expect(cache.get('geoconv', 'a')).toBe('a');
  });

  it('persists in the SQLite file across restarts', () => {
    const file = join(tmp, 'nested', 'baidu.sqlite');
    const s1 = openStore(file);
    expect(s1.kind).toBe('sqlite');
    new BaiduCache({ store: s1 }).set('routematrix_walking', 'route', { distanceM: 1044 });
    s1.close();
    const s2 = openStore(file);
    expect(new BaiduCache({ store: s2 }).get('routematrix_walking', 'route')).toEqual({ distanceM: 1044 });
    s2.close();
  });

  it('openStore(null) is a Map-backed store', () => {
    const s = openStore(null);
    expect(s.kind).toBe('memory');
    s.set('ns', 'k', 'v', null);
    expect(s.get('ns', 'k')).toEqual({ value: 'v', expiresAt: null });
    expect(s.purgeExpired(Date.now())).toBe(0);
  });

  it('singleflight: identical concurrent loads call the loader once', async () => {
    const cache = new BaiduCache();
    let calls = 0;
    const load = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return { v: 42 };
    };
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => cache.getOrLoad('place', 'same', load)));
    expect(calls).toBe(1);
    expect(results.map((r) => r.value)).toEqual(Array(5).fill({ v: 42 }));
    expect(cache.stats().place.joined).toBe(4);
    expect(await cache.getOrLoad('place', 'same', load)).toEqual({ value: { v: 42 }, via: 'cache' });
  });

  it('never caches failures', async () => {
    const cache = new BaiduCache();
    let calls = 0;
    const load = async () => {
      calls++;
      if (calls === 1) throw new Error('boom');
      return 'ok';
    };
    await expect(cache.getOrLoad('geocoding', 'k', load)).rejects.toThrow('boom');
    expect((await cache.getOrLoad('geocoding', 'k', load)).value).toBe('ok');
    expect(calls).toBe(2);
  });

  it('client requests share one Baidu call and then hit the cache', async () => {
    const t = spyTransport(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return baiduJson({
        status: 0,
        result: {
          location: { lng: 121.64, lat: 31.19 },
          precise: 1,
          confidence: 80,
          comprehension: 100,
          level: '道路',
        },
      });
    });
    const client = testClient(t);
    const [a, b] = await Promise.all([client.geocode('上海市申城佳苑'), client.geocode('上海市申城佳苑')]);
    expect(t.urls).toHaveLength(1);
    expect(a?.location).toEqual(b?.location);
    const c = await client.geocode(' 上海市申城佳苑 ');
    expect(c?.via).toBe('cache');
    expect(t.urls).toHaveLength(1);
    expect(client.ledger.usage('geocoding').used).toBe(1);
  });
});
