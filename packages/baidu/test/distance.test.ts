import { haversine, type LngLat } from '@zoudedao/core';
import { describe, expect, it } from 'vitest';
import {
  coarseWalk,
  DISTANCE_SOURCE_LABEL,
  estimateWalk,
  walkDistances,
  type WalkPair,
} from '../src/index.js';
import {
  baiduJson,
  fakeMatrix,
  fixture,
  latLngList,
  requestParam,
  spyReplay,
  spyTransport,
  testClient,
} from './helpers.js';

const CENTER: LngLat = [121.644195, 31.19007];
const FACILITIES = fixture('zhangjiang/raw/bv_facilities_A_from_center_000.json');
const DESTS = latLngList(requestParam(FACILITIES, 'destinations'));
const straight = (a: LngLat, b: LngLat) => haversine(a[0], a[1], b[0], b[1]);

/** routematrix answers 211 (the measured SN problem); directionlite answers with a 1.4 × straight route. */
function matrixBroken(directionlite: 'ok' | 'none' | 'auth' = 'ok') {
  return spyTransport((u) => {
    if (u.pathname.startsWith('/routematrix')) return baiduJson({ status: 211, message: 'APP SN校验失败' });
    if (directionlite === 'auth') return baiduJson({ status: 211, message: 'APP SN校验失败' });
    if (directionlite === 'none') return baiduJson({ status: 7, message: '无返回结果' });
    const [olat, olng] = (u.searchParams.get('origin') ?? '').split(',').map(Number);
    const [dlat, dlng] = (u.searchParams.get('destination') ?? '').split(',').map(Number);
    const m = Math.round(1.4 * haversine(olng ?? 0, olat ?? 0, dlng ?? 0, dlat ?? 0));
    return baiduJson({
      status: 0,
      result: { routes: [{ distance: m, duration: Math.round(m / 1.12), steps: [] }] },
    });
  });
}

describe('walkDistances degrade chain', () => {
  const pairs: WalkPair[] = DESTS.slice(0, 4).map((destination) => ({ origin: CENTER, destination }));

  it('uses routematrix when it answers (recorded centre → facilities batch)', async () => {
    const { transport } = spyReplay([FACILITIES]);
    const all: WalkPair[] = DESTS.map((destination) => ({ origin: CENTER, destination }));
    const r = await walkDistances(testClient(transport), all);
    expect(r.counts).toEqual({ routematrix: 18, directionlite: 0, estimate: 0, coarse: 0 });
    expect(r.results[0]).toMatchObject({
      distanceM: 1122,
      durationS: 960,
      source: 'routematrix',
      via: 'api',
    });
    expect(r.results[0]?.rho).toBeCloseTo(1122 / straight(CENTER, DESTS[0] as LngLat), 6);
  });

  it('falls back to directionlite when routematrix fails', async () => {
    const t = matrixBroken('ok');
    const r = await walkDistances(testClient(t), pairs);
    expect(r.counts.directionlite).toBe(4);
    expect(r.results[0]?.fallbackReason).toContain('批量算路失败');
    expect(r.results[0]?.rho).toBeCloseTo(1.4, 2);
    expect(r.errors[0]?.status).toBe(211);
  });

  it('then to ρ̂ × straight distance ("估算") when both APIs fail', async () => {
    const r = await walkDistances(testClient(matrixBroken('none')), pairs, { rhoLocal: () => 1.6 });
    expect(r.counts.estimate).toBe(4);
    const first = r.results[0];
    const s = straight(CENTER, DESTS[0] as LngLat);
    expect(first?.distanceM).toBeCloseTo(1.6 * s, 6);
    expect(first?.durationS).toBeCloseTo((1.6 * s) / 1.17, 6);
    expect(first?.fallbackReason).toContain('步行路线无结果');
    expect(DISTANCE_SOURCE_LABEL[first?.source ?? 'coarse']).toBe('估算');
  });

  it('and finally to 1.35 × straight ("粗估") without a local ρ̂', async () => {
    const r = await walkDistances(testClient(matrixBroken('none')), pairs, { rhoLocal: () => null });
    expect(r.counts.coarse).toBe(4);
    expect(r.results[1]?.distanceM).toBeCloseTo(1.35 * straight(CENTER, DESTS[1] as LngLat), 6);
    expect(DISTANCE_SOURCE_LABEL.coarse).toBe('粗估');
  });

  it('stops calling directionlite after a config error and respects its call budget', async () => {
    const auth = matrixBroken('auth');
    const r = await walkDistances(testClient(auth), pairs);
    expect(auth.urls.filter((u) => u.includes('/directionlite/'))).toHaveLength(1);
    expect(r.counts.coarse).toBe(4);

    const ok = matrixBroken('ok');
    const r2 = await walkDistances(testClient(ok), pairs, { maxDirectionlite: 2 });
    expect(r2.counts).toMatchObject({ directionlite: 2, coarse: 2 });
  });

  it('keeps no-route cells honest: never reported as 0 m', async () => {
    const t = fakeMatrix((_o, d) => d[0] === (DESTS[0] as LngLat)[0]);
    const r = await walkDistances(testClient(t), pairs, { useDirectionlite: false });
    expect(r.results[0]).toMatchObject({ source: 'coarse', fallbackReason: '批量算路无结果' });
    expect(r.results[0]?.distanceM).toBeGreaterThan(0);
    expect(r.counts.routematrix).toBe(3);
  });

  it('pure estimators never go below the straight line', () => {
    const a: LngLat = [121.64, 31.19];
    const b: LngLat = [121.65, 31.19];
    expect(estimateWalk(a, b, 0.8).distanceM).toBeCloseTo(straight(a, b), 6);
    expect(coarseWalk(a, b).rho).toBe(1.35);
    expect(coarseWalk(a, a).rho).toBeNull();
  });
});
