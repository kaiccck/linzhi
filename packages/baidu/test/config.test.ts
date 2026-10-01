import { describe, expect, it } from 'vitest';
import {
  authModes,
  BaiduConfigError,
  loadBaiduConfig,
  QuotaLedger,
  replayConfig,
  requireAuth,
} from '../src/index.js';
import { FAKE_ENV } from './helpers.js';

const AK = FAKE_ENV.BAIDU_SERVER_AK;
const SK = FAKE_ENV.BAIDU_SERVER_SK;
const MATRIX = FAKE_ENV.BAIDU_MATRIX_AK;

describe('loadBaiduConfig', () => {
  it('SN server key + IP-whitelist matrix key (the measured working setup)', () => {
    const cfg = loadBaiduConfig({ ...FAKE_ENV });
    expect(cfg.live).toBe(true);
    expect(cfg.serverAuth).toBe('sn');
    expect(cfg.auth.geocoding).toEqual({ mode: 'sn', ak: AK, sk: SK, akVar: 'BAIDU_SERVER_AK' });
    expect(cfg.auth.routematrix_walking).toEqual({ mode: 'ip', ak: MATRIX, akVar: 'BAIDU_MATRIX_AK' });
    expect(cfg.issues).toEqual([]);
    expect(authModes(cfg)).toEqual({
      geocoding: 'sn',
      reverse_geocoding: 'sn',
      geoconv: 'sn',
      place: 'sn',
      routematrix_walking: 'ip',
      directionlite_walking: 'sn',
    });
  });

  it('IP mode sends everything unsigned and ignores the SK', () => {
    const cfg = loadBaiduConfig({ BAIDU_SERVER_AK: AK, BAIDU_SERVER_SK: SK, BAIDU_SERVER_AUTH: 'IP' });
    expect(cfg.serverAuth).toBe('ip');
    expect(cfg.auth.place).toEqual({ mode: 'ip', ak: AK, akVar: 'BAIDU_SERVER_AK' });
    expect(cfg.auth.routematrix_walking).toEqual(cfg.auth.place);
    expect(cfg.issues.map((i) => i.key)).toEqual(['BAIDU_SERVER_SK']);
  });

  it('SN mode without SK is unusable, with a Chinese fix hint', () => {
    const cfg = loadBaiduConfig({ BAIDU_SERVER_AK: AK, BAIDU_SERVER_AUTH: 'sn' });
    expect(cfg.live).toBe(false);
    expect(cfg.issues[0]).toMatchObject({ level: 'error', key: 'BAIDU_SERVER_SK' });
    expect(() => requireAuth(cfg, 'geocoding')).toThrow(BaiduConfigError);
    try {
      requireAuth(cfg, 'geocoding');
    } catch (e) {
      expect((e as BaiduConfigError).hint).toContain('BAIDU_SERVER_AUTH=ip');
    }
  });

  it('infers SN from a present SK and rejects an unknown mode', () => {
    expect(loadBaiduConfig({ BAIDU_SERVER_AK: AK, BAIDU_SERVER_SK: SK }).serverAuth).toBe('sn');
    const bad = loadBaiduConfig({ BAIDU_SERVER_AK: AK, BAIDU_SERVER_SK: SK, BAIDU_SERVER_AUTH: 'token' });
    expect(bad.live).toBe(false);
    expect(bad.issues.some((i) => i.level === 'error' && i.key === 'BAIDU_SERVER_AUTH')).toBe(true);
  });

  it('treats .env.example placeholders as missing (sample mode)', () => {
    const cfg = loadBaiduConfig({
      BAIDU_SERVER_AK: 'your_server_ak',
      BAIDU_SERVER_SK: '',
      BAIDU_SERVER_AUTH: 'sn',
    });
    expect(cfg.live).toBe(false);
    expect(Object.values(cfg.auth).every((a) => a === null)).toBe(true);
    expect(cfg.issues[0]?.message).toContain('占位符');
  });

  it('routematrix falls back to the SN server key with a warning when no matrix key is set', () => {
    const cfg = loadBaiduConfig({ BAIDU_SERVER_AK: AK, BAIDU_SERVER_SK: SK, BAIDU_SERVER_AUTH: 'sn' });
    expect(cfg.auth.routematrix_walking?.mode).toBe('sn');
    expect(cfg.issues.find((i) => i.key === 'BAIDU_MATRIX_AK')?.message).toContain('211');
  });

  it('a matrix key alone enables batch routing but not live mode', () => {
    const cfg = loadBaiduConfig({ BAIDU_MATRIX_AK: MATRIX });
    expect(cfg.live).toBe(false);
    expect(cfg.auth.routematrix_walking?.ak).toBe(MATRIX);
    expect(cfg.auth.geocoding).toBeNull();
  });

  it('parses the tier and resolves the cache path against cwd', () => {
    expect(loadBaiduConfig({ BAIDU_TIER: 'Enterprise' }).tier).toBe('enterprise');
    const odd = loadBaiduConfig({ BAIDU_TIER: 'gold' });
    expect(odd.tier).toBe('personal');
    expect(odd.issues[0]?.key).toBe('BAIDU_TIER');
    expect(loadBaiduConfig({}, { cwd: '/srv/app' }).cachePath).toBe('/srv/app/data/cache/baidu.sqlite');
    expect(loadBaiduConfig({ BAIDU_CACHE_PATH: '/var/zdd/c.sqlite' }).cachePath).toBe('/var/zdd/c.sqlite');
  });

  it('warns about malformed keys without rejecting them', () => {
    const cfg = loadBaiduConfig({ BAIDU_SERVER_AK: 'abc-def', BAIDU_SERVER_AUTH: 'ip' });
    expect(cfg.live).toBe(true);
    expect(cfg.issues[0]).toMatchObject({ level: 'warn', key: 'BAIDU_SERVER_AK' });
  });

  it('reads the limits Baidu raised (BAIDU_DAILY_LIMITS) until their last day, Beijing time', () => {
    const env = { BAIDU_DAILY_LIMITS: 'place=5000, reverse_geocoding=5000, until=2026-10-11' };
    // 2026-10-11 23:30 in Beijing is still the raise's last day
    const lastDay = Date.parse('2026-10-11T15:30:00Z');
    const cfg = loadBaiduConfig(env, { now: () => lastDay });
    expect(cfg.limits).toEqual({ place: 5000, reverse_geocoding: 5000 });
    expect(cfg.issues).toEqual([]);
    expect(new QuotaLedger({ tier: cfg.tier, limits: cfg.limits }).limit('place')).toBe(5000);
    // the next day the tier's limits are back, and the config says why
    const after = loadBaiduConfig(env, { now: () => Date.parse('2026-10-11T16:30:00Z') });
    expect(after.limits).toEqual({});
    expect(after.issues[0]).toMatchObject({ level: 'warn', key: 'BAIDU_DAILY_LIMITS' });
    expect(loadBaiduConfig({}).limits).toEqual({});
  });

  it('skips unknown services and malformed values of BAIDU_DAILY_LIMITS with a warning', () => {
    const cfg = loadBaiduConfig({ BAIDU_DAILY_LIMITS: 'place=5000;isochrone=10;geocoding=lots;until=soon' });
    expect(cfg.limits).toEqual({ place: 5000 });
    expect(cfg.issues.map((i) => i.key)).toEqual([
      'BAIDU_DAILY_LIMITS',
      'BAIDU_DAILY_LIMITS',
      'BAIDU_DAILY_LIMITS',
    ]);
  });

  it('replay config carries fake keys only', () => {
    const cfg = replayConfig('enterprise');
    expect(cfg.tier).toBe('enterprise');
    expect(cfg.live).toBe(false);
    expect(cfg.auth.place).toEqual({ mode: 'ip', ak: 'replay', akVar: 'BAIDU_SERVER_AK' });
  });
});
