/**
 * The CLI as the operator runs it — arguments, keys check, SQLite cache and ledger, ceilings, exit
 * codes — with the network replaced by the synthetic city and the clock by a fixed date.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Scheduler } from '@zoudedao/baidu';
import { afterAll, describe, expect, it } from 'vitest';

import { cityTransport } from '../../engine/test/transport.js';
import { main, USAGE, type CliIO } from '../src/cli.js';
import {
  CITY_AREA,
  cleanupTempRoots,
  countingTransport,
  MATRIX_PATH,
  NOW,
  SHARED_CITY,
  tempRoot,
} from './fixtures.js';

afterAll(cleanupTempRoots);

/** Fake keys only: tests never see .env.local. */
const FAKE_ENV = {
  BAIDU_SERVER_AK: 'FakeServerAk0123456789abcdef0000',
  BAIDU_SERVER_SK: 'FakeServerSk0123456789abcdef0000',
  BAIDU_SERVER_AUTH: 'sn',
  BAIDU_MATRIX_AK: 'FakeMatrixAk0123456789abcdef0000',
  BAIDU_TIER: 'personal',
};

function cli(root: string, env: Record<string, string> = FAKE_ENV) {
  const out: string[] = [];
  const err: string[] = [];
  const transport = countingTransport(cityTransport(SHARED_CITY));
  const io: CliIO = {
    env: { ...env, BAIDU_CACHE_PATH: join(root, 'cache.sqlite') },
    cwd: root,
    repo: root,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    areas: { T: CITY_AREA },
    client: {
      transport,
      scheduler: new Scheduler({ tier: 'personal', sleep: () => Promise.resolve(), random: () => 0 }),
    },
    now: NOW,
    sigint: false,
  };
  return { out, err, transport, io, run: (...argv: string[]) => main(argv, io) };
}

describe('CLI', () => {
  it('plan prints the steps, the totals and the ceilings to use, and writes nothing', async () => {
    const root = tempRoot();
    const c = cli(root);
    expect(await c.run('plan', 't')).toBe(0);
    const text = c.out.join('\n');
    expect(text).toContain('区域 T：临河测试城');
    expect(text).toMatch(/合计\s+3,280\s+2,148\s+48/);
    expect(text).toContain('建议：run T --max-routes 2148 --max-walks 6');
    expect(await c.run('plan', 'T', '--json', '--steps', 'reference', '--radius', '1200')).toBe(0);
    const plan = JSON.parse(c.out[c.out.length - 1]!) as {
      totals: { billed: number };
      reference: { points: number };
    };
    expect(plan.reference.points).toBe(440);
    expect(plan.totals.billed).toBe(440);
    expect(existsSync(join(root, 'research'))).toBe(false);
    expect(c.transport.paths).toHaveLength(0);
  });

  it('run without keys stops before touching the cache or the network', async () => {
    const root = tempRoot();
    const c = cli(root, {});
    expect(await c.run('run', 'T')).toBe(2);
    expect(c.err.join('\n')).toMatch(/没有可用的 Key/);
    expect(existsSync(join(root, 'cache.sqlite'))).toBe(false);
    expect(c.transport.paths).toHaveLength(0);
  });

  it('run stops at --max-routes (exit 3), the rerun continues under the default ceiling, score reads the files', async () => {
    const root = tempRoot();
    const first = cli(root);
    expect(await first.run('run', 'T', '--steps', 'reference', '--max-routes', '120')).toBe(3);
    const text = first.out.join('\n');
    expect(text).toContain('本次上限：批量算路 120 条');
    expect(text).toContain('本次计费：批量算路 100 条（上限 120）');
    expect(text).toMatch(/未完成：reference：.*上限 120/);
    expect(first.transport.routesSent).toBe(100);
    expect(existsSync(join(root, 'cache.sqlite'))).toBe(true);

    const second = cli(root);
    expect(await second.run('run', 'T')).toBe(0);
    const log = second.out.join('\n');
    expect(log).toContain('待测 696 点');
    // without --dir the artefacts go to <repo>/research/eval/<area>/
    expect(log).toContain('产物目录：research/eval/T');
    expect(log).toContain('完成：结果见 research/eval/T/results.md');
    // the default ceiling is the plan of what was left; the run stays within it
    const cap = Number(/本次上限：批量算路 (\d+) 条/.exec(log)![1]);
    const billed = Number(/本次计费：批量算路 (\d+) 条/.exec(log)![1]);
    expect(cap).toBe(2148 - 100);
    expect(billed).toBeLessThanOrEqual(cap);
    expect(second.transport.routesSent).toBe(billed);
    expect(second.transport.count(MATRIX_PATH)).toBeGreaterThan(0);
    for (const f of ['reference.json', 'results.json', 'results.md', 'accuracy-quota.svg', 'overlay.svg'])
      expect(existsSync(join(root, 'research', 'eval', 'T', f)), f).toBe(true);

    const third = cli(root);
    expect(await third.run('score', 'T')).toBe(0);
    expect(third.out.some((l) => /^engine@700 +路线 +700 +IoU 0\.9\d\d/.test(l))).toBe(true);
    expect(third.out.some((l) => l.startsWith('circle '))).toBe(true);
    expect(third.transport.paths).toHaveLength(0);
  });

  it('prints usage for a missing command and rejects bad arguments with a Chinese message', async () => {
    const root = tempRoot();
    const c = cli(root);
    expect(await c.run()).toBe(1);
    expect(c.out[0]).toBe(USAGE);
    expect(await c.run('--help')).toBe(0);
    await expect(c.run('plan', 'X')).rejects.toThrow(/未知区域 X/);
    await expect(c.run('plan', 'T', '--steps', 'reference,bogus')).rejects.toThrow(/未知步骤 bogus/);
    await expect(c.run('run', 'T', '--max-routes', '-5')).rejects.toThrow(/--max-routes/);
    await expect(c.run('plan', 'T', '--budgets', '100,abc')).rejects.toThrow(/--budgets/);
  });
});
