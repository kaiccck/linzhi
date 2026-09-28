/**
 * Environment → per-service credentials (技术设计文档 §4.1).
 *
 * Measured 2026-09-26: routematrix/v2 answers 211 to every SN signature that the other five services
 * accept, so batch routing can use its own IP-whitelist key (BAIDU_MATRIX_AK). Everything else follows
 * BAIDU_SERVER_AUTH, because a judge's key may be in either mode.
 */
import { resolve } from 'node:path';
import { BaiduConfigError } from './errors.js';
import { BAIDU_SERVICES, SERVICE_LABEL, type AuthMode, type BaiduService, type BaiduTier } from './types.js';

export type AkVar = 'BAIDU_SERVER_AK' | 'BAIDU_MATRIX_AK';

export type ServiceAuth =
  | { readonly mode: 'sn'; readonly ak: string; readonly sk: string; readonly akVar: AkVar }
  | { readonly mode: 'ip'; readonly ak: string; readonly akVar: AkVar };

export interface ConfigIssue {
  level: 'error' | 'warn';
  key: string;
  message: string;
}

export interface BaiduConfig {
  readonly tier: BaiduTier;
  /** Resolved mode of BAIDU_SERVER_AK; null when it is missing or unusable. */
  readonly serverAuth: AuthMode | null;
  /** Credentials per service; null = the service cannot be called. */
  readonly auth: Readonly<Record<BaiduService, ServiceAuth | null>>;
  /** True when the server AK is usable, i.e. arbitrary places can be analysed (docs/api.md `live`). */
  readonly live: boolean;
  /** SQLite file shared by the cache and the quota ledger. */
  readonly cachePath: string;
  readonly issues: readonly ConfigIssue[];
}

export type Env = Readonly<Record<string, string | undefined>>;

export const DEFAULT_CACHE_PATH = 'data/cache/baidu.sqlite';

// .env.example ships placeholders such as `your_server_ak`; treat them as "not configured".
const PLACEHOLDER = /^(your[_-]|<|x{3,}|\*+$)/i;
const KEY_SHAPE = /^[A-Za-z0-9]{16,64}$/;

function readKey(env: Env, name: string, issues: ConfigIssue[]): string | null {
  const raw = env[name]?.trim();
  if (!raw) return null;
  if (PLACEHOLDER.test(raw)) {
    issues.push({ level: 'warn', key: name, message: `${name} 仍是示例占位符，按未配置处理` });
    return null;
  }
  if (!KEY_SHAPE.test(raw)) {
    issues.push({ level: 'warn', key: name, message: `${name} 格式看起来不对（应为 16–64 位字母或数字）` });
  }
  return raw;
}

function readTier(env: Env, issues: ConfigIssue[]): BaiduTier {
  const raw = env.BAIDU_TIER?.trim().toLowerCase();
  if (!raw || raw === 'personal') return 'personal';
  if (raw === 'enterprise') return 'enterprise';
  issues.push({
    level: 'warn',
    key: 'BAIDU_TIER',
    message: `BAIDU_TIER=${raw} 无法识别，按 personal（个人认证）处理`,
  });
  return 'personal';
}

export interface LoadConfigOptions {
  /** Base for a relative BAIDU_CACHE_PATH (default: process.cwd()). */
  cwd?: string;
}

export function loadBaiduConfig(env: Env = process.env, opts: LoadConfigOptions = {}): BaiduConfig {
  const issues: ConfigIssue[] = [];
  const serverAk = readKey(env, 'BAIDU_SERVER_AK', issues);
  const sk = readKey(env, 'BAIDU_SERVER_SK', issues);
  const matrixAk = readKey(env, 'BAIDU_MATRIX_AK', issues);
  const tier = readTier(env, issues);

  const authRaw = env.BAIDU_SERVER_AUTH?.trim().toLowerCase() ?? '';
  let mode: AuthMode | null = null;
  if (authRaw === 'sn' || authRaw === 'ip') mode = authRaw;
  else if (authRaw === '') mode = sk ? 'sn' : null;
  else {
    issues.push({
      level: 'error',
      key: 'BAIDU_SERVER_AUTH',
      message: `BAIDU_SERVER_AUTH 只能是 sn 或 ip，当前为 ${authRaw}`,
    });
  }

  let server: ServiceAuth | null = null;
  if (serverAk) {
    if (mode === 'ip') {
      server = { mode: 'ip', ak: serverAk, akVar: 'BAIDU_SERVER_AK' };
      if (sk)
        issues.push({
          level: 'warn',
          key: 'BAIDU_SERVER_SK',
          message: 'BAIDU_SERVER_AUTH=ip 时不使用 BAIDU_SERVER_SK',
        });
    } else if (mode === 'sn' && sk) {
      server = { mode: 'sn', ak: serverAk, sk, akVar: 'BAIDU_SERVER_AK' };
    } else if (mode === 'sn' || authRaw === '') {
      issues.push({
        level: 'error',
        key: 'BAIDU_SERVER_SK',
        message: 'SN 模式需要 BAIDU_SERVER_SK；若服务端 AK 是 IP 白名单模式，请设置 BAIDU_SERVER_AUTH=ip',
      });
    }
  } else if (sk) {
    issues.push({
      level: 'warn',
      key: 'BAIDU_SERVER_AK',
      message: '已配置 BAIDU_SERVER_SK，但缺少 BAIDU_SERVER_AK',
    });
  }

  const matrix: ServiceAuth | null = matrixAk
    ? { mode: 'ip', ak: matrixAk, akVar: 'BAIDU_MATRIX_AK' }
    : server;
  if (!matrixAk && server?.mode === 'sn') {
    issues.push({
      level: 'warn',
      key: 'BAIDU_MATRIX_AK',
      message: '批量算路在 SN 模式下实测始终返回 211；建议另配 IP 白名单模式的 BAIDU_MATRIX_AK',
    });
  }

  const auth = Object.fromEntries(
    BAIDU_SERVICES.map((s) => [s, s === 'routematrix_walking' ? matrix : server]),
  ) as Record<BaiduService, ServiceAuth | null>;

  return {
    tier,
    serverAuth: server?.mode ?? null,
    auth,
    live: server !== null,
    cachePath: resolve(opts.cwd ?? process.cwd(), env.BAIDU_CACHE_PATH?.trim() || DEFAULT_CACHE_PATH),
    issues,
  };
}

/** Credentials for one service, or a BaiduConfigError that says which variable to set. */
export function requireAuth(config: BaiduConfig, service: BaiduService): ServiceAuth {
  const auth = config.auth[service];
  if (auth) return auth;
  const hint =
    service === 'routematrix_walking'
      ? '批量算路需要 BAIDU_MATRIX_AK（IP 白名单），或可用的 BAIDU_SERVER_AK'
      : '在 .env.local 中配置 BAIDU_SERVER_AK，并配置 BAIDU_SERVER_SK（SN 模式）或 BAIDU_SERVER_AUTH=ip';
  throw new BaiduConfigError(`${SERVICE_LABEL[service]}没有可用的 Key`, { service, hint });
}

/** Auth mode per service for /api/health; never exposes key material. */
export function authModes(config: BaiduConfig): Record<BaiduService, AuthMode | null> {
  return Object.fromEntries(BAIDU_SERVICES.map((s) => [s, config.auth[s]?.mode ?? null])) as Record<
    BaiduService,
    AuthMode | null
  >;
}

/** Offline config for replay mode: fake keys that never leave the process. */
export function replayConfig(tier: BaiduTier = 'personal', cachePath = ':memory:'): BaiduConfig {
  const fake: ServiceAuth = { mode: 'ip', ak: 'replay', akVar: 'BAIDU_SERVER_AK' };
  const auth = Object.fromEntries(BAIDU_SERVICES.map((s) => [s, fake])) as Record<BaiduService, ServiceAuth>;
  return { tier, serverAuth: 'ip', auth, live: false, cachePath, issues: [] };
}
