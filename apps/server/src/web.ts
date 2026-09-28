import { existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { isApiPath } from './security.js';

/** Serves the built web app when <distDir>/index.html exists; returns whether it did. */
export async function registerWebApp(app: FastifyInstance, distDir: string): Promise<boolean> {
  if (!existsSync(join(distDir, 'index.html'))) return false;
  await app.register(fastifyStatic, {
    root: distDir,
    dotfiles: 'ignore',
    setHeaders(reply, file) {
      // Vite fingerprints everything under assets/; index.html must always be revalidated.
      const immutable = relative(distDir, file).startsWith(`assets${sep}`);
      reply.header('cache-control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });
  return true;
}

export function registerNotFound(app: FastifyInstance, hasWeb: boolean): void {
  app.setNotFoundHandler({ preHandler: app.rateLimit() }, (req, reply) => {
    const path = req.url.split('?', 1)[0] ?? '/';
    if (isApiPath(path)) return reply.code(404).send({ error: 'not_found', message: '接口不存在' });
    // Client-side routes get the SPA shell; a missing file (anything with an extension) stays 404.
    if (hasWeb && (req.method === 'GET' || req.method === 'HEAD') && !/\.[^/]*$/.test(path)) {
      return reply.sendFile('index.html');
    }
    const message = hasWeb
      ? '文件不存在'
      : '未找到 Web 构建产物：开发时请访问 http://localhost:5173，部署前请先运行 pnpm build';
    return reply.code(404).send({ error: 'not_found', message });
  });
}
