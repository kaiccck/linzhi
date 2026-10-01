/**
 * Search plate → GET /api/locate (docs/api.md). Sample mode only matches sample communities.
 * Coordinates go to the same endpoint with `crs`: the server converts them to BD-09 (Baidu geoconv in
 * live mode, the public formulas in sample mode) and answers with one `coordinate` candidate.
 */
import { errorText } from './api.js';
import { crsCode, fmtLngLat, toBd09, type Crs } from './coords.js';

/** How a typed point reached BD-09: Baidu's geoconv service, the public formulas, or it already was. */
export type ConvertedVia = 'baidu_geoconv' | 'local' | 'none';

export interface LocateCandidate {
  name: string;
  address?: string;
  center_bd09: [number, number];
  /** coordinate = typed coordinates; click = a point picked on the map (both BD-09 after conversion) */
  source: 'geocoding' | 'place_region' | 'sample' | 'coordinate' | 'click';
  confidence: number;
  reason: string;
  distance_to_best_m?: number;
  sample_id?: string;
  /** coordinate candidates: the frame the point was typed in and how it was converted */
  crs?: Crs;
  converted_via?: ConvertedVia;
}

export type LocateOutcome =
  | { kind: 'sample'; id: string; name: string }
  | { kind: 'place'; best: LocateCandidate; candidates: LocateCandidate[]; needsConfirmation: boolean }
  | { kind: 'coordinate'; point: LocateCandidate }
  | { kind: 'none'; warnings: string[] }
  | { kind: 'unavailable'; message: string };

interface LocateBody {
  best?: LocateCandidate | null;
  candidates?: LocateCandidate[];
  needsConfirmation?: boolean;
  needs_confirmation?: boolean;
  warnings?: string[];
  error?: string;
  message?: string;
}

export async function locate(q: string, signal?: AbortSignal, crs?: Crs): Promise<LocateOutcome> {
  const query = q.trim().slice(0, 60);
  let res: Response;
  try {
    res = await fetch(`/api/locate?q=${encodeURIComponent(query)}${crs ? `&crs=${crs}` : ''}`, {
      signal,
      headers: { accept: 'application/json' },
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    return { kind: 'unavailable', message: '未连接服务端' };
  }
  if (!/json/i.test(res.headers.get('content-type') ?? ''))
    return { kind: 'unavailable', message: '未连接服务端' };
  const body = (await res.json().catch(() => null)) as LocateBody | null;
  if (!res.ok || !body) {
    return {
      kind: 'unavailable',
      message: errorText(body?.error, body?.message ?? `地址检索失败（HTTP ${res.status}）`),
    };
  }
  const best = body.best ?? body.candidates?.[0];
  if (!best) return { kind: 'none', warnings: body.warnings ?? [] };
  if (best.source === 'coordinate') return { kind: 'coordinate', point: best };
  if (best.sample_id) return { kind: 'sample', id: best.sample_id, name: best.name };
  return {
    kind: 'place',
    best,
    candidates: body.candidates?.length ? body.candidates : [best],
    needsConfirmation: !!(body.needsConfirmation ?? body.needs_confirmation),
  };
}

/**
 * A typed coordinate pair → one BD-09 point. Asks the server first (Baidu's geoconv in live mode);
 * a server that is unreachable or does not convert coordinates yet falls back to the public formulas
 * here, and says so (`converted_via: 'local'`). Errors the server states (quota, rate limit) are
 * passed on rather than hidden behind a local answer.
 */
export async function locateCoords(
  lng: number,
  lat: number,
  crs: Crs,
  signal?: AbortSignal,
): Promise<LocateOutcome> {
  const q = `${lng},${lat}`;
  const r = await locate(q, signal, crs);
  if (r.kind === 'coordinate') {
    // trust the server's point, but keep the frame the visitor chose if an older reply omits it
    return { kind: 'coordinate', point: { ...r.point, crs: r.point.crs ?? crs } };
  }
  if (r.kind === 'unavailable' && r.message !== '未连接服务端') return r;
  const center = toBd09(lng, lat, crs);
  return {
    kind: 'coordinate',
    point: {
      name: `坐标 ${fmtLngLat([lng, lat])}`,
      center_bd09: [Number(center[0].toFixed(6)), Number(center[1].toFixed(6))],
      source: 'coordinate',
      confidence: 1,
      reason: '输入的经纬度',
      crs,
      converted_via: crs === 'bd09' ? 'none' : 'local',
    },
  };
}

/**
 * The line that says how a typed point reached BD-09, e.g. "已用百度坐标转换：WGS-84 → BD-09"
 * (shown with the check's progress and in the sample-mode note). Null for anything but coordinates.
 */
export function conversionText(crs: Crs | undefined, via: ConvertedVia | undefined): string | null {
  if (!crs) return null;
  if (crs === 'bd09' || via === 'none') return '百度 BD-09 坐标，无需转换';
  if (via === 'baidu_geoconv') return `已用百度坐标转换：${crsCode(crs)} → BD-09`;
  return `已按公开公式换算：${crsCode(crs)} → BD-09`;
}
