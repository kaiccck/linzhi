/**
 * Adds BD-09 coordinates to the official facility lists in data/official/*.json (Baidu geocoding,
 * one call per entry without `bd09`; answers are cached in BAIDU_CACHE_PATH like every other call).
 *
 *   node --env-file=.env.local --conditions=source --import tsx apps/server/scripts/geocode-official.ts
 *
 * Geocoding can land far from the real door (海科路1650号 once came back 3.5 km off with
 * precise = 0), so every answer keeps its precision flags and points outside the list's district
 * box are rejected; the engine only trusts a geocoded point when no Baidu POI confirms the entry.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBaiduClient, loadBaiduConfig } from '@zoudedao/baidu';

interface Entry {
  name: string;
  address: string;
  town?: string;
  bd09?: [number, number];
  geocode?: { precise: boolean; confidence: number | null; level: string | null; query: string };
}
interface OfficialList {
  id: string;
  region: { city: string; district?: string };
  entries: Entry[];
}

// generous boxes (BD-09) per district: an answer outside is a mislocation
const DISTRICT_BOX: Record<string, [number, number, number, number]> = {
  浦东新区: [121.45, 30.85, 122.0, 31.42],
};

const root = fileURLToPath(new URL('../../../', import.meta.url));
const dir = join(root, 'data/official');
const client = createBaiduClient({ config: loadBaiduConfig(process.env, { cwd: root }) });
let calls = 0;
try {
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const path = join(dir, file);
    const list = JSON.parse(readFileSync(path, 'utf8')) as OfficialList;
    const box = list.region.district ? DISTRICT_BOX[list.region.district] : undefined;
    let added = 0;
    let rejected = 0;
    for (const e of list.entries) {
      if (e.bd09) continue;
      const query = `${list.region.city}${list.region.district ?? ''}${e.address}`;
      const g = await client.geocode(query, { city: list.region.city });
      calls++;
      if (!g) continue;
      const [lng, lat] = g.location;
      if (box && !(lng >= box[0] && lat >= box[1] && lng <= box[2] && lat <= box[3])) {
        rejected++;
        continue;
      }
      e.bd09 = [Number(lng.toFixed(6)), Number(lat.toFixed(6))];
      e.geocode = { precise: g.precise, confidence: g.confidence ?? null, level: g.level ?? null, query };
      added++;
    }
    writeFileSync(path, JSON.stringify(list, null, 1) + '\n');
    console.log(
      `${file}: +${added} geocoded, ${rejected} rejected (outside ${list.region.district ?? 'box'})`,
    );
  }
} finally {
  client.close();
}
console.log(`geocoding calls: ${calls}`);
