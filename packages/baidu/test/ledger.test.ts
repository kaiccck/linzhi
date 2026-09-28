import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  BaiduQuotaError,
  DAILY_QUOTA,
  MemoryStore,
  openStore,
  QuotaLedger,
  quotaDay,
  type BaiduService,
} from '../src/index.js';

const T0 = Date.parse('2026-09-27T02:00:00Z'); // 10:00 Beijing time
const tmp = mkdtempSync(join(tmpdir(), 'zdd-ledger-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function fill(ledger: QuotaLedger, service: BaiduService, units: number): void {
  ledger.acquire(service, units).commit();
}

describe('QuotaLedger', () => {
  it('knows the tier limits (开发者权益表)', () => {
    expect(DAILY_QUOTA.personal).toEqual({
      place: 100,
      routematrix_walking: 5000,
      directionlite_walking: 5000,
      geocoding: 5000,
      reverse_geocoding: 300,
      geoconv: 5000,
    });
    expect(DAILY_QUOTA.enterprise.place).toBe(2000);
    expect(DAILY_QUOTA.enterprise.reverse_geocoding).toBe(100_000);
    const ledger = new QuotaLedger({ tier: 'enterprise' });
    expect(ledger.limit('routematrix_walking')).toBe(100_000);
    expect(ledger.softLimit('place')).toBe(1800);
  });

  it('counts routematrix in routes and exposes the /api/health shape', () => {
    const ledger = new QuotaLedger({ now: () => T0 });
    fill(ledger, 'routematrix_walking', 48);
    fill(ledger, 'routematrix_walking', 50);
    const snap = ledger.snapshot();
    expect(snap.routematrix_walking).toMatchObject({
      used: 98,
      limit: 5000,
      calls: 2,
      remaining: 4902,
      soft_limit: 4500,
    });
    expect(snap.place).toMatchObject({ used: 0, limit: 100 });
  });

  it('refuses cold calls beyond 90 % of the limit', () => {
    const ledger = new QuotaLedger({ now: () => T0 });
    fill(ledger, 'place', 89);
    fill(ledger, 'place', 1); // 90 = soft limit, still allowed
    const err = (() => {
      try {
        ledger.acquire('place', 1);
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(BaiduQuotaError);
    expect(err).toMatchObject({ scope: 'soft', service: 'place', attempts: 0 });
    expect(ledger.blockedBy({ place: 1 })).toEqual(['place']);
  });

  it('holds in-flight units until they are committed or released', () => {
    const ledger = new QuotaLedger({ now: () => T0 });
    const t = ledger.acquire('place', 90);
    expect(() => ledger.acquire('place', 1)).toThrow(BaiduQuotaError);
    t.fail();
    expect(ledger.usage('place')).toMatchObject({ used: 0, failed: 1, in_flight: 0 });
    const t2 = ledger.acquire('place', 5);
    t2.release();
    t2.commit(); // no effect after release
    expect(ledger.usage('place')).toMatchObject({ used: 0, failed: 1, in_flight: 0 });
  });

  it('lets a reserved analysis budget run from 90 % up to the hard limit', () => {
    const ledger = new QuotaLedger({ now: () => T0 });
    fill(ledger, 'routematrix_walking', 4000);
    const budget = ledger.reserve({ routematrix_walking: 500, place: 6 });
    expect(ledger.usage('routematrix_walking').reserved).toBe(500);
    // A cold call outside the budget must fit next to the reservation: 4000 + 500 + 50 > 4500.
    expect(() => ledger.acquire('routematrix_walking', 50)).toThrow(/90%/);
    for (let i = 0; i < 10; i++) ledger.acquire('routematrix_walking', 50, budget).commit();
    expect(ledger.usage('routematrix_walking')).toMatchObject({ used: 4500, reserved: 0 });
    // Budget spent: further calls fall back to the soft limit.
    expect(() => ledger.acquire('routematrix_walking', 1, budget)).toThrow(BaiduQuotaError);
    budget.release();
    expect(ledger.usage('place').reserved).toBe(0);
  });

  it('never lets a budget exceed the hard limit', () => {
    const ledger = new QuotaLedger({ now: () => T0, limits: { place: 10 } });
    const budget = ledger.reserve({ place: 9 });
    fill(ledger, 'place', 0);
    for (let i = 0; i < 9; i++) ledger.acquire('place', 1, budget).commit();
    const other = ledger.reserve({});
    expect(() => ledger.acquire('place', 2, other)).toThrow(BaiduQuotaError);
    expect(ledger.usage('place').used).toBe(9);
  });

  it('refuses to reserve an analysis that would pass 90 %', () => {
    const ledger = new QuotaLedger({ now: () => T0 });
    fill(ledger, 'place', 85);
    expect(() => ledger.reserve({ place: 6, routematrix_walking: 740 })).toThrow(/90%/);
    expect(ledger.blockedBy({ place: 5, routematrix_walking: 740 })).toEqual([]);
    const b = ledger.reserve({ place: 5, routematrix_walking: 740 });
    expect(ledger.blockedBy({ place: 1 })).toEqual(['place']);
    b.release();
    expect(ledger.blockedBy({ place: 1 })).toEqual([]);
  });

  it('opens a breaker for the rest of the Beijing day after a 302', () => {
    let now = T0;
    const ledger = new QuotaLedger({ now: () => now });
    ledger.markExhausted('place', 'status 302 天配额超限');
    expect(() => ledger.acquire('place', 1)).toThrow(expect.objectContaining({ scope: 'daily' }));
    expect(ledger.usage('place')).toMatchObject({
      exhausted: true,
      exhausted_reason: 'status 302 天配额超限',
    });
    now = Date.parse('2026-09-27T16:00:00Z'); // 00:00 Beijing time on the 28th
    expect(ledger.usage('place').exhausted).toBe(false);
    expect(() => ledger.acquire('place', 1).commit()).not.toThrow();
  });

  it('rolls the day over at midnight Beijing time, not UTC', () => {
    expect(quotaDay(Date.parse('2026-09-27T15:59:59Z'))).toBe('2026-09-27');
    expect(quotaDay(Date.parse('2026-09-27T16:00:00Z'))).toBe('2026-09-28');
    let now = Date.parse('2026-09-27T15:59:00Z');
    const ledger = new QuotaLedger({ now: () => now });
    fill(ledger, 'geocoding', 7);
    now += 60_000;
    expect(ledger.usage('geocoding').used).toBe(0);
  });

  it('persists through the shared store (SQLite file) and merges two writers', () => {
    const file = join(tmp, 'ledger.sqlite');
    const s1 = openStore(file);
    expect(s1.kind).toBe('sqlite');
    const a = new QuotaLedger({ store: s1, now: () => T0 });
    const b = new QuotaLedger({ store: s1, now: () => T0 });
    fill(a, 'reverse_geocoding', 3);
    fill(b, 'reverse_geocoding', 2);
    expect(a.usage('reverse_geocoding').used).toBe(5);
    s1.close();
    const s2 = openStore(file);
    expect(new QuotaLedger({ store: s2, now: () => T0 }).usage('reverse_geocoding')).toMatchObject({
      used: 5,
      calls: 2,
    });
    s2.close();
  });

  it('notifies listeners on every change', () => {
    const ledger = new QuotaLedger({ store: new MemoryStore(), now: () => T0 });
    const seen: [string, number][] = [];
    const off = ledger.onChange((s, q) => seen.push([s, q.used]));
    fill(ledger, 'geoconv', 1);
    off();
    fill(ledger, 'geoconv', 1);
    expect(seen).toEqual([['geoconv', 1]]);
  });
});
