import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import type { AnalysisResult } from '@zoudedao/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { LIVE_ID, type LiveResults } from '../advisor.js';
import type { Analyzer } from '../analyzer.js';
import type { ServerConfig } from '../config.js';
import { ApiError } from '../errors.js';
import { HISTORY_RECENT, historyItem, type HistoryItem, type HistoryStore } from '../history.js';
import type { QuotaProvider } from '../quota.js';
import type { SampleStore } from '../samples.js';
import { appendVary } from '../security.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export interface HealthOptions {
  config: ServerConfig;
  quota: QuotaProvider;
  analyzer: Analyzer | undefined;
  /** POST /api/ask: template or LLM mode, and the model name (never its key or URL). */
  advisor: { mode: 'llm' | 'template'; model?: string };
}

export function registerHealthRoute(
  app: FastifyInstance,
  { config, quota, analyzer, advisor }: HealthOptions,
): void {
  // `analyzer` lets clients label replayed results; it is absent in sample mode.
  const analyzerName = config.mode === 'live' ? analyzer?.name : undefined;
  app.get('/api/health', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    return {
      ok: true,
      mode: config.mode,
      version: config.version,
      ...(analyzerName === undefined ? {} : { analyzer: analyzerName }),
      advisor,
      quota: await quota.snapshot(),
    };
  });
}

function acceptsGzip(header: string | undefined): boolean {
  return (header ?? '').split(',').some((part) => {
    const [coding, ...params] = part.split(';').map((s) => s.trim());
    const q = params.find((p) => p.startsWith('q='));
    return coding === 'gzip' && (q === undefined || Number(q.slice(2)) > 0);
  });
}

/** JSON with ETag / 304 and gzip when accepted: from the body, or from its gzip (made on demand). */
async function sendJson(
  req: FastifyRequest,
  reply: FastifyReply,
  etag: string,
  data: { body: Buffer; gz?: () => Promise<Buffer> } | { gz: () => Promise<Buffer> | Buffer },
) {
  reply.header('etag', etag).header('cache-control', 'no-cache');
  appendVary(reply, 'Accept-Encoding');
  if (req.headers['if-none-match'] === etag) return reply.code(304).send();
  reply.type('application/json; charset=utf-8');
  const body = 'body' in data ? data.body : undefined;
  if (acceptsGzip(req.headers['accept-encoding'])) {
    const gz = data.gz ? await data.gz() : await gzipAsync(body!);
    return reply.header('content-encoding', 'gzip').send(gz);
  }
  return reply.send(body ?? (await gunzipAsync(await data.gz!())));
}

export interface AnalysisRouteOptions {
  samples: SampleStore;
  /** Live results (memory, then the history): GET /api/analysis/live-… after a restart too. */
  live?: LiveResults;
  history?: HistoryStore;
}

export function registerSampleRoutes(
  app: FastifyInstance,
  { samples, live, history }: AnalysisRouteOptions,
): void {
  app.get('/api/samples', async () => samples.list());

  app.get<{ Params: { id: string } }>('/api/analysis/:id', async (req, reply) => {
    // The id only ever selects an entry of the scanned catalogue or a stored live result by key; it
    // never becomes part of a path.
    const id = req.params.id;
    const sample = await samples.get(id);
    if (sample) {
      return sendJson(req, reply, sample.etag, { body: sample.body, gz: () => sample.gzipped() });
    }
    if (live && LIVE_ID.test(id)) {
      // a live result's content never changes under its id
      const etag = `W/"${id}"`;
      const inMemory = live.peek(id);
      if (inMemory) return sendJson(req, reply, etag, { body: Buffer.from(JSON.stringify(inMemory)) });
      const gz = history?.analysisGzip(id);
      if (gz) return sendJson(req, reply, etag, { gz: () => gz });
    }
    throw new ApiError(
      404,
      'not_found',
      LIVE_ID.test(id) ? '实时体检结果不存在或已过期，请重新体检' : '样例不存在',
    );
  });
}

export interface HistoryRouteOptions {
  samples: SampleStore;
  live: LiveResults;
  history: HistoryStore | undefined;
}

/** GET /api/history (recent live analyses + the samples) and GET /api/analysis/:id/branches. */
export function registerHistoryRoutes(
  app: FastifyInstance,
  { samples, live, history }: HistoryRouteOptions,
): void {
  // headlines of the samples, recomputed only when a file changes
  const sampleItems = new Map<string, { etag: string; item: HistoryItem }>();
  const sampleItem = async (id: string): Promise<HistoryItem | undefined> => {
    const file = await samples.get(id);
    if (!file) return undefined;
    const hit = sampleItems.get(id);
    if (hit?.etag === file.etag) return hit.item;
    const result = JSON.parse(file.body.toString('utf8')) as AnalysisResult;
    const item = historyItem(id, result, { sample: true, created_at: result.meta.generated });
    sampleItems.set(id, { etag: file.etag, item });
    return item;
  };

  app.get('/api/history', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    const recent = history?.recent(HISTORY_RECENT) ?? [];
    const bundled: HistoryItem[] = [];
    for (const s of await samples.list()) {
      const item = await sampleItem(s.id).catch(() => undefined);
      if (item) bundled.push(item);
    }
    return {
      items: [...recent, ...bundled],
      persistent: history?.persistent ?? false,
      retention_days: history?.retentionDays ?? 0,
    };
  });

  app.get<{ Params: { id: string } }>('/api/analysis/:id/branches', async (req) => {
    const id = req.params.id.replace(/~elder$/, '');
    const known = (await samples.get(id)) !== undefined || live.has(id);
    if (!known) {
      throw new ApiError(
        404,
        'not_found',
        `找不到分析 ${id}：样例 id 不存在，或实时结果已过期（服务端${live.retention()}）`,
      );
    }
    return { analysis_id: id, branches: history?.branches(id) ?? [] };
  });
}
