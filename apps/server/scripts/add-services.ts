/**
 * Adds the everyday services (中学、文化、健身、银行、快递、便利店、餐饮) to saved samples, as the live
 * engine searches them since 2026-10-10: the same two place searches around the sample's centre
 * (engine searchServices: the services union, then the restaurants), cleaned and de-duplicated
 * against the sample's own inventory, then the 圈内设施 counts recomputed. Nothing else changes: the
 * per-community checks, the field and the notes about them stay as they were.
 *
 *   cd apps/server
 *   node --env-file=../../.env.local --conditions=source --import tsx scripts/add-services.ts --dry-run
 *   node --env-file=../../.env.local --conditions=source --import tsx scripts/add-services.ts [zj-a …] [--max-place 40]
 *
 * Per sample at most 8 place pages (3 + 5); a live run stops before it could spend more than
 * --max-place place requests in total (default 40) and prints the ledger before and after; --dry-run
 * answers from a copy of the cache only and writes nothing.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { countFacilities, facilityStats, localFrame, type AnalysisResult } from '@zoudedao/core';
import {
  LIVELIHOOD_RADIUS_M,
  Meter,
  resolveBudget,
  searchServices,
  SERVICE_CATEGORIES,
  serviceCaps,
  stepCaps,
  type EngineClient,
} from '@zoudedao/engine';
import { missCost, openScriptClient, printLedger, REPO_ROOT, spendGuard, usage } from './script-client.js';

const NOTE_PREFIX = '生活服务（';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const at = args.indexOf('--max-place');
const limits = { place: at >= 0 ? Number(args[at + 1]) : 40, routematrix_walking: 0 };
const ids = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--max-place');
const samples = ids.length ? ids : ['zj-a', 'zj-b', 'zj-c', 'zj-v'];
const today = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10); // Beijing date

const sc = openScriptClient(dryRun);
const before = usage(sc.client);
if (!dryRun) printLedger('ledger before', sc.client);
const client: EngineClient = dryRun ? sc.client : spendGuard(sc.client, limits);

type Meta = AnalysisResult['meta'] & { notes?: string[] };

function setNote(meta: Meta, prefix: string, text: string): void {
  const notes = (meta.notes ??= []);
  const i = notes.findIndex((n) => n.startsWith(prefix));
  if (i >= 0) notes[i] = text;
  else notes.push(text);
}

try {
  for (const id of samples) {
    const file = join(REPO_ROOT, 'data/samples', `${id}.json`);
    const raw = readFileSync(file, 'utf8');
    const result = JSON.parse(raw) as AnalysisResult;
    const meta = result.meta as Meta;
    console.log(`\n${id}: ${meta.name}`);
    const [lng, lat] = meta.center_bd09;
    const frame = localFrame(lng, lat);
    // a rerun replaces what an earlier one added
    const kept = result.pois.filter((p) => !SERVICE_CATEGORIES.includes(p.cat));
    const budget = resolveBudget('enterprise');
    const meter = new Meter(stepCaps(budget), serviceCaps(budget), { onQuota: () => {} });
    const warnings: string[] = [];
    const found = await searchServices({
      meter,
      client,
      center: [lng, lat],
      frame,
      existing: kept,
      warn: (m) => warnings.push(m),
    });
    if (!found) {
      console.log(`  no answer: ${warnings.join('；') || 'no budget'}`);
      continue;
    }
    for (const w of warnings) console.log(`  warning: ${w}`);
    result.pois = [...kept, ...found.pois];

    const stats = result.stats as Record<string, unknown>;
    stats.facility_counts = {
      ...(stats.facility_counts as Record<string, number> | undefined),
      ...Object.fromEntries(SERVICE_CATEGORIES.map((c) => [c, countFacilities(result.pois, c)])),
    };
    stats.facility_inventory = {
      ...(stats.facility_inventory as Record<string, unknown> | undefined),
      ...found.inventory,
    };
    const queries = ((stats.place_queries as { keywords: string }[] | undefined) ?? []).filter(
      (q) => !found.queries.some((f) => f.keywords === q.keywords),
    );
    stats.place_queries = [...queries, ...found.queries];
    stats.facility_stats = facilityStats(result);

    const cut = Object.entries(found.inventory)
      .filter(([, inv]) => inv && !inv.complete)
      .map(([cat, inv]) => `${cat}只统计到离中心 ${Math.round(inv!.radius_m)} 米`);
    setNote(
      meta,
      NOTE_PREFIX,
      `${NOTE_PREFIX}${today}）：${SERVICE_CATEGORIES.filter((c) => c !== '餐饮').join('、')}用一次百度地点检索（$ 并集），餐饮单独检索，半径 ${LIVELIHOOD_RADIUS_M} 米，与已有设施去重后补充 ${found.pois.length} 处（apps/server/scripts/add-services.ts）。` +
        '餐饮不含咖啡厅、茶座、酒吧与甜品店，长者食堂计入养老，快递含菜鸟驿站与快递柜，银行不含 ATM。到每处的步行时间按步行时间场在其入口处的取值估算，不是逐处实测。' +
        (cut.length ? `检索页数用完：${cut.join('，')}。` : ''),
    );
    const byCat = Object.fromEntries(SERVICE_CATEGORIES.map((c) => [c, countFacilities(result.pois, c)]));
    console.log(`  added ${found.pois.length}: ${JSON.stringify(byCat)}`);
    const walk = (stats.facility_stats as { category: string; found: number; walk: number }[])
      .filter((s) => SERVICE_CATEGORIES.includes(s.category as never))
      .map((s) => `${s.category} ${s.walk}/${s.found}`);
    console.log(`  walk 15′: ${walk.join(' · ')}`);
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
