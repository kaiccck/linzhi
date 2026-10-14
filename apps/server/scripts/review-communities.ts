/**
 * Apply the community review (data/official/community-review.json) to the samples: drop what is not a
 * compound of its own (residents' committee offices, non-residential points, duplicates, demolished or
 * mislocated points, points with no official record), mark 商办 compounds as having no 对口小学, match
 * corrected addresses against the catchment table, then recompute what depends on the communities:
 * verdict counts, gray areas, the 对口小学 notes, the siting suggestions' covers and the route evidence.
 *
 * A compound's new 对口小学 is routed (routematrix, within --max-routes, default 60), every other
 * measured route reused; the siting suggestions are searched again over the compounds that are left,
 * the top sites verified with routematrix (the engine's siting budget, 100 routes per sample).
 *   cd apps/server && node --env-file=../../.env.local --conditions=source --import tsx scripts/review-communities.ts --dry-run
 *   cd apps/server && node --env-file=../../.env.local --conditions=source --import tsx scripts/review-communities.ts
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { frameOf } from '@zoudedao/agent';
import {
  COMMITTEE_NAME,
  fieldEstimator,
  gapCount,
  HARD_CATEGORIES,
  isVisible,
  rhoSamplesOf,
  grayAreaPolygons,
  pointInRing,
  reviewOf,
  statusRaster,
  type AnalysisResult,
  type BarrierSegment,
  type CatchmentList,
  type CommunityReview,
  type HardCategory,
  type RoutedPair,
  type XY,
} from '@zoudedao/core';
import {
  Meter,
  resolveBudget,
  stepCaps,
  serviceCaps,
  runCatchment,
  runSiting,
  statusCounts,
  worstStatus,
  communityGrayAreas,
  type DemandSite,
  type LiveCommunity,
  type MatrixFn,
  type OfficialList,
} from '@zoudedao/engine';
import { missCost, openScriptClient, printLedger, REPO_ROOT, spendGuard, usage } from './script-client.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const at = args.indexOf('--max-routes');
const maxRoutes = at >= 0 ? Number(args[at + 1]) : 60;
const ids = args.filter((a) => /^zj-/.test(a));

const read = <T>(path: string): T => JSON.parse(readFileSync(join(REPO_ROOT, path), 'utf8')) as T;
const table = read<CatchmentList>('data/official/pudong-catchment-2026.json');
const official = read<OfficialList>('data/official/pudong-schools-2026.json');
const reviews = read<{ entries: CommunityReview[] }>('data/official/community-review.json').entries;
const REVIEW_DATE = reviews.reduce((d, r) => (r.date > d ? r.date : d), '');

const sc = openScriptClient(dryRun);
const before = usage(sc.client);
const guard = spendGuard(sc.client, { place: 0, routematrix_walking: maxRoutes + 400 });

interface Suggestion {
  rank: number;
  covers: string[];
  gain: number;
  routes?: { demand_id: string }[];
  [k: string]: unknown;
}

for (const id of ids.length ? ids : ['zj-a', 'zj-b', 'zj-c', 'zj-v']) {
  const file = join(REPO_ROOT, `data/samples/${id}.json`);
  const raw = readFileSync(file, 'utf8');
  const data = JSON.parse(raw) as AnalysisResult & { site_suggestions?: Record<string, Suggestion[]> };
  const frame = frameOf(data.meta);

  // 1. what is not a compound of its own leaves
  const removed: { name: string; why: string }[] = [];
  data.communities = data.communities.filter((c) => {
    const uid = (c as { uid?: string }).uid;
    const r = reviewOf(reviews, [uid]);
    if (r?.action === 'exclude') {
      removed.push({ name: c.name, why: r.kind });
      return false;
    }
    if (COMMITTEE_NAME.test(c.name.trim())) {
      removed.push({ name: c.name, why: 'committee' });
      return false;
    }
    return true;
  });
  const gone = new Set(removed.map((r) => r.name));

  // official names where Baidu gives a lane or a spelling of its own (益江路511弄 → 玉兰香苑二期A块)
  const renamed = new Map<string, string>();
  for (const c of data.communities) {
    const r = reviewOf(reviews, [(c as { uid?: string }).uid]);
    if (r?.action !== 'name' || !r.official_name || r.official_name === c.name) continue;
    renamed.set(c.name, r.official_name);
    c.name = r.official_name;
  }
  // old names in text, longest first (玉兰香苑-一期 before a shorter one it contains)
  const rename = (text: string) =>
    [...renamed]
      .sort((a, b) => b[0].length - a[0].length)
      .reduce((t, [from, to]) => t.split(from).join(to), text);

  // 2. 对口小学 again: corrected addresses, 商办 compounds, reused routes
  const routes: RoutedPair[] = [];
  const demand: DemandSite[] = data.communities.map((c) => {
    const uid = (c as { uid?: string }).uid ?? null;
    const r = reviewOf(reviews, [uid]);
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
    const address = r?.action === 'address' ? r.address : lane;
    return {
      id: c.name,
      name: c.name,
      uid,
      ...(address ? { address } : {}),
      ...(r?.action === 'no_catchment' ? { no_catchment: r.reason } : {}),
      xy: c.centroid,
      bd09: frame.toLngLat(...c.centroid),
      gate: 'location',
      straight_m: Math.hypot(...c.centroid),
      merged: [],
    };
  });
  const budget = resolveBudget('personal', { catchment: maxRoutes, siting: 100 });
  const meter = new Meter(stepCaps(budget), serviceCaps(budget), { onQuota: () => {} });
  const matrix: MatrixFn = (step, origins, destinations) =>
    meter.run(
      step,
      origins.length * destinations.length,
      (o) => guard.routeMatrixWalking(origins, destinations, { ...o, partial: true }),
      (res) => res.stats.routesRequested,
    );
  const result = await runCatchment({
    meter,
    frame,
    matrix,
    lists: [table],
    region: { city: '上海市', district: '浦东新区', town: '张江镇' },
    demand,
    communities: data.communities,
    pois: data.pois,
    official: [official],
    routes,
    rule_m: data.baseline.rule_radius_m,
    warn: (m) => console.warn(`[${id}] ${m}`),
  });

  // 3. what depends on the communities
  for (const c of data.communities) {
    const worst = worstStatus(Object.values(c.checks));
    if (worst) c.worst_status = worst;
    else delete c.worst_status;
  }
  data.stats.catchment = result.stats ?? undefined;
  data.stats.community_status_counts = statusCounts(data.communities);
  (data.stats as { demand_points?: number }).demand_points = data.communities.length;
  if (data.communities.some((c) => c.pts.length >= 3)) {
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

  // the suggestions were made for the old list (most of zj-b's served committee offices and
  // mislocated points): search again over the compounds that are left, top sites verified by routes
  let siting: { categories: string[]; verified: number } | null = null;
  if (data.site_suggestions) {
    const v = data.meta.walk_speed_mps || 1.17;
    const pieces = (data.barriers ?? []) as unknown as BarrierSegment[];
    const rule = data.baseline.rule_radius_m || 1000;
    const out = await runSiting({
      meter,
      frame,
      matrix,
      communities: data.communities as LiveCommunity[],
      gates: new Map(data.communities.map((c) => [c.name, frame.toLngLat(...c.centroid)])),
      paths: data.paths,
      rule: Object.fromEntries(HARD_CATEGORIES.map((c) => [c, rule])) as Record<HardCategory, number>,
      estimator: fieldEstimator(rhoSamplesOf(data.samples, v).rho, {
        speed: v,
        ...(pieces.length ? { visible: (x, y, sg) => isVisible([x, y], [sg.x, sg.y], pieces) } : {}),
      }),
      warn: (m) => console.warn(`[${id}] ${m}`),
    });
    // 小学 is the assigned school, never a nearer new one (update-school-catchments.ts)
    delete out.suggestions.小学;
    data.site_suggestions = out.suggestions as unknown as Record<string, Suggestion[]>;
    (data.stats as { siting_verified_sites?: number }).siting_verified_sites = out.verified_sites;
    siting = { categories: Object.keys(out.suggestions), verified: out.verified_sites };
  }

  const meta = data.meta as AnalysisResult['meta'] & { notes: string[] };
  // a rerun removes nothing more: the review's note from the first run stays
  meta.notes = (meta.notes ?? []).filter(
    (n) => !n.startsWith('对口小学') && !(removed.length && n.startsWith('小区核实')),
  );
  meta.notes = meta.notes.map((n) =>
    n.replace(/本次 (\d+) 个（检出 (\d+) 个）/, (_m, a: string, b: string) =>
      removed.length
        ? `检出 ${b} 个、取 ${a} 个，人工核实后保留 ${data.communities.length} 个（见“小区核实”）`
        : `本次 ${a} 个（检出 ${b} 个）`,
    ),
  );
  meta.notes = meta.notes.map(rename);
  meta.notes.push(...result.notes);
  if (removed.length) {
    const KIND: Record<string, string> = {
      committee: '居委会',
      not_residential: '不是住宅',
      duplicate: '与另一小区重复',
      demolished: '已动迁',
      mislocated: '位置标错',
      unverified: '查无此小区',
    };
    const by = new Map<string, string[]>();
    for (const r of removed) by.set(KIND[r.why] ?? r.why, [...(by.get(KIND[r.why] ?? r.why) ?? []), r.name]);
    meta.notes.push(
      `小区核实（${REVIEW_DATE}，data/official/community-review.json）：百度“住宅区”检索结果对照张江镇住宅小区清单、` +
        `浦东新区 2026 年小学招生地段与居村委地址逐条核实，去掉 ${removed.length} 个不是独立住宅小区的点——` +
        [...by].map(([k, v]) => `${k}：${v.join('、')}`).join('；') +
        `。保留 ${data.communities.length} 个小区。`,
    );
  }
  const after = JSON.stringify(data) + (raw.endsWith('\n') ? '\n' : '');
  if (!dryRun && after !== raw) writeFileSync(file, after);

  // the route evidence of compounds that left goes with them
  const routesFile = join(REPO_ROOT, `data/samples/routes/${id}.json`);
  if (existsSync(routesFile) && (gone.size || renamed.size)) {
    const rraw = readFileSync(routesFile, 'utf8');
    const ev = JSON.parse(rraw) as { routes: { community: string }[] };
    ev.routes = ev.routes
      .filter((r) => !gone.has(r.community))
      .map((r) => ({ ...r, community: renamed.get(r.community) ?? r.community }));
    const out = JSON.stringify(ev) + (rraw.endsWith('\n') ? '\n' : '');
    if (!dryRun && out !== rraw) writeFileSync(routesFile, out);
  }
  console.log(
    id,
    JSON.stringify({
      removed: removed.map((r) => `${r.name}(${r.why})`),
      renamed: [...renamed].map(([a, b]) => `${a}→${b}`),
      kept: data.communities.length,
      catchment: result.stats && {
        matched: result.stats.matched,
        routed: result.stats.routed,
        new_routes: result.stats.new_routes,
        campus_pending: result.stats.campus_pending,
        not_applicable: result.stats.not_applicable,
        unmatched: result.stats.unmatched,
      },
      siting,
      written: !dryRun && after !== raw,
    }),
  );
}
if (dryRun) console.log('dry run, a live run would request:', JSON.stringify(missCost(sc.misses())));
else printLedger('百度配额', sc.client, before);
sc.close();
