import { BaiduError, toApiError } from '@zoudedao/baidu';
import type { AnalysisResult, HardCategory, LngLat, XY } from '@zoudedao/core';
import type { FastifyInstance, FastifySchemaValidationError } from 'fastify';
import { untilAborted } from '../abort.js';
import { ApiError, ERROR_STATUS } from '../errors.js';
import { formatWait } from '../rate-limit.js';
import { forClient } from '../redact.js';
import {
  checkPair,
  pathXY,
  ROUTE_MAX_STRAIGHT_M,
  straightM,
  type CheckPair,
  type RouteBook,
  type RouteCheck,
  type RouteCommunity,
  type RouteFacility,
  type RouteSource,
  type RouteWalker,
} from '../route.js';
import { CHINA_BD09 } from './analyze.js';

interface RouteQuery {
  analysis_id?: string;
  community?: string;
  category?: HardCategory;
  /** Accepted for older clients; only the task rule exists. */
  rules?: 'task';
  from?: string;
  to?: string;
}

/** GET /api/route's answer (docs/api.md). */
export interface RouteResponse {
  analysis_id: string | null;
  community: RouteCommunity | null;
  facility: RouteFacility | null;
  category: HardCategory | null;
  /** 'task' with a check (always `checks`), null without one; kept for older clients. */
  rules: 'task' | null;
  check: RouteCheck | null;
  from_bd09: LngLat;
  to_bd09: LngLat;
  path_bd09: LngLat[];
  /** The path in the analysis' local frame; null without an analysis. */
  path_xy: XY[] | null;
  /** Baidu's walking route (directionlite): its own distance and time. */
  distance_m: number;
  duration_s: number;
  /** Straight line between the two ends. */
  straight_m: number;
  /** stored: answered from the kept routes (no Baidu call); baidu: fetched now, kept from now on. */
  source: RouteSource;
  fetched_at: string;
}

const querySchema = {
  type: 'object',
  properties: {
    analysis_id: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[A-Za-z0-9][A-Za-z0-9_~-]*$' },
    community: { type: 'string', minLength: 1, maxLength: 60 },
    category: { type: 'string', enum: ['小学', '菜市场', '药店'] },
    rules: { type: 'string', enum: ['task'] },
    from: { type: 'string', maxLength: 60 },
    to: { type: 'string', maxLength: 60 },
  },
} as const;

function describeInvalid(errors: FastifySchemaValidationError[]): string {
  const field = errors[0]?.instancePath.split('/')[1];
  switch (field) {
    case 'analysis_id':
      return 'analysis_id 须为分析编号：样例 id（如 zj-a）或实时结果的 meta.analysis_id（如 live-1a2b3c4d）';
    case 'community':
      return 'community 须为小区名（或地图编号，如 A-01），不超过 60 个字符';
    case 'category':
      return 'category 只能是 小学、菜市场 或 药店';
    case 'rules':
      return 'rules 只能是 task（赛题口径：步行 1 公里），国标口径已停用';
    default:
      return 'from / to 须为 BD-09 坐标“经度,纬度”，如 121.644195,31.19007';
  }
}

const USAGE =
  '请给出 analysis_id、community、category（小区到其判定经由设施的路线），或 from、to（两个 BD-09 坐标“经度,纬度”）';

/** "121.644195,31.19007" → [lng, lat] inside China, or null. */
function parsePoint(text: string): LngLat | null {
  const m = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*[,，]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(text);
  if (!m) return null;
  const lng = Number(m[1]);
  const lat = Number(m[2]);
  const inside =
    lng >= CHINA_BD09.minLng &&
    lng <= CHINA_BD09.maxLng &&
    lat >= CHINA_BD09.minLat &&
    lat <= CHINA_BD09.maxLat;
  return inside ? [lng, lat] : null;
}

/**
 * Per-key sliding window: `take` counts a hit and returns 0, or returns how long until the oldest hit
 * leaves the window (ms) without counting. Keys whose hits all expired are dropped as it goes.
 */
export class WindowLimiter {
  readonly #hits = new Map<string, number[]>();

  constructor(
    readonly max: number,
    readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  take(key: string): number {
    const t = this.now();
    const recent = (this.#hits.get(key) ?? []).filter((at) => at > t - this.windowMs);
    if (recent.length >= this.max) {
      this.#hits.set(key, recent);
      return recent[0]! + this.windowMs - t;
    }
    recent.push(t);
    this.#hits.set(key, recent);
    if (this.#hits.size > 10_000) {
      for (const [k, hits] of this.#hits)
        if (hits.every((at) => at <= t - this.windowMs)) this.#hits.delete(k);
    }
    return 0;
  }
}

// Abort reasons, compared by identity.
const CLIENT_GONE = new Error('client disconnected');
const SHUTDOWN = new Error('server shutting down');
const TIMEOUT = new Error('route timed out');

export interface RouteRouteOptions {
  /** directionlite through the cached Baidu client; absent in sample and replay mode. */
  walker: RouteWalker | undefined;
  routes: RouteBook;
  /** Sample id or live result id → the analysis; undefined when unknown. */
  resolve: (id: string) => Promise<AnalysisResult | undefined>;
  /** How live results are kept, for the not-found message ("保存 30 天"). */
  retention: string;
  /**
   * Lookups that need Baidu, per IP per 10 minutes; stored routes (the samples' prefetched ones and any
   * route asked for before) never count, only the global per-minute limit applies to them.
   */
  per10Min: number;
  timeoutMs: number;
}

export function registerRouteRoute(app: FastifyInstance, opts: RouteRouteOptions): void {
  const running = new Set<AbortController>();
  app.addHook('preClose', async () => {
    for (const controller of running) controller.abort(SHUTDOWN);
  });

  // judges at the venue share one IP: only lookups that spend Baidu quota are limited
  const baiduLookups = new WindowLimiter(opts.per10Min, 600_000);

  app.get<{ Querystring: RouteQuery }>(
    '/api/route',
    {
      schema: { querystring: querySchema },
      schemaErrorFormatter: (errors) => new ApiError(400, 'invalid_input', describeInvalid(errors)),
    },
    async (req, reply): Promise<RouteResponse> => {
      const q = req.query;
      const byPoints = q.from !== undefined || q.to !== undefined;
      if (byPoints && (q.community !== undefined || q.category !== undefined)) {
        throw new ApiError(400, 'invalid_input', `from / to 与 community / category 只能二选一。${USAGE}`);
      }
      if (!byPoints && (!q.analysis_id || !q.community || !q.category)) {
        throw new ApiError(400, 'invalid_input', USAGE);
      }

      let result: AnalysisResult | undefined;
      const id = q.analysis_id?.replace(/~elder$/, '');
      if (id) {
        result = await opts.resolve(id);
        if (!result) {
          throw new ApiError(
            404,
            'not_found',
            `找不到分析 ${id}：样例 id 不存在，或实时结果已过期（服务端${opts.retention}），请重新体检`,
          );
        }
      }

      let from: LngLat;
      let to: LngLat;
      let pair: CheckPair | null = null;
      if (byPoints) {
        const a = q.from === undefined ? null : parsePoint(q.from);
        const b = q.to === undefined ? null : parsePoint(q.to);
        if (!a || !b) {
          throw new ApiError(
            400,
            'invalid_input',
            'from 和 to 都要给出，且须为中国境内的 BD-09 坐标“经度,纬度”，如 121.644195,31.19007',
          );
        }
        from = a;
        to = b;
      } else {
        const found = checkPair(result!, id!, { community: q.community!, category: q.category! });
        if ('kind' in found) {
          switch (found.kind) {
            case 'no_community':
              throw new ApiError(
                404,
                'not_found',
                `分析 ${id} 里没有小区“${q.community}”。可选：${found.names.join('、')}`,
              );
            case 'no_check':
              throw new ApiError(404, 'not_found', `“${q.community}”没有${q.category}的判定`);
            case 'not_routed':
              throw new ApiError(
                404,
                'not_found',
                `“${q.community}”的${q.category}判定没有算路（${found.status}：判定距离内没有这类设施，或还没有从该小区算路），没有可展示的步行路线`,
              );
            case 'no_facility':
              throw new ApiError(
                404,
                'not_found',
                `找不到“${q.community}”的${q.category}判定经由的设施“${found.via}”`,
              );
          }
        }
        pair = found;
        from = found.from;
        to = found.to;
      }
      const straight = straightM(from, to);
      // a check's own pair is always within its rule distance; free points are bounded here
      if (byPoints && straight > ROUTE_MAX_STRAIGHT_M) {
        throw new ApiError(
          400,
          'invalid_input',
          `两点直线距离 ${Math.round(straight)} 米，超过 ${ROUTE_MAX_STRAIGHT_M} 米：步行路线只用于生活圈范围内的核验`,
        );
      }

      if (!opts.routes.stored(from, to)) {
        if (!opts.walker) {
          throw new ApiError(
            409,
            'live_mode_disabled',
            '当前为样例模式（未配置百度服务端 Key）：只能查看样例中预先保存的步行路线（已核实的伪覆盖），其他路线需要实时模式',
          );
        }
        const wait = baiduLookups.take(req.ip);
        if (wait > 0) {
          reply.header('retry-after', String(Math.max(1, Math.ceil(wait / 1000))));
          throw new ApiError(
            429,
            'rate_limited',
            `需要调用百度的步行路线查询过于频繁（每个 IP 每 10 分钟 ${opts.per10Min} 次，已保存的路线不计），请 ${formatWait(wait)}后再试`,
          );
        }
      }

      const controller = new AbortController();
      running.add(controller);
      const onClose = () => {
        if (!reply.raw.writableEnded) controller.abort(CLIENT_GONE);
      };
      reply.raw.on('close', onClose);
      const timer = setTimeout(() => controller.abort(TIMEOUT), opts.timeoutMs).unref();
      let walked: Awaited<ReturnType<RouteBook['walk']>>;
      try {
        walked = await untilAborted(
          opts.routes.walk(from, to, opts.walker, controller.signal),
          controller.signal,
        );
      } catch (err) {
        const reason = controller.signal.reason;
        if (controller.signal.aborted && err === reason) {
          if (reason === TIMEOUT) {
            throw new ApiError(
              504,
              'timeout',
              `步行路线查询超时（${Math.round(opts.timeoutMs / 1000)} 秒），请稍后重试`,
            );
          }
          if (reason === SHUTDOWN) throw new ApiError(503, 'internal', '服务正在重启，请稍后重试');
          req.log.info('客户端已断开，步行路线查询中止');
          throw new ApiError(499, 'client_closed', '客户端已断开');
        }
        if (err instanceof BaiduError) {
          const { error, message } = toApiError(err);
          req.log.warn({ code: error }, `步行路线查询失败：${forClient(message)}`);
          throw new ApiError(ERROR_STATUS[error], error, forClient(message));
        }
        throw err;
      } finally {
        clearTimeout(timer);
        reply.raw.off('close', onClose);
        running.delete(controller);
      }

      if (!walked) {
        // stored a moment ago, gone now: cannot happen with the stores in use; say so plainly
        throw new ApiError(409, 'live_mode_disabled', '当前为样例模式，只能查看样例中预先保存的步行路线');
      }
      if (!walked.route) {
        throw new ApiError(404, 'not_found', '百度地图没有找到这两点之间的步行路线');
      }
      const route = walked.route;
      if (walked.source === 'baidu') {
        req.log.info(
          { analysis_id: id ?? null, community: pair?.community.name ?? null, category: q.category ?? null },
          '步行路线（百度，已保存）',
        );
      }
      return {
        analysis_id: id ?? null,
        community: pair?.community ?? null,
        facility: pair?.facility ?? null,
        category: pair ? q.category! : null,
        rules: pair ? 'task' : null,
        check: pair?.check ?? null,
        from_bd09: route.from_bd09,
        to_bd09: route.to_bd09,
        path_bd09: route.path_bd09,
        path_xy: result ? pathXY(result, route.path_bd09) : null,
        distance_m: route.distance_m,
        duration_s: route.duration_s,
        straight_m: straight,
        source: walked.source,
        fetched_at: route.fetched_at,
      };
    },
  );
}
