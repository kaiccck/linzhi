/**
 * Adds the checked categories a saved sample lacks (幼儿园 and 社区卫生 on a sample made when only 小学,
 * 菜市场 and 药店 were checked) without touching its other checks: the same facility search, browser
 * top-up, official fusion and coverage check the live engine runs for them, then the gray areas, the
 * counts and the notes over every category. The samples' 小学, 菜市场 and 药店 results stay as they were.
 *
 *   cd apps/server
 *   node --env-file=../../.env.local --conditions=source --import tsx scripts/add-categories.ts --dry-run
 *   node --env-file=../../.env.local --conditions=source --import tsx scripts/add-categories.ts [zj-a …] \
 *     [--browser-pois ../../research/zhangjiang/raw/jsapi_nearby.json] [--max-place 12] [--max-routes 800]
 *
 * Per sample: one place/v3 union of the missing categories' keywords at 2.1 km (the engine's facility
 * radius and keyword groups), place/v3/detail for what the browser's LocalSearch found and the search
 * did not return (only the missing categories' keywords), the official lists of those categories (社区卫生:
 * 上海市社区卫生服务中心信息), then the engine's coverage rounds and nearest top-up from every
 * community's gate. A live run stops before it could spend more than --max-place place requests or
 * --max-routes routematrix routes in total (defaults 12 and 800) and prints the ledger before and
 * after; --dry-run answers from a copy of the cache only, writes nothing and prints what a live run
 * would ask for.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PlacePoi } from '@zoudedao/baidu';
import {
  applyExclusions,
  checkedCategories,
  cleanPois,
  countFacilities,
  facilitiesFor,
  facilityStats,
  gapCount,
  grayAreaPolygons,
  HARD_CATEGORIES,
  localFrame,
  pointInRing,
  statusRaster,
  type AnalysisResult,
  type Community,
  type Poi,
  type StatusPoint,
} from '@zoudedao/core';
import {
  browserPois,
  detailBrowserPois,
  facilityGroups,
  fuseOfficial,
  GRAY_CELL_M,
  GRAY_REACH_M,
  inventoryOf,
  Meter,
  PLACE_PAGE_SIZE,
  resolveBudget,
  runCoverage,
  serviceCaps,
  statusCounts,
  stepCaps,
  toPlaceResult,
  worstStatus,
  type BrowserPoi,
  type CheckSet,
  type DemandSite,
  type EngineClient,
  type MatrixFn,
} from '@zoudedao/engine';
import { loadOfficialData } from '../src/official.js';
import { missCost, openScriptClient, printLedger, REPO_ROOT, spendGuard, usage } from './script-client.js';

/** The live engine's facility radius: a gate up to 1,100 m out, plus the 1 km rule. */
const FACILITY_RADIUS_M = 2100;
/** zj-a's gray areas reach this far past an outline (as augment-zj-a.ts draws them). */
const GRAY_HALO_M = 120;
const NOTE_PREFIX = '追加类别（';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string, fallback: number) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const WITH_VALUE = new Set(['--max-place', '--max-routes', '--browser-pois', '--pages']);
const dryRun = flag('--dry-run');
const limits = { place: option('--max-place', 12), routematrix_walking: option('--max-routes', 800) };
const maxPages = option('--pages', 4);
const ids = args.filter((a, i) => !a.startsWith('--') && !WITH_VALUE.has(args[i - 1] ?? ''));
const samples = ids.length ? ids : ['zj-a', 'zj-b', 'zj-c', 'zj-v'];
const today = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10); // Beijing date

const browserFile = args.includes('--browser-pois') ? args[args.indexOf('--browser-pois') + 1] : undefined;
const browser = new Map<string, BrowserPoi[]>();
if (browserFile) {
  const raw = JSON.parse(readFileSync(browserFile, 'utf8')) as Record<string, unknown>;
  for (const [id, list] of Object.entries(raw)) browser.set(id, browserPois(list));
}

const official = loadOfficialData(join(REPO_ROOT, 'data/official'), (m) => console.warn(m));
const sc = openScriptClient(dryRun);
const before = usage(sc.client);
if (!dryRun) printLedger('ledger before', sc.client);
const client: EngineClient = dryRun ? sc.client : spendGuard(sc.client, limits);

type Meta = AnalysisResult['meta'] & { notes?: string[]; rule_m?: Record<string, number> };

/** Replaces the note starting with `prefix` where it stands, or appends it (reruns keep the order). */
function setNote(meta: Meta, prefix: string, text: string): void {
  const notes = (meta.notes ??= []);
  const at = notes.findIndex((n) => n.startsWith(prefix));
  if (at >= 0) notes[at] = text;
  else notes.push(text);
}

/** The gray areas over every checked category: outlines where the sample has them (zj-a), gates else. */
function grayAreas(result: AnalysisResult) {
  const points: StatusPoint[] = [];
  const outlined = result.communities.some((c) => c.pts.length >= 3);
  for (const c of result.communities) {
    const status = gapCount(c.checks);
    points.push({ xy: c.centroid, ...status });
    if (!outlined || c.pts.length < 3) continue;
    const xs = c.pts.map((p) => p[0]);
    const ys = c.pts.map((p) => p[1]);
    for (
      let gx = Math.ceil(Math.min(...xs) / GRAY_CELL_M) * GRAY_CELL_M;
      gx <= Math.max(...xs);
      gx += GRAY_CELL_M
    )
      for (
        let gy = Math.ceil(Math.min(...ys) / GRAY_CELL_M) * GRAY_CELL_M;
        gy <= Math.max(...ys);
        gy += GRAY_CELL_M
      )
        if (pointInRing(gx, gy, c.pts)) points.push({ xy: [gx, gy], ...status });
  }
  if (!outlined)
    return grayAreaPolygons(statusRaster(points, { cell_m: GRAY_CELL_M, maxDist_m: GRAY_REACH_M }));
  const water = (result.base?.water_areas ?? []).map((w) => w.pts).filter((ring) => ring.length >= 3);
  return grayAreaPolygons(
    statusRaster(points, {
      cell_m: GRAY_CELL_M,
      maxDist_m: GRAY_HALO_M,
      inside: (gx, gy) => !water.some((ring) => pointInRing(gx, gy, ring)),
    }),
  );
}

try {
  for (const id of samples) {
    const file = join(REPO_ROOT, 'data/samples', `${id}.json`);
    const raw = readFileSync(file, 'utf8');
    const result = JSON.parse(raw) as AnalysisResult;
    const meta = result.meta as Meta;
    const have = checkedCategories(result);
    const add = HARD_CATEGORIES.filter((c) => !have.includes(c));
    console.log(`\n${id}: ${meta.name} — checked ${have.join('、')}; adding ${add.join('、') || 'nothing'}`);
    if (!add.length) continue;
    const [lng, lat] = meta.center_bd09;
    const frame = localFrame(lng, lat);
    const distOf = (p: PlacePoi) => Math.hypot(...frame.toXY(p.location[0], p.location[1]));
    const budget = resolveBudget('enterprise', { coverage: limits.routematrix_walking, detailCalls: 5 });
    const meter = new Meter(stepCaps(budget), serviceCaps(budget), { onQuota: () => {} });

    // 1. the missing categories' keywords, one union at the engine's radius (its groups, its order)
    const groups = facilityGroups().required.filter((g) => (add as string[]).includes(g.key));
    const keywords = groups.flatMap((g) => g.keywords);
    let search: Awaited<ReturnType<EngineClient['placeAround']>>;
    try {
      search = await client.placeAround(keywords, [lng, lat], {
        radius: FACILITY_RADIUS_M,
        maxPages,
        pageSize: PLACE_PAGE_SIZE,
      });
    } catch (err) {
      // a dry run stops a sample at its first request the cache cannot answer, and goes on
      if (!dryRun) throw err;
      console.log(`  (not in the cache: the search) — a live run asks it first`);
      continue;
    }
    const inventory = inventoryOf(groups, search, distOf, FACILITY_RADIUS_M);
    const rows: PlacePoi[] = [...search.pois];
    console.log(
      `  search ${keywords.join('$')}: ${search.pois.length} rows, ${search.pages} pages, complete ${search.complete}` +
        [...inventory]
          .map(([k, v]) => ` · ${k} ${v.fetched} (${v.complete ? 'complete' : `≤ ${v.radius_m} m`})`)
          .join(''),
    );

    // 2. what the browser's LocalSearch found for these keywords and the search did not return
    const offered = (browser.get(id) ?? []).filter((p) =>
      groups.some((g) => p.keyword.includes(g.key) || g.keywords.includes(p.keyword)),
    );
    let browserKept = 0;
    const browserUids = new Set<string>();
    if (offered.length) {
      const known = new Set([
        ...rows.flatMap((r) => (r.uid ? [r.uid] : [])),
        ...result.pois.map((p) => p.uid),
      ]);
      const found = await detailBrowserPois({
        meter,
        client,
        frame,
        radius_m: FACILITY_RADIUS_M,
        offered,
        known,
        exclusions: official.exclusions,
        onDetail: (fresh, asked) =>
          console.log(`  browser: ${fresh} new of ${offered.length} offered, detailing ${asked}`),
        warn: (m) => console.warn(`  ${m}`),
      });
      for (const r of found.rows) if (r.uid) browserUids.add(r.uid);
      rows.push(...found.rows);
    }

    // 3. cleaned like every search, the missing categories only, curated exclusions, official lists
    const cleaned = cleanPois(rows.map(toPlaceResult), { project: frame.toXY });
    const mine = cleaned.pois.filter((p) => (add as string[]).includes(p.cat));
    const x = applyExclusions(mine, official.exclusions);
    for (const e of x.excluded) console.log(`  excluded ${e.category} ${e.name}: ${e.reason}`);
    const fused = fuseOfficial({
      lists: official.lists.filter((l) => (add as string[]).includes(l.category)),
      pois: x.pois,
      dropped: cleaned.dropped,
      pool: rows,
      frame,
      radius_m: FACILITY_RADIUS_M,
      district: meta.region?.district ?? undefined,
    });
    for (const n of fused.notes) console.log(`  official: ${n}`);
    const fresh = fused.pois.filter((p) => (add as string[]).includes(p.cat));
    for (const p of fresh) {
      if (browserUids.has(p.uid) || (p.merged_uids ?? []).some((u) => browserUids.has(u))) {
        p.found_by = 'jsapi';
        browserKept++;
      }
    }

    // 4. into the sample's facilities: the new ones replace the older rows of these categories that
    //    Baidu or the lists gave (the 民生设施 search found some within 1.1 km); OSM marks stay
    const taken = new Set(fresh.flatMap((p) => [p.uid, ...(p.merged_uids ?? [])]));
    const older = result.pois.filter((p) => (add as string[]).includes(p.cat) && p.source !== 'osm');
    const keptOlder = older.filter((p) => !taken.has(p.uid));
    result.pois = [
      ...result.pois.filter((p) => !(add as string[]).includes(p.cat) || p.source === 'osm'),
      ...fresh,
      ...keptOlder,
    ];
    for (const cat of add)
      console.log(
        `  ${cat}: ${countFacilities(result.pois, cat)} facilities (${fresh.filter((p) => p.cat === cat).length} found now, ${keptOlder.filter((p) => p.cat === cat).length} kept from before)`,
      );

    // 5. the engine's coverage check of the missing categories, from every community's gate
    const demand: DemandSite[] = result.communities.map((c) => ({
      id: c.name,
      name: c.name,
      uid: (c as Community & { uid?: string }).uid ?? null,
      xy: c.centroid,
      ...(c.label_xy ? { label_xy: c.label_xy } : {}),
      bd09: frame.toLngLat(c.centroid[0], c.centroid[1]),
      gate: (c as Community & { gate?: DemandSite['gate'] }).gate ?? 'location',
      straight_m: Math.hypot(c.centroid[0], c.centroid[1]),
      merged: [],
    }));
    const checked = (p: Poi) => p.source === 'baidu' || p.source === 'gov';
    const set: CheckSet = {
      rule: {},
      facilities: Object.fromEntries(add.map((c) => [c, facilitiesFor(result.pois.filter(checked), [c])])),
      knownRadius: Object.fromEntries(
        add.map((c) => {
          const inv = inventory.get(c);
          return [c, inv?.complete ? Infinity : (inv?.radius_m ?? 0)];
        }),
      ),
    };
    const matrix: MatrixFn = async (step, origins, destinations) =>
      meter.run(
        step,
        origins.length * destinations.length,
        (o) => client.routeMatrixWalking(origins, destinations, { ...o, partial: true }),
        (res) => res.stats.routesRequested,
      );
    const cov = await runCoverage({
      meter,
      frame,
      matrix,
      demand,
      set,
      onRound: (round, routes) => console.log(`  coverage round ${round}: ${routes} routes`),
      onNearest: (routes) => console.log(`  nearest top-up: ${routes} routes`),
      warn: (m) => console.warn(`  ${m}`),
    });
    const byName = new Map(cov.communities.map((c) => [c.name, c]));
    for (const c of result.communities) {
      const got = byName.get(c.name);
      if (!got) throw new Error(`${id}: no coverage answer for ${c.name}`);
      for (const cat of add) {
        const k = got.checks[cat];
        c.checks[cat] = k;
        console.log(
          `  check ${c.name} ${cat}: ${k.status}${k.verified ? '' : '(待核实)'} ${k.route_m} m (直线 ${Math.round(k.straight_m)}) via ${k.via ?? '-'}`,
        );
      }
      const worst = worstStatus(Object.values(c.checks));
      if (worst) c.worst_status = worst;
      else delete c.worst_status;
    }

    // 6. everything read over all categories: gray areas, counts, inventory, 圈内设施, the rule, notes
    result.gray_areas = grayAreas(result);
    const stats = result.stats as Record<string, unknown>;
    stats.community_status_counts = statusCounts(result.communities);
    stats.facility_counts = {
      ...(stats.facility_counts as Record<string, number> | undefined),
      ...Object.fromEntries(add.map((c) => [c, countFacilities(result.pois, c)])),
    };
    stats.facility_inventory = {
      ...(stats.facility_inventory as Record<string, unknown> | undefined),
      ...Object.fromEntries(add.flatMap((c) => (inventory.get(c) ? [[c, inventory.get(c)]] : []))),
    };
    stats.facility_stats = facilityStats(result);
    if (fused.summaries.length) {
      const lists = new Set(fused.summaries.map((x) => x.list));
      const prior = (stats.official as { list?: string }[] | undefined) ?? [];
      stats.official = [...prior.filter((x) => !lists.has(x.list ?? '')), ...fused.summaries];
    }
    if (meta.rule_m) for (const c of add) meta.rule_m[c] = 1000;
    const quota = usage(sc.client);
    setNote(
      meta,
      NOTE_PREFIX,
      `${NOTE_PREFIX}${add.join('、')}，${today}）：与${have.join('、')}同一规则（步行 1 公里）逐小区实测。设施为以片区中心为圆心 ${FACILITY_RADIUS_M} 米的百度地点检索（${keywords.join('、')}）` +
        (browserKept ? `，地图前端补充 ${browserKept} 处` : '') +
        (fused.summaries.length ? '，并与官方名录核对' : '') +
        `；判定为百度批量算路从每个小区出入口逐轮实测、最近设施补算（engine runCoverage，apps/server/scripts/add-categories.ts）。${have.join('、')}的判定未改动。`,
    );
    for (const a of fused.attribution) if (!meta.attribution.includes(a)) meta.attribution.push(a);
    const counts = stats.community_status_counts as { by_category?: Record<string, Record<string, number>> };
    console.log(
      `  counts ${JSON.stringify(Object.fromEntries(add.map((c) => [c, counts.by_category?.[c]])))}`,
    );
    console.log(
      `  gray ${result.gray_areas.map((g) => `${g.kind}${g.min_missing}:${Math.round(g.area_m2)}`).join(' ')}`,
    );
    console.log(
      `  quota so far: place +${quota.place - before.place}, routes +${quota.routematrix_walking - before.routematrix_walking}`,
    );
    if (!dryRun) {
      writeFileSync(file, JSON.stringify(result) + (raw.endsWith('\n') ? '\n' : ''));
      console.log(`  → ${file}`);
    }
  }
} finally {
  if (dryRun) {
    const misses = sc.misses();
    console.log(`\ndry run: ${misses.length} requests not in the cache`);
    console.log(JSON.stringify(missCost(misses)));
  } else printLedger('ledger after', sc.client, before);
  sc.close();
}
