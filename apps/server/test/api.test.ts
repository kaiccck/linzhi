import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { gunzipSync } from 'node:zlib';
import type { AnalysisResult } from '@zoudedao/core';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, SERVER_VERSION } from './helpers.js';

describe('GET /api/health', () => {
  it('reports sample mode, the version and an empty quota, with security headers and no CORS', async () => {
    const app = await makeApp();
    const res = await app.inject('/api/health');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      mode: 'sample',
      version: SERVER_VERSION,
      advisor: { mode: 'template' },
      quota: {},
    });
    expect(res.headers).toMatchObject({
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
  });

  it('takes the quota snapshot from the injected provider', async () => {
    const app = await makeApp({}, { quota: { snapshot: async () => ({ place: { used: 3, limit: 100 } }) } });
    const res = await app.inject('/api/health');
    expect(res.json()).toMatchObject({ quota: { place: { used: 3, limit: 100 } } });
    await app.close();
  });
});

describe('samples', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await makeApp();
  });
  afterAll(() => app.close());

  it('lists samples with id, name and centre taken from meta', async () => {
    const res = await app.inject('/api/samples');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toContainEqual({
      id: 'zj-a',
      name: '申城佳苑片区',
      center_bd09: [121.644195, 31.19007],
      center_label: '孙环路 × 高木桥路',
    });
  });

  it('serves the full AnalysisResult, gzip on request, and honours the ETag', async () => {
    const res = await app.inject('/api/analysis/zj-a');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    const result = res.json<AnalysisResult>();
    expect(result.meta.name).toBe('申城佳苑片区');
    expect(result.field.t_s).toHaveLength(result.field.nx * result.field.ny);
    expect(Object.keys(result.contours)).toEqual(['300', '600', '900']);

    const zipped = await app.inject({
      url: '/api/analysis/zj-a',
      headers: { 'accept-encoding': 'br, gzip' },
    });
    expect(zipped.headers['content-encoding']).toBe('gzip');
    expect(zipped.headers.vary).toContain('Accept-Encoding');
    expect(gunzipSync(zipped.rawPayload).equals(res.rawPayload)).toBe(true);

    const etag = res.headers.etag;
    expect(etag).toMatch(/^W\//);
    const cached = await app.inject({
      url: '/api/analysis/zj-a',
      headers: { 'if-none-match': String(etag) },
    });
    expect(cached.statusCode).toBe(304);
    expect(cached.payload).toBe('');
  });

  it('answers 404 not_found for an unknown sample', async () => {
    const res = await app.inject('/api/analysis/zj-z');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found', message: '样例不存在' });
  });

  it.each([
    '..%2F..%2F..%2Fpackage.json',
    '..%2Fsamples%2Fzj-a',
    '%2e%2e',
    '..',
    'zj-a.json',
    '..%5C..%5Cpackage.json',
    '%2Fetc%2Fpasswd',
    'zj-a%00',
  ])('treats %s as an unknown sample (no path traversal)', async (id) => {
    const res = await app.inject(`/api/analysis/${id}`);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'not_found' });
  });

  it('does not route multi-segment traversal to the sample handler', async () => {
    const res = await app.inject('/api/analysis/../../package.json');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'not_found' });
  });
});

describe('sample directory scanning', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zdd-samples-'));
  const meta = (name: string) => JSON.stringify({ meta: { name, center_bd09: [121.5, 31.2] } });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('skips unreadable, meta-less and oddly named files, and picks up new files without a restart', async () => {
    writeFileSync(join(dir, 'good.json'), meta('好样例'));
    writeFileSync(join(dir, 'broken.json'), '{');
    writeFileSync(join(dir, 'no-meta.json'), '{}');
    writeFileSync(join(dir, 'bad name.json'), meta('空格'));
    writeFileSync(join(dir, 'notes.txt'), 'hello');
    const app = await makeApp({ samplesDir: dir });

    const first = await app.inject('/api/samples');
    expect(first.json()).toEqual([{ id: 'good', name: '好样例', center_bd09: [121.5, 31.2] }]);

    writeFileSync(join(dir, 'later.json'), meta('新样例'));
    const second = await app.inject('/api/samples');
    expect(second.json<{ id: string }[]>().map((s) => s.id)).toEqual(['good', 'later']);
    expect((await app.inject('/api/analysis/later')).statusCode).toBe(200);
    expect((await app.inject('/api/analysis/broken')).statusCode).toBe(404);
    await app.close();
  });

  it('returns an empty list when the directory is missing', async () => {
    const app = await makeApp({ samplesDir: join(dir, 'missing') });
    const res = await app.inject('/api/samples');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    await app.close();
  });
});

describe('CORS', () => {
  it('is only enabled for configured origins', async () => {
    const app = await makeApp({ corsOrigins: ['https://demo.example'] });
    const allowed = await app.inject({ url: '/api/samples', headers: { origin: 'https://demo.example' } });
    expect(allowed.headers['access-control-allow-origin']).toBe('https://demo.example');
    expect(allowed.headers.vary).toContain('Origin');

    const other = await app.inject({ url: '/api/samples', headers: { origin: 'https://evil.example' } });
    expect(other.headers['access-control-allow-origin']).toBeUndefined();

    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/api/analyze',
      headers: { origin: 'https://demo.example', 'access-control-request-method': 'POST' },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-methods']).toContain('POST');
    await app.close();
  });
});

describe('shutdown', () => {
  it('answers requests that arrive while the server drains with 503 internal in the unified format', async () => {
    const app = await makeApp();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as AddressInfo;

    // A half-sent request keeps its connection busy, so closing the server does not drop it.
    const socket = connect(port, '127.0.0.1');
    await once(socket, 'connect');
    socket.write('GET /api/health HTTP/1.1\r\nHost: localhost\r\n');
    await sleep(20);
    const closed = app.close();
    await sleep(50);

    let raw = '';
    socket.setEncoding('utf8').on('data', (chunk: string) => (raw += chunk));
    socket.write('\r\n');
    await once(socket, 'close');
    await closed;

    expect(raw).toMatch(/^HTTP\/1\.1 503 /);
    expect(raw).toMatch(/\r\nconnection: close\r\n/i);
    expect(JSON.parse(raw.slice(raw.indexOf('\r\n\r\n') + 4))).toEqual({
      error: 'internal',
      message: '服务正在重启，请稍后重试',
    });
  });
});
