/**
 * Loads Baidu Maps JSAPI 4.0 (WebGL) once per page.
 *
 * The plain loader URL uses document.write, which is a no-op after the page has parsed, so we pass
 * `callback=`: Baidu's loader then injects `getscript` itself and calls the named global when the
 * API is ready. A failed `getscript` request never reaches our onerror (only the first script's
 * does), hence the timeout. The key only ever travels inside the script URL — it is never logged.
 */

export type BMapNS = typeof BMap;

export type BaiduLoadFailure = 'no-key' | 'network' | 'timeout' | 'unsupported';

export class BaiduLoadError extends Error {
  constructor(
    readonly reason: BaiduLoadFailure,
    message: string,
  ) {
    super(message);
    this.name = 'BaiduLoadError';
  }
}

const CALLBACK = '__zddBaiduReady';
let pending: Promise<BMapNS> | null = null;

declare global {
  interface Window {
    BMap?: BMapNS;
    BMapGL?: BMapNS;
    [CALLBACK]?: () => void;
  }
}

function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

export function loadBaidu(ak: string | undefined, timeoutMs = 12000): Promise<BMapNS> {
  if (pending) return pending;
  const attempt = new Promise<BMapNS>((resolve, reject) => {
    if (!ak) {
      reject(new BaiduLoadError('no-key', '未配置 VITE_BAIDU_BROWSER_AK'));
      return;
    }
    if (!webglAvailable()) {
      reject(new BaiduLoadError('unsupported', '浏览器不支持 WebGL'));
      return;
    }
    const loaded = window.BMap?.Map ? window.BMap : window.BMapGL;
    if (loaded?.Map) {
      resolve(loaded);
      return;
    }
    let settled = false;
    const script = document.createElement('script');
    const timer = window.setTimeout(() => fail('timeout', '百度地图脚本加载超时'), timeoutMs);
    function fail(reason: BaiduLoadFailure, message: string) {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      delete window[CALLBACK];
      script.remove();
      reject(new BaiduLoadError(reason, message));
    }
    window[CALLBACK] = () => {
      if (settled) return;
      const ns = window.BMap?.Map ? window.BMap : window.BMapGL;
      if (!ns?.Map) {
        fail('network', '百度地图脚本不完整');
        return;
      }
      settled = true;
      window.clearTimeout(timer);
      delete window[CALLBACK];
      resolve(ns);
    };
    script.src = `https://api.map.baidu.com/api?v=4.0&ak=${encodeURIComponent(ak)}&callback=${CALLBACK}`;
    script.async = true;
    script.onerror = () => fail('network', '无法连接百度地图（api.map.baidu.com）');
    document.head.appendChild(script);
  });
  // a failed attempt may be retried later (e.g. after the network comes back)
  pending = attempt.catch((err: unknown) => {
    pending = null;
    throw err;
  });
  return pending;
}
