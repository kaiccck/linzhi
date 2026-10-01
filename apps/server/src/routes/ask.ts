import { PassThrough } from 'node:stream';
import {
  createToolRegistry,
  scrubSecrets,
  type AdvisorAnswer,
  type AdvisorEvent,
  type LlmConfig,
} from '@zoudedao/agent';
import type { FastifyInstance, FastifySchemaValidationError } from 'fastify';
import { untilAborted } from '../abort.js';
import { answerQuestion, type LiveResults, type ServerBackend } from '../advisor.js';
import { ApiError } from '../errors.js';
import { formatWait } from '../rate-limit.js';
import { forClient } from '../redact.js';
import { sseEvent } from './analyze.js';

/** POST /api/ask per IP per 10 minutes, template and LLM mode alike (ZDD_ASK_PER_10MIN overrides). */
export const ASK_PER_10MIN = 30;
export const QUESTION_MAX = 300;
export const HISTORY_MAX = 8;
export const HISTORY_CONTENT_MAX = 2000;
/** Summaries and arguments beyond this are cut: events carry text, never raw data blobs. */
const SUMMARY_MAX = 20_000;
const ARGS_MAX = 2_000;
const HEARTBEAT_MS = 15_000;
// Abort reasons, compared by identity to choose the closing message.
const CLIENT_GONE = new Error('client disconnected');
const SHUTDOWN = new Error('server shutting down');
const TIMEOUT = new Error('ask timed out');

interface AskBody {
  question: string;
  analysis_id?: string;
  history?: { role: 'user' | 'assistant'; content: string }[];
}

const bodySchema = {
  type: 'object',
  required: ['question'],
  properties: {
    question: { type: 'string', maxLength: 1000 },
    analysis_id: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[A-Za-z0-9][A-Za-z0-9_~-]*$' },
    history: {
      type: 'array',
      maxItems: HISTORY_MAX,
      items: {
        type: 'object',
        required: ['role', 'content'],
        properties: {
          role: { type: 'string', enum: ['user', 'assistant'] },
          content: { type: 'string', maxLength: HISTORY_CONTENT_MAX },
        },
      },
    },
  },
} as const;

const EXAMPLE = '请求体须为 JSON 对象，例如 {"question": "老人买菜方便吗？", "analysis_id": "zj-a"}';

function describeInvalid(errors: FastifySchemaValidationError[]): string {
  const first = errors[0];
  // a field missing inside history[] belongs to history
  const field =
    first?.keyword === 'required' && !first.instancePath
      ? first.params.missingProperty
      : first?.instancePath.split('/')[1];
  switch (field) {
    case 'question':
      return `question 须为 1–${QUESTION_MAX} 个字符的问题`;
    case 'analysis_id':
      return 'analysis_id 须为分析编号，例如 zj-a 或 live-1a2b3c4d';
    case 'history':
      return `history 最多 ${HISTORY_MAX} 条，每条为 {"role": "user" 或 "assistant", "content": 不超过 ${HISTORY_CONTENT_MAX} 个字符}`;
    default:
      return EXAMPLE;
  }
}

const length = (text: string) => [...text].length;

export interface AskRouteOptions {
  backend: ServerBackend;
  live: LiveResults;
  llm: LlmConfig | null;
  /** Per IP per 10 minutes. */
  per10Min: number;
  maxConcurrent: number;
  timeoutMs: number;
}

function cut(text: string, max = SUMMARY_MAX): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function registerAskRoute(app: FastifyInstance, opts: AskRouteOptions): void {
  const registry = createToolRegistry();
  const title = (tool: string) => registry.get(tool)?.title ?? tool;
  const secret = opts.llm?.apiKey;
  const clean = (text: string) => forClient(scrubSecrets(text, secret));
  // the model gets three quarters of the budget (45 s of 60 s); the template needs well under a second
  const llmBudgetMs = Math.max(Math.round(opts.timeoutMs * 0.75), opts.timeoutMs - 15_000);
  const running = new Set<AbortController>();
  app.addHook('preClose', async () => {
    for (const controller of running) controller.abort(SHUTDOWN);
  });

  // Event and answer shapes of docs/api.md: text only, tool titles resolved, no raw data blobs.
  const toEvent = (e: AdvisorEvent): [string, unknown] | null => {
    switch (e.type) {
      case 'tool_call': {
        const args = JSON.stringify(e.args ?? {});
        return [
          'tool_call',
          { tool: e.tool, title: title(e.tool), ...(args.length <= ARGS_MAX ? { args: e.args ?? {} } : {}) },
        ];
      }
      case 'tool_result':
        return [
          'tool_result',
          {
            tool: e.tool,
            title: title(e.tool),
            ...(e.id ? { id: e.id } : {}),
            ...(e.summary !== undefined ? { summary: cut(e.summary) } : {}),
            ...(e.error !== undefined ? { error: clean(e.error) } : {}),
          },
        ];
      case 'progress':
        return [
          'progress',
          { message: e.message, ...(e.progress === undefined ? {} : { progress: e.progress }) },
        ];
      case 'repair':
        return ['repair', { unsupported: e.unsupported, uncited: e.uncited }];
      case 'fallback':
        return ['fallback', { reason: clean(e.reason) }];
      case 'answer':
        return null; // sent once, from the returned answer
    }
  };

  const toAnswer = (a: AdvisorAnswer) => ({
    answer: a.answer,
    mode: a.mode,
    ...(opts.llm ? { model: opts.llm.model } : {}),
    citations: a.citations.map((c) => ({
      id: c.id,
      tool: c.tool,
      title: title(c.tool),
      summary: cut(c.summary),
      // the places the result names, for the map; [] when it names none
      anchors: c.anchors ?? [],
    })),
    grounding: {
      ok: a.grounding.ok,
      checked: a.grounding.checked,
      unsupported: a.grounding.unsupported,
      uncited: a.grounding.uncited,
    },
    ...(a.analysisId ? { analysis_id: a.analysisId } : {}),
    ...(a.attachments?.length ? { attachments: a.attachments } : {}),
    ...(a.repaired ? { repaired: true } : {}),
    // numbers that were real but cited in the wrong place, whose source ids the system appended
    ...(a.citationsAdded?.length ? { citations_added: a.citationsAdded } : {}),
    ...(a.fallback
      ? { fallback: { reason: clean(a.fallback.reason), unsupported: a.fallback.unsupported } }
      : {}),
  });

  // Tool and model failures already became answers inside the advisor; what is left is ours.
  const closingEvent = (signal: AbortSignal): { code: string; message: string } => {
    if (signal.reason === SHUTDOWN) return { code: 'internal', message: '服务正在重启，请稍后重试' };
    if (signal.reason === TIMEOUT) {
      return {
        code: 'timeout',
        message: `问询超时（${Math.round(opts.timeoutMs / 1000)} 秒），请稍后重试或换个问法`,
      };
    }
    return { code: 'internal', message: '问询出错，请稍后重试' };
  };

  app.post<{ Body: AskBody }>(
    '/api/ask',
    {
      bodyLimit: 64 * 1024,
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
              `问询过于频繁（每个 IP 每 10 分钟 ${ctx.max} 次），请 ${formatWait(ctx.ttl)}后再试`,
            ),
        },
      },
    },
    async (req, reply) => {
      const question = req.body.question.trim();
      if (length(question) === 0 || length(question) > QUESTION_MAX) {
        throw new ApiError(400, 'invalid_input', `question 须为 1–${QUESTION_MAX} 个字符的问题`);
      }
      const analysisId = req.body.analysis_id;
      if (analysisId !== undefined && !(await opts.backend.knows(analysisId))) {
        throw new ApiError(
          400,
          'invalid_input',
          `analysis_id「${analysisId}」对应的分析不存在或已过期（实时体检的结果在服务端${opts.live.retention()}），请重新体检，或切换到样例`,
        );
      }
      if (running.size >= opts.maxConcurrent) {
        throw new ApiError(503, 'busy', '当前问询较多，请稍后再试');
      }

      const controller = new AbortController();
      const { signal } = controller;
      running.add(controller);
      const stream = new PassThrough();
      let open = true;
      const write = (chunk: string) => {
        if (open && !stream.destroyed) stream.write(chunk);
      };
      stream.on('close', () => {
        if (open) controller.abort(CLIENT_GONE);
      });
      // a model may think for a while before the first event: flush the headers now
      write(': ping\n\n');
      const heartbeat = setInterval(() => write(': ping\n\n'), HEARTBEAT_MS).unref();
      const timer = setTimeout(() => controller.abort(TIMEOUT), opts.timeoutMs).unref();
      const started = Date.now();
      const tools: string[] = [];

      void (async () => {
        try {
          const answer = await untilAborted(
            answerQuestion({
              backend: opts.backend,
              live: opts.live,
              registry,
              llm: opts.llm,
              question,
              ...(analysisId ? { analysisId } : {}),
              history: req.body.history ?? [],
              signal,
              llmBudgetMs,
              onEvent: (e) => {
                if (e.type === 'tool_call') tools.push(e.tool);
                const ev = toEvent(e);
                if (ev) write(sseEvent(ev[0], ev[1]));
              },
            }),
            signal,
          );
          write(sseEvent('answer', toAnswer(answer)));
          req.log.info(
            {
              analysisId,
              mode: answer.mode,
              tools,
              grounded: answer.grounding.ok,
              fallback: !!answer.fallback,
              ms: Date.now() - started,
            },
            '问询完成',
          );
        } catch (err) {
          if (signal.reason === CLIENT_GONE) {
            req.log.info('客户端已断开，问询中止');
          } else {
            const event = closingEvent(signal);
            if (!signal.aborted) req.log.error({ err }, '问询异常');
            else req.log.warn({ code: event.code }, `问询结束：${event.message}`);
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
        .header('x-accel-buffering', 'no')
        .send(stream);
    },
  );
}
