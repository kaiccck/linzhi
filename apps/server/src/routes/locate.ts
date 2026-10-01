import { BaiduError, locate, toApiError, type LocateCandidate, type LocateClient } from '@zoudedao/baidu';
import {
  CHINA_BOX,
  haversine,
  parseCoordinateText,
  type LngLat,
  type TypedCoordinates,
} from '@zoudedao/core';
import type { FastifyInstance, FastifySchemaValidationError } from 'fastify';
import { untilAborted } from '../abort.js';
import { CRS_VALUES, toBd09, type ConvertedVia, type Crs, type GeoconvClient } from '../coordinates.js';
import { ApiError, ERROR_STATUS } from '../errors.js';
import { formatWait } from '../rate-limit.js';
import { forClient } from '../redact.js';
import type { SampleStore, SampleSummary } from '../samples.js';

export const DEFAULT_CITY = '上海市';
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX_ENTRIES = 500;

export interface PlaceCandidate {
  name: string;
  address?: string;
  center_bd09: LngLat;
  /** `coordinate`: q was a typed point, no text geocoding (see crs / converted_via). */
  source: 'geocoding' | 'place_region' | 'sample' | 'coordinate';
  /** 0–1; ≥ 0.6 can be used without asking (sample hits and typed coordinates are 1). */
  confidence: number;
  /** Why this candidate, in Chinese. */
  reason: string;
  /** Straight-line distance to `best`; absent on the best candidate itself. */
  distance_to_best_m?: number;
  /** Baidu POI uid (place search hits). */
  uid?: string;
  /** Sample mode hits; for typed coordinates, a sample whose centre lies within 100 m. */
  sample_id?: string;
  /** Typed coordinates only: the datum they were read in. */
  crs?: Crs;
  /** Typed coordinates only: Baidu geoconv, the local formula (fallback, sample mode), or none (BD-09). */
  converted_via?: ConvertedVia;
}

export interface LocateResponse {
  query: string;
  city: string;
  best: PlaceCandidate | null;
  /** Best first. */
  candidates: PlaceCandidate[];
  /** Show the candidates and let the user pick (技术设计文档 §4.6 step 4). */
  needs_confirmation: boolean;
  warnings: string[];
}

const round = (value: number, digits: number) => Number(value.toFixed(digits));

function withDistances(candidates: PlaceCandidate[]): Pick<LocateResponse, 'best' | 'candidates'> {
  const [best] = candidates;
  if (!best) return { best: null, candidates };
  const [lng, lat] = best.center_bd09;
  const all = candidates.map((c, i) =>
    i === 0
      ? c
      : { ...c, distance_to_best_m: Math.round(haversine(lng, lat, c.center_bd09[0], c.center_bd09[1])) },
  );
  return { best: all[0] ?? null, candidates: all };
}

// Place labels come as "名称（地址）"; the name itself may contain full-width brackets.
const NAME_AND_ADDRESS = /^(.+)（([^（）]+)）$/;

function fromBaidu(c: LocateCandidate): PlaceCandidate {
  const parts = c.source === 'place_region' ? NAME_AND_ADDRESS.exec(c.label) : null;
  return {
    name: parts?.[1] ?? c.label,
    ...(parts?.[2] ? { address: parts[2] } : {}),
    center_bd09: [round(c.location[0], 6), round(c.location[1], 6)],
    source: c.source,
    confidence: round(c.confidence, 2),
    reason: forClient(c.reason),
    ...(c.uid ? { uid: c.uid } : {}),
  };
}

const normalise = (text: string) => text.replace(/\s+/g, '').toLowerCase();

/** Sample mode: match against the sample catalogue only, never calling Baidu. */
function fromSamples(q: string, samples: SampleSummary[]): Omit<LocateResponse, 'query' | 'city'> {
  const needle = normalise(q);
  const hits = samples
    .filter((s) => normalise(s.name).includes(needle) || normalise(s.center_label ?? '').includes(needle))
    .map((s): PlaceCandidate => ({
      name: s.name,
      ...(s.center_label ? { address: s.center_label } : {}),
      center_bd09: s.center_bd09,
      source: 'sample',
      confidence: 1,
      reason: '样例社区的名称或中心点标注包含搜索词',
      sample_id: s.id,
    }));
  return {
    ...withDistances(hits),
    needs_confirmation: hits.length !== 1,
    warnings: ['当前为样例模式：只在样例社区中查找，不调用百度接口'],
  };
}

function describeInvalid(errors: FastifySchemaValidationError[]): string {
  const first = errors[0];
  const field =
    first?.keyword === 'required' ? first.params.missingProperty : first?.instancePath.split('/')[1];
  if (field === 'city') return 'city 须为不超过 20 个字符的城市名';
  if (field === 'crs') return 'crs 只能是 bd09（百度）、gcj02（高德、腾讯）或 wgs84（GPS）';
  return 'q 须为 1–60 个字符的地址、地名或坐标';
}

const querySchema = {
  type: 'object',
  required: ['q'],
  properties: {
    q: { type: 'string', maxLength: 200 },
    city: { type: 'string', maxLength: 200 },
    crs: { type: 'string', enum: [...CRS_VALUES] },
  },
} as const;

/** A sample centred this close to a typed point is offered with it (opening it costs no quota). */
export const SAMPLE_NEAR_M = 100;

const OUT_OF_CHINA =
  `坐标不在中国范围内：经度须在 ${CHINA_BOX.minLng}–${CHINA_BOX.maxLng}、纬度须在 ${CHINA_BOX.minLat}–${CHINA_BOX.maxLat} 之间` +
  '（可以写成“经度,纬度”或“纬度,经度”，例如 121.644195,31.19007）';

/**
 * q typed as coordinates: no geocoding, one conversion at most (geoconv, or the local formula in sample
 * mode and when geoconv fails). Always a single candidate that needs no confirmation.
 */
async function fromCoordinates(args: {
  query: string;
  city: string;
  typed: TypedCoordinates;
  crs: Crs;
  baidu: GeoconvClient | undefined;
  samples: SampleStore;
  timeoutMs: number;
}): Promise<LocateResponse> {
  const { typed, crs } = args;
  if (!typed.inChina) throw new ApiError(400, 'invalid_input', OUT_OF_CHINA);
  const conv = await toBd09([typed.lng, typed.lat], crs, args.baidu, AbortSignal.timeout(args.timeoutMs));
  const [lng, lat] = conv.center_bd09;
  const near = (await args.samples.list())
    .map((s) => ({ s, d: haversine(lng, lat, s.center_bd09[0], s.center_bd09[1]) }))
    .filter((x) => x.d <= SAMPLE_NEAR_M)
    .sort((a, b) => a.d - b.d)[0];
  const reason = [
    conv.reason,
    typed.swapped ? '按“纬度, 经度”的顺序识别' : '',
    near ? `中心点 ${Math.round(near.d)} 米内有样例“${near.s.name}”（${near.s.id}），可以直接查看` : '',
  ]
    .filter(Boolean)
    .join('；');
  const candidate: PlaceCandidate = {
    name: `坐标 ${typed.lng.toFixed(6)}, ${typed.lat.toFixed(6)}`,
    center_bd09: conv.center_bd09,
    source: 'coordinate',
    confidence: 1,
    reason,
    crs,
    converted_via: conv.converted_via,
    ...(near ? { sample_id: near.s.id } : {}),
  };
  const warnings = [...conv.warnings];
  if (!args.baidu)
    warnings.push('当前为样例模式：不调用百度接口，只能查看样例社区；实时体检需要配置百度服务端 Key');
  return {
    query: args.query,
    city: args.city,
    best: candidate,
    candidates: [candidate],
    needs_confirmation: false,
    warnings,
  };
}

export interface LocateRouteOptions {
  /** Present when live calls are possible; otherwise the samples are searched. */
  baidu: (LocateClient & GeoconvClient) | undefined;
  samples: SampleStore;
  perMinute: number;
  /** Deadline of one lookup; Baidu retries and back-off could otherwise hold a search box for a minute. */
  timeoutMs: number;
}

export function registerLocateRoute(
  app: FastifyInstance,
  { baidu, samples, perMinute, timeoutMs }: LocateRouteOptions,
): void {
  // Repeated demo searches cost no quota; concurrent identical lookups share one promise.
  const cache = new Map<string, { expires: number; response: Promise<LocateResponse> }>();

  const lookUp = (client: LocateClient, query: string, city: string): Promise<LocateResponse> => {
    const key = `${city}\n${query}`;
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && hit.expires > now) return hit.response;
    // Tied to no single request: a client that leaves does not cancel a lookup others may be sharing.
    const deadline = AbortSignal.timeout(timeoutMs);
    const response = untilAborted(locate(client, query, { city, signal: deadline }), deadline).then(
      (r): LocateResponse => ({
        query,
        city,
        ...withDistances(r.candidates.map(fromBaidu)),
        needs_confirmation: r.needsConfirmation,
        warnings: r.warnings.map(forClient),
      }),
      (err: unknown) => {
        if (!deadline.aborted) throw err;
        const seconds = Math.round(timeoutMs / 1000);
        throw new ApiError(ERROR_STATUS.timeout, 'timeout', `地址搜索超时（${seconds} 秒），请稍后重试`);
      },
    );
    const entry = { expires: now + CACHE_TTL_MS, response };
    cache.delete(key);
    cache.set(key, entry);
    response.catch(() => {
      if (cache.get(key) === entry) cache.delete(key); // never cache failures
    });
    for (const oldest of cache.keys()) {
      if (cache.size <= CACHE_MAX_ENTRIES) break;
      cache.delete(oldest);
    }
    return response;
  };

  app.get<{ Querystring: { q: string; city?: string; crs?: Crs } }>(
    '/api/locate',
    {
      schema: { querystring: querySchema },
      schemaErrorFormatter: (errors) => new ApiError(400, 'invalid_input', describeInvalid(errors)),
      config: {
        rateLimit: {
          max: perMinute,
          timeWindow: 60_000,
          errorResponseBuilder: (_req, ctx) =>
            new ApiError(ctx.statusCode, 'rate_limited', `地址搜索过于频繁，请 ${formatWait(ctx.ttl)}后再试`),
        },
      },
    },
    async (req): Promise<LocateResponse> => {
      const query = req.query.q.trim();
      const city = req.query.city?.trim() || DEFAULT_CITY;
      if ([...query].length === 0 || [...query].length > 60) {
        throw new ApiError(400, 'invalid_input', 'q 须为 1–60 个字符的地址、地名或坐标');
      }
      if ([...city].length > 20)
        throw new ApiError(400, 'invalid_input', 'city 须为不超过 20 个字符的城市名');

      // "121.644195,31.19007" and the like: a point, not an address
      const typed = parseCoordinateText(query);
      if (typed) {
        const crs = req.query.crs ?? 'bd09';
        return fromCoordinates({ query, city, typed, crs, baidu, samples, timeoutMs });
      }

      if (!baidu) return { query, city, ...fromSamples(query, await samples.list()) };
      try {
        return await lookUp(baidu, query, city);
      } catch (err) {
        // ApiError: the timeout above. Anything that is not a Baidu answer is a bug: generic 500 internal.
        if (!(err instanceof BaiduError)) throw err;
        const { error, message, hint } = toApiError(err);
        req.log.warn({ code: error, hint: hint && forClient(hint) }, `地址搜索失败：${forClient(message)}`);
        throw new ApiError(ERROR_STATUS[error], error, forClient(message));
      }
    },
  );
}
