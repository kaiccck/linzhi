import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, findRepoRoot, loadConfig } from '../src/config.js';
import { REPO_ROOT, SERVER_VERSION } from './helpers.js';

// Shaped like real keys (16–64 letters or digits) so @zoudedao/baidu does not flag their format.
const AK = 'TestServerAk0000000000000000abcd';
const SK = 'TestServerSk0000000000000000abcd';

describe('loadConfig', () => {
  it('defaults to sample mode and repo-relative paths without Baidu server keys', () => {
    const config = loadConfig({}, REPO_ROOT);
    expect(config).toMatchObject({
      mode: 'sample',
      port: 8787,
      version: SERVER_VERSION,
      baidu: {
        live: false,
        tier: 'personal',
        cachePath: join(REPO_ROOT, 'data/cache/baidu.sqlite'),
        issues: [],
      },
      samplesDir: join(REPO_ROOT, 'data/samples'),
      webDistDir: join(REPO_ROOT, 'apps/web/dist'),
      corsOrigins: [],
      trustProxy: false,
    });
  });

  it('switches to live exactly when @zoudedao/baidu finds usable server keys', () => {
    const mode = (env: Record<string, string>) => loadConfig(env, REPO_ROOT).mode;
    expect(mode({ BAIDU_SERVER_AK: AK, BAIDU_SERVER_SK: SK })).toBe('live');
    expect(mode({ BAIDU_SERVER_AK: AK, BAIDU_SERVER_AUTH: 'ip' })).toBe('live');
    expect(mode({ BAIDU_SERVER_AK: AK, BAIDU_SERVER_AUTH: 'sn' })).toBe('sample');
    expect(mode({ BAIDU_SERVER_SK: SK })).toBe('sample');
    // .env.example copied without editing
    expect(mode({ BAIDU_SERVER_AK: 'your_server_ak', BAIDU_SERVER_AUTH: 'ip' })).toBe('sample');
  });

  it('keeps the Baidu config issues, which explain rejected keys without quoting them', () => {
    const { baidu } = loadConfig({ BAIDU_SERVER_AK: AK, BAIDU_SERVER_AUTH: 'sn' }, REPO_ROOT);
    expect(baidu.live).toBe(false);
    expect(baidu.issues).toContainEqual(
      expect.objectContaining({
        level: 'error',
        key: 'BAIDU_SERVER_SK',
        message: expect.stringContaining('SN'),
      }),
    );
    expect(JSON.stringify(baidu.issues)).not.toContain(AK);
  });

  it('lets ZDD_MODE override the detection and rejects unknown modes', () => {
    expect(loadConfig({ ZDD_MODE: 'live' }, REPO_ROOT).mode).toBe('live');
    expect(loadConfig({ ZDD_MODE: 'sample', BAIDU_SERVER_AK: AK, BAIDU_SERVER_SK: SK }, REPO_ROOT).mode).toBe(
      'sample',
    );
    expect(() => loadConfig({ ZDD_MODE: 'demo' }, REPO_ROOT)).toThrow(ConfigError);
  });

  it('never keeps key values in the config object', () => {
    const config = loadConfig({ BAIDU_SERVER_AK: AK, BAIDU_SERVER_SK: SK, BAIDU_MATRIX_AK: AK }, REPO_ROOT);
    expect(config.baidu.live).toBe(true);
    const json = JSON.stringify(config);
    expect(json).not.toContain(AK);
    expect(json).not.toContain(SK);
  });

  it('resolves BAIDU_CACHE_PATH against the repo root, not the working directory', () => {
    expect(loadConfig({ BAIDU_CACHE_PATH: 'data/cache/other.sqlite' }, REPO_ROOT).baidu.cachePath).toBe(
      join(REPO_ROOT, 'data/cache/other.sqlite'),
    );
    expect(loadConfig({ BAIDU_CACHE_PATH: '/var/zdd/baidu.sqlite' }, REPO_ROOT).baidu.cachePath).toBe(
      '/var/zdd/baidu.sqlite',
    );
  });

  it('reads overrides and validates numbers', () => {
    const config = loadConfig(
      {
        PORT: '9000',
        ZDD_SAMPLES_DIR: 'some/samples',
        ZDD_TRUST_PROXY: '1',
        ZDD_CORS_ORIGINS: 'https://a.example, https://b.example',
        ZDD_ANALYZE_PER_HOUR: '3',
        ZDD_REPLAY_PACE: '0.2',
      },
      REPO_ROOT,
    );
    expect(config).toMatchObject({
      port: 9000,
      samplesDir: resolve('some/samples'),
      trustProxy: 1,
      corsOrigins: ['https://a.example', 'https://b.example'],
      rateLimit: { analyzePerHour: 3 },
      replayPace: 0.2,
    });
    expect(loadConfig({ ZDD_TRUST_PROXY: '10.0.0.0/8' }, REPO_ROOT).trustProxy).toBe('10.0.0.0/8');
    expect(() => loadConfig({ PORT: 'http' }, REPO_ROOT)).toThrow(ConfigError);
    expect(() => loadConfig({ ZDD_ANALYZE_PER_HOUR: '0' }, REPO_ROOT)).toThrow(ConfigError);
  });

  it('finds the workspace root from the package location', () => {
    expect(findRepoRoot()).toBe(REPO_ROOT);
  });
});
