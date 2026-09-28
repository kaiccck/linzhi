/**
 * Streamable HTTP transport: SDK v2's createMcpHandler (2026-07-28 requests, with the stateless
 * fallback for 2025-era clients) behind a plain node:http server. Binds 127.0.0.1 by default and then
 * checks Host and Origin against localhost names (DNS-rebinding protection).
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMcpHandler, type McpServerFactory } from '@modelcontextprotocol/server';
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from '@modelcontextprotocol/node';

export interface HttpOptions {
  host?: string;
  /** 0 picks a free port. Default 8788. */
  port?: number;
  /** Default /mcp. */
  path?: string;
  /** Out-of-band errors (never secrets). */
  onError?: (err: Error) => void;
}

export interface RunningHttp {
  url: string;
  server: Server;
  close(): Promise<void>;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export async function startHttp(factory: McpServerFactory, opts: HttpOptions = {}): Promise<RunningHttp> {
  const host = opts.host ?? '127.0.0.1';
  const path = opts.path ?? '/mcp';
  const onError = opts.onError ?? (() => undefined);
  const handler = createMcpHandler(factory, { onerror: onError });
  const node = toNodeHandler(handler, { onerror: onError });
  const local = LOOPBACK.has(host);
  // a public bind is an explicit choice; the guards only make sense for loopback names
  const validateHost = local ? localhostHostValidation() : () => true;
  const validateOrigin = local ? localhostOriginValidation() : () => true;

  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/' || pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, name: 'zoudedao-mcp', transport: 'streamable-http', path }));
      return;
    }
    if (pathname !== path) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'not_found', message: `MCP 端点在 ${path}` }));
      return;
    }
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    node(req, res).catch((err: unknown) => {
      onError(err instanceof Error ? err : new Error(String(err)));
      if (!res.headersSent) res.writeHead(500).end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 8788, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const shownHost = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  return {
    url: `http://${shownHost}:${address.port}${path}`,
    server,
    async close() {
      await handler.close();
      await new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}
