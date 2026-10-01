import { BaiduError, toApiError } from '@zoudedao/baidu';
import { HARD_CATEGORIES, type AnalysisResult, type HardCategory, type LngLat } from '@zoudedao/core';
import type { FastifyInstance, FastifySchemaValidationError } from 'fastify';
import { untilAborted } from '../abort.js';
import type { Mode } from '../config.js';
import { ApiError, ERROR_STATUS } from '../errors.js';
import type { HistoryStore } from '../history.js';
import { formatWait } from '../rate-limit.js';
import { forClient } from '../redact.js';
import { runWhatIf, type WhatIfRouter } from '../whatif.js';
import { CHINA_BD09 } from './analyze.js';

interface WhatIfBody {
  analysis_id: string;
  category: HardCategory;
  site_bd09: LngLat;
  /** Accepted for older clients; only the task rule exists. */
  rules?: 'task';
}

const bodySchema = {
  type: 'object',
  required: ['analysis_id', 'category', 'site_bd09'],
  additionalProperties: false,
  properties: {
    analysis_id: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[A-Za-z0-9][A-Za-z0-9_~-]*$' },
    // every category an analysis can be checked for; one the analysis was not checked for is a 400 later
    category: { type: 'string', enum: [...HARD_CATEGORIES] },
    site_bd09: {
      type: 'array',
      minItems: 2,
      maxItems: 2,
      items: [
        { type: 'number', minimum: CHINA_BD09.minLng, maximum: CHINA_BD09.maxLng },
        { type: 'number', minimum: CHINA_BD09.minLat, maximum: CHINA_BD09.maxLat },
      ],
    },
    rules: { type: 'string', enum: ['task'] },
  },
} as const;

function describeInvalid(errors: FastifySchemaValidationError[]): string {
  const first = errors[0];
  const field =
    first?.keyword === 'required' ? first.params.missingProperty : first?.instancePath.split('/')[1];
  switch (field) {
    case 'analysis_id':
      return 'analysis_id 须为分析编号：样例 id（如 zj-a）或实时结果的 meta.analysis_id（如 live-1a2b3c4d）';
    case 'category':
      return `category 只能是 ${HARD_CATEGORIES.join('、')} 之一`;
    case 'site_bd09':
      return 'site_bd09 须为中国境内的 BD-09 坐标 [经度, 纬度]';
    case 'rules':
      return 'rules 只能是 task（赛题口径：步行 1 公里），国标口径已停用';
    default:
      return '请求体须为 JSON 对象，例如 {"analysis_id": "zj-a", "category": "药店", "site_bd09": [121.64, 31.19]}';
  }
}

// Abort reasons, compared by identity.
const CLIENT_GONE = new Error('client disconnected');
const SHUTDOWN = new Error('server shutting down');
const TIMEOUT = new Error('what-if timed out');

export interface WhatIfRouteOptions {
  mode: Mode;
  /** Live Baidu client (routematrix only); absent in sample mode and in replay mode. */
  router: WhatIfRouter | undefined;
  /** Sample id or live result id (meta.analysis_id) → the analysis; undefined when unknown. */
  resolve: (id: string) => Promise<AnalysisResult | undefined>;
  /** Every measurement is saved as a branch of its analysis (GET /api/analysis/:id/branches). */
  history?: HistoryStore;
  /** How live results are kept, for the not-found message ("保存 30 天"). */
  retention?: string;
  per10Min: number;
  timeoutMs: number;
}

export function registerWhatIfRoute(app: FastifyInstance, opts: WhatIfRouteOptions): void {
  const running = new Set<AbortController>();
  app.addHook('preClose', async () => {
    for (const controller of running) controller.abort(SHUTDOWN);
  });

  app.post<{ Body: WhatIfBody }>(
    '/api/whatif',
    {
      bodyLimit: 4096,
      schema: { body: bodySchema },
      schemaErrorFormatter: (errors) => new ApiError(400, 'invalid_input', describeInvalid(errors)),
      config: {
        rateLimit: {
          max: opts.per10Min,
          timeWindow: 600_000,
          errorResponseBuilder: (_req, ctx) =>
            new ApiError(
              ctx.statusCode,
              'rate_limited',
              `模拟次数已达上限（每个 IP 每 10 分钟 ${ctx.max} 次），请 ${formatWait(ctx.ttl)}后再试`,
            ),
        },
      },
      // Before body parsing: without a Baidu client there is nothing to measure, whatever the body.
      onRequest: async () => {
        if (opts.mode !== 'live' || !opts.router) {
          throw new ApiError(
            409,
            'live_mode_disabled',
            '当前为样例模式（未配置百度服务端 Key），不能用实测路线模拟新增设施；可以在地图上查看估算结果',
          );
        }
      },
    },
    async (req, reply) => {
      const router = opts.router;
      if (!router)
        throw new ApiError(409, 'live_mode_disabled', '当前为样例模式，不能用实测路线模拟新增设施');
      const body = req.body;
      const id = body.analysis_id.replace(/~elder$/, '');
      const result = await opts.resolve(id);
      if (!result) {
        throw new ApiError(
          404,
          'not_found',
          `找不到分析 ${id}：样例 id 不存在，或实时结果已过期（服务端${opts.retention ?? '只保留最近 20 个'}），请重新体检`,
        );
      }

      const controller = new AbortController();
      running.add(controller);
      // the response closing before it was written means the client went away
      const onClose = () => {
        if (!reply.raw.writableEnded) controller.abort(CLIENT_GONE);
      };
      reply.raw.on('close', onClose);
      const timer = setTimeout(() => controller.abort(TIMEOUT), opts.timeoutMs).unref();
      try {
        const out = await untilAborted(
          runWhatIf(
            id,
            result,
            { category: body.category, site_bd09: body.site_bd09 },
            router,
            controller.signal,
          ),
          controller.signal,
        );
        if ('kind' in out) {
          if (out.kind === 'no_checks') {
            throw new ApiError(
              400,
              'invalid_input',
              '这次分析没有小区判定（只生成了等时圈），无法模拟新增设施',
            );
          }
          if (out.kind === 'unchecked') {
            throw new ApiError(
              400,
              'invalid_input',
              `分析 ${id} 没有检查${body.category}：它只检查了${out.checked.join('、')}（较早的分析只检查赛题点名的三类），没有新增前的判定可比，无法模拟新增${body.category}。重新体检一次即可检查全部 ${HARD_CATEGORIES.length} 类设施`,
            );
          }
          const err = out.error;
          if (err instanceof BaiduError) {
            const { error, message } = toApiError(err);
            req.log.warn({ code: error }, `模拟新增设施失败：${forClient(message)}`);
            throw new ApiError(ERROR_STATUS[error], error, forClient(message));
          }
          throw err;
        }
        req.log.info(
          {
            analysis_id: id,
            category: out.category,
            rules: out.rules,
            routes: out.quota.routes,
            cached: out.quota.cached,
          },
          '模拟新增设施',
        );
        // a measurement is kept as a branch of its analysis; failing to keep it costs only the branch
        let branch_id: string | undefined;
        try {
          branch_id = opts.history?.saveBranch(out).id;
        } catch (err) {
          req.log.warn({ err }, '模拟结果未能保存为分支');
        }
        return branch_id ? { ...out, branch_id } : out;
      } catch (err) {
        const reason = controller.signal.reason;
        if (controller.signal.aborted && err === reason) {
          if (reason === TIMEOUT) {
            throw new ApiError(
              504,
              'timeout',
              `模拟超时（${Math.round(opts.timeoutMs / 1000)} 秒），请稍后重试`,
            );
          }
          if (reason === SHUTDOWN) throw new ApiError(503, 'internal', '服务正在重启，请稍后重试');
          req.log.info('客户端已断开，模拟中止');
          throw new ApiError(499, 'client_closed', '客户端已断开');
        }
        throw err;
      } finally {
        clearTimeout(timer);
        reply.raw.off('close', onClose);
        running.delete(controller);
      }
    },
  );
}
