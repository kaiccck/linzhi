import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import { ApiError } from './errors.js';

/** "42 秒" / "5 分钟" / "1 小时" for retry hints. */
export function formatWait(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.ceil(minutes / 60)} 小时`;
}

/** Per-IP limit on every route; routes may override it (POST /api/analyze is much stricter). */
export async function registerRateLimit(app: FastifyInstance, perMinute: number): Promise<void> {
  await app.register(rateLimit, {
    global: true,
    max: perMinute,
    timeWindow: 60_000,
    errorResponseBuilder: (_req, ctx) =>
      new ApiError(ctx.statusCode, 'rate_limited', `请求过于频繁，请 ${formatWait(ctx.ttl)}后再试`),
  });
}
