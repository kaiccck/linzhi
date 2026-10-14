/**
 * Restaurants the samples took for market stalls. Before 餐饮 was a category (2026-10-10), a POI Baidu
 * tags 美食 whose name says "(孙桥菜场店)" fell through to the stall rule and counted as 菜市场 — the
 * restaurant 仙味楼上海本帮菜江浙菜(孙桥菜场店) became the 孙桥菜市场 four communities of zj-v walk to.
 * Today's core categorize() files it under 餐饮; this brings the samples in line:
 *
 *   1. every 菜市场 POI whose tags core now files elsewhere gets that category, and is no stall;
 *   2. a 菜市场 check that went to one of them is routed again (routematrix) to the market cluster it
 *      stood for (the market and its real stalls within 150 m), the shortest walk kept and judged;
 *   3. facility_stats, verdict counts and gray areas follow.
 *
 *   cd apps/server && node --env-file=../../.env.local --conditions=source --import tsx scripts/fix-market-stalls.ts --dry-run
 *   cd apps/server && node --env-file=../../.env.local --conditions=source --import tsx scripts/fix-market-stalls.ts
 * Then scripts/prefetch-routes.ts for the route evidence of the re-judged checks.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { frameOf } from '@zoudedao/agent';
import {
  categorize,
  classifyCheck,
  facilityStats,
  type AnalysisResult,
  type FacilityCheck,
  type Poi,
} from '@zoudedao/core';
import { communityGrayAreas, statusCounts, worstStatus } from '@zoudedao/engine';
import { missCost, openScriptClient, printLedger, REPO_ROOT, usage } from './script-client.js';

const dryRun = process.argv.includes('--dry-run');
const CLUSTER_M = 150;
const sc = openScriptClient(dryRun);
const before = usage(sc.client);
const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!);

for (const id of ['zj-a', 'zj-b', 'zj-c', 'zj-v']) {
  const file = join(REPO_ROOT, `data/samples/${id}.json`);
  const raw = readFileSync(file, 'utf8');
  const data = JSON.parse(raw) as AnalysisResult;
  const frame = frameOf(data.meta);

  // 1. what core files elsewhere today leaves the markets
  const moved = new Map<string, Poi>();
  for (const p of data.pois) {
    // an official list's market stays one, whatever Baidu's tag (浦商生鲜 filed as 生鲜超市)
    if (p.cat !== '菜市场' || (p as Poi & { official?: unknown }).official) continue;
    const now = categorize(p.name, p.tag ?? '').cat;
    if (now === '菜市场' || now === '其他' || now === '生鲜超市') continue;
    moved.set(p.uid, { ...p });
    p.cat = now;
    delete p.stall_of;
    delete p.stall_of_uid;
  }
  if (!moved.size) {
    console.log(id, 'nothing to fix');
    continue;
  }
  const markets = data.pois.filter((p) => p.cat === '菜市场');

  // 2. the checks that walked to one of them, routed again to the market they stood for
  const redo: string[] = [];
  for (const c of data.communities) {
    const k = c.checks.菜市场;
    const was = k?.via_uid ? moved.get(k.via_uid) : undefined;
    if (!k || !was) continue;
    const cluster = markets.filter((m) => dist(m.xy, was.xy) <= CLUSTER_M);
    const origin = frame.toLngLat(...c.centroid);
    const m = await sc.client.routeMatrixWalking(
      [origin],
      cluster.map((p) => frame.toLngLat(...(p.navi_xy ?? p.xy))),
      { partial: true },
    );
    const walks = cluster
      .map((p, j) => ({ p, cell: m.cells[0]?.[j] }))
      .filter((w) => w.cell?.status === 'ok')
      .map((w) => ({ p: w.p, route_m: w.cell!.distanceM!, dur_s: w.cell!.durationS! }));
    if (!walks.length) {
      console.warn(`${id} ${c.name}: no route to the ${was.stall_of ?? was.name} cluster, left as it was`);
      continue;
    }
    const best = walks.reduce((a, b) => (b.route_m < a.route_m ? b : a));
    const nearest = markets.reduce((a, b) => (dist(b.xy, c.centroid) < dist(a.xy, c.centroid) ? b : a));
    const straight = Math.round(dist(nearest.xy, c.centroid) * 10) / 10;
    const next: FacilityCheck = {
      ...k,
      straight_m: straight,
      nearest_straight: nearest.name,
      route_m: best.route_m,
      dur_s: best.dur_s,
      via: best.p.name,
      via_uid: best.p.uid,
      via_straight_m: Math.round(dist(best.p.xy, c.centroid) * 10) / 10,
      route_basis: 'routed',
      ...classifyCheck({ straight_m: straight, route_m: best.route_m, rule_m: data.baseline.rule_radius_m }),
    };
    if (best.p.stall_of) next.via_stall_of = best.p.stall_of;
    else delete next.via_stall_of;
    c.checks.菜市场 = next;
    redo.push(`${c.name}: ${was.name} ${k.route_m} m → ${best.p.name} ${best.route_m} m（${next.status}）`);
  }

  // 3. what follows from the POIs and the checks
  for (const c of data.communities) {
    const worst = worstStatus(Object.values(c.checks));
    if (worst) c.worst_status = worst;
    else delete c.worst_status;
  }
  data.stats.facility_stats = facilityStats(data);
  data.stats.community_status_counts = statusCounts(data.communities);
  if (!data.communities.some((c) => c.pts.length >= 3))
    data.gray_areas = communityGrayAreas(data.communities);

  const after = JSON.stringify(data) + (raw.endsWith('\n') ? '\n' : '');
  if (!dryRun && after !== raw) writeFileSync(file, after);
  console.log(id, JSON.stringify({ moved: [...moved.values()].map((p) => p.name), redo }));
}
if (dryRun) console.log('dry run, a live run would request:', JSON.stringify(missCost(sc.misses())));
else printLedger('百度配额', sc.client, before);
sc.close();
