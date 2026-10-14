/**
 * Prefetches the walking-route evidence (GET /api/route) of the samples, so the demo never waits and
 * the sample mode (no keys) can show it too: for every verified 伪覆盖 check of data/samples/*.json,
 * Baidu's walking route (directionlite, steps_info) from the community to the facility the check
 * routed to, through the
 * shared cache and ledger, written to data/samples/routes/<sample id>.json. The server reads those
 * files as stored routes (apps/server/src/route.ts), keyed by the same OD pair as its own lookups.
 *
 *   cd apps/server
 *   node --env-file=../../.env.local --conditions=source --import tsx scripts/prefetch-routes.ts --dry-run
 *   node --env-file=../../.env.local --conditions=source --import tsx scripts/prefetch-routes.ts [--max 40]
 *   node --env-file=../../.env.local --conditions=source --import tsx scripts/prefetch-routes.ts --cached-only
 *
 * Routes already in the files are kept as they are (a rerun rewrites the same files), except the ones
 * older versions fetched only for GB 50180-2018 checks, which are dropped; a live run stops
 * before it could bill more than --max directionlite requests (default 40) and prints the ledger
 * before and after; --dry-run answers from a copy of the cache and lists what a live run would request;
 * --cached-only writes what the cache already holds without any request.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkedCategories, HARD_CATEGORIES, type AnalysisResult, type HardCategory } from '@zoudedao/core';
import type { StoredRoute } from '../src/history.js';
import { checkPair, routeKey, toStoredRoute, type CheckPair } from '../src/route.js';
import { missCost, openScriptClient, printLedger, REPO_ROOT, usage } from './script-client.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
/** Only what the cache already holds (no request at all), but written to the files. */
const cachedOnly = args.includes('--cached-only');
const at = args.indexOf('--max');
const max = at >= 0 ? Number(args[at + 1]) : 40;
if (!Number.isInteger(max) || max < 0) throw new Error('--max 须为非负整数');

const SAMPLES = ['zj-a', 'zj-b', 'zj-c', 'zj-v'];
const samplesDir = join(REPO_ROOT, 'data/samples');
const routesDir = join(samplesDir, 'routes');

interface RouteEntry extends StoredRoute {
  community: string;
  category: HardCategory;
  /** The rule whose verified 伪覆盖 this walk is the evidence of (older files also list gb50180). */
  rules: string[];
  facility: string;
  facility_uid: string;
}

interface RouteFile {
  analysis_id: string;
  note: string;
  routes: RouteEntry[];
}

const NOTE =
  '已核实伪覆盖判定的步行路线证据：从小区（实时样例为出入口，zj-a 为 OSM 轮廓几何中心）到判定经由的设施入口，百度地图轻量步行路线 directionlite/v1/walking（steps_info=1）。由 apps/server/scripts/prefetch-routes.ts 经缓存与配额账本获取；GET /api/route 按起终点（1e-5°）直接返回这些路线，不再调用百度接口。distance_m、duration_s 是这条路线自己的距离与耗时，与判定所用的批量算路 route_m 可能略有差别。';

interface Want {
  sample: string;
  community: string;
  category: HardCategory;
  pair: CheckPair;
}

const results = new Map(
  SAMPLES.map((id) => [
    id,
    JSON.parse(readFileSync(join(samplesDir, `${id}.json`), 'utf8')) as AnalysisResult,
  ]),
);
const files = new Map<string, RouteFile>(
  SAMPLES.map((id) => {
    const file = join(routesDir, `${id}.json`);
    const old = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as RouteFile) : undefined;
    // only the task rule is checked now: routes kept for GB 50180 checks alone go
    const routes = (old?.routes ?? [])
      .filter((r) => r.rules.includes('task'))
      .map((r) => ({ ...r, rules: ['task'] }));
    return [id, { analysis_id: id, note: NOTE, routes }];
  }),
);

/** Verified 伪覆盖 checks with a routed facility, in the order they are fetched. */
function wanted(): Want[] {
  const out: Want[] = [];
  for (const sample of SAMPLES) {
    const r = results.get(sample)!;
    for (const c of r.communities) {
      for (const category of checkedCategories(r)) {
        const k = c.checks[category];
        if (!k?.verified || (k.status_main !== '伪覆盖' && category !== '小学')) continue;
        const pair = checkPair(r, sample, { community: c.name, category });
        if ('kind' in pair) {
          console.warn(`${sample} ${c.name} ${category}: no routed facility (${pair.kind})`);
          continue;
        }
        out.push({ sample, community: c.name, category, pair });
      }
    }
  }
  return out;
}

const offline = dryRun || cachedOnly;
const sc = openScriptClient(offline);
const before = usage(sc.client);
if (!offline) printLedger('ledger before', sc.client);
const spent = () => sc.client.ledger.usage('directionlite_walking').used - before.directionlite_walking;
const counts = { pairs: 0, kept: 0, cached: 0, fetched: 0, no_route: 0, skipped: 0, dry_misses: 0 };

try {
  for (const w of wanted()) {
    const file = files.get(w.sample)!;
    const key = routeKey(w.pair.from, w.pair.to);
    const have = file.routes.find((r) => routeKey(r.from_bd09, r.to_bd09) === key);
    if (have) {
      // the same walk may be the evidence of another category as well
      if (have.community === w.community && have.category === w.category) counts.kept++;
      continue;
    }
    counts.pairs++;
    if (!offline && spent() >= max) {
      counts.skipped++;
      continue;
    }
    let route: Awaited<ReturnType<typeof sc.client.walkingRoute>>;
    try {
      route = await sc.client.walkingRoute(w.pair.from, w.pair.to, { stepsInfo: true });
    } catch (err) {
      // offline runs only know the cache: everything else is what a live run would request
      if (offline) {
        counts.dry_misses++;
        continue;
      }
      console.error(
        `${w.sample} ${w.community} ${w.category}: ${err instanceof Error ? err.message : String(err)}`,
      );
      break; // key, quota or network: stop, keep what is written
    }
    if (!route) {
      counts.no_route++;
      console.warn(`${w.sample} ${w.community} ${w.category}: 百度没有步行路线`);
      continue;
    }
    if (route.via === 'cache') counts.cached++;
    else counts.fetched++;
    const stored = toStoredRoute(w.pair.from, w.pair.to, route, new Date());
    file.routes.push({
      community: w.community,
      category: w.category,
      rules: ['task'],
      facility: w.pair.facility.name,
      facility_uid: w.pair.facility.uid,
      ...stored,
    });
    console.log(
      `${w.sample} ${w.community} → ${w.pair.facility.name} (${w.category}): ` +
        `${route.distanceM} m / ${route.durationS} s (routematrix ${w.pair.check.route_m} m) [${route.via}]`,
    );
  }
} finally {
  const billed = offline ? 0 : spent();
  if (offline) {
    console.log(`\ncache only: a live run would request ${JSON.stringify(missCost(sc.misses()))}`);
  } else {
    printLedger('\nledger after', sc.client, before);
  }
  sc.close();
  console.log(`\n${JSON.stringify({ ...counts, max, directionlite_billed: billed })}`);
}

if (!dryRun) {
  mkdirSync(routesDir, { recursive: true });
  for (const [id, file] of files) {
    if (!file.routes.length) continue;
    const order = (r: RouteEntry) => `${r.community}\u0000${HARD_CATEGORIES.indexOf(r.category)}`;
    file.routes.sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
    writeFileSync(join(routesDir, `${id}.json`), `${JSON.stringify(file, null, 1)}\n`);
    console.log(`wrote data/samples/routes/${id}.json (${file.routes.length} routes)`);
  }
}
