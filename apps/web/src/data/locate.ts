/** Search plate → GET /api/locate (docs/api.md). Sample mode only matches sample communities. */
import { errorText } from './api.js';

export interface LocateCandidate {
  name: string;
  address?: string;
  center_bd09: [number, number];
  source: 'geocoding' | 'place_region' | 'sample';
  confidence: number;
  reason: string;
  distance_to_best_m?: number;
  sample_id?: string;
}

export type LocateOutcome =
  | { kind: 'sample'; id: string; name: string }
  | { kind: 'place'; best: LocateCandidate; candidates: LocateCandidate[]; needsConfirmation: boolean }
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

export async function locate(q: string, signal?: AbortSignal): Promise<LocateOutcome> {
  const query = q.trim().slice(0, 60);
  let res: Response;
  try {
    res = await fetch(`/api/locate?q=${encodeURIComponent(query)}`, {
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
  const best = body.best;
  if (!best) return { kind: 'none', warnings: body.warnings ?? [] };
  if (best.sample_id) return { kind: 'sample', id: best.sample_id, name: best.name };
  return {
    kind: 'place',
    best,
    candidates: body.candidates?.length ? body.candidates : [best],
    needsConfirmation: !!(body.needsConfirmation ?? body.needs_confirmation),
  };
}
