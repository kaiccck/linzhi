/**
 * The engine through the real BaiduClient: request building, routematrix tiling, the two-level cache
 * and the ledger's reservation all run; only the network is replaced by the synthetic city.
 */
import { BaiduClient, MemoryStore, QuotaLedger, replayConfig, Scheduler } from '@zoudedao/baidu';
import type { AnalysisResult } from '@zoudedao/core';
import { beforeAll, describe, expect, it } from 'vitest';

import { analyze, ENGINE_SERVICES, type Emit, type QuotaEvent } from '../src/index.js';
import { City, CITY_ORIGIN } from './city.js';
import { cityTransport } from './transport.js';

const NOW = () => new Date('2026-09-27T02:00:00Z');

describe('engine on the real BaiduClient', () => {
  const city = new City();
  const store = new MemoryStore();
  const ledger = new QuotaLedger({ tier: 'personal', store });
  const transport = cityTransport(city);
  const client = new BaiduClient({
    config: replayConfig('personal'),
    transport,
    store,
    ledger,
    scheduler: new Scheduler({ tier: 'personal', sleep: () => Promise.resolve(), random: () => 0 }),
  });
  const quota: QuotaEvent[] = [];
  const emit: Emit = (event, data) => {
    if (event === 'quota') quota.push(data as QuotaEvent);
  };
  let first: AnalysisResult;
  let requestsAfterFirst = 0;

  beforeAll(async () => {
    first = await analyze({ center_bd09: CITY_ORIGIN, profile: 'adult' }, { client, now: NOW }, emit);
    requestsAfterFirst = transport.paths.length;
  });

  it('bills through the ledger within the personal budget and gives the reservation back', () => {
    const used = first.stats.quota_used as Record<string, number>;
    for (const s of ENGINE_SERVICES) {
      const u = ledger.usage(s);
      expect(u.used, s).toBe(used[s]);
      expect(u.reserved, s).toBe(0);
      expect(u.in_flight, s).toBe(0);
    }
    expect(ledger.usage('routematrix_walking').used).toBeLessThanOrEqual(1030);
    expect(ledger.usage('place').used).toBeLessThanOrEqual(20);
    expect(ledger.usage('directionlite_walking').used).toBeLessThanOrEqual(6);
    expect(ledger.usage('reverse_geocoding').used).toBe(1);
    // quota events carry the ledger's day totals and tier limits
    const last = quota.filter((q) => q.service === 'routematrix_walking').pop();
    expect(last).toEqual({
      service: 'routematrix_walking',
      used: ledger.usage('routematrix_walking').used,
      limit: 5000,
    });
    expect(quota.find((q) => q.service === 'place')?.limit).toBe(100);
  });

  it('finds the same across-river gaps as with the fake client', () => {
    const byName = new Map(first.communities.map((c) => [c.name, c]));
    expect(first.communities).toHaveLength(30);
    expect(first.communities.every((c) => Object.keys(c.checks).length === 5)).toBe(true);
    expect(byName.get('滨河花园')!.checks['小学']).toMatchObject({
      school_assignment: 'unmatched',
      verified: false,
    });
    expect(byName.get('滨河花园')!.checks['幼儿园']).toMatchObject({ status_main: '伪覆盖', verified: true });
    expect(byName.get('东岸新村')!.checks['菜市场']).toMatchObject({ status_main: '伪覆盖', verified: true });
    expect(first.stats.area_iso15_km2).toBeLessThan(0.7 * first.stats.area_circle15_km2);
  });

  it('answers a repeated analysis from the cache: same result, no request, no quota', async () => {
    const before = Object.fromEntries(ENGINE_SERVICES.map((s) => [s, ledger.usage(s).used]));
    const again = await analyze(
      { center_bd09: CITY_ORIGIN, profile: 'adult' },
      { client, now: NOW },
      () => {},
    );
    expect(transport.paths.length).toBe(requestsAfterFirst);
    for (const s of ENGINE_SERVICES) expect(ledger.usage(s).used).toBe(before[s]);
    expect(again.stats.quota_used).toEqual({
      reverse_geocoding: 0,
      place: 0,
      directionlite_walking: 0,
      routematrix_walking: 0,
    });
    const queries = again.stats.place_queries as { billed: number }[];
    expect(queries.every((q) => q.billed === 0)).toBe(true);
    // only the bookkeeping differs (cached pages leave budget, so later queries may ask for more pages)
    const strip = (r: AnalysisResult) => ({
      ...r,
      stats: { ...r.stats, quota_used: null, quota_by_step: null, place_queries: null },
    });
    expect(strip(again)).toEqual(strip(first));
  });
});
