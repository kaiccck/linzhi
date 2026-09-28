import type { FastifyInstance } from 'fastify';
import type { Analyzer } from '../analyzer.js';
import type { ServerConfig } from '../config.js';
import { ApiError } from '../errors.js';
import type { QuotaProvider } from '../quota.js';
import type { SampleStore } from '../samples.js';
import { appendVary } from '../security.js';

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

export function registerSampleRoutes(app: FastifyInstance, samples: SampleStore): void {
  app.get('/api/samples', async () => samples.list());

  app.get<{ Params: { id: string } }>('/api/analysis/:id', async (req, reply) => {
    // The id only ever selects an entry of the scanned catalogue; it never becomes part of a path.
    const sample = await samples.get(req.params.id);
    if (!sample) throw new ApiError(404, 'not_found', '样例不存在');

    reply.header('etag', sample.etag).header('cache-control', 'no-cache');
    appendVary(reply, 'Accept-Encoding');
    if (req.headers['if-none-match'] === sample.etag) return reply.code(304).send();

    reply.type('application/json; charset=utf-8');
    if (!acceptsGzip(req.headers['accept-encoding'])) return reply.send(sample.body);
    return reply.header('content-encoding', 'gzip').send(await sample.gzipped());
  });
}
