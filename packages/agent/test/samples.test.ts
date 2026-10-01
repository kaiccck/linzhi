/**
 * Every tool on every sample in data/samples: the hand-built zj-a and the engine's live-mode results
 * (no community outlines, explicit route_basis, gray areas and siting suggestions of their own). All
 * of them check 幼儿园、小学、菜市场、药店、社区卫生 per community.
 */
import { readdirSync } from 'node:fs';
import { HARD_CATEGORIES } from '@zoudedao/core';
import { describe, expect, it } from 'vitest';
import { checkGrounding, entityNames } from '../src/grounding.js';
import type { FeatureCollection } from '../src/geo.js';
import { createToolRegistry } from '../src/tools/registry.js';
import type { Overview } from '../src/summary.js';
import { SAMPLES_DIR, SHANGHAI, localCtx, sphericalRingArea } from './helpers.js';

const ids = readdirSync(SAMPLES_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.slice(0, -5));
const reg = createToolRegistry();

describe.each(ids)('sample %s', (id) => {
  it('runs every tool with grounded summaries and schema-valid data', async () => {
    const ctx = localCtx();
    const overview = (await reg.run('analyze_life_circle', { sample_id: id }, ctx)).data as Overview;
    const community = (await ctx.backend.getAnalysis(id)).communities[0]!.name;
    const calls: [string, Record<string, unknown>][] = [
      ['analyze_life_circle', { sample_id: id, profile: 'elder' }],
      ['get_isochrone', { analysis_id: id }],
      ['list_service_gaps', { analysis_id: id }],
      ['list_service_gaps', { analysis_id: `${id}~elder`, category: '菜市场' }],
      ['list_service_gaps', { analysis_id: id, category: '社区卫生' }],
      ['simulate_facility', { analysis_id: id, category: '菜市场', near_community: community }],
      ['simulate_facility', { analysis_id: id, category: '幼儿园', near_community: community }],
      ['compare_sites', { analysis_ids: [id, `${id}~elder`] }],
      ['export_report', { analysis_id: id }],
      ['export_report', { analysis_id: id, format: 'geojson' }],
    ];
    // every sample checks all five categories, for every community
    expect(overview.checked_categories).toEqual([...HARD_CATEGORIES]);
    expect(overview.headline.checks).toBe(overview.headline.communities * HARD_CATEGORIES.length);
    for (const [name, args] of calls) {
      const r = await reg.run(name, args, ctx);
      const g = checkGrounding(r.summary, [{ id: 'T1', facts: r.facts, names: entityNames(r.data) }], {
        citations: false,
      });
      expect([name, g.unsupported]).toEqual([name, []]);
      expect(
        reg.get(name)!.outputSchema!.safeParse(JSON.parse(JSON.stringify(r.data))).error,
      ).toBeUndefined();
    }
  });

  it('keeps the headline consistent: circle gaps + missed = walking gaps + circle gaps that walking confirms', async () => {
    const o = (await reg.run('analyze_life_circle', { sample_id: id }, localCtx())).data as Overview;
    const h = o.headline;
    expect(h.walking_gaps).toBe(h.pseudo + h.blind);
    expect(h.missed_by_circle).toBe(h.pseudo);
    // every straight-line gap is a blind spot on foot (walking is never shorter than the line)
    expect(h.blind).toBeLessThanOrEqual(h.straight_gaps);
    const byCat = Object.values(o.by_category);
    expect(byCat.reduce((s, c) => s + c.伪覆盖 + c.盲区, 0)).toBe(h.walking_gaps);
    expect(byCat.reduce((s, c) => s + c.待核实, 0)).toBe(h.pending);
  });

  it('exports valid GeoJSON whose 15-minute area matches the stats', async () => {
    const r = await reg.run('get_isochrone', { analysis_id: id, levels: [15] }, localCtx());
    const fc = r.data as FeatureCollection;
    const f15 = fc.features[0]!;
    if (f15.geometry.type !== 'MultiPolygon') throw new Error('expected MultiPolygon');
    let area = 0;
    for (const poly of f15.geometry.coordinates) {
      poly.forEach((ring, k) => {
        expect(ring[0]).toEqual(ring[ring.length - 1]);
        expect(Math.sign(sphericalRingArea(ring))).toBe(k === 0 ? 1 : -1);
        for (const [lng, lat] of ring) {
          expect(lng).toBeGreaterThan(SHANGHAI.minLng);
          expect(lng).toBeLessThan(SHANGHAI.maxLng);
          expect(lat).toBeGreaterThan(SHANGHAI.minLat);
          expect(lat).toBeLessThan(SHANGHAI.maxLat);
        }
        area += sphericalRingArea(ring);
      });
    }
    expect(Math.abs(area / 1e6 / (f15.properties.area_km2 as number) - 1)).toBeLessThan(0.02);
  });
});
