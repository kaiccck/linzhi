/**
 * 实测核验 (POST /api/whatif) against a mocked server: the request carries the contract's fields,
 * a measured answer is read as it comes, and every failure says what went wrong in Chinese.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseWhatIf, postWhatIf, type WhatIfRequest } from './whatif.js';

const req: WhatIfRequest = {
  analysis_id: 'zj-b',
  category: '菜市场',
  site_bd09: [121.6363, 31.2091],
};

const reply = (body: unknown, status = 200) =>
  vi.fn(
    async () =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );

describe('postWhatIf', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts the site in BD-09 with the analysis, category and rule set', async () => {
    const answer = {
      measured: [
        { community: '樟盛苑社区', route_m: 812, dur_s: 694, before: '伪覆盖', after: '覆盖' },
        { community: '梦想园', route_m: null, dur_s: null, before: '伪覆盖', after: '伪覆盖' },
      ],
      newly_covered: ['樟盛苑社区'],
      quota: { routes: 2 },
    };
    const fetchMock = reply(answer);
    vi.stubGlobal('fetch', fetchMock);
    const r = await postWhatIf(req, new AbortController().signal);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/whatif');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual(req);
    expect(r).toEqual(answer);
  });

  it('says sample mode cannot measure (409 live_mode_disabled)', async () => {
    vi.stubGlobal('fetch', reply({ error: 'live_mode_disabled' }, 409));
    await expect(postWhatIf(req, new AbortController().signal)).rejects.toThrow(
      '服务端为样例模式，不能分析新地点',
    );
  });

  it('passes the server’s own message through', async () => {
    vi.stubGlobal('fetch', reply({ error: 'quota_exhausted', message: '今日百度配额已用尽，明天再试' }, 429));
    await expect(postWhatIf(req, new AbortController().signal)).rejects.toThrow(
      '今日百度配额已用尽，明天再试',
    );
  });

  it('names the missing endpoint on an older server', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Not Found', { status: 404 })),
    );
    await expect(postWhatIf(req, new AbortController().signal)).rejects.toThrow('服务端还没有实测核验接口');
  });

  it('treats a broken answer as an error, never as “nobody covered”', async () => {
    vi.stubGlobal('fetch', reply({ measured: 'nope' }));
    await expect(postWhatIf(req, new AbortController().signal)).rejects.toThrow('返回数据不完整');
  });

  it('says so when there is no server at all', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await expect(postWhatIf(req, new AbortController().signal)).rejects.toThrow('无法连接邻至服务端');
  });
});

describe('parseWhatIf', () => {
  it('keeps what it can read and counts the routes when the quota is missing', () => {
    const r = parseWhatIf({
      measured: [{ community: 'A', route_m: 900, dur_s: 769, before: '盲区', after: '覆盖' }, { nope: 1 }],
      newly_covered: ['A', 3],
    });
    expect(r).toEqual({
      measured: [{ community: 'A', route_m: 900, dur_s: 769, before: '盲区', after: '覆盖' }],
      newly_covered: ['A'],
      quota: { routes: 1 },
    });
    expect(parseWhatIf(null)).toBeNull();
  });
});
