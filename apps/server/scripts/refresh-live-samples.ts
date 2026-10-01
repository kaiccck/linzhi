/**
 * Re-runs the live engine for the saved live samples (data/samples/zj-b, zj-c, zj-v by default) with
 * their own centres, labels and profiles, and the official data of data/official loaded the way
 * the server does (apps/server/src/official.ts: facility lists, the 对口地段 table, the exclusions), so
 * the files carry what the engine produces today: the 民生设施 union, stats.facility_stats, the
 * 买菜替代 and communities[].catchment (and no longer the GB 50180-2018 checks_gb). Every Baidu answer the samples
 * were built from is in the cache, so only what is new costs quota; `--dry-run` shows what that would
 * be, from a copy of the cache, without any request.
 *
 *   cd apps/server
 *   node --env-file=../../.env.local --conditions=source --import tsx scripts/refresh-live-samples.ts --dry-run
 *   node --env-file=../../.env.local --conditions=source --import tsx scripts/refresh-live-samples.ts [zj-b …]
 *
 * A live run stops (writing nothing further) before it could spend more than --max-place pages or
 * --max-routes routematrix routes in total (defaults 12 and 300), and prints the ledger before and after.
 * --max-place 0 answers place searches from a copy of the cache only (as --dry-run does) and stops at
 * the first one that is not cached.
 *
 * --detail-calls N: up to N place/v3/detail requests per sample (10 uids each; the tier's default is 5
 * on personal, 10 on enterprise), so a sample can look up every POI the browser found.
 *
 * --browser-pois <file>: a JSON object mapping sample id → the POST /api/analyze `browser_pois` array
 * (what the browser JSAPI's LocalSearch found around that centre). The engine looks up the ones place
 * search did not return with place/v3/detail (10 uids a request, counted against --max-place);
 * --dry-run lists each detail request a live run would make, with the uids and names.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AnalysisResult, LngLat } from '@zoudedao/core';
import { analyze, browserPois, type BrowserPoi, type EngineInput, type Profile } from '@zoudedao/engine';
import { loadOfficialData } from '../src/official.js';
import {
  detailMisses,
  missCost,
  openScriptClient,
  printLedger,
  REPO_ROOT,
  spendGuard,
  usage,
} from './script-client.js';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string, fallback: number) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const WITH_VALUE = new Set(['--max-place', '--max-routes', '--browser-pois', '--detail-calls']);
const dryRun = flag('--dry-run');
const limits = { place: option('--max-place', 12), routematrix_walking: option('--max-routes', 300) };
// --detail-calls: place/v3/detail requests per sample (10 uids each) instead of the tier's (5 personal):
// a sample may look up every POI the browser found, a live check keeps its budget
const detailCalls = args.includes('--detail-calls') ? option('--detail-calls', 5) : null;
const ids = args.filter((a, i) => !a.startsWith('--') && !WITH_VALUE.has(args[i - 1] ?? ''));
const samples = ids.length ? ids : ['zj-b', 'zj-c', 'zj-v'];

// --browser-pois: sample id → browser_pois, validated as the server does (invalid items dropped)
const browserFile = args.includes('--browser-pois') ? args[args.indexOf('--browser-pois') + 1] : undefined;
const browser = new Map<string, BrowserPoi[]>();
if (browserFile) {
  const raw = JSON.parse(readFileSync(browserFile, 'utf8')) as Record<string, unknown>;
  for (const [id, list] of Object.entries(raw)) {
    const valid = browserPois(list);
    browser.set(id, valid);
    const given = Array.isArray(list) ? list.length : 0;
    console.log(`browser_pois ${id}: ${valid.length} valid of ${given}`);
  }
}
const browserNames = new Map([...browser.values()].flat().map((p) => [p.uid, p.name]));

const official = loadOfficialData(join(REPO_ROOT, 'data/official'), (m) => console.warn(m));
const sc = openScriptClient(dryRun);
const before = usage(sc.client);
if (!dryRun) printLedger('ledger before', sc.client);
// --max-place 0: place searches only from (a copy of) the cache
const placeCache = !dryRun && limits.place === 0 ? openScriptClient(true) : null;
const client = dryRun ? sc.client : spendGuard(sc.client, limits, placeCache?.client);

interface LiveMetaLike {
  center_bd09: LngLat;
  center_label?: string;
  profile?: Profile;
}

type Counts = {
  main?: Record<string, number>;
  by_category?: Record<string, Record<string, number>>;
  unverified?: number;
};
const summary = (r: AnalysisResult) => {
  const s = r.stats;
  const task = s.community_status_counts as Counts | undefined;
  const catchment = s.catchment as { matched?: number; communities?: number; routed?: number } | undefined;
  return {
    name: r.meta.name,
    area_iso15_km2: s.area_iso15_km2,
    n_samples: s.n_samples,
    communities: r.communities.length,
    main: task?.main,
    unverified: task?.unverified,
    by_category: task?.by_category,
    catchment:
      catchment && `${catchment.matched}/${catchment.communities} matched, ${catchment.routed} routed`,
    gray_areas: r.gray_areas?.length ?? 0,
    pois: r.pois.length,
    facility_counts: s.facility_counts,
    fresh_alternatives: s.fresh_alternatives,
    browser_pois: s.browser_pois,
  };
};

try {
  for (const id of samples) {
    const file = join(REPO_ROOT, 'data/samples', `${id}.json`);
    const old = JSON.parse(readFileSync(file, 'utf8')) as AnalysisResult;
    const meta = old.meta as AnalysisResult['meta'] & LiveMetaLike;
    const input: EngineInput = {
      center_bd09: meta.center_bd09,
      ...(meta.center_label ? { label: meta.center_label } : {}),
      profile: meta.profile ?? 'adult',
    };
    const found = browser.get(id);
    console.log(
      `\n${id}: ${meta.name} ${JSON.stringify(input)}${found ? ` + ${found.length} browser_pois` : ''}`,
    );
    if (found?.length) input.browser_pois = found;
    let result: AnalysisResult;
    try {
      result = await analyze(
        input,
        { client, official: official.lists, catchment: official.catchments, exclusions: official.exclusions },
        () => {},
        detailCalls === null ? {} : { budget: { detailCalls } },
      );
    } catch (err) {
      console.error(`${id}: ${err instanceof Error ? err.message : String(err)}`);
      if (!dryRun) throw err;
      continue;
    }
    const warnings = (result.meta as { warnings?: string[] }).warnings ?? [];
    console.log('  before', JSON.stringify(summary(old)));
    console.log('  after ', JSON.stringify(summary(result)));
    // what changed in the task-rule checks, community by community
    const was = new Map(old.communities.map((c) => [c.name, c]));
    for (const c of result.communities) {
      const o = was.get(c.name);
      for (const cat of ['小学', '菜市场', '药店'] as const) {
        const a = o?.checks[cat];
        const b = c.checks[cat];
        if (
          !a ||
          a.status !== b.status ||
          a.verified !== b.verified ||
          a.via !== b.via ||
          a.route_m !== b.route_m
        ) {
          console.log(
            `  check ${c.name} ${cat}: ${a ? `${a.status}${a.verified ? '' : '(待核实)'} ${a.route_m} via ${a.via ?? '-'}` : 'new'} → ${b.status}${b.verified ? '' : '(待核实)'} ${b.route_m} via ${b.via ?? '-'}`,
          );
        }
      }
      if (c.catchment)
        console.log(
          `  catchment ${c.name}: ${c.catchment.school} ${c.catchment.route_m ?? '-'} m (${c.catchment.matched_by})`,
        );
      // 买菜替代 of the 菜市场 gaps: shop, why, walk; null = none; - = not looked
      const k = c.checks['菜市场'];
      if (k.verified && k.status_main !== '覆盖') {
        const alt =
          k.alt === undefined
            ? '-'
            : k.alt === null
              ? 'null'
              : `${k.alt.name} ${k.alt.kind} ${k.alt.route_m} m`;
        console.log(`  alt ${c.name} (${k.status_main} ${k.route_m} m): ${alt}`);
      }
    }
    const s = result.stats as Record<string, unknown>;
    // residential dedupe: which compounds were merged or dropped, and the list before and after
    const dedupe = s.residential_dedupe as { items?: unknown[] } | undefined;
    for (const item of dedupe?.items ?? []) console.log(`  dedupe ${JSON.stringify(item)}`);
    const names = (r: AnalysisResult) => r.communities.map((c) => c.name);
    const gone = names(old).filter((n) => !names(result).includes(n));
    const added = names(result).filter((n) => !names(old).includes(n));
    if (gone.length || added.length)
      console.log(`  communities -[${gone.join('、')}] +[${added.join('、')}]`);
    for (const p of result.pois.filter((x) => x.found_by === 'jsapi'))
      console.log(`  jsapi ${p.name} ${p.cat} ${p.tag ?? ''}`);
    console.log(
      `  fresh routes ${s.fresh_alt_routes}, budget limited ${s.fresh_alt_budget_limited}, failed cells ${s.fresh_alt_failed_cells}`,
    );
    for (const n of (result.meta as { notes?: string[] }).notes ?? []) {
      if (/名录|对口|排除|买菜替代|小区去重|地图前端/.test(n)) console.log(`  note ${n}`);
    }
    console.log('  quota_used', JSON.stringify(result.stats.quota_used));
    if (warnings.length) console.log('  warnings', JSON.stringify(warnings));
    for (const f of result.stats.facility_stats ?? []) {
      const near = f.nearest_s === null ? '—' : `${(f.nearest_s / 60).toFixed(1)} min ${f.nearest ?? ''}`;
      console.log(`  ${f.category}\tfound ${f.found}\twalk ${f.walk}\tcircle ${f.circle}\tnearest ${near}`);
    }
    if (dryRun) continue;
    writeFileSync(file, JSON.stringify(result));
    console.log(`  wrote ${file}`);
  }
} finally {
  if (dryRun) {
    const cost = missCost(sc.misses());
    console.log(`\ndry run: a live run would request ${JSON.stringify(cost)}`);
    for (const line of detailMisses(sc.misses(), browserNames)) console.log(`  ${line}`);
  } else {
    printLedger('\nledger after', sc.client, before);
  }
  sc.close();
  placeCache?.close();
}
