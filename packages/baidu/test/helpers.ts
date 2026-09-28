/** Shared test utilities: recorded fixtures from research/, fake keys, instant schedulers. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { haversine, type LngLat } from '@zoudedao/core';
import {
  BaiduClient,
  loadBaiduConfig,
  MemoryStore,
  ReplayTransport,
  Scheduler,
  type BaiduClientOptions,
  type BaiduConfig,
  type ReplayFixture,
  type SchedulerOptions,
  type Transport,
  type TransportResponse,
} from '../src/index.js';

export const RESEARCH_DIR = fileURLToPath(new URL('../../../research/', import.meta.url));
export const PROBE_RAW = `${RESEARCH_DIR}api-probe/raw`;
export const ZJ_RAW = `${RESEARCH_DIR}zhangjiang/raw`;

/** Loads research/<rel> (e.g. 'api-probe/raw/04c_1x50_routematrix_walking.json') as a replay fixture. */
export function fixture(rel: string): ReplayFixture {
  const data: unknown = JSON.parse(readFileSync(`${RESEARCH_DIR}${rel}`, 'utf8'));
  const fx = ReplayTransport.parseFixture(rel, data);
  if (!fx) throw new Error(`not a recording: ${rel}`);
  return fx;
}

export function responseOf(rel: string): Record<string, unknown> {
  return fixture(rel).response as Record<string, unknown>;
}

/** Decoded query param of a recorded request. */
export function requestParam(fx: ReplayFixture, name: string): string {
  const v = new URL(fx.request).searchParams.get(name);
  if (v === null) throw new Error(`${fx.name} has no ${name}`);
  return v;
}

/** "lat,lng|lat,lng" (Baidu order) → BD-09 [lng, lat][]. */
export function latLngList(s: string): LngLat[] {
  return s.split('|').map((part) => {
    const [lat, lng] = (part.split(';')[0] ?? '').split(',').map(Number);
    return [lng as number, lat as number];
  });
}

/** Fake keys only — tests never see the real .env.local. */
export const FAKE_ENV = {
  BAIDU_SERVER_AK: 'FakeServerAk0123456789abcdef0000',
  BAIDU_SERVER_SK: 'FakeServerSk0123456789abcdef0000',
  BAIDU_SERVER_AUTH: 'sn',
  BAIDU_MATRIX_AK: 'FakeMatrixAk0123456789abcdef0000',
  BAIDU_TIER: 'personal',
} as const;

export function fakeConfig(overrides: Record<string, string | undefined> = {}): BaiduConfig {
  return loadBaiduConfig({ ...FAKE_ENV, ...overrides }, { cwd: '/tmp/zdd-baidu-test' });
}

/** Scheduler that never waits (pacing and backoff are covered by scheduler.test.ts). */
export function instantScheduler(opts: SchedulerOptions = {}): Scheduler {
  return new Scheduler({ tier: 'personal', sleep: () => Promise.resolve(), random: () => 0, ...opts });
}

export function testClient(transport: Transport, opts: Partial<BaiduClientOptions> = {}): BaiduClient {
  return new BaiduClient({
    config: fakeConfig(),
    transport,
    store: new MemoryStore(),
    scheduler: instantScheduler(),
    ...opts,
  });
}

export type SpyTransport = Transport & { urls: string[] };

/** Records every URL and answers with `handler`. */
export function spyTransport(
  handler: (url: URL) => TransportResponse | Promise<TransportResponse>,
): SpyTransport {
  const urls: string[] = [];
  const t = (async ({ url }) => {
    urls.push(url);
    return handler(new URL(url));
  }) as SpyTransport;
  t.urls = urls;
  return t;
}

/** Wraps a ReplayTransport so tests can count and inspect the URLs it served. */
export function spyReplay(fixtures: ReplayFixture[]): { transport: SpyTransport; replay: ReplayTransport } {
  const replay = new ReplayTransport(fixtures);
  const urls: string[] = [];
  const t = (async (req) => {
    urls.push(req.url);
    return replay.send(req);
  }) as SpyTransport;
  t.urls = urls;
  return { transport: t, replay };
}

/**
 * Synthetic routematrix: answers every origin × destination (origin-major) with 1.3 × straight distance
 * and distance / 1.17 duration, like the real service. `zero` marks pairs to answer with value 0.
 */
export function fakeMatrix(zero: (o: LngLat, d: LngLat) => boolean = () => false): SpyTransport {
  return spyTransport((url) => {
    const origins = latLngList(url.searchParams.get('origins') ?? '');
    const dests = latLngList(url.searchParams.get('destinations') ?? '');
    const result = origins.flatMap((o) =>
      dests.map((d) => {
        const m = zero(o, d) ? 0 : Math.round(1.3 * haversine(o[0], o[1], d[0], d[1]));
        const s = Math.round(m / 1.17);
        return { distance: { text: `${m}米`, value: m }, duration: { text: '', value: s } };
      }),
    );
    return { httpStatus: 200, json: { status: 0, message: '成功', num: result.length, result } };
  });
}

export function baiduJson(json: Record<string, unknown>): TransportResponse {
  return { httpStatus: 200, json };
}
