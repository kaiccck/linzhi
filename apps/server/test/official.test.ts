import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadOfficialLists } from '../src/official.js';
import { REPO_ROOT } from './helpers.js';

describe('official facility lists', () => {
  it('loads the bundled 浦东 standardized-market list with coordinates', () => {
    const lists = loadOfficialLists(join(REPO_ROOT, 'data/official'));
    const markets = lists.find((l) => l.id === 'pudong-markets-2023q4');
    expect(markets).toMatchObject({ category: '菜市场', publisher: '上海市浦东新区商务委员会' });
    expect(markets!.entries).toHaveLength(196);
    expect(markets!.entries.filter((e) => e.status === 'active')).toHaveLength(171);
    const shenCheng = markets!.entries.find((e) => e.name === '浦商生鲜申城佳苑店');
    expect(shenCheng).toMatchObject({ address: '孙建路858号', status: 'active' });
    expect(shenCheng!.bd09).toHaveLength(2);
  });

  it('skips broken files with a Chinese warning and tolerates a missing directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zdd-official-'));
    try {
      writeFileSync(join(dir, 'bad.json'), '{ not json');
      writeFileSync(join(dir, 'shape.json'), JSON.stringify({ id: 'x' }));
      writeFileSync(join(dir, 'ok.json'), JSON.stringify({ id: 'ok', category: '药店', entries: [] }));
      const warnings: string[] = [];
      const lists = loadOfficialLists(dir, (m) => warnings.push(m));
      expect(lists.map((l) => l.id)).toEqual(['ok']);
      expect(warnings).toHaveLength(2);
      expect(warnings.join('\n')).toMatch(/已跳过/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(loadOfficialLists(join(dir, 'missing'))).toEqual([]);
  });
});
