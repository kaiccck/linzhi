import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyExclusions, type FacilityCategory, type Poi } from '@zoudedao/core';
import { describe, expect, it } from 'vitest';
import { loadOfficialData, loadOfficialLists } from '../src/official.js';
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

  it('loads facility lists, catchment tables and exclusions from data/official', () => {
    const data = loadOfficialData(join(REPO_ROOT, 'data/official'));
    expect(data.lists.map((l) => l.id).sort()).toEqual([
      'pudong-markets-2023q4',
      'pudong-schools-2026',
      'shanghai-community-health',
    ]);
    const schools = data.lists.find((l) => l.id === 'pudong-schools-2026')!;
    expect(schools).toMatchObject({
      category: '小学',
      publisher: '上海市浦东新区教育局',
      published: '2026-04-07',
    });
    expect(schools.entries).toHaveLength(267);
    expect(schools.entries.filter((e) => e.status === 'active')).toHaveLength(263);
    expect(schools.entries.find((e) => e.name === '上海市浦东新区孙桥小学（张江校区）')).toMatchObject({
      code: '3101150090',
      address: '张江路1615号',
      sector: '公办',
    });
    expect(schools.entries.some((e) => e.name.includes('育华'))).toBe(false);
    const health = data.lists.find((l) => l.id === 'shanghai-community-health')!;
    expect(health).toMatchObject({ category: '社区卫生', publisher: '上海市卫生健康委员会' });
    expect(health.entries).toHaveLength(46);
    expect(health.entries.find((e) => e.name === '张江社区卫生服务中心')).toMatchObject({
      address: '益江路458号',
    });
    expect(data.catchments.map((c) => c.id)).toEqual(['pudong-catchment-2025']);
    const catchment = data.catchments[0]!;
    expect(catchment.coverage?.towns).toEqual(['张江镇']);
    expect(catchment.schools.reduce((n, s) => n + s.entries.length, 0)).toBe(232);
    expect(data.exclusions[0]).toEqual(
      expect.objectContaining({
        category: '小学',
        uid: '593850fb69993a5cdf1e527e',
        name: '上海市浦东新区育华学校(雪英校区)',
        source: 'https://www.pudong.gov.cn/zwgk/ywjy-jyjzdgz/2026/97/354049.html',
      }),
    );
    // name patterns: every entry carries its reason, source and date
    const patterns = data.exclusions.filter((x) => x.name_pattern);
    expect(patterns.map((x) => x.name_pattern)).toEqual([
      '^叮咚买菜(?!.*(?:奥莱|黑钻))',
      '^美团买菜',
      '^(?:美团)?小象超市.*(?:站|仓)\\)?$',
      '^每日优鲜',
    ]);
    for (const x of patterns) {
      expect(x.category).toEqual(['生鲜超市', '超市', '菜市场']);
      expect(x.reason).toMatch(/前置仓|便民服务站/);
      expect(x.source).toMatch(/^https:\/\//);
      expect(x.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('excludes the delivery stations Baidu tags 生鲜超市, never a walk-in store', () => {
    const { exclusions } = loadOfficialData(join(REPO_ROOT, 'data/official'));
    const poi = (name: string, cat: FacilityCategory = '生鲜超市'): Poi => ({
      uid: `u-${name}`,
      name,
      cat,
      xy: [0, 0],
      navi_xy: null,
      source: 'baidu',
    });
    // Baidu's own names around 张江 (data/cache, 2026-09-28) and the brands' stores elsewhere
    const stations = [
      poi('叮咚买菜(孙桥站)'),
      poi('每日优鲜(唐镇店)'),
      poi('叮咚买菜（张江站）', '超市'),
      poi('美团买菜(峨山路站)'),
      poi('小象超市(张江站)'),
      poi('美团小象超市(孙桥站)', '菜市场'),
    ];
    const stores = [
      '盒马鲜生(长泰广场店)',
      '盒马鲜生(恒生万鹂店)',
      '叮咚奥莱(九里亭店)',
      '小象超市(华联万柳店)',
      '清美生鲜(创新西路店)',
      '如海生鲜超市(中科路店)',
      '浦商生鲜(环西店)',
      '优品生鲜(孙桥菜场店)',
      '农鲜生活(碧波路生鲜超市)',
      '明康汇生鲜菜市(上海东塘苑店)',
      '海翔生鲜超市',
    ].map((n) => poi(n));
    const out = applyExclusions([...stations, ...stores], exclusions);
    expect(out.excluded.map((e) => e.name)).toEqual(stations.map((p) => p.name));
    expect(out.pois.map((p) => p.name)).toEqual(stores.map((p) => p.name));
    // a pharmacy or school with such a name is not the pattern's business
    expect(applyExclusions([poi('叮咚买菜(孙桥站)', '药店')], exclusions).excluded).toEqual([]);
  });

  it('skips catchment tables, exclusions and kinds it cannot read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zdd-official-'));
    try {
      writeFileSync(join(dir, 'a.json'), JSON.stringify({ kind: 'catchment', id: 'c' }));
      writeFileSync(join(dir, 'b.json'), JSON.stringify({ kind: 'exclusions' }));
      writeFileSync(
        join(dir, 'c.json'),
        JSON.stringify({
          kind: 'exclusions',
          entries: [
            { category: '小学' },
            { category: '小学', uid: 'u', reason: 'r', source: 's', date: 'd' },
            { category: ['生鲜超市'], name_pattern: '(', reason: 'r', source: 's', date: 'd' },
            { category: ['生鲜超市', '超市'], name_pattern: '^前置仓', reason: 'r', source: 's', date: 'd' },
            { category: '超市', name_pattern: '^x', source: 's', date: 'd' },
          ],
        }),
      );
      writeFileSync(join(dir, 'd.json'), JSON.stringify({ kind: 'weird', id: 'w' }));
      const warnings: string[] = [];
      const data = loadOfficialData(dir, (m) => warnings.push(m));
      expect(data).toEqual({
        lists: [],
        catchments: [],
        exclusions: [
          expect.objectContaining({ uid: 'u' }),
          expect.objectContaining({ name_pattern: '^前置仓' }),
        ],
      });
      expect(warnings).toHaveLength(6);
      expect(warnings.every((w) => /跳过/.test(w))).toBe(true);
      expect(warnings.join('\n')).toMatch(/第 3 条：name_pattern 不是有效的正则表达式/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
