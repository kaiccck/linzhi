/**
 * 浏览器端周边检索 against a fake JSAPI LocalSearch: every keyword searched in turn, a POI kept once (the
 * first keyword wins), an empty answer asked once more, a second page turned on the same search, a
 * failing keyword skipped, and one centre's result kept for the day.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BMapNS } from '../map/loadBaidu.js';
import { findNearby } from './nearby.js';

type Row = { uid: string; title: string; lng: number; lat: number };
const uid = (n: number) => n.toString(16).padStart(24, '0');
const row = (n: number, title: string, lng = 121.62, lat = 31.19): Row => ({ uid: uid(n), title, lng, lat });

/** Answers per keyword: pages of rows; `null` = the search never answers. */
function fakeBaidu(answers: Record<string, (Row[] | null)[]>) {
  const calls: string[] = [];
  const tries = new Map<string, number>();
  class LocalSearch {
    private kw = '';
    constructor(
      _at: unknown,
      private readonly opts: { onSearchComplete(r: unknown): void },
    ) {}
    private answer(page: number) {
      const pages = answers[this.kw] ?? [[]];
      // an empty first answer is asked again: `tries` hands out the next of `pages[0]`'s repeats
      const rows = pages[page];
      if (rows === null || rows === undefined) return;
      queueMicrotask(() =>
        this.opts.onSearchComplete({
          getCurrentNumPois: () => rows.length,
          getPoi: (i: number) => ({
            uid: rows[i]!.uid,
            title: rows[i]!.title,
            point: { lng: rows[i]!.lng, lat: rows[i]!.lat },
          }),
          getNumPages: () => pages.filter((p) => p !== null).length,
        }),
      );
    }
    searchNearby(kw: string) {
      this.kw = kw;
      const n = (tries.get(kw) ?? 0) + 1;
      tries.set(kw, n);
      calls.push(`search:${kw}`);
      // "retry" keyword: empty at first, rows the second time
      if (kw === 'retry' && n === 1) {
        queueMicrotask(() =>
          this.opts.onSearchComplete({
            getCurrentNumPois: () => 0,
            getPoi: () => undefined,
            getNumPages: () => 0,
          }),
        );
        return;
      }
      this.answer(0);
    }
    gotoPage(page: number) {
      calls.push(`page:${this.kw}:${page}`);
      this.answer(page);
    }
  }
  class Point {
    constructor(
      readonly lng: number,
      readonly lat: number,
    ) {}
  }
  return { B: { LocalSearch, Point } as unknown as BMapNS, calls };
}

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
});
afterEach(() => vi.unstubAllGlobals());

const C: [number, number] = [121.618088, 31.185923];
const opts = (keywords: string[]) => ({ keywords, gapMs: 0, cache: true });

describe('浏览器端周边检索', () => {
  it('searches every keyword, keeps a POI once (first keyword wins), turns a second page on the same search, nearest first', async () => {
    const { B, calls } = fakeBaidu({
      生鲜超市: [[row(1, '盒马鲜生(陆悦天地店)', 121.6228, 31.1888)]],
      超市: [
        [row(2, '联华超市(川和路店)', 121.6182, 31.1856), row(1, '盒马鲜生(陆悦天地店)')],
        [row(3, '世纪生活超市(张江店)')],
      ],
    });
    const progress: number[] = [];
    const pois = await findNearby(
      B,
      C,
      new AbortController().signal,
      (d) => progress.push(d),
      opts(['生鲜超市', '超市']),
    );
    expect(pois.map((p) => p.name)).toEqual([
      '联华超市(川和路店)',
      '世纪生活超市(张江店)',
      '盒马鲜生(陆悦天地店)',
    ]);
    expect(pois.find((p) => p.uid === uid(1))?.keyword).toBe('生鲜超市');
    expect(calls).toEqual(['search:生鲜超市', 'search:超市', 'page:超市:1']);
    expect(progress).toEqual([1, 2]);
  });

  it('asks an empty answer once more', async () => {
    const { B, calls } = fakeBaidu({ retry: [[row(4, '清美生鲜(荣科路店)')]] });
    const pois = await findNearby(B, C, new AbortController().signal, undefined, opts(['retry']));
    expect(pois.map((p) => p.name)).toEqual(['清美生鲜(荣科路店)']);
    expect(calls).toEqual(['search:retry', 'search:retry']);
  });

  it('skips a keyword that never answers, and keeps the day cache only for a complete search', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { B } = fakeBaidu({ 药店: [null], 小学: [[row(5, '万科实验小学')]] });
      const run = findNearby(B, C, new AbortController().signal, undefined, opts(['药店', '小学']));
      await vi.advanceTimersByTimeAsync(20000);
      expect((await run).map((p) => p.name)).toEqual(['万科实验小学']);
      expect(store.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never lets a few keywords asked on their own stand in for the full search', async () => {
    const few = fakeBaidu({ 小学: [[row(6, '孙桥小学')]] });
    await findNearby(few.B, C, new AbortController().signal, undefined, { keywords: ['小学'], gapMs: 0 });
    expect(store.size).toBe(0);
  });

  it('hands back the same day’s result for the same centre without searching', async () => {
    const first = fakeBaidu({ 小学: [[row(6, '孙桥小学')]] });
    await findNearby(first.B, C, new AbortController().signal, undefined, opts(['小学']));
    const again = fakeBaidu({});
    const pois = await findNearby(again.B, C, new AbortController().signal, undefined, opts(['小学']));
    expect(pois.map((p) => p.name)).toEqual(['孙桥小学']);
    expect(again.calls).toEqual([]);
  });
});
