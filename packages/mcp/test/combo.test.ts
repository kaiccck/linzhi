/** demo/combo.ts, offline: the AK never printed, refusals of the key told apart, Baidu units. */
import { checkGrounding } from '@zoudedao/agent';
import { describe, expect, it } from 'vitest';
import { baiduFailureOf, classifyConnect, makeRedactor, mcpAk, withUnits } from '../demo/baidu.ts';

const AK = 'AbCdEf0123456789AbCdEf0123456789';
const redact = makeRedactor([AK, 'sk-live-0123456789']);
const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], isError });

describe('combo demo helpers', () => {
  it('prefers the optional BAIDU_MCP_AK (IP whitelist) and falls back to BAIDU_SERVER_AK', () => {
    expect(mcpAk({ BAIDU_MCP_AK: ` ${AK} `, BAIDU_SERVER_AK: 'sn-key-0123456789' })).toEqual({
      ak: AK,
      from: 'BAIDU_MCP_AK',
    });
    // blank or still the .env.example placeholder: not set
    for (const unset of ['', '   ', 'your_mcp_ak', undefined]) {
      expect(mcpAk({ BAIDU_MCP_AK: unset, BAIDU_SERVER_AK: AK })).toEqual({
        ak: AK,
        from: 'BAIDU_SERVER_AK',
      });
    }
    expect(mcpAk({ BAIDU_SERVER_AK: 'your_server_ak' })).toEqual({ ak: '', from: null });
    expect(mcpAk({})).toEqual({ ak: '', from: null });
  });

  it('keeps keys out of every message', () => {
    const leaked = `SSE error: GET https://mcp.map.baidu.com/sse?ak=${AK}&x=1 failed; key ${AK}; Bearer sk-live-0123456789`;
    const clean = redact(leaked);
    expect(clean).not.toContain(AK);
    expect(clean).not.toContain('sk-live-0123456789');
    expect(clean).toContain('ak=***');
    expect(redact('https://example.com/sse?ak=other-key-value')).toBe('https://example.com/sse?ak=***');
  });

  it('recognises a key in SN mode, as the official server words it', () => {
    // the refusal seen with a real SN-mode server AK (2026-09-28)
    const f = baiduFailureOf(text('Authentication failed: APP SN校验失败', true), redact);
    expect(f).toEqual({
      kind: 'AK 为 SN 校验方式，调用未带签名',
      detail: 'status 211：Authentication failed: APP SN校验失败',
      auth: true,
    });
  });

  it('tells refusals of the key from quota and success', () => {
    expect(baiduFailureOf(text('{"status":210,"message":"APP IP校验失败"}'), redact)).toMatchObject({
      kind: 'AK 的 IP 白名单不允许这次调用',
      auth: true,
    });
    expect(baiduFailureOf(text('{"status":240,"message":"APP 服务被禁用"}'), redact)?.auth).toBe(true);
    expect(baiduFailureOf(text('{"status":302,"message":"天配额超限，限制访问"}'), redact)).toMatchObject({
      kind: '配额或并发已用尽',
      auth: false,
    });
    expect(baiduFailureOf(text('{"status":0,"message":"ok","results":[]}'), redact)).toBeNull();
    expect(baiduFailureOf(text('学林路(地铁站) 31.18,121.61'), redact)).toBeNull();
  });

  it('classifies connection failures without the URL', () => {
    const err = Object.assign(
      new Error(`Non-200 status code (403) for https://mcp.map.baidu.com/sse?ak=${AK}`),
      {
        code: 403,
      },
    );
    const f = classifyConnect(err, 403, redact);
    expect(f.auth).toBe(true);
    expect(f.kind).toContain('HTTP 403');
    expect(f.detail).not.toContain(AK);
    expect(classifyConnect(new Error('fetch failed'), null, redact).kind).toBe('网络不可达');
  });

  it('gives Baidu distances and durations their units for the number check', () => {
    const data = withUnits({ result: { routes: [{ distance: 1234, duration: 960 }] } });
    expect(data).toEqual({ result: { routes: [{ distance_m: 1234, duration_s: 960 }] } });
    const g = checkGrounding('步行 1,234 m，约 16 分钟 [T1]。', [{ id: 'T1', data }]);
    expect(g).toMatchObject({ ok: true, uncited: [] });
    // without the units, a bare 1234 backs no distance
    const bare = checkGrounding('步行 1,234 m [T1]。', [{ id: 'T1', data: { distance: 1234 } }]);
    expect(bare.unsupported).toEqual(['1,234 m']);
  });
});
