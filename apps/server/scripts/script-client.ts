/**
 * The Baidu client of the data scripts under apps/server/scripts: the real client with the shared
 * SQLite cache and quota ledger (BAIDU_CACHE_PATH, default data/cache/baidu.sqlite), or — with
 * `--dry-run` — a cache-only client over a copy of that file, which never reaches Baidu and lists what
 * a live run would have to ask for. Live runs go through a spend guard and print /api/health-style
 * ledger deltas. Keys come from the environment only (`node --env-file=../../.env.local …`).
 */
import { copyFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BAIDU_SERVICES,
  BaiduClient,
  createBaiduClient,
  loadBaiduConfig,
  openStore,
  PLACE_DETAIL_MAX_UIDS,
  QuotaLedger,
  replayConfig,
  ReplayTransport,
  Scheduler,
  type BaiduService,
  type QuotaSnapshot,
} from '@zoudedao/baidu';
import type { EngineClient } from '@zoudedao/engine';

/** The repository root (fileURLToPath: the path has non-ASCII characters). */
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export interface ScriptClient {
  client: BaiduClient;
  dryRun: boolean;
  /** Dry run only: masked URLs a live run would have requested. */
  misses(): string[];
  close(): void;
}

export function openScriptClient(dryRun: boolean): ScriptClient {
  const config = loadBaiduConfig(process.env, { cwd: REPO_ROOT });
  if (!dryRun) {
    const client = createBaiduClient({ config, onWarning: (m) => console.warn(`[baidu] ${m}`) });
    return { client, dryRun, misses: () => [], close: () => client.close() };
  }
  // a private copy of cache + ledger: the dry run neither spends nor records anything
  const dir = mkdtempSync(join(tmpdir(), 'zdd-dry-'));
  const copy = join(dir, 'baidu.sqlite');
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(config.cachePath + suffix)) copyFileSync(config.cachePath + suffix, copy + suffix);
  }
  const store = openStore(copy);
  const replay = new ReplayTransport([]);
  const unlimited = Object.fromEntries(BAIDU_SERVICES.map((s) => [s, 1e9]));
  const client = new BaiduClient({
    config: replayConfig(config.tier, copy),
    transport: replay.send,
    store,
    ledger: new QuotaLedger({ tier: config.tier, store, limits: unlimited }),
    scheduler: new Scheduler({ tier: config.tier, sleep: () => Promise.resolve() }),
    mode: 'replay',
  });
  return { client, dryRun, misses: () => replay.misses.slice(), close: () => client.close() };
}

/**
 * The place/v3/detail requests of a dry run's misses, one line each: the uids a live run would look
 * up, with the names `names` knows (e.g. from the --browser-pois file).
 */
export function detailMisses(
  misses: readonly string[],
  names: ReadonlyMap<string, string> = new Map(),
): string[] {
  return misses
    .map((m) => new URL(m))
    .filter((u) => u.pathname === '/place/v3/detail')
    .map((u) => {
      const uids = (u.searchParams.get('uids') ?? '').split(',').filter(Boolean);
      return `place/v3/detail ${uids.length} uids: ${uids.map((x) => `${x} ${names.get(x) ?? '?'}`).join(', ')}`;
    });
}

/** What each uncached request of a dry run would have cost: pages, or routes for routematrix. */
export function missCost(misses: readonly string[]): Record<string, { requests: number; units: number }> {
  const out: Record<string, { requests: number; units: number }> = {};
  for (const m of misses) {
    const u = new URL(m);
    let units = 1;
    if (u.pathname.startsWith('/routematrix')) {
      const n = (k: string) => (u.searchParams.get(k) ?? '').split('|').filter(Boolean).length;
      units = n('origins') * n('destinations');
    }
    const e = (out[u.pathname] ??= { requests: 0, units: 0 });
    e.requests++;
    e.units += units;
  }
  return out;
}

const SHOWN: readonly BaiduService[] = [
  'place',
  'routematrix_walking',
  'geoconv',
  'reverse_geocoding',
  'directionlite_walking',
  'geocoding',
];

export type Usage = Record<BaiduService, number>;

export function usage(client: BaiduClient): Usage {
  return Object.fromEntries(BAIDU_SERVICES.map((s) => [s, client.ledger.usage(s).used])) as Usage;
}

/** The ledger as /api/health shows it (used / limit per service), plus the change since `before`. */
export function printLedger(label: string, client: BaiduClient, before?: Usage): void {
  const snap: QuotaSnapshot = client.ledger.snapshot();
  const rows = SHOWN.map((s) => {
    const q = snap[s];
    const delta = before ? `  (+${q.used - before[s]})` : '';
    return `  ${s.padEnd(22)} ${String(q.used).padStart(5)} / ${q.limit}${delta}`;
  });
  console.log(`${label}\n${rows.join('\n')}`);
}

export interface SpendLimits {
  place: number;
  routematrix_walking: number;
}

/**
 * The engine's client with a hard stop: a place search is refused when its page limit could pass
 * `limits.place` (so is a place detail lookup, one request per 10 uids), a routematrix call when fewer
 * than 50 routes (one engine call at most) are left
 * under `limits.routematrix_walking`. Counted from the ledger since the guard was made. A refusal is a
 * plain Error, which the engine treats as a bug: the run ends and nothing is written.
 *
 * `limits.place` 0 with a `placeCache` (a cache-only client, openScriptClient(true)) means cached
 * pages only: place searches are answered from it, and the first one it cannot answer is refused.
 * Without it no place search could pass a limit of 0, not even a cached one.
 */
export function spendGuard(client: BaiduClient, limits: SpendLimits, placeCache?: BaiduClient): EngineClient {
  const start = usage(client);
  const spent = (s: BaiduService) => client.ledger.usage(s).used - start[s];
  const refuse = (what: string) => {
    throw new Error(
      `spend guard: ${what} (place +${spent('place')}, routes +${spent('routematrix_walking')})`,
    );
  };
  return {
    ledger: client.ledger,
    reverseGeocode: (...a) => client.reverseGeocode(...a),
    walkingRoute: (...a) => client.walkingRoute(...a),
    placeAround: async (keywords, center, opts = {}) => {
      if (placeCache && limits.place === 0) {
        try {
          return await placeCache.placeAround(keywords, center, opts);
        } catch {
          refuse(`place search ${String(keywords)} is not cached`);
        }
      }
      if (spent('place') + (opts.maxPages ?? 3) > limits.place) refuse(`place search ${String(keywords)}`);
      return client.placeAround(keywords, center, opts);
    },
    placeDetail: async (uids, opts = {}) => {
      if (placeCache && limits.place === 0) {
        try {
          return await placeCache.placeDetail(uids, opts);
        } catch {
          refuse(`place detail of ${uids.length} uids is not cached`);
        }
      }
      const requests = Math.ceil(new Set(uids).size / PLACE_DETAIL_MAX_UIDS);
      if (spent('place') + requests > limits.place) refuse(`place detail of ${uids.length} uids`);
      return client.placeDetail(uids, opts);
    },
    routeMatrixWalking: (origins, destinations, opts) => {
      if (spent('routematrix_walking') + 50 > limits.routematrix_walking) refuse('routematrix');
      return client.routeMatrixWalking(origins, destinations, opts);
    },
  };
}
