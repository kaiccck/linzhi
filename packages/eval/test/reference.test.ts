/** The dense reference: covers the disc, resumes after a stop, retries failed cells once. */
import { localFrame } from '@zoudedao/core';
import { afterAll, describe, expect, it } from 'vitest';

import { areaPaths, readReference } from '../src/artefacts.js';
import { EvalCeilingError } from '../src/ceiling.js';
import { referenceField, runReference } from '../src/reference.js';
import {
  CITY_AREA,
  cityClient,
  MATRIX_PATH,
  NOW,
  tempRoot,
  truthTime,
  cleanupTempRoots,
} from './fixtures.js';

const frame = localFrame(CITY_AREA.center_bd09[0], CITY_AREA.center_bd09[1]);

afterAll(cleanupTempRoots);

describe('reference grid', () => {
  it('measures every lattice point of the 1,600 m disc once, with BD-09, route and time', async () => {
    const root = tempRoot();
    const c = cityClient();
    const res = await runReference({ client: c.client, root, area: CITY_AREA, now: NOW });
    expect(res.stopped).toBeNull();
    const ref = readReference(areaPaths(root, CITY_AREA.id))!;
    expect(ref).toEqual(res.artefact);
    expect(ref.lattice).toEqual({ spacing_m: 100, radius_m: 1600, points: 796 });
    expect(ref.counts).toEqual({ points: 796, ok: 796, no_route: 0, failed: 0, pending: 0 });
    // 16 calls of ≤ 50 routes, all billed on a cold cache
    expect(res.session).toMatchObject({
      calls: 16,
      requests: 16,
      routes: 796,
      routes_billed: 796,
      retried: 0,
    });
    expect(c.transport.count(MATRIX_PATH)).toBe(16);
    expect(c.ledger.billed('routematrix_walking')).toBe(796);
    for (const p of ref.points) {
      expect(Math.hypot(...p.xy)).toBeLessThanOrEqual(1600);
      const back = frame.toXY(p.bd09[0], p.bd09[1]);
      expect(Math.hypot(back[0] - p.xy[0], back[1] - p.xy[1])).toBeLessThan(0.02);
      // Baidu's answer is the city's walk: whole metres, seconds = metres / 1.17 rounded
      expect(p.dur_s).toBe(Math.round(p.route_m! / 1.17));
      expect(Math.abs(p.dur_s! - truthTime(p.xy))).toBeLessThanOrEqual(1);
    }
    expect(ref.sessions).toHaveLength(1);
    expect(ref.totals).toEqual({ calls: 16, requests: 16, routes: 796, routes_billed: 796 });
    expect(ref.source).toMatch(/routematrix/);
    expect(ref.area.center_bd09).toEqual(CITY_AREA.center_bd09);

    // the reference field reproduces the city: most of the 15-minute region is on this side of the river
    const rf = referenceField(ref);
    expect(rf.iso.grid.nx).toBe(161);
    expect(rf.barriers.segments.length).toBeGreaterThan(10);
    expect(rf.iso.stats.loo_mae_s).toBeLessThan(40);
  });

  it('stops cleanly at the ceiling, keeps what it measured and resumes without asking a point twice', async () => {
    const root = tempRoot();
    const first = cityClient({ caps: { routematrix_walking: 330 } });
    const a = await runReference({ client: first.client, root, area: CITY_AREA, now: NOW });
    expect(a.stopped).toBeInstanceOf(EvalCeilingError);
    // six full calls fit under 330; the seventh would pass it and is never sent
    expect(first.ledger.billed('routematrix_walking')).toBe(300);
    expect(first.transport.count(MATRIX_PATH)).toBe(6);
    const saved = readReference(areaPaths(root, CITY_AREA.id))!;
    expect(saved.counts).toMatchObject({ ok: 300, failed: 0, pending: 496 });
    expect(saved.sessions[0]).toMatchObject({ calls: 7, routes_billed: 300, not_asked: 496 });
    expect(saved.sessions[0]!.stopped).toMatch(/上限 330/);
    // inner points first: every measured point is at least as close as every pending one
    const maxDone = Math.max(
      ...saved.points.filter((p) => p.status === 'ok').map((p) => Math.hypot(...p.xy)),
    );
    const minTodo = Math.min(
      ...saved.points.filter((p) => p.status === 'pending').map((p) => Math.hypot(...p.xy)),
    );
    expect(maxDone).toBeLessThanOrEqual(minTodo);

    // a new process with an empty cache: only the pending points are asked
    const second = cityClient({ caps: { routematrix_walking: 1000 } });
    const b = await runReference({ client: second.client, root, area: CITY_AREA, now: NOW });
    expect(b.stopped).toBeNull();
    expect(second.ledger.billed('routematrix_walking')).toBe(496);
    expect(second.transport.count(MATRIX_PATH)).toBe(10);
    const done = readReference(areaPaths(root, CITY_AREA.id))!;
    expect(done.counts).toMatchObject({ ok: 796, pending: 0 });
    expect(done.sessions).toHaveLength(2);
    expect(done.totals.routes_billed).toBe(796);

    // nothing left: a third run asks nothing
    const third = cityClient();
    const c = await runReference({ client: third.client, root, area: CITY_AREA, now: NOW });
    expect(c.session.calls).toBe(0);
    expect(third.transport.paths).toHaveLength(0);
    expect(readReference(areaPaths(root, CITY_AREA.id))!.sessions).toHaveLength(2);
  });

  it('retries failed cells once in the same run, and asks cells that failed twice again next run', async () => {
    const root = tempRoot();
    // the second request fails once (network), the retry pass succeeds
    const flaky = cityClient({
      networkRetries: 0,
      fail: (req, n) => n === 2 && req.url.includes('routematrix'),
    });
    const a = await runReference({ client: flaky.client, root, area: CITY_AREA, now: NOW });
    expect(a.session).toMatchObject({ retried: 50, failed: 0, calls: 17 });
    expect(a.artefact.counts).toMatchObject({ ok: 796, failed: 0 });
    // failed attempts are not billed
    expect(flaky.ledger.billed('routematrix_walking')).toBe(796);

    // a request that always fails for one chunk: failed after the retry, asked again by the next run
    const root2 = tempRoot();
    const first = frame.toLngLat(0, 100);
    const token = `${first[1].toFixed(6)},${first[0].toFixed(6)}`;
    const broken = cityClient({
      networkRetries: 0,
      fail: (req) => decodeURIComponent(req.url).includes(token),
    });
    const b = await runReference({ client: broken.client, root: root2, area: CITY_AREA, now: NOW });
    expect(b.stopped).toBeNull();
    expect(b.session).toMatchObject({ retried: 50, failed: 50 });
    expect(b.artefact.counts).toMatchObject({ ok: 746, failed: 50, pending: 0 });
    const fixed = cityClient();
    const c = await runReference({ client: fixed.client, root: root2, area: CITY_AREA, now: NOW });
    expect(c.session).toMatchObject({ calls: 1, routes: 50, failed: 0 });
    expect(c.artefact.counts).toMatchObject({ ok: 796, failed: 0 });
  });

  it('refuses to resume a reference measured on another lattice', async () => {
    const root = tempRoot();
    const c = cityClient({ caps: { routematrix_walking: 50 } });
    await runReference({ client: c.client, root, area: CITY_AREA, now: NOW });
    await expect(
      runReference({ client: c.client, root, area: CITY_AREA, now: NOW, opts: { spacing_m: 50 } }),
    ).rejects.toThrow(/参考网格/);
  });
});
