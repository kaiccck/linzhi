import { readFileSync } from 'node:fs';
import type { AnalysisResult } from '@zoudedao/core';
import { describe, expect, it } from 'vitest';
import { createAdvisor } from '../src/advisor.js';
import { AnchorBook, communityCodes, type Anchor } from '../src/anchors.js';
import { frameOf, headline } from '../src/analysis.js';
import { LocalBackend } from '../src/backend.js';
import { createToolRegistry } from '../src/tools/registry.js';
import { SAMPLES_DIR, localCtx, zjA } from './helpers.js';

const reg = createToolRegistry();
const zjB = () => JSON.parse(readFileSync(`${SAMPLES_DIR}zj-b.json`, 'utf8')) as AnalysisResult;
const of = <T extends Anchor['type']>(anchors: readonly Anchor[] | undefined, type: T) =>
  (anchors ?? []).filter((a): a is Extract<Anchor, { type: T }> => a.type === type);

describe('community codes (the web map codes)', () => {
  it('numbers communities north to south, then west to east, with the sample letter', () => {
    const r = zjA();
    const codes = communityCodes(r, 'zj-a');
    expect(new Set(codes).size).toBe(r.communities.length);
    const north = r.communities.reduce((a, c) => (c.centroid[1] > a.centroid[1] ? c : a));
    expect(codes[r.communities.indexOf(north)]).toBe('A-01');
    const byCode = r.communities
      .map((c, i) => ({ c, code: codes[i]! }))
      .sort((a, b) => a.code.localeCompare(b.code));
    for (let k = 1; k < byCode.length; k++) {
      expect(byCode[k - 1]!.c.centroid[1]).toBeGreaterThanOrEqual(byCode[k]!.c.centroid[1]);
    }
    expect(communityCodes(r, 'zj-a~elder')).toEqual(codes);
    expect(communityCodes(r, 'live-1a2b3c4d')[0]).toMatch(/^A-\d\d$/);
    expect(communityCodes(zjB(), 'zj-b').every((c) => /^B-\d\d$/.test(c))).toBe(true);
  });

  it('anchors carry XY in the analysis frame and the matching BD-09, once each, capped', () => {
    const r = zjA();
    const book = new AnchorBook(r, 'zj-a', 3);
    const c = r.communities[0]!;
    book.community(c.name).community(c.name).communityAt(1).grayAreas().poi({ name: 'nope' });
    expect(book.anchors).toHaveLength(3);
    const first = book.anchors[0] as Extract<Anchor, { type: 'community' }>;
    expect(first).toMatchObject({ type: 'community', analysis_id: 'zj-a', name: c.name });
    const [lng, lat] = first.bd09;
    const [x, y] = frameOf(r.meta).toXY(lng, lat);
    expect(Math.hypot(x - c.centroid[0], y - c.centroid[1])).toBeLessThan(0.2);
    expect(first.xy[0]).toBeCloseTo(c.centroid[0], 1);
  });
});

describe('tool results carry anchors', () => {
  it('analyze_life_circle: 灰色区域 layers, the communities with verified gaps, the nearest facilities', async () => {
    const r = await reg.run('analyze_life_circle', { analysis_id: 'zj-a' }, localCtx());
    const gray = of(r.anchors, 'gray_area');
    expect(gray.map((g) => g.id)).toEqual((zjA().gray_areas ?? []).map((g) => `${g.kind}-${g.min_missing}`));
    expect(gray[0]).toMatchObject({ analysis_id: 'zj-a', index: 0, area_m2: expect.any(Number) });
    const withGaps = new Set(
      zjA()
        .communities.filter((c) =>
          Object.values(c.checks).some((k) => k.verified && k.status_main !== '覆盖'),
        )
        .map((c) => c.name),
    );
    expect(headline(zjA()).walking_gaps).toBeGreaterThan(0);
    expect(new Set(of(r.anchors, 'community').map((c) => c.name))).toEqual(withGaps);
    const pois = of(r.anchors, 'poi');
    expect(pois.map((p) => p.name)).toContain('医保药店(高木桥路店)');
    expect(pois.every((p) => p.uid && p.bd09.length === 2)).toBe(true);
    expect(r.anchors!.length).toBeLessThanOrEqual(40);
  });

  it('list_service_gaps: each gap community and the facility its walk reaches; a named community first', async () => {
    const r = await reg.run('list_service_gaps', { analysis_id: 'zj-a', category: '菜市场' }, localCtx());
    const data = r.data as { gaps: { community: string; via: string | null }[] };
    expect(data.gaps.length).toBeGreaterThan(0);
    const communities = of(r.anchors, 'community').map((c) => c.name);
    for (const g of data.gaps) expect(communities).toContain(g.community);
    const pois = of(r.anchors, 'poi').map((p) => p.name);
    for (const g of data.gaps) if (g.via) expect(pois).toContain(g.via);

    const one = await reg.run(
      'list_service_gaps',
      { analysis_id: 'zj-a', community: '申城佳苑一期A块' },
      localCtx(),
    );
    expect(one.anchors?.[0]).toMatchObject({ type: 'community', name: '申城佳苑一期A块', code: /^A-\d\d$/ });
    expect(of(one.anchors, 'community').map((c) => c.name)).toEqual(['申城佳苑一期A块']);
  });

  it('simulate_facility: the new site first', async () => {
    const r = await reg.run(
      'simulate_facility',
      { analysis_id: 'zj-a', category: '药店', near_community: '川杨新苑四期' },
      localCtx(),
    );
    expect(r.anchors?.[0]).toMatchObject({ type: 'site', analysis_id: 'zj-a', label: '川杨新苑四期旁' });
  });

  it('tools about no place in particular carry none', async () => {
    const r = await reg.run('get_isochrone', { analysis_id: 'zj-a' }, localCtx());
    expect(r.anchors ?? []).toEqual([]);
  });

  it('the advisor puts each result’s anchors on its citation', async () => {
    const advisor = createAdvisor({ backend: new LocalBackend({ samplesDir: SAMPLES_DIR }), llm: null });
    const a = await advisor.ask('老人买菜方便吗？', { analysisId: 'zj-a' });
    expect(a.citations.map((c) => c.tool)).toEqual(['analyze_life_circle', 'list_service_gaps']);
    for (const c of a.citations) expect(Array.isArray(c.anchors)).toBe(true);
    const gaps = a.citations[1]!;
    expect(of(gaps.anchors, 'community').length).toBeGreaterThan(0);
    expect(gaps.anchors.every((x) => x.analysis_id === 'zj-a~elder')).toBe(true);
  });
});
