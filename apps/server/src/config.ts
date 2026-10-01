import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBaiduConfig, type BaiduTier, type ConfigIssue } from '@zoudedao/baidu';

export type Mode = 'sample' | 'live';

export interface ServerConfig {
  host: string;
  port: number;
  mode: Mode;
  /** The Baidu setup as far as the server may know it: never the keys themselves. */
  baidu: {
    /** Server keys are usable (docs/api.md `live` condition), per @zoudedao/baidu. */
    live: boolean;
    tier: BaiduTier;
    /** SQLite file of the Baidu cache and quota ledger (BAIDU_CACHE_PATH, relative to the repo root). */
    cachePath: string;
    /** Chinese, key-free notes on the Baidu variables, logged at startup. */
    issues: readonly ConfigIssue[];
  };
  version: string;
  samplesDir: string;
  /** Official facility lists fused into live results (data/official/*.json). */
  officialDir: string;
  /** Built web app; served statically only when it contains index.html. */
  webDistDir: string;
  /**
   * SQLite file of the history (live analyses 30 days, what-if branches, walking routes forever):
   * ZDD_HISTORY_PATH, relative to the repo root; null = in memory only (ZDD_HISTORY_PATH=off).
   */
  historyPath: string | null;
  /** Fastify trustProxy: needed behind a reverse proxy, otherwise every client shares the proxy's IP. */
  trustProxy: boolean | number | string;
  /** Exact origins allowed to call /api cross-origin; empty = same-origin only. */
  corsOrigins: string[];
  rateLimit: {
    globalPerMinute: number;
    analyzePerHour: number;
    locatePerMinute: number;
    /** POST /api/ask per IP per 10 minutes; absent = 30 (template and LLM mode alike). */
    askPer10Min?: number;
    /** POST /api/whatif per IP per 10 minutes (each spends up to 30 routematrix routes); absent = 10. */
    whatifPer10Min?: number;
    /** GET /api/route lookups that need Baidu (one directionlite call each) per IP per 10 minutes; absent = 30. */
    routePer10Min?: number;
  };
  maxConcurrentAnalyses: number;
  analyzeTimeoutMs: number;
  locateTimeoutMs: number;
  /** Whole answer of POST /api/ask, LLM calls and tools included. */
  askTimeoutMs: number;
  /** One POST /api/whatif (one routematrix request); absent = 20 s. */
  whatifTimeoutMs?: number;
  /** One GET /api/route (one directionlite request); absent = 20 s. */
  routeTimeoutMs?: number;
  maxConcurrentAsks: number;
  /** Delay multiplier for the sample replay analyzer: 1 = realistic pacing, 0 = instant. */
  replayPace: number;
  logLevel: string;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

type Env = Readonly<Record<string, string | undefined>>;

const moduleDir = dirname(fileURLToPath(import.meta.url));

/** Walks up from this module to the pnpm workspace root, so src/ (tsx) and dist/ (node) agree. */
export function findRepoRoot(start: string = moduleDir): string {
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    if (dirname(dir) === dir) break;
  }
  // Deployed layout without the workspace file (Docker): <root>/apps/server/{src,dist}/config.*
  return resolve(moduleDir, '../../..');
}

/** Loads <root>/.env.local then <root>/.env; variables already set in the environment always win. */
export function loadEnvFiles(root: string): string[] {
  const loaded: string[] = [];
  for (const name of ['.env.local', '.env']) {
    const file = join(root, name);
    if (!existsSync(file)) continue;
    process.loadEnvFile(file);
    loaded.push(name);
  }
  return loaded;
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(moduleDir, '../package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function str(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function int(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = str(env, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} 应为 ${min}–${max} 之间的整数，当前为 "${raw}"`);
  }
  return value;
}

function readMode(env: Env, keysUsable: boolean): Mode {
  const raw = str(env, 'ZDD_MODE')?.toLowerCase();
  if (raw === undefined) return keysUsable ? 'live' : 'sample';
  if (raw === 'sample' || raw === 'live') return raw;
  throw new ConfigError(`ZDD_MODE 只能是 sample 或 live，当前为 "${raw}"`);
}

function readTrustProxy(env: Env): boolean | number | string {
  const raw = str(env, 'ZDD_TRUST_PROXY');
  if (raw === undefined || raw === 'false') return false;
  if (raw === 'true') return true;
  if (/^\d+$/.test(raw)) return Number(raw); // hop count
  return raw; // comma-separated addresses / CIDRs
}

/** ZDD_HISTORY_PATH: a file (relative to the repo root), or off / none / memory for no file. */
function readHistoryPath(env: Env, root: string): string | null {
  const raw = str(env, 'ZDD_HISTORY_PATH');
  if (raw === undefined) return join(root, 'data/cache/analyses.sqlite');
  if (/^(off|none|memory|false)$/i.test(raw)) return null;
  return resolve(root, raw);
}

function readPace(env: Env): number {
  const raw = str(env, 'ZDD_REPLAY_PACE');
  if (raw === undefined) return 1;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 10) {
    throw new ConfigError(`ZDD_REPLAY_PACE 应为 0–10 之间的数字，当前为 "${raw}"`);
  }
  return value;
}

export function loadConfig(env: Env = process.env, root: string = findRepoRoot()): ServerConfig {
  // Only the key-free parts of the Baidu config are kept; index.ts re-reads it to build the client.
  const { live, tier, cachePath, issues } = loadBaiduConfig(env, { cwd: root });
  const path = (name: string, fallback: string) => resolve(str(env, name) ?? fallback);
  return {
    host: str(env, 'HOST') ?? 'localhost',
    port: int(env, 'PORT', 8787, 0, 65535),
    mode: readMode(env, live),
    baidu: { live, tier, cachePath, issues },
    version: readVersion(),
    samplesDir: path('ZDD_SAMPLES_DIR', join(root, 'data/samples')),
    officialDir: path('ZDD_OFFICIAL_DIR', join(root, 'data/official')),
    webDistDir: path('ZDD_WEB_DIST', join(root, 'apps/web/dist')),
    historyPath: readHistoryPath(env, root),
    trustProxy: readTrustProxy(env),
    corsOrigins: (str(env, 'ZDD_CORS_ORIGINS') ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    rateLimit: {
      globalPerMinute: int(env, 'ZDD_RATE_LIMIT_PER_MINUTE', 300, 1, 1_000_000),
      analyzePerHour: int(env, 'ZDD_ANALYZE_PER_HOUR', 6, 1, 10_000),
      locatePerMinute: int(env, 'ZDD_LOCATE_PER_MINUTE', 30, 1, 10_000),
      ...(str(env, 'ZDD_ASK_PER_10MIN') === undefined
        ? {}
        : { askPer10Min: int(env, 'ZDD_ASK_PER_10MIN', 30, 1, 10_000) }),
      ...(str(env, 'ZDD_WHATIF_PER_10MIN') === undefined
        ? {}
        : { whatifPer10Min: int(env, 'ZDD_WHATIF_PER_10MIN', 10, 1, 10_000) }),
      ...(str(env, 'ZDD_ROUTE_PER_10MIN') === undefined
        ? {}
        : { routePer10Min: int(env, 'ZDD_ROUTE_PER_10MIN', 30, 1, 10_000) }),
    },
    maxConcurrentAnalyses: int(env, 'ZDD_MAX_CONCURRENT_ANALYSES', 2, 1, 100),
    analyzeTimeoutMs: int(env, 'ZDD_ANALYZE_TIMEOUT_S', 180, 5, 3600) * 1000,
    locateTimeoutMs: int(env, 'ZDD_LOCATE_TIMEOUT_S', 20, 1, 300) * 1000,
    askTimeoutMs: int(env, 'ZDD_ASK_TIMEOUT_S', 60, 5, 600) * 1000,
    ...(str(env, 'ZDD_WHATIF_TIMEOUT_S') === undefined
      ? {}
      : { whatifTimeoutMs: int(env, 'ZDD_WHATIF_TIMEOUT_S', 20, 1, 300) * 1000 }),
    ...(str(env, 'ZDD_ROUTE_TIMEOUT_S') === undefined
      ? {}
      : { routeTimeoutMs: int(env, 'ZDD_ROUTE_TIMEOUT_S', 20, 1, 300) * 1000 }),
    maxConcurrentAsks: int(env, 'ZDD_MAX_CONCURRENT_ASKS', 8, 1, 1000),
    replayPace: readPace(env),
    logLevel: str(env, 'LOG_LEVEL') ?? 'info',
  };
}
