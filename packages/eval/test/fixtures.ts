/**
 * The evaluation over the engine tests' synthetic river city (packages/engine/test/city.ts: a 100 m
 * street grid, a river at x = 450 m with one bridge at y = −300 m, Dijkstra walking at 1.17 m/s),
 * served in Baidu's wire format to the real BaiduClient (packages/engine/test/transport.ts), so the
 * client's batching, cache and ledger — and the evaluation's ceiling — all run. No network.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BaiduClient,
  MemoryStore,
  replayConfig,
  Scheduler,
  type KvStore,
  type Transport,
  type TransportRequest,
} from '@zoudedao/baidu';

import { City, CITY_ORIGIN } from '../../engine/test/city.js';
import { cityTransport } from '../../engine/test/transport.js';
import type { EvalArea } from '../src/areas.js';
import { CeilingLedger, type Ceilings } from '../src/ceiling.js';

export { City, CITY_ORIGIN };

export const CITY_AREA: EvalArea = {
  id: 'T',
  name: '临河测试城',
  label: '河西路 × 滨河路',
  center_bd09: CITY_ORIGIN,
};

export const NOW = () => new Date('2026-10-01T02:00:00Z');

/** Counts HTTP attempts per Baidu path; `fail` can refuse attempts (thrown like a network error). */
export interface CountingTransport extends Transport {
  paths: string[];
  /** Routematrix routes (origins × destinations) of the requests that reached the network. */
  routesSent: number;
  count(path: string): number;
}

export function countingTransport(
  inner: Transport,
  fail?: (req: TransportRequest, attempt: number) => boolean,
): CountingTransport {
  const paths: string[] = [];
  const t = (async (req: TransportRequest) => {
    const url = new URL(req.url);
    paths.push(url.pathname);
    if (fail?.(req, paths.length)) throw new Error('ECONNRESET (injected)');
    if (url.pathname === MATRIX_PATH) {
      const n = (k: string) => (url.searchParams.get(k) ?? '').split('|').filter(Boolean).length;
      t.routesSent += n('origins') * n('destinations');
    }
    return inner(req);
  }) as CountingTransport;
  t.paths = paths;
  t.routesSent = 0;
  t.count = (p: string) => paths.filter((x) => x === p).length;
  return t;
}

export const MATRIX_PATH = '/routematrix/v2/walking';
export const WALK_PATH = '/directionlite/v1/walking';

export interface CityClient {
  city: City;
  store: KvStore;
  ledger: CeilingLedger;
  client: BaiduClient;
  transport: CountingTransport;
}

/** A real BaiduClient over the city with an instant scheduler and the evaluation's ceiling ledger. */
export function cityClient(
  opts: {
    city?: City;
    caps?: Ceilings;
    store?: KvStore;
    fail?: (req: TransportRequest, attempt: number) => boolean;
    networkRetries?: number;
  } = {},
): CityClient {
  const city = opts.city ?? SHARED_CITY;
  const store = opts.store ?? new MemoryStore();
  const transport = countingTransport(cityTransport(city), opts.fail);
  const ledger = new CeilingLedger({ tier: 'personal', store, caps: opts.caps ?? {} });
  const client = new BaiduClient({
    config: replayConfig('personal'),
    transport,
    store,
    ledger,
    scheduler: new Scheduler({
      tier: 'personal',
      sleep: () => Promise.resolve(),
      random: () => 0,
      ...(opts.networkRetries !== undefined ? { networkRetries: opts.networkRetries } : {}),
    }),
  });
  return { city, store, ledger, client, transport };
}

/** One city for all tests: its shortest-path trees are cached per snapped origin. */
export const SHARED_CITY = new City();

const roots: string[] = [];

/** A fresh artefact root under the OS temp dir; removed by cleanupTempRoots. */
export function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zdd-eval-'));
  roots.push(dir);
  return dir;
}

export function cleanupTempRoots(): void {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** Walking-time truth of the city from its origin, seconds. */
export const truthTime = (xy: [number, number]) => SHARED_CITY.timeFromOrigin(xy);
