/** The part of @tarojs/taro the units under test call, driven by the tests. */
export interface StubRequest {
  url: string;
  method?: string;
  header?: Record<string, string>;
  data?: unknown;
  enableChunked?: boolean;
  success?(res: { statusCode: number; header: Record<string, string>; data: unknown }): void;
  fail?(err: { errMsg: string }): void;
}

export interface StubTask {
  abort(): void;
  onHeadersReceived(fn: (h: { header: Record<string, string> }) => void): void;
  onChunkReceived(fn: (r: { data: ArrayBuffer }) => void): void;
}

type Handler = (req: StubRequest, task: StubControl) => void;
export interface StubControl {
  headers(h: Record<string, string>): void;
  chunk(data: ArrayBuffer): void;
  aborted: boolean;
}

let handler: Handler = () => {};
export const onRequest = (h: Handler) => {
  handler = h;
};

const Taro = {
  env: { USER_DATA_PATH: '/tmp' },
  request(req: StubRequest): StubTask {
    let onH: ((h: { header: Record<string, string> }) => void) | null = null;
    let onC: ((r: { data: ArrayBuffer }) => void) | null = null;
    const ctl: StubControl = {
      aborted: false,
      headers: (header) => onH?.({ header }),
      chunk: (data) => onC?.({ data }),
    };
    const task: StubTask = {
      abort: () => {
        ctl.aborted = true;
        req.fail?.({ errMsg: 'request:fail abort' });
      },
      onHeadersReceived: (fn) => {
        onH = fn;
      },
      onChunkReceived: (fn) => {
        onC = fn;
      },
    };
    queueMicrotask(() => handler(req, ctl));
    return task;
  },
};
export default Taro;
