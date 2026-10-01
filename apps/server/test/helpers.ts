import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AnalysisResult } from '@zoudedao/core';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppOptions } from '../src/app.js';
import { loadConfig, type ServerConfig } from '../src/config.js';

export const REPO_ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
export const SAMPLES_DIR = join(REPO_ROOT, 'data/samples');
export const SERVER_VERSION = (
  JSON.parse(readFileSync(join(REPO_ROOT, 'apps/server/package.json'), 'utf8')) as { version: string }
).version;

export const ANALYZE_BODY = {
  center_bd09: [121.644195, 31.19007],
  label: '孙环路 × 高木桥路',
  profile: 'adult',
};

/** Stand-in result for route tests that do not care about its contents. */
export const STUB_RESULT = { meta: { name: '测试' } } as unknown as AnalysisResult;

export function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    ...loadConfig({ ZDD_MODE: 'sample' }, REPO_ROOT),
    samplesDir: SAMPLES_DIR,
    webDistDir: resolve('/nonexistent/zdd-web-dist'), // deterministic even after the web app is built
    historyPath: null, // never the repo's data/cache/analyses.sqlite; history tests use a temp file
    logLevel: 'silent',
    replayPace: 0,
    ...overrides,
  };
}

export async function makeApp(
  overrides: Partial<ServerConfig> = {},
  deps: Omit<AppOptions, 'config'> = {},
): Promise<FastifyInstance> {
  const app = await buildApp({ config: testConfig(overrides), ...deps });
  await app.ready();
  return app;
}

export interface SseEvent {
  event: string;
  data: unknown;
}

export function parseSse(text: string): SseEvent[] {
  return text
    .split('\n\n')
    .map((block) => block.split('\n').filter((line) => line !== '' && !line.startsWith(':')))
    .filter((lines) => lines.length > 0)
    .map((lines) => ({
      event: lines.find((line) => line.startsWith('event: '))?.slice('event: '.length) ?? 'message',
      data: JSON.parse(
        lines
          .filter((line) => line.startsWith('data: '))
          .map((line) => line.slice('data: '.length))
          .join('\n'),
      ) as unknown,
    }));
}
