/**
 * Official facility lists (data/official/*.json, e.g. 浦东新区商务委's standardized-market list) that
 * the live engine fuses with Baidu POIs. A broken or missing file only costs the fusion, never the
 * server: it is skipped with a Chinese warning.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OfficialList } from '@zoudedao/engine';

export function loadOfficialLists(dir: string, warn: (message: string) => void = () => {}): OfficialList[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const lists: OfficialList[] = [];
  for (const file of files.sort()) {
    try {
      const list = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Partial<OfficialList>;
      if (typeof list.id !== 'string' || typeof list.category !== 'string' || !Array.isArray(list.entries)) {
        warn(`官方名录 ${file} 缺少 id、category 或 entries，已跳过`);
        continue;
      }
      lists.push(list as OfficialList);
    } catch (err) {
      warn(`官方名录 ${file} 无法读取，已跳过：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return lists;
}
