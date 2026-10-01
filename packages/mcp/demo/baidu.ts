/**
 * The parts of demo/combo.ts that must never go wrong: keeping the AK out of every printed line,
 * telling a refused key (SN mode, IP whitelist, service not enabled) from a transient failure, and
 * giving Baidu's distances and durations the units the number check needs. No I/O: unit-tested in
 * test/combo.test.ts.
 */
import type { CallToolResult } from '@modelcontextprotocol/client';
import { scrubSecrets } from '@zoudedao/agent';

export type Redact = (text: string) => string;

/** The secrets, `ak=…` query values and bearer tokens out of a text. */
export function makeRedactor(secrets: readonly string[]): Redact {
  const list = secrets.filter((s) => s.length >= 6);
  return (text) => {
    let s = text;
    for (const secret of list) s = s.split(secret).join('***');
    return scrubSecrets(s).replace(/([?&]ak=)[^&\s"')]+/gi, '$1***');
  };
}

/** Where the demo's AK for the official MCP server comes from (never its value in any output). */
export interface McpAk {
  ak: string;
  /** The variable it was read from; null when neither is set. */
  from: 'BAIDU_MCP_AK' | 'BAIDU_SERVER_AK' | null;
}

const unset = (v: string | undefined) => !v?.trim() || /^your[_-]/i.test(v.trim());

/**
 * BAIDU_MCP_AK when set — an IP-whitelist server AK with MCP(SSE) enabled, which the official server
 * can use as it is — else BAIDU_SERVER_AK (in SN mode the official server refuses it on the first
 * tool call). Blank values and .env.example placeholders (your_…) count as unset.
 */
export function mcpAk(env: Readonly<Record<string, string | undefined>>): McpAk {
  if (!unset(env.BAIDU_MCP_AK)) return { ak: env.BAIDU_MCP_AK!.trim(), from: 'BAIDU_MCP_AK' };
  if (!unset(env.BAIDU_SERVER_AK)) return { ak: env.BAIDU_SERVER_AK!.trim(), from: 'BAIDU_SERVER_AK' };
  return { ak: '', from: null };
}

export interface BaiduFailure {
  /** Error class in words, never a secret. */
  kind: string;
  detail: string;
  /** The key itself was refused: stop calling Baidu for this run. */
  auth: boolean;
}

/** Status codes of the Baidu web APIs behind the official tools, grouped by what the owner must do. */
const BAIDU_STATUS: [RegExp, string][] = [
  [/^(?:101|200|250)$/, 'AK 无效或不存在'],
  [/^(?:102|210)$/, 'AK 的 IP 白名单不允许这次调用'],
  [/^211$/, 'AK 为 SN 校验方式，调用未带签名'],
  [/^(?:220|230)$/, 'AK 的 Referer / Mcode 校验不通过（请使用服务端 AK）'],
  [/^(?:240|260|261)$/, 'AK 未开通或已禁用这项服务（请在控制台勾选 MCP(SSE) 及相关服务）'],
  [/^(?:302|401|402|4\d\d)$/, '配额或并发已用尽'],
];

/** The same refusals as the official server words them ("Authentication failed: APP SN校验失败"). */
const BAIDU_MESSAGES: [RegExp, string][] = [
  [/SN校验失败/, '211'],
  [/IP校验失败|白名单/, '210'],
  [/Referer校验失败/, '220'],
  [/Mcode码?校验失败/, '230'],
  [/服务被禁用|服务不存在|未开通/, '240'],
  [/APP不存在|AK参数不存在|AK有误|ak不存在/i, '200'],
  [/配额超限|并发量已经超过/, '302'],
];

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

export function classifyStatus(status: string, message: string, redact: Redact): BaiduFailure | null {
  if (status === '0') return null;
  const hit = BAIDU_STATUS.find(([re]) => re.test(status));
  return {
    kind: hit ? hit[1] : `百度接口返回状态 ${status}`,
    detail: redact(`status ${status}${message ? `：${message}` : ''}`),
    auth: !!hit && !/配额/.test(hit[1]),
  };
}

export function textOf(result: CallToolResult): string {
  return (result.content ?? [])
    .map((c) => (c.type === 'text' ? c.text : c.type === 'resource_link' ? `[资源 ${c.uri}]` : ''))
    .filter(Boolean)
    .join('\n');
}

/** A tool result that is really a refusal of the key (the servers wrap the web API's status). */
export function baiduFailureOf(result: CallToolResult, redact: Redact): BaiduFailure | null {
  const text = textOf(result);
  const m = /"status"\s*:\s*"?(\d+)"?[\s\S]{0,200}?"(?:message|msg)"\s*:\s*"([^"]*)"/.exec(text);
  if (m) return classifyStatus(m[1]!, m[2]!, redact);
  const worded = BAIDU_MESSAGES.find(([re]) => re.test(text));
  if (worded) return classifyStatus(worded[1], clip(text, 120), redact);
  if (result.isError) {
    const status = /(?:status|状态)\D{0,4}(\d{3})/.exec(text)?.[1];
    if (status) return classifyStatus(status, clip(text, 120), redact);
    return {
      kind: '工具调用失败',
      detail: redact(clip(text, 200)),
      auth: /\bak\b|权限|鉴权|unauthori[sz]ed|authentication/i.test(text),
    };
  }
  return null;
}

/** Connection failures: HTTP status of the SSE stream, protocol, or network. */
export function classifyConnect(err: unknown, lastStatus: number | null, redact: Redact): BaiduFailure {
  const message = redact(err instanceof Error ? err.message : String(err));
  const code = (err as { code?: unknown }).code;
  const status =
    typeof code === 'number' && code >= 400 ? code : lastStatus && lastStatus >= 400 ? lastStatus : null;
  if (status === 401 || status === 403) {
    return {
      kind: `鉴权失败（HTTP ${status}）：AK 无效、不是服务端 AK，或没有开通 MCP(SSE)`,
      detail: message,
      auth: true,
    };
  }
  if (status) return { kind: `HTTP ${status}`, detail: message, auth: false };
  if (/timed? ?out|timeout|超时/i.test(message)) return { kind: '连接超时', detail: message, auth: false };
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|fetch failed|network/i.test(message)) {
    return { kind: '网络不可达', detail: message, auth: false };
  }
  return { kind: '协议错误', detail: message, auth: false };
}

/** Baidu JSON with the units the number check needs: distance in metres, duration in seconds. */
export function withUnits(value: unknown, depth = 0): unknown {
  if (depth > 12) return undefined;
  if (Array.isArray(value)) return value.map((v) => withUnits(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k === 'distance' ? 'distance_m' : k === 'duration' ? 'duration_s' : k,
        withUnits(v, depth + 1),
      ]),
    );
  }
  return value;
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
