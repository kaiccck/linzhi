import type { LlmConfig } from '@zoudedao/agent';
import type { BaiduClient } from '@zoudedao/baidu';
import Fastify, { type FastifyInstance } from 'fastify';
import { advisorInfo, LiveResults, ServerBackend } from './advisor.js';
import type { Analyzer } from './analyzer.js';
import type { ServerConfig } from './config.js';
import { ApiError, registerErrorHandler } from './errors.js';
import { emptyQuota, type QuotaProvider } from './quota.js';
import { registerRateLimit } from './rate-limit.js';
import { logSerializers } from './redact.js';
import { REPLAY_SAMPLE_ID, SampleReplayAnalyzer } from './replay.js';
import { registerAnalyzeRoute } from './routes/analyze.js';
import { registerHealthRoute, registerSampleRoutes } from './routes/api.js';
import { registerAskRoute } from './routes/ask.js';
import { registerLocateRoute } from './routes/locate.js';
import { SampleStore } from './samples.js';
import { registerCors, registerSecurityHeaders } from './security.js';
import { registerNotFound, registerWebApp } from './web.js';

export interface AppOptions {
  config: ServerConfig;
  /** Live-mode Baidu client: its ledger feeds /api/health and it is closed together with the app. */
  baidu?: BaiduClient;
  /** Live-mode engine; defaults to SampleReplayAnalyzer until the Baidu-backed one is wired in. */
  analyzer?: Analyzer;
  /** Quota block of /api/health; defaults to the Baidu ledger, else the replay ledger (live) or {} (sample). */
  quota?: QuotaProvider;
  /**
   * Model of the 体检顾问 (POST /api/ask), from llmConfigFromEnv(); null/absent = template mode. The
   * key only ever reaches the model's Authorization header.
   */
  llm?: LlmConfig | null;
  /** Log destination (default stdout); tests capture it. */
  logStream?: { write(line: string): void };
}

export async function buildApp({
  config,
  baidu,
  analyzer,
  quota,
  llm = null,
  logStream,
}: AppOptions): Promise<FastifyInstance> {
  const { trustProxy } = config;
  const app = Fastify({
    logger: {
      level: config.logLevel,
      serializers: logSerializers,
      ...(logStream === undefined ? {} : { stream: logStream }),
    },
    // A hop count trusts that many proxies in front of us (Fastify's typings only take the function form).
    trustProxy:
      typeof trustProxy === 'number' ? (_address: string, hop: number) => hop < trustProxy : trustProxy,
    bodyLimit: 64 * 1024,
    // Bodies are tiny and typed: reject "121.6" where a number is expected instead of coercing it.
    ajv: { customOptions: { coerceTypes: false } },
    // Fastify's own 503 body is not in the unified error format; the onRequest hook below answers instead.
    return503OnClosing: false,
  });

  // Also in sample mode: they explain why keys were not accepted. The messages never contain key values.
  for (const issue of config.baidu.issues) app.log[issue.level]({ key: issue.key }, issue.message);

  registerErrorHandler(app);
  // Requests that still arrive on open connections while the server drains (the analyze route ends
  // running streams from its own preClose hook). 503 rather than 500, so proxies retry elsewhere.
  let closing = false;
  app.addHook('preClose', async () => {
    closing = true;
  });
  app.addHook('onRequest', async () => {
    if (closing) throw new ApiError(503, 'internal', '服务正在重启，请稍后重试');
  });
  registerSecurityHeaders(app);
  registerCors(app, config.corsOrigins);
  await registerRateLimit(app, config.rateLimit.globalPerMinute);

  if (baidu) {
    quota ??= baidu.ledger;
    app.addHook('onClose', async () => baidu.close());
  }
  const samples = new SampleStore(config.samplesDir, app.log);
  if (config.mode === 'live' && !analyzer) {
    const replay = new SampleReplayAnalyzer({
      load: () => samples.readResult(REPLAY_SAMPLE_ID),
      pace: config.replayPace,
    });
    analyzer = replay;
    // Simulated usage never enters the real Baidu ledger.
    quota ??= replay.ledger;
    app.log.warn(
      `live 模式尚未接入实时分析器：POST /api/analyze 回放样例 ${REPLAY_SAMPLE_ID}，不调用百度接口`,
    );
  }

  // Results of POST /api/analyze that the advisor can still answer about (meta.analysis_id).
  const live = new LiveResults();
  registerHealthRoute(app, { config, quota: quota ?? emptyQuota, analyzer, advisor: advisorInfo(llm) });
  registerSampleRoutes(app, samples);
  registerLocateRoute(app, {
    baidu,
    samples,
    perMinute: config.rateLimit.locatePerMinute,
    timeoutMs: config.locateTimeoutMs,
  });
  registerAnalyzeRoute(app, {
    mode: config.mode,
    analyzer,
    perHour: config.rateLimit.analyzePerHour,
    maxConcurrent: config.maxConcurrentAnalyses,
    timeoutMs: config.analyzeTimeoutMs,
    live,
  });
  registerAskRoute(app, {
    backend: new ServerBackend(samples, live),
    live,
    llm,
    // an LLM answer costs money and up to a minute of a model's time: fewer per visitor
    per10Min: config.rateLimit.askPer10Min ?? (llm ? 12 : 30),
    maxConcurrent: config.maxConcurrentAsks,
    timeoutMs: config.askTimeoutMs,
  });

  const hasWeb = await registerWebApp(app, config.webDistDir);
  if (!hasWeb) app.log.info({ webDistDir: config.webDistDir }, '未找到 Web 构建产物，只提供 /api');
  registerNotFound(app, hasWeb);
  return app;
}
