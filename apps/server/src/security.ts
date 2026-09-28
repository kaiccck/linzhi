import type { FastifyInstance, FastifyReply } from 'fastify';

const API_CSP = "default-src 'none'; frame-ancestors 'none'";
// Pages load Baidu JSAPI GL, which pulls scripts, styles, tiles and workers from many Baidu hosts, so
// the page policy only locks down what never breaks the map.
const PAGE_CSP = "object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

export function isApiPath(url: string): boolean {
  return url === '/api' || url.startsWith('/api/') || url.startsWith('/api?');
}

/** reply.header() replaces; Vary has to accumulate (CORS adds Origin, samples add Accept-Encoding). */
export function appendVary(reply: FastifyReply, value: string): void {
  const current = reply.getHeader('vary');
  reply.header('vary', current === undefined ? value : `${String(current)}, ${value}`);
}

export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    // The browser AK is checked against the Referer whitelist, so the origin must still be sent.
    reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    reply.header('cross-origin-resource-policy', 'same-origin');
    reply.header('content-security-policy', isApiPath(req.url) ? API_CSP : PAGE_CSP);
    return payload;
  });
}

/**
 * Off unless origins are listed: without CORS headers browsers keep /api same-origin (the built web
 * app is served from here; in development Vite proxies /api).
 */
export function registerCors(app: FastifyInstance, origins: readonly string[]): void {
  if (origins.length === 0) return;
  const allowed = new Set(origins);
  app.addHook('onRequest', async (req, reply) => {
    if (!isApiPath(req.url)) return;
    appendVary(reply, 'Origin');
    const origin = req.headers.origin;
    if (origin === undefined || !allowed.has(origin)) return;
    reply.header('access-control-allow-origin', origin);
    if (req.method !== 'OPTIONS') return;
    return reply
      .code(204)
      .header('access-control-allow-methods', 'GET, POST')
      .header('access-control-allow-headers', 'content-type')
      .header('access-control-max-age', '600')
      .send();
  });
}
