/**
 * 下载 GeoJSON: the isochrones, the straight circle, the communities with their verdicts, the
 * facilities and the gray areas, in WGS-84 (RFC 7946), converted with core's public formulas.
 */
import { describe, expect, it } from 'vitest';
import { bd09ToWgs84, type AnalysisResult } from '@zoudedao/core';
import rawA from '../../../../data/samples/zj-a.json?raw';
import rawB from '../../../../data/samples/zj-b.json?raw';
import { deriveModel } from './derive.js';
import { analysisGeoJSON, geojsonName, polygonsOf } from './geojson.js';

const a = deriveModel(JSON.parse(rawA) as AnalysisResult, 'zj-a');
const b = deriveModel(JSON.parse(rawB) as AnalysisResult, 'zj-b');

describe('analysisGeoJSON', () => {
  const fc = analysisGeoJSON(a, { scale: 1 });
  const layer = (name: string) => fc.features.filter((f) => f.properties.layer === name);

  it('carries every layer the check shows', () => {
    expect(fc.type).toBe('FeatureCollection');
    expect(layer('isochrone').map((f) => f.properties.minutes)).toEqual([5, 10, 15]);
    expect(layer('straight_circle')[0]!.properties.radius_m).toBe(Math.round(a.r15));
    expect(layer('community')).toHaveLength(a.units.length);
    expect(layer('poi').length).toBe(a.data.pois.filter((p) => !p.stall_of).length);
    expect(layer('gray_area').length).toBe((a.data.gray_areas ?? []).filter((g) => g.rings.length).length);
  });

  it('writes WGS-84 longitude, latitude — the centre moves by the BD-09 offset, a few hundred metres', () => {
    const [lng0, lat0] = a.data.meta.center_bd09;
    const [wLng, wLat] = bd09ToWgs84(lng0, lat0);
    const here = fc.features.find((f) => f.properties.code === 'A-11')!;
    expect(here.geometry.type).toBe('Polygon');
    const ring = (here.geometry as { coordinates: number[][][] }).coordinates[0]!;
    // closed, and near the WGS-84 centre rather than the BD-09 one
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    const [x, y] = ring[0]!;
    expect(Math.abs(x! - wLng)).toBeLessThan(0.02);
    expect(Math.abs(y! - wLat)).toBeLessThan(0.02);
    expect(Math.abs(x! - lng0)).toBeGreaterThan(0.004);
  });

  it('gives each community its verdicts under the rule set on screen, and its assigned school', () => {
    const p = fc.features.find((f) => f.properties.code === 'A-11')!.properties;
    expect(p).toMatchObject({
      name: '申城佳苑三期B块',
      小学_status: '待核实',
      小学_route_m: null,
      小学_straight_m: null,
    });
    expect(p.catchment_school).toContain('孙桥小学');
    const live = analysisGeoJSON(b, { scale: 1 });
    expect(live.metadata.rules).toBe('步行 1 公里（赛题）');
    // live results and samples B, C, V have no outlines: their communities are points
    expect(live.features.find((f) => f.properties.layer === 'community')!.geometry.type).toBe('Point');
  });

  it('keeps holes inside their outer ring', () => {
    const outer: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    const hole: [number, number][] = [
      [2, 2],
      [2, 8],
      [8, 8],
      [8, 2],
    ];
    expect(polygonsOf([outer, hole])).toEqual([[outer, hole]]);
    expect(
      polygonsOf(
        [outer, hole],
        [
          { hole: false, parent: null, area_m2: 100 },
          { hole: true, parent: 0, area_m2: 36 },
        ],
      ),
    ).toEqual([[outer, hole]]);
  });

  it('names the file after the analysis', () => {
    expect(geojsonName(a, 'zj-a')).toBe('zoudedao-zj-a.geojson');
    expect(geojsonName(b, null)).toBe('zoudedao-zj-b.geojson');
  });
});
