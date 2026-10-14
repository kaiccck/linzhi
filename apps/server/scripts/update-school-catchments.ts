/** Refresh sample school checks from the newest official table. Offline: reuse only measured OD pairs.
 * cd apps/server && node --conditions=source --import tsx scripts/update-school-catchments.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { frameOf } from '@zoudedao/agent';
import {
  gapCount,
  grayAreaPolygons,
  pointInRing,
  statusRaster,
  type AnalysisResult,
  type CatchmentList,
  type RoutedPair,
  type XY,
} from '@zoudedao/core';
import {
  Meter,
  resolveBudget,
  stepCaps,
  serviceCaps,
  runCatchment,
  statusCounts,
  worstStatus,
  communityGrayAreas,
  type DemandSite,
  type OfficialList,
} from '@zoudedao/engine';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = <T>(path: string): T => JSON.parse(readFileSync(join(root, path), 'utf8')) as T;
const table = read<CatchmentList>('data/official/pudong-catchment-2026.json');
const official = read<OfficialList>('data/official/pudong-schools-2026.json');
const budget = resolveBudget('personal', { catchment: 0 });

for (const id of ['zj-a', 'zj-b', 'zj-c', 'zj-v']) {
  const file = join(root, `data/samples/${id}.json`);
  const before = readFileSync(file, 'utf8');
  const data = JSON.parse(before) as AnalysisResult;
  const frame = frameOf(data.meta);
  const routes: RoutedPair[] = [];
  const demand: DemandSite[] = data.communities.map((c) => {
    // Old samples kept the matched lane, even where they omitted the original POI address.
    const lane = c.catchment?.matched_by.startsWith('lane:') ? c.catchment.matched_by.slice(5) : undefined;
    const known = c.catchment;
    if (known?.school_uid && known.route_m !== null && known.dur_s !== null) {
      routes.push({
        origin_id: c.name,
        dest_id: known.school_uid,
        route_m: known.route_m,
        dur_s: known.dur_s,
      });
    }
    const check = c.checks.小学;
    if (check?.via_uid && check.route_m >= 0 && check.route_basis === 'routed') {
      routes.push({ origin_id: c.name, dest_id: check.via_uid, route_m: check.route_m, dur_s: check.dur_s });
    }
    return {
      id: c.name,
      name: c.name,
      uid: null,
      ...(lane ? { address: lane } : {}),
      xy: c.centroid,
      bd09: frame.toLngLat(...c.centroid),
      gate: 'location',
      straight_m: Math.hypot(...c.centroid),
      merged: [],
    };
  });
  const result = await runCatchment({
    meter: new Meter(stepCaps(budget), serviceCaps(budget), { onQuota: () => {} }),
    frame,
    matrix: async () => {
      throw new Error('Offline migration must never request a route');
    },
    lists: [table],
    region: { city: '上海市', district: '浦东新区', town: '张江镇' },
    demand,
    communities: data.communities,
    pois: data.pois,
    official: [official],
    routes,
    rule_m: data.baseline.rule_radius_m,
  });
  for (const c of data.communities) {
    const worst = worstStatus(Object.values(c.checks));
    if (worst) c.worst_status = worst;
    else delete c.worst_status;
  }
  data.stats.catchment = result.stats;
  data.stats.community_status_counts = statusCounts(data.communities);
  if (data.communities.some((c) => c.pts.length >= 3)) {
    // Preserve the curated sample's 25 m outline raster and 120 m halo; only its verdicts change.
    const points = data.communities.flatMap((c) => {
      const status = gapCount(c.checks);
      const points = [{ xy: c.centroid, ...status }];
      if (c.pts.length < 3) return points;
      const xs = c.pts.map((p) => p[0]),
        ys = c.pts.map((p) => p[1]);
      for (let x = Math.ceil(Math.min(...xs) / 25) * 25; x <= Math.max(...xs); x += 25) {
        for (let y = Math.ceil(Math.min(...ys) / 25) * 25; y <= Math.max(...ys); y += 25) {
          if (pointInRing(x, y, c.pts)) points.push({ xy: [x, y] as XY, ...status });
        }
      }
      return points;
    });
    const water = data.base?.water_areas ?? [];
    data.gray_areas = grayAreaPolygons(
      statusRaster(points, {
        cell_m: 25,
        maxDist_m: 120,
        inside: (x, y) => !water.some((w) => pointInRing(x, y, w.pts)),
      }),
    );
  } else data.gray_areas = communityGrayAreas(data.communities);
  // Old proximity-based suggestions cannot stand in for an admissions-policy intervention.
  if (data.site_suggestions) delete data.site_suggestions.小学;
  const meta = data.meta as AnalysisResult['meta'] & { notes: string[]; sources?: string[] };
  meta.notes = (meta.notes ?? []).filter((n) => !n.startsWith('对口小学') && !n.startsWith('灰色区域'));
  meta.notes = meta.notes.map((n) =>
    n.startsWith('小区判定（checks，赛题口径')
      ? n.replace('小区判定（checks，赛题口径', '其他类别小区判定（小学另按官方对口，checks，赛题口径')
      : n,
  );
  meta.notes.push(
    ...result.notes,
    data.communities.some((c) => c.pts.length >= 3)
      ? '灰色区域：25 米栅格，小区轮廓内及轮廓外 120 米，水面不计。仅按已核实判定计数，未明确对口校区的小学项不计入缺口。'
      : '灰色区域：50 米栅格，每个小区出入口代表周围 250 米，仅按已核实判定计数，未明确对口校区的小学项不计入缺口。',
  );
  if (meta.sources) meta.sources = meta.sources.map((s) => s.replace('pudong-catchment-2025', table.id));
  meta.attribution = (meta.attribution ?? []).filter((s) => !/对口|招生地段/.test(s));
  meta.attribution.push(`${table.publisher}，《${table.title}》（${table.published}），${table.url}`);
  const after = JSON.stringify(data) + (id === 'zj-a' ? '\n' : '');
  if (after !== before) writeFileSync(file, after);
  console.log(id, JSON.stringify({ ...result.stats, unchanged: before === after }));
}
