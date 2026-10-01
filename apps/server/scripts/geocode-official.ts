/**
 * Adds BD-09 coordinates to the facility lists in data/official/*.json (Baidu geocoding, one call per
 * entry without `bd09`; answers are cached in BAIDU_CACHE_PATH and counted in its ledger like every
 * other call). Catchment tables and exclusions (other `kind`s) are left alone.
 *
 *   cd apps/server
 *   node --env-file=../../.env.local --conditions=source --import tsx scripts/geocode-official.ts \
 *     [--only <list id>] [--towns 张江镇,北蔡镇] [--max 150] [--dry-run]
 *
 * --max caps the geocoding calls of the run (default 150; the personal tier allows 5,000 a day, but
 * the rest of the day's work needs some too). Entries are taken active first, then those whose town
 * (markets) or 2025 catchment towns (schools) are in --towns, in that order, then private schools and
 * other entries without any town, then the rest; rerunning continues where the last run stopped.
 * --dry-run answers from a copy of the cache only and writes nothing.
 *
 * Geocoding can land far from the real door (海科路1650号 once came back 3.5 km off with
 * precise = 0), so every answer keeps its precision flags and points outside the list's district
 * box are rejected; the engine only trusts a geocoded point when no Baidu POI confirms the entry.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { missCost, openScriptClient, printLedger, REPO_ROOT, usage } from './script-client.js';

interface Entry {
  name: string;
  address?: string;
  status?: string;
  sector?: string;
  town?: string;
  catchment_towns?: string[];
  bd09?: [number, number];
  geocode?: { precise: boolean; confidence: number | null; level: string | null; query: string };
}
interface OfficialList {
  id: string;
  kind?: string;
  region: { city: string; district?: string };
  entries: Entry[];
}

// generous boxes (BD-09) per district: an answer outside is a mislocation
const DISTRICT_BOX: Record<string, [number, number, number, number]> = {
  浦东新区: [121.45, 30.85, 122.0, 31.42],
};

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dryRun = args.includes('--dry-run');
const only = option('--only');
const towns = (option('--towns') ?? '').split(',').filter(Boolean);
const max = Number(option('--max') ?? 150);

/**
 * Lower sorts first: active; then by the first --towns town the entry belongs to; then private schools
 * (no 地段, so no town to go by); then other entries without a town; then the rest.
 */
function rank(e: Entry): number {
  const inactive = e.status && e.status !== 'active' ? 1000 : 0;
  const mine = [e.town, ...(e.catchment_towns ?? [])].filter((t): t is string => !!t);
  const hit = towns.findIndex((t) => mine.includes(t));
  if (hit >= 0) return inactive + hit;
  if (mine.length) return inactive + 500;
  return inactive + (e.sector === '民办' ? 50 : 100);
}

const dir = join(REPO_ROOT, 'data/official');
const sc = openScriptClient(dryRun);
const before = usage(sc.client);
if (!dryRun) printLedger('ledger before', sc.client);
let calls = 0;
try {
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()) {
    const path = join(dir, file);
    const list = JSON.parse(readFileSync(path, 'utf8')) as OfficialList;
    if ((list.kind ?? 'facilities') !== 'facilities' || !Array.isArray(list.entries)) continue;
    if (only && list.id !== only) continue;
    const box = list.region.district ? DISTRICT_BOX[list.region.district] : undefined;
    const todo = list.entries
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => !e.bd09 && e.address)
      .sort((a, b) => rank(a.e) - rank(b.e) || a.i - b.i);
    let added = 0;
    let rejected = 0;
    let missing = 0;
    for (const { e } of todo) {
      if (calls >= max) break;
      const query = `${list.region.city}${list.region.district ?? ''}${e.address}`;
      calls++;
      let g: Awaited<ReturnType<typeof sc.client.geocode>>;
      try {
        g = await sc.client.geocode(query, { city: list.region.city });
      } catch (err) {
        // a dry run only lists what it would ask for
        if (!dryRun) throw err;
        missing++;
        continue;
      }
      if (!g) {
        missing++;
        continue;
      }
      const [lng, lat] = g.location;
      if (box && !(lng >= box[0] && lat >= box[1] && lng <= box[2] && lat <= box[3])) {
        rejected++;
        continue;
      }
      e.bd09 = [Number(lng.toFixed(6)), Number(lat.toFixed(6))];
      e.geocode = { precise: g.precise, confidence: g.confidence ?? null, level: g.level ?? null, query };
      added++;
    }
    const left = list.entries.filter((e) => !e.bd09).length;
    if (!dryRun && added) writeFileSync(path, JSON.stringify(list, null, 1) + '\n');
    console.log(
      `${file}: +${added} geocoded, ${rejected} rejected (outside ${list.region.district ?? 'box'}), ${missing} without result; ${left} of ${list.entries.length} still without bd09`,
    );
  }
} finally {
  if (dryRun) console.log(`dry run: a live run would request ${JSON.stringify(missCost(sc.misses()))}`);
  else printLedger('ledger after', sc.client, before);
  sc.close();
}
console.log(`geocoding calls: ${calls} (cap ${max})`);
