/**
 * The few browser globals the web app's data layer (apps/web/src/data) relies on, built on
 * wx.request so that code runs unchanged in the mini program. config/index.ts injects them with
 * webpack's ProvidePlugin wherever a module uses them as free variables; nothing is put on a global.
 *
 * Only the subset those modules use: fetch(url, { method, headers, body, signal }) → { ok, status,
 * headers.get, json, text, body.pipeThrough(new TextDecoderStream()).getReader() } — the last one for
 * the event streams of POST /api/analyze and POST /api/ask, read with enableChunked.
 */

/**
 * wx.request itself, not Taro.request: this module is injected into whatever uses the globals above —
 * React's scheduler reads `performance` — so it loads before Taro's React runtime has put its page
 * hooks on the Taro object; importing @tarojs/taro here would initialise it too early.
 */
interface WxRequestTask {
  abort(): void;
  onHeadersReceived(fn: (r: { header: Record<string, string> }) => void): void;
  onChunkReceived(fn: (r: { data: ArrayBuffer }) => void): void;
}
interface WxRequestOptions {
  url: string;
  method: 'GET' | 'POST';
  header: Record<string, string>;
  data?: string;
  dataType: string;
  responseType: 'text' | 'arraybuffer';
  enableChunked?: boolean;
  success(res: { statusCode: number; header: Record<string, string>; data: unknown }): void;
  fail(err: { errMsg: string }): void;
}
declare const wx: { request(o: WxRequestOptions): WxRequestTask };
const request = (o: WxRequestOptions) => wx.request(o);

/* ---------------- AbortController ---------------- */

type Listener = () => void;

export class AbortSignalShim {
  aborted = false;
  reason: unknown = undefined;
  onabort: Listener | null = null;
  private listeners = new Set<Listener>();

  addEventListener(type: string, fn: Listener) {
    if (type === 'abort') this.listeners.add(fn);
  }

  removeEventListener(type: string, fn: Listener) {
    if (type === 'abort') this.listeners.delete(fn);
  }

  throwIfAborted() {
    if (this.aborted) throw this.reason;
  }

  /** @internal */
  fire(reason: unknown) {
    if (this.aborted) return;
    this.aborted = true;
    this.reason = reason;
    this.onabort?.();
    for (const fn of [...this.listeners]) fn();
    this.listeners.clear();
  }
}

export class AbortController {
  readonly signal = new AbortSignalShim();

  abort(reason?: unknown) {
    this.signal.fire(reason ?? abortError());
  }
}

export function abortError(): Error {
  const e = new Error('The operation was aborted.');
  e.name = 'AbortError';
  return e;
}

/* ---------------- UTF-8 decoding (no TextDecoder in the mini program) ---------------- */

/** Incremental UTF-8 decoder: a sequence split across chunks is held until its last byte arrives. */
export class Utf8Decoder {
  private rest: number[] = [];

  decode(buf: ArrayBuffer | Uint8Array | undefined, stream = true): string {
    const bytes = buf ? (buf instanceof Uint8Array ? buf : new Uint8Array(buf)) : new Uint8Array(0);
    const all = this.rest.length ? Uint8Array.from([...this.rest, ...bytes]) : bytes;
    this.rest = [];
    let out = '';
    let i = 0;
    while (i < all.length) {
      const b = all[i]!;
      const need = b < 0x80 ? 0 : b >= 0xf0 ? 3 : b >= 0xe0 ? 2 : b >= 0xc0 ? 1 : -1;
      if (need < 0) {
        out += '�';
        i++;
        continue;
      }
      if (i + need >= all.length && need > 0) {
        if (stream) {
          this.rest = Array.from(all.subarray(i));
          break;
        }
        out += '�';
        break;
      }
      let cp = need === 0 ? b : b & (0x3f >> need);
      for (let k = 1; k <= need; k++) cp = (cp << 6) | (all[i + k]! & 0x3f);
      out += String.fromCodePoint(cp);
      i += need + 1;
    }
    return out;
  }
}

/** Marker object: `body.pipeThrough(new TextDecoderStream())` yields decoded strings. */
export class TextDecoderStream {
  readonly decoder = new Utf8Decoder();
}

/* ---------------- fetch ---------------- */

interface Init {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignalShim | null;
}

interface Reader {
  read(): Promise<{ value: string | undefined; done: boolean }>;
  cancel(): Promise<void>;
}

/** The streamed body: chunks queue up until read, then end (or fail) once the request completes. */
class ChunkBody {
  private queue: ArrayBuffer[] = [];
  private waiting: (() => void) | null = null;
  private ended = false;
  private failed: unknown = null;

  constructor(private readonly onCancel: () => void) {}

  push(chunk: ArrayBuffer) {
    this.queue.push(chunk);
    this.wake();
  }

  end(err?: unknown) {
    if (err) this.failed = err;
    this.ended = true;
    this.wake();
  }

  private wake() {
    const w = this.waiting;
    this.waiting = null;
    w?.();
  }

  async next(): Promise<ArrayBuffer | null> {
    for (;;) {
      if (this.queue.length) return this.queue.shift()!;
      if (this.failed) throw this.failed;
      if (this.ended) return null;
      await new Promise<void>((resolve) => (this.waiting = resolve));
    }
  }

  /** everything not read yet, decoded (error bodies of a stream request) */
  async text(): Promise<string> {
    const d = new Utf8Decoder();
    let out = '';
    for (let c = await this.next(); c; c = await this.next()) out += d.decode(c);
    return out + d.decode(undefined, false);
  }

  pipeThrough(t: TextDecoderStream): { getReader(): Reader } {
    return {
      getReader: () => ({
        read: async () => {
          for (;;) {
            const c = await this.next();
            if (!c) {
              const tail = t.decoder.decode(undefined, false);
              return tail ? { value: tail, done: false } : { value: undefined, done: true };
            }
            const value = t.decoder.decode(c);
            if (value) return { value, done: false };
          }
        },
        cancel: async () => {
          this.end();
          this.onCancel();
        },
      }),
    };
  }
}

export interface ResponseShim {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
  body: ChunkBody | null;
}

const headerGetter = (h: Record<string, string> | undefined) => {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) lower[k.toLowerCase()] = String(v);
  return { get: (name: string) => lower[name.toLowerCase()] ?? null };
};

/** "/api/…" goes to the configured server (ZDD_API_BASE). */
export const apiUrl = (url: string) => (/^https?:\/\//.test(url) ? url : `${ZDD_API_BASE}${url}`);

const offlineError = (msg: string) => new TypeError(`Failed to fetch: ${msg}`);

export function fetch(url: string, init: Init = {}): Promise<ResponseShim> {
  const signal = init.signal ?? null;
  if (signal?.aborted) return Promise.reject(signal.reason ?? abortError());
  const headers = { ...(init.headers ?? {}) };
  const stream = /event-stream/i.test(headers.accept ?? headers.Accept ?? '');
  const method = (init.method ?? 'GET').toUpperCase() as 'GET' | 'POST';

  if (!stream) {
    return new Promise((resolve, reject) => {
      const task = request({
        url: apiUrl(url),
        method,
        header: headers,
        data: init.body,
        dataType: '其他',
        responseType: 'text',
        success: (res) => {
          signal?.removeEventListener('abort', onAbort);
          const raw = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? '');
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            headers: headerGetter(res.header),
            json: async () => JSON.parse(raw) as unknown,
            text: async () => raw,
            body: null,
          });
        },
        fail: (err) => {
          signal?.removeEventListener('abort', onAbort);
          reject(signal?.aborted ? signal.reason : offlineError(err.errMsg));
        },
      });
      const onAbort = () => task.abort();
      signal?.addEventListener('abort', onAbort);
    });
  }

  // event stream: resolve at the headers, then feed chunks to the body as they arrive. WeChat's
  // headers event carries no status code, so only an event-stream answer resolves early; anything
  // else (a JSON error, 400/429 …) waits for the whole response and its real status.
  return new Promise((resolve, reject) => {
    let settled = false;
    const body = new ChunkBody(() => task.abort());
    const task = request({
      url: apiUrl(url),
      method,
      header: headers,
      data: init.body,
      dataType: '其他',
      responseType: 'arraybuffer',
      enableChunked: true,
      success: (res) => {
        signal?.removeEventListener('abort', onAbort);
        if (!settled) {
          settled = true;
          // chunks went to the body already; a runtime without chunked transfer hands over res.data
          if (res.data instanceof ArrayBuffer && res.data.byteLength && !seen) body.push(res.data);
          resolve(respond(res.statusCode, res.header, body));
        }
        body.end();
      },
      fail: (err) => {
        signal?.removeEventListener('abort', onAbort);
        const e = signal?.aborted ? signal.reason : offlineError(err.errMsg);
        if (!settled) {
          settled = true;
          reject(e);
        } else body.end(e);
      },
    });
    let seen = false;
    const onAbort = () => task.abort();
    signal?.addEventListener('abort', onAbort);
    task.onHeadersReceived((h) => {
      const header = h.header ?? {};
      if (settled || !/event-stream/i.test(headerGetter(header).get('content-type') ?? '')) return;
      settled = true;
      resolve(respond(200, header, body));
    });
    task.onChunkReceived((r) => {
      seen = true;
      body.push(r.data);
    });
  });
}

function respond(status: number, header: Record<string, string>, body: ChunkBody): ResponseShim {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: headerGetter(header),
    json: async () => JSON.parse(await body.text()) as unknown,
    text: () => body.text(),
    body,
  };
}

/* ---------------- performance ---------------- */

/** Only performance.now() is used (animation clocks). */
export const performance = { now: () => Date.now() };
