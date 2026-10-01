import type { LlmConfig } from '@zoudedao/agent';
import type { BaiduClient } from '@zoudedao/baidu';
import Fastify, { type FastifyInstance } from 'fastify';
import { join } from 'node:path';
import { advisorInfo, LIVE_RESULTS_MAX, LiveResults, ServerBackend } from './advisor.js';
import type { Analyzer } from './analyzer.js';
import type { ServerConfig } from './config.js';
import { ApiError, registerErrorHandler } from './errors.js';
import { HistoryStore } from './history.js';
import { emptyQuota, type QuotaProvider } from './quota.js';
import { registerRateLimit } from './rate-limit.js';
import { logSerializers } from './redact.js';
import { REPLAY_SAMPLE_ID, SampleReplayAnalyzer } from './replay.js';
import { loadSampleRoutes, RouteBook, type RouteWalker } from './route.js';
import { registerAnalyzeRoute } from './routes/analyze.js';
import { registerHealthRoute, registerHistoryRoutes, registerSampleRoutes } from './routes/api.js';
import { ASK_PER_10MIN, registerAskRoute } from './routes/ask.js';
import { registerLocateRoute } from './routes/locate.js';
import { registerRouteRoute } from './routes/route.js';
import { registerWhatIfRoute } from './routes/whatif.js';
import { SampleStore } from './samples.js';
import { registerCors, registerSecurityHeaders } from './security.js';
import { registerNotFound, registerWebApp } from './web.js';
import type { WhatIfRouter } from './whatif.js';

export interface AppOptions {
  config: ServerConfig;
  /** Live-mode Baidu client: its ledger feeds /api/health and it is closed together with the app. */
  baidu?: BaiduClient;
  /** Live-mode engine; defaults to SampleReplayAnalyzer until the Baidu-backed one is wired in. */
  analyzer?: Analyzer;
  /** Routematrix for POST /api/whatif; defaults to the Baidu client (tests inject a fake). */
  router?: WhatIfRouter;
  /** Walking routes (directionlite) for GET /api/route; defaults to the Baidu client (tests inject a fake). */
  walker?: RouteWalker;
  /**
   * The persistent history (live analyses, what-if branches, walking routes); default: opened at
   * config.historyPath (in memory when null) and closed together with the app.
   */
  history?: HistoryStore;
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
  router,
  walker,
  history,
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

  // The history: every live result for 30 days, what-if branches, walking routes (history.ts).
  if (!history) {
    const own = new HistoryStore({ path: config.historyPath, onWarning: (m) => app.log.warn(m) });
    app.addHook('onClose', async () => own.close());
    history = own;
  }
  // Results of POST /api/analyze by meta.analysis_id: in memory, then from the history (after a
  // restart too). Replayed results are the zj-a sample and are not written to the history.
  const live = new LiveResults(LIVE_RESULTS_MAX, {
    history,
    persist: analyzer?.name !== 'replay',
    warn: (message, err) => app.log.warn({ err }, message),
  });
  registerHealthRoute(app, { config, quota: quota ?? emptyQuota, analyzer, advisor: advisorInfo(llm) });
  registerSampleRoutes(app, { samples, live, history });
  registerHistoryRoutes(app, { samples, live, history });
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
  const backend = new ServerBackend(samples, live);
  const resolve = (id: string) => backend.getAnalysis(id).catch(() => undefined);
  registerWhatIfRoute(app, {
    mode: config.mode,
    router: router ?? baidu,
    resolve,
    history,
    retention: live.retention(),
    per10Min: config.rateLimit.whatifPer10Min ?? 10,
    timeoutMs: config.whatifTimeoutMs ?? 20_000,
  });
  registerRouteRoute(app, {
    // Baidu only in live mode with a client; stored routes (samples, history) in every mode
    walker: config.mode === 'live' ? (walker ?? baidu) : undefined,
    routes: new RouteBook(
      loadSampleRoutes(join(config.samplesDir, 'routes'), (m) => app.log.warn(m)),
      history,
      (message, err) => app.log.warn({ err }, message),
    ),
    resolve,
    retention: live.retention(),
    per10Min: config.rateLimit.routePer10Min ?? 30,
    timeoutMs: config.routeTimeoutMs ?? 20_000,
  });
  registerAskRoute(app, {
    backend,
    live,
    llm,
    // 30 in both modes: judges at the venue share one IP; ZDD_ASK_PER_10MIN tightens it
    per10Min: config.rateLimit.askPer10Min ?? ASK_PER_10MIN,
    maxConcurrent: config.maxConcurrentAsks,
    timeoutMs: config.askTimeoutMs,
  });

  const hasWeb = await registerWebApp(app, config.webDistDir);
  if (!hasWeb) app.log.info({ webDistDir: config.webDistDir }, '未找到 Web 构建产物，只提供 /api');
  registerNotFound(app, hasWeb);
  return app;
}
