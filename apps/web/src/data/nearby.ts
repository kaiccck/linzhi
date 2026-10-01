/**
 * 浏览器端周边检索: the facilities around a centre as Baidu's own map search finds them (JSAPI
 * LocalSearch, billed to the JS API 地点检索 quota). The server's place search leaves out shops that
 * are in Baidu's database (张江: 盒马鲜生(陆悦天地店), 联华超市(川和路店)); this search finds them.
 * It returns names and uids only, no category: the server reads each new uid's details (place/v3/detail)
 * and its own rules decide what the shop is (POST /api/analyze `browser_pois`, docs/api.md).
 *
 * Best effort: a keyword that fails or times out is skipped, and the whole search never holds a check
 * up for long. One centre's result is kept for the day, so a check run again spends nothing.
 */
import type { BMapNS } from '../map/loadBaidu.js';

/** The facility keywords of the server's searches, and the 买菜替代 ones (蔬菜, 果蔬, 生鲜, 超市). */
export const NEARBY_KEYWORDS = [
  '小学',
  '社区卫生',
  '幼儿园',
  '菜市场',
  '菜场',
  '农贸市场',
  '生鲜市场',
  '生鲜超市',
  '药店',
  '药房',
  '蔬菜',
  '果蔬',
  '生鲜',
  '超市',
] as const;

/** The server's facility search radius (a gate up to 1,100 m out, plus the 1 km rule). */
export const NEARBY_RADIUS_M = 2100;
/** At most this many go to the server (the request body's own cap). */
export const NEARBY_MAX = 400;

/** One POI found, as POST /api/analyze takes it. */
export interface BrowserPoi {
  uid: string;
  name: string;
  /** the keyword that found it first */
  keyword: string;
  bd09: [number, number];
}

/** The personal tier allows 3 searches a second: one every 400 ms stays under it. */
const GAP_MS = 400;
/** A search that has not answered by then is skipped. */
const SEARCH_TIMEOUT_MS = 6000;
/** Results per page (Baidu's maximum), and pages per keyword (超市 runs past one page in 张江). */
const PAGE = 50;
const MAX_PAGES = 2;
/** The whole search gives up after this long: the check goes on with what it has. */
const TOTAL_MS = 25000;
const CACHE_PREFIX = 'zdd:nearby:v2:';

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });

interface Page {
  rows: BrowserPoi[];
  pages: number;
}

/**
 * One keyword, up to MAX_PAGES pages, on one LocalSearch (a page is turned on the search that found
 * the first, so it costs one more query and no repeat). An empty first answer is asked once more:
 * Baidu answers nothing when the searches come too fast. Null when every attempt failed.
 */
async function searchKeyword(
  B: BMapNS,
  center: [number, number],
  keyword: string,
  signal: AbortSignal,
  gap: number,
): Promise<BrowserPoi[] | null> {
  const at = new B.Point(center[0], center[1]);
  let settle: ((v: Page | null) => void) | null = null;
  const ls = new B.LocalSearch(at, {
    pageCapacity: PAGE,
    onSearchComplete: (res) => {
      const done = settle;
      settle = null;
      if (!done) return;
      const r = Array.isArray(res) ? res[0] : res;
      if (!r) return done({ rows: [], pages: 0 });
      const rows: BrowserPoi[] = [];
      for (let i = 0; i < r.getCurrentNumPois(); i++) {
        const p = r.getPoi(i);
        if (!p?.uid || !p.point || !/^[0-9a-f]{24}$/.test(p.uid)) continue;
        rows.push({
          uid: p.uid,
          name: String(p.title ?? '').slice(0, 60),
          keyword,
          bd09: [Number(p.point.lng.toFixed(6)), Number(p.point.lat.toFixed(6))],
        });
      }
      done({ rows, pages: r.getNumPages() });
    },
  });
  const ask = (go: () => void): Promise<Page | null> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        settle = null;
        resolve(null);
      }, SEARCH_TIMEOUT_MS);
      settle = (v) => {
        clearTimeout(timer);
        resolve(v);
      };
      try {
        go();
      } catch {
        clearTimeout(timer);
        settle = null;
        resolve(null);
      }
    });

  const search = () => ask(() => ls.searchNearby(keyword, at, NEARBY_RADIUS_M));
  let first = await search();
  if (first && !first.rows.length && !signal.aborted) {
    await sleep(gap * 2, signal);
    first = (await search()) ?? first;
  }
  if (!first) return null;
  const rows = [...first.rows];
  for (let page = 1; page < Math.min(first.pages, MAX_PAGES) && !signal.aborted; page++) {
    await sleep(gap, signal);
    const more = await ask(() => ls.gotoPage(page));
    if (more) rows.push(...more.rows);
  }
  return rows;
}

const cacheKey = (center: [number, number]) =>
  `${CACHE_PREFIX}${center[0].toFixed(5)},${center[1].toFixed(5)}`;
const today = () => new Date().toISOString().slice(0, 10);

function readCache(center: [number, number]): BrowserPoi[] | null {
  try {
    const raw = localStorage.getItem(cacheKey(center));
    if (!raw) return null;
    const v = JSON.parse(raw) as { day?: string; pois?: BrowserPoi[] };
    return v.day === today() && Array.isArray(v.pois) ? v.pois : null;
  } catch {
    return null;
  }
}

function writeCache(center: [number, number], pois: BrowserPoi[]) {
  try {
    localStorage.setItem(cacheKey(center), JSON.stringify({ day: today(), pois }));
  } catch {
    // storage full or blocked: the next check searches again
  }
}

/**
 * Every keyword around the centre, one at a time, deduplicated by uid (the first keyword wins),
 * nearest first. `onProgress` reports keywords done. Resolves with what was found when the time runs
 * out or the check is cancelled; an empty list when nothing could be searched.
 */
export async function findNearby(
  B: BMapNS,
  center: [number, number],
  signal: AbortSignal,
  onProgress?: (done: number, total: number) => void,
  /**
   * tests: fewer keywords, no wait between searches; `cache` keeps the day cache for a keyword list
   * of its own (by default only the full search reads and writes it)
   */
  opts: { keywords?: readonly string[]; gapMs?: number; cache?: boolean } = {},
): Promise<BrowserPoi[]> {
  const keywords = opts.keywords ?? NEARBY_KEYWORDS;
  const gap = opts.gapMs ?? GAP_MS;
  // the day cache holds the full search only (a few keywords asked on their own never stand in for it)
  const own = opts.cache ?? !opts.keywords;
  const cached = own ? readCache(center) : null;
  if (cached) return cached;
  const deadline = Date.now() + TOTAL_MS;
  const found = new Map<string, BrowserPoi>();
  let failed = 0;
  let complete = true;
  for (const [i, keyword] of keywords.entries()) {
    if (signal.aborted || Date.now() > deadline) {
      complete = false;
      break;
    }
    if (i) await sleep(gap, signal);
    const rows = await searchKeyword(B, center, keyword, signal, gap);
    if (!rows) {
      failed++;
      complete = false;
      // three in a row: the JS quota is spent or the service is down, stop asking
      if (failed >= 3 && found.size === 0) break;
    } else for (const p of rows) if (!found.has(p.uid)) found.set(p.uid, p);
    onProgress?.(i + 1, keywords.length);
  }
  const d = (p: BrowserPoi) =>
    Math.hypot((p.bd09[0] - center[0]) * Math.cos((center[1] * Math.PI) / 180), p.bd09[1] - center[1]);
  const pois = [...found.values()].sort((a, b) => d(a) - d(b)).slice(0, NEARBY_MAX);
  if (own && complete && !signal.aborted) writeCache(center, pois);
  return pois;
}

/**
 * Dev only: `window.__zddNearby(lng, lat)` runs the search for any centre, for
 * apps/web/scripts/capture-nearby.mjs (the samples' refresh reads its file). Spends the JS quota.
 */
export function exposeNearby(load: () => Promise<BMapNS>) {
  (window as unknown as Record<string, unknown>).__zddNearby = async (
    lng: number,
    lat: number,
    keywords?: readonly string[],
  ) =>
    findNearby(
      await load(),
      [lng, lat],
      new AbortController().signal,
      undefined,
      keywords ? { keywords } : {},
    );
}
