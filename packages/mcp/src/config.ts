/**
 * Where the MCP server gets its analyses: a running 邻至 server (ZDD_API_URL, live analyses when it
 * has Baidu keys) or the repository's sample files (no server, no keys).
 */
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpBackend, LocalBackend, type ZddBackend } from '@zoudedao/agent';

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Samples directory: --samples, then ZDD_SAMPLES_DIR, then the repository's data/samples next to this
 * package (src/ and dist/ sit at the same depth), then ./data/samples. The first existing one wins;
 * with none existing the first candidate is returned so messages can name it.
 */
export function resolveSamplesDir(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  const candidates = [
    explicit,
    env.ZDD_SAMPLES_DIR,
    fileURLToPath(new URL('../../../data/samples/', import.meta.url)),
    resolve(process.cwd(), 'data/samples'),
  ].filter((c): c is string => !!c && c.trim().length > 0);
  return resolve(candidates.find(isDir) ?? candidates[0]!);
}

export interface BackendChoice {
  backend: ZddBackend;
  /** Chinese one-liner for the startup log. */
  describe: string;
}

export function createBackend(
  opts: { api?: string; samples?: string },
  env: NodeJS.ProcessEnv = process.env,
): BackendChoice {
  const api = opts.api ?? env.ZDD_API_URL?.trim();
  if (api) {
    return { backend: new HttpBackend(api), describe: `邻至服务 ${api.replace(/\/+$/, '')}` };
  }
  const dir = resolveSamplesDir(opts.samples, env);
  return { backend: new LocalBackend({ samplesDir: dir }), describe: `本地样例目录 ${dir}` };
}

/** Version of this package (read at runtime so src/ and dist/ agree). */
export function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
