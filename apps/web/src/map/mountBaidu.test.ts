import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Frame } from '../geo/frame.js';
import type { BasemapEvents } from './BaiduBasemap.js';
import { BaiduLoadError, loadBaidu, type BMapNS } from './loadBaidu.js';
import { mountBaidu } from './mountBaidu.js';

const { maps } = vi.hoisted(() => ({
  maps: [] as { events: BasemapEvents; destroy: ReturnType<typeof vi.fn> }[],
}));
vi.mock('./BaiduBasemap.js', () => ({
  BaiduBasemap: class {
    destroy = vi.fn();
    constructor(
      _B: unknown,
      _container: unknown,
      _frame: unknown,
      readonly events: BasemapEvents,
    ) {
      maps.push(this);
    }
  },
}));
vi.mock('./loadBaidu.js', async (original) => ({
  ...(await original<typeof import('./loadBaidu.js')>()),
  loadBaidu: vi.fn(),
}));

const sessions: ReturnType<typeof mountBaidu>[] = [];
function setup() {
  const onOffline = vi.fn();
  const onReady = vi.fn();
  const onRetrying = vi.fn();
  const session = mountBaidu({
    key: 'test',
    container: {} as HTMLElement,
    frame: () => ({}) as Frame,
    events: { onChange() {}, onTilesLoaded: onReady, onUserMove() {}, onClick() {} },
    onCreate() {},
    onDestroy() {},
    onRetrying,
    onOffline,
  });
  sessions.push(session);
  return { session, onOffline, onReady, onRetrying };
}

beforeEach(() => {
  vi.useFakeTimers();
  maps.length = 0;
  vi.mocked(loadBaidu)
    .mockReset()
    .mockResolvedValue({} as BMapNS);
});
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  vi.useRealTimers();
});

describe('basemap recovery', () => {
  it('recovers from a tile timeout and ignores a late event from the failed map', async () => {
    const { onOffline, onReady } = setup();
    await vi.advanceTimersByTimeAsync(15000);
    expect(onOffline).toHaveBeenCalledOnce();
    expect(maps[0]!.destroy).toHaveBeenCalledOnce();
    maps[0]!.events.onTilesLoaded();
    expect(onReady).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(maps).toHaveLength(2);
    maps[1]!.events.onTilesLoaded();
    await vi.advanceTimersByTimeAsync(60000);
    expect(onReady).toHaveBeenCalledOnce();
    expect(onOffline).toHaveBeenCalledOnce();
    expect(maps[1]!.destroy).not.toHaveBeenCalled();
  });

  it('bounds automatic retries, but lets the user reconnect without reloading the page', async () => {
    const { session, onOffline, onReady } = setup();
    await vi.advanceTimersByTimeAsync(60000);
    expect(maps).toHaveLength(2);
    expect(onOffline).toHaveBeenCalledTimes(2);
    session.retry();
    await vi.advanceTimersByTimeAsync(0);
    maps[2]!.events.onTilesLoaded();
    await vi.advanceTimersByTimeAsync(60000);
    expect(maps).toHaveLength(3);
    expect(onReady).toHaveBeenCalledOnce();
  });

  it('retries a failed SDK request, too', async () => {
    vi.mocked(loadBaidu).mockRejectedValueOnce(new BaiduLoadError('network', 'unavailable'));
    const { onOffline, onReady } = setup();
    await vi.advanceTimersByTimeAsync(2000);
    expect(onOffline).toHaveBeenCalledOnce();
    expect(loadBaidu).toHaveBeenCalledTimes(2);
    maps[0]!.events.onTilesLoaded();
    expect(onReady).toHaveBeenCalledOnce();
  });

  it.each(['no-key', 'unsupported'] as const)('does not auto-retry %s', async (reason) => {
    vi.mocked(loadBaidu).mockRejectedValue(new BaiduLoadError(reason, reason));
    const { onOffline } = setup();
    await vi.advanceTimersByTimeAsync(60000);
    expect(onOffline).toHaveBeenCalledOnce();
    expect(loadBaidu).toHaveBeenCalledOnce();
  });

  it('cancels pending recovery on unmount', async () => {
    const { session, onOffline } = setup();
    await vi.advanceTimersByTimeAsync(15000);
    session.dispose();
    await vi.advanceTimersByTimeAsync(60000);
    expect(onOffline).toHaveBeenCalledOnce();
    expect(maps).toHaveLength(1);
  });

  it('does not create a map after an outstanding SDK request outlives the component', async () => {
    let resolve!: (ns: BMapNS) => void;
    vi.mocked(loadBaidu).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const { session, onReady, onOffline } = setup();
    session.dispose();
    resolve({} as BMapNS);
    await vi.advanceTimersByTimeAsync(60000);
    expect(maps).toHaveLength(0);
    expect(onReady).not.toHaveBeenCalled();
    expect(onOffline).not.toHaveBeenCalled();
  });
});
