import { describe, expect, it, vi } from 'vitest';
import Taro, { onRequest } from '../../test/taro-stub';
import { AbortController, fetch, TextDecoderStream, Utf8Decoder } from './web';

// the module calls the mini program's global wx.request
vi.stubGlobal('wx', Taro);

const enc = (s: string) => new TextEncoder().encode(s);
const buf = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

describe('Utf8Decoder', () => {
  it('holds a character split across chunks', () => {
    const bytes = enc('走一遍 15′');
    const d = new Utf8Decoder();
    let out = '';
    for (let i = 0; i < bytes.length; i += 2) out += d.decode(bytes.subarray(i, i + 2));
    expect(out + d.decode(undefined, false)).toBe('走一遍 15′');
  });
});

describe('fetch over wx.request', () => {
  it('reads JSON with its status and headers, relative URLs on the API origin', async () => {
    onRequest((req, t) => {
      expect(req.url).toBe('http://api.test/api/health');
      req.success?.({ statusCode: 200, header: { 'Content-Type': 'application/json' }, data: '{"ok":true}' });
      void t;
    });
    const res = await fetch('/api/health', { headers: { accept: 'application/json' } });
    expect(res.ok).toBe(true);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual({ ok: true });
  });

  it('rejects as offline when the request fails, and as aborted when asked to stop', async () => {
    onRequest((req) => req.fail?.({ errMsg: 'request:fail timeout' }));
    await expect(fetch('/api/x')).rejects.toThrow(/Failed to fetch/);
    onRequest(() => {});
    const ctl = new AbortController();
    const p = fetch('/api/x', { signal: ctl.signal });
    ctl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('streams an event stream chunk by chunk through the web’s own reader', async () => {
    const text =
      'event: stage\ndata: {"stage":"seed","message":"采样","progress":0.1}\n\nevent: result\ndata: {"ok":"走得到"}\n\n';
    const bytes = enc(text);
    onRequest((req, t) => {
      expect(req.enableChunked).toBe(true);
      t.headers({ 'content-type': 'text/event-stream' });
      // odd-sized chunks cut through the Chinese characters
      for (let i = 0; i < bytes.length; i += 7) t.chunk(buf(bytes.subarray(i, i + 7)));
      req.success?.({ statusCode: 200, header: {}, data: new ArrayBuffer(0) });
    });
    // what config/index.ts's ProvidePlugin does in the build
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('TextDecoderStream', TextDecoderStream);
    const { postEvents } = await import('@web/data/api');
    const seen: string[] = [];
    const out = await postEvents(
      '/api/analyze',
      {},
      (event, payload) => {
        seen.push(event);
        return event === 'result' ? payload : undefined;
      },
      new AbortController().signal as never,
    );
    expect(seen).toEqual(['stage', 'result']);
    expect(out).toEqual({ ok: '走得到' });
    vi.unstubAllGlobals();
    vi.stubGlobal('wx', Taro);
  });

  it('answers a stream request that fails with JSON with its real status', async () => {
    onRequest((req, t) => {
      t.headers({ 'content-type': 'application/json' });
      t.chunk(buf(enc('{"error":"rate_limited","message":"请求太频繁"}')));
      req.success?.({
        statusCode: 429,
        header: { 'content-type': 'application/json' },
        data: new ArrayBuffer(0),
      });
    });
    const res = await fetch('/api/ask', {
      method: 'POST',
      headers: { accept: 'text/event-stream' },
      body: '{}',
    });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'rate_limited', message: '请求太频繁' });
  });

  it('decodes through the TextDecoderStream marker', async () => {
    onRequest((req, t) => {
      t.headers({ 'content-type': 'text/event-stream' });
      t.chunk(buf(enc('邻至')));
      req.success?.({ statusCode: 200, header: {}, data: new ArrayBuffer(0) });
    });
    const res = await fetch('/s', { headers: { accept: 'text/event-stream' } });
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    expect((await reader.read()).value).toBe('邻至');
    expect((await reader.read()).done).toBe(true);
  });
});
