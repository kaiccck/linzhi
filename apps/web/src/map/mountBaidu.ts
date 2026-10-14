import type { Frame } from '../geo/frame.js';
import { BaiduBasemap, type BasemapEvents } from './BaiduBasemap.js';
import { BaiduLoadError, loadBaidu } from './loadBaidu.js';

const TILE_TIMEOUT_MS = 15000;
const RETRY_DELAY_MS = 2000;

/** Keep the offline preview while reconnecting; allow one automatic retry per request. */
export function mountBaidu(options: {
  key: string | undefined;
  container: HTMLElement;
  frame(): Frame;
  events: BasemapEvents;
  onCreate(map: BaiduBasemap): void;
  onDestroy(): void;
  onRetrying(): void;
  onOffline(error: unknown): void;
}) {
  let disposed = false;
  let generation = 0;
  let automaticRetries = 1;
  let map: BaiduBasemap | null = null;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const clear = () => {
    clearTimeout(watchdog);
    clearTimeout(retryTimer);
    map?.destroy();
    map = null;
    options.onDestroy();
  };

  const start = async () => {
    if (disposed) return;
    const attempt = ++generation;
    clear();
    options.onRetrying();
    const current = () => !disposed && attempt === generation;
    const fail = (error: unknown) => {
      if (!current()) return;
      ++generation; // discard late tiles and script callbacks from this attempt
      clear();
      options.onOffline(error);
      const permanent = error instanceof BaiduLoadError && ['no-key', 'unsupported'].includes(error.reason);
      if (!permanent && automaticRetries > 0) {
        --automaticRetries;
        retryTimer = setTimeout(() => void start(), RETRY_DELAY_MS);
      }
    };
    try {
      const B = await loadBaidu(options.key);
      if (!current()) return;
      let ready = false;
      map = new BaiduBasemap(B, options.container, options.frame(), {
        ...options.events,
        onTilesLoaded: () => {
          if (!current()) return;
          ready = true;
          clearTimeout(watchdog);
          options.events.onTilesLoaded();
        },
      });
      options.onCreate(map);
      if (!ready) {
        watchdog = setTimeout(() => fail(new BaiduLoadError('timeout', '百度瓦片加载超时')), TILE_TIMEOUT_MS);
      }
    } catch (error) {
      fail(error);
    }
  };

  void start();
  return {
    retry() {
      automaticRetries = 1;
      void start();
    },
    dispose() {
      disposed = true;
      ++generation;
      clear();
    },
  };
}
