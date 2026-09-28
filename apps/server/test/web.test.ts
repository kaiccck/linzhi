import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp } from './helpers.js';

describe('static web hosting', () => {
  const root = mkdtempSync(join(tmpdir(), 'zdd-web-'));
  const dist = join(root, 'dist');
  let app: FastifyInstance;

  beforeAll(async () => {
    mkdirSync(join(dist, 'assets'), { recursive: true });
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>走得到</title>');
    writeFileSync(join(dist, 'assets/index-1a2b3c.js'), 'console.log("zdd")');
    writeFileSync(join(root, 'secret.txt'), 'TOP-SECRET');
    app = await makeApp({ webDistDir: dist });
  });
  afterAll(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('serves index.html uncached and fingerprinted assets as immutable', async () => {
    const page = await app.inject('/');
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toMatch(/^text\/html/);
    expect(page.headers['cache-control']).toBe('no-cache');
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(page.payload).toContain('走得到');

    const asset = await app.inject('/assets/index-1a2b3c.js');
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('falls back to index.html for client-side routes', async () => {
    const res = await app.inject('/community/zj-a');
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('<title>走得到</title>');
  });

  it('keeps JSON 404s for API routes and missing files', async () => {
    const api = await app.inject('/api/unknown');
    expect(api.statusCode).toBe(404);
    expect(api.json()).toEqual({ error: 'not_found', message: '接口不存在' });

    const file = await app.inject('/assets/missing.js');
    expect(file.statusCode).toBe(404);
    expect(file.json()).toMatchObject({ error: 'not_found' });

    const post = await app.inject({ method: 'POST', url: '/community' });
    expect(post.statusCode).toBe(404);
  });

  it.each([
    '/..%2fsecret.txt',
    '/%2e%2e/secret.txt',
    '/assets/..%2f..%2fsecret.txt',
    '/assets/%2e%2e/%2e%2e/secret.txt',
  ])('does not serve files outside the web root via %s', async (url) => {
    const res = await app.inject(url);
    expect([400, 403, 404]).toContain(res.statusCode);
    expect(res.payload).not.toContain('TOP-SECRET');
  });
});

describe('without a web build', () => {
  it('skips static hosting and explains how to get the web app', async () => {
    const app = await makeApp();
    const res = await app.inject('/');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found', message: expect.stringContaining('Web 构建产物') });
    expect((await app.inject('/api/health')).statusCode).toBe(200);
    await app.close();
  });
});
