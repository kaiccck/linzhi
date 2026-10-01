import { PassThrough } from 'node:stream';
import { BaiduError, toApiError } from '@zoudedao/baidu';
import { browserPois } from '@zoudedao/engine';
import type { FastifyInstance, FastifySchemaValidationError } from 'fastify';
import { untilAborted } from '../abort.js';
import {
  AnalyzeError,
  type AnalyzeErrorCode,
  type AnalyzeInput,
  type Analyzer,
  type Emit,
} from '../analyzer.js';
import type { LiveResults } from '../advisor.js';
import type { Mode } from '../config.js';
import { ApiError } from '../errors.js';
import { formatWait } from '../rate-limit.js';
import { forClient } from '../redact.js';

/** Mainland China box of the GCJ-02 formulas (core's outOfChina); Baidu's BD-09 offset stays inside it. */
export const CHINA_BD09 = { minLng: 72.004, maxLng: 137.8347, minLat: 0.8293, maxLat: 55.8271 } as const;

const bodySchema = {
  type: 'object',
  required: ['center_bd09'],
  additionalProperties: false,
  properties: {
    center_bd09: {
      type: 'array',
      minItems: 2,
      maxItems: 2,
      items: [
        { type: 'number', minimum: CHINA_BD09.minLng, maximum: CHINA_BD09.maxLng },
        { type: 'number', minimum: CHINA_BD09.minLat, maximum: CHINA_BD09.maxLat },
      ],
    },
    label: { type: 'string', maxLength: 80 },
    profile: { type: 'string', enum: ['adult', 'elder'], default: 'adult' },
    // items are checked one by one in the handler (engine browserPois): a bad one is dropped, not fatal
    browser_pois: { type: 'array' },
  },
} as const;

/**
 * Up to 400 browser POIs of ~250 bytes each (a 60-character name and an escaped one stay well inside).
 * Everything else of the body is a few hundred bytes.
 */
export const ANALYZE_BODY_LIMIT = 192 * 1024;

function describeInvalid(errors: FastifySchemaValidationError[]): string {
  const first = errors[0];
  const field =
    first?.keyword === 'required' ? first.params.missingProperty : first?.instancePath.split('/')[1];
  switch (field) {
    case 'center_bd09':
      return 'center_bd09 须为中国境内的 BD-09 坐标 [经度, 纬度]';
    case 'profile':
      return 'profile 只能是 adult（成人）或 elder（老年人）';
    case 'label':
      return 'label 须为不超过 80 个字符的文本';
    case 'browser_pois':
      return 'browser_pois 须为数组：[{ uid, name, keyword, bd09 }]（地图前端检索到的设施）';
    default:
      return '请求体须为 JSON 对象，例如 {"center_bd09": [121.644195, 31.19007], "profile": "adult"}';
  }
}

export function sseEvent(event: string, data: unknown): string {
  // JSON.stringify escapes CR and LF, so one data line always suffices.
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const HEARTBEAT_MS = 15_000;
// Abort reasons, compared by identity to choose the closing message.
const CLIENT_GONE = new Error('client disconnected');
const SHUTDOWN = new Error('server shutting down');
const TIMEOUT = new Error('analysis timed out');

export interface AnalyzeRouteOptions {
  mode: Mode;
  analyzer: Analyzer | undefined;
  perHour: number;
  maxConcurrent: number;
  timeoutMs: number;
  /**
   * Keeps each result (memory and the persistent history) for POST /api/ask, GET /api/analysis/:id and
   * GET /api/history, and stamps meta.analysis_id on what is sent.
   */
  live?: LiveResults;
}

export function registerAnalyzeRoute(app: FastifyInstance, opts: AnalyzeRouteOptions): void {
  const running = new Set<AbortController>();
  // Open streams would hold app.close() forever; end them with an error event instead.
  app.addHook('preClose', async () => {
    for (const controller of running) controller.abort(SHUTDOWN);
  });

  // `upstream` stays reserved for Baidu-side failures; everything unexpected is `internal`.
  const closingEvent = (err: unknown, signal: AbortSignal): { code: AnalyzeErrorCode; message: string } => {
    if (signal.reason === SHUTDOWN) return { code: 'internal', message: '服务正在重启，请稍后重试' };
    if (signal.reason === TIMEOUT) {
      return { code: 'timeout', message: `分析超时（${Math.round(opts.timeoutMs / 1000)} 秒），请稍后重试` };
    }
    if (err instanceof AnalyzeError) return { code: err.code, message: err.message };
    // Baidu errors that the analyzer did not wrap keep their own code (auth, quota_exhausted …).
    if (err instanceof BaiduError) {
      const { error, message } = toApiError(err);
      return { code: error, message: forClient(message) };
    }
    return { code: 'internal', message: '分析出错，请稍后重试' };
  };

  app.post<{ Body: AnalyzeInput }>(
    '/api/analyze',
    {
      bodyLimit: ANALYZE_BODY_LIMIT,
      schema: { body: bodySchema },
      schemaErrorFormatter: (errors) => new ApiError(400, 'invalid_input', describeInvalid(errors)),
      config: {
        rateLimit: {
          max: opts.perHour,
          timeWindow: 3_600_000,
          errorResponseBuilder: (_req, ctx) =>
            new ApiError(
              ctx.statusCode,
              'rate_limited',
              `分析次数已达上限（每个 IP 每小时 ${ctx.max} 次），请 ${formatWait(ctx.ttl)}后再试`,
            ),
        },
      },
      // Before body parsing and validation: in sample mode the endpoint does not exist, whatever the body.
      onRequest: async () => {
        if (opts.mode !== 'live' || !opts.analyzer) {
          throw new ApiError(
            409,
            'live_mode_disabled',
            '当前为样例模式（未配置百度服务端 Key），只能查看样例社区',
          );
        }
      },
    },
    async (req, reply) => {
      const analyzer = opts.analyzer;
      if (!analyzer) throw new ApiError(409, 'live_mode_disabled', '当前为样例模式，只能查看样例社区');
      if (running.size >= opts.maxConcurrent) {
        throw new ApiError(503, 'busy', '当前分析任务较多，请稍后再试');
      }

      // Browser POIs: the valid items only, the field left out when none is. No result is ever served
      // from a cache here: every request runs the analyzer, whose Baidu cache is per request (a detail
      // request is keyed by its uids), and AnalysisStore.liveId includes meta.generated, so a result
      // computed without browser_pois never stands in for one with them. Nothing to add to any key.
      const { browser_pois: raw, ...rest } = req.body;
      const found = raw === undefined ? [] : browserPois(raw);
      const input: AnalyzeInput = found.length ? { ...rest, browser_pois: found } : rest;

      const controller = new AbortController();
      const { signal } = controller;
      running.add(controller);
      const stream = new PassThrough();
      let open = true;
      const write = (chunk: string) => {
        if (open && !stream.destroyed) stream.write(chunk);
      };
      const emit: Emit = (event, data) => write(sseEvent(event, data));
      // Fastify destroys the payload stream when the client goes away.
      stream.on('close', () => {
        if (open) controller.abort(CLIENT_GONE);
      });
      const heartbeat = setInterval(() => write(': ping\n\n'), HEARTBEAT_MS).unref();
      const timer = setTimeout(() => controller.abort(TIMEOUT), opts.timeoutMs).unref();

      void (async () => {
        try {
          const result = await untilAborted(analyzer.analyze(input, emit, signal), signal);
          const { label, profile } = input;
          const sent = opts.live
            ? opts.live.put(result, { ...(label === undefined ? {} : { label }), profile })
            : result;
          write(sseEvent('result', sent));
        } catch (err) {
          if (signal.reason === CLIENT_GONE) {
            req.log.info('客户端已断开，分析中止');
          } else {
            const event = closingEvent(err, signal);
            if (err instanceof AnalyzeError || err instanceof BaiduError) {
              req.log.warn({ code: event.code, err }, `分析失败：${event.message}`);
            } else if (!signal.aborted) {
              req.log.error({ err }, '分析器异常');
            }
            write(sseEvent('error', event));
          }
        } finally {
          open = false;
          clearInterval(heartbeat);
          clearTimeout(timer);
          running.delete(controller);
          stream.end();
        }
      })();

      return reply
        .header('content-type', 'text/event-stream; charset=utf-8')
        .header('cache-control', 'no-cache, no-transform')
        .header('x-accel-buffering', 'no') // nginx: flush events as they come
        .send(stream);
    },
  );
}
