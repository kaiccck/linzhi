#!/usr/bin/env node
/**
 * 百度地图官方 MCP × 邻至 MCP: one model, two MCP servers. The official server (SSE) finds places,
 * nearby communities and routes; 邻至 (stdio) checks, community by community, what can really be
 * reached on foot. The model is DeepSeek (or any OpenAI-compatible model) through @zoudedao/agent's
 * client, its final answer goes through the same number check as the 体检顾问, and the whole tool
 * trace is printed.
 *
 *   pnpm --filter "@zoudedao/mcp..." build
 *   cd packages/mcp
 *   node --env-file=../../.env.local demo/combo.ts ["问题"]
 *
 * Needs LLM_* (the model) and a server AK with the MCP(SSE) service enabled: BAIDU_MCP_AK, else
 * BAIDU_SERVER_AK. The official server calls the web APIs with the bare AK, so an AK in SN mode is
 * refused ("APP SN校验失败") and one in IP-whitelist mode must allow Baidu's own servers. The AK only
 * goes into the SSE URL: it is never printed, and every message is scrubbed of it. Without the AK,
 * or when Baidu refuses it, the demo says so and answers with 邻至's MCP alone.
 *
 * Quota: the official server bills the AK's own daily quota (地点检索 100 次/日 on a personal key), so
 * Baidu calls are capped per run (--max-baidu-calls, default 5). 邻至's tools only read analyses
 * that already exist; a live check (about a minute and 100+ route requests) needs --allow-live.
 */
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import {
  ChatClient,
  checkGrounding,
  completeCitations,
  describeLlm,
  llmConfigFromEnv,
  repairPrompt,
  type ChatMessage,
  type Fact,
  type NumberSource,
  type OpenAITool,
} from '@zoudedao/agent';
import {
  baiduFailureOf,
  classifyConnect,
  makeRedactor,
  mcpAk,
  parseJson,
  textOf,
  withUnits,
  type BaiduFailure,
} from './baidu.ts';

const DEFAULT_QUESTION = '我在张江学林路地铁站附近给父母找房子，哪些小区老人步行买菜、看病都方便？';
const BAIDU_SSE = 'https://mcp.map.baidu.com/sse';
const BAIDU_HTTP = 'https://mcp.map.baidu.com/mcp';
/** Official tools offered to the model: place search, geocoding, routes. */
const BAIDU_TOOLS = ['map_geocode', 'map_search_places', 'map_directions'];
/** 邻至 tools offered to the model: read existing analyses (locate_place would geocode through the server). */
const ZDD_TOOLS = ['analyze_life_circle', 'list_service_gaps', 'compare_sites'];
const RESULT_MAX = 16_000;

const HELP = `百度地图官方 MCP × 邻至 MCP 组合演示

用法（在 packages/mcp 目录，先 pnpm --filter "@zoudedao/mcp..." build）：
  node --env-file=../../.env.local demo/combo.ts ["问题"]

选项：
  --api <地址>             邻至服务（默认 http://localhost:8787；写 none 则直接读仓库样例）
  --baidu-transport <方式> sse（默认，控制台的“MCP(SSE)”服务）或 http（Streamable HTTP）
  --max-baidu-calls <n>    本次最多调用百度地图 MCP 工具几次（默认 5）
  --max-steps <n>          大模型最多调用几次（默认 10）
  --allow-live             允许邻至发起实时体检（约 1 分钟，消耗百度路线配额）
  --no-baidu               不连接百度地图 MCP，只演示邻至 MCP
  --list                   只连接两个 Server 并列出工具，不调用工具和大模型
  -h, --help               显示本帮助

环境变量：LLM_BASE_URL、LLM_API_KEY、LLM_MODEL（可选 LLM_EXTRA_BODY）；
  BAIDU_MCP_AK（开通 MCP(SSE) 的服务端 AK，须为 IP 白名单方式；未设置时用 BAIDU_SERVER_AK）。
`;

const out = (line = '') => process.stdout.write(`${line}\n`);

// ------------------------------------------------------------------------------------ secrets

// BAIDU_MCP_AK (optional, an IP-whitelist key for the official server), else BAIDU_SERVER_AK
const MCP_AK = mcpAk(process.env);
const AK = MCP_AK.ak;
/** Every text that may reach the terminal goes through here. */
const redact = makeRedactor([AK, process.env.LLM_API_KEY?.trim() ?? '']);
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

// ----------------------------------------------------------------------------- MCP plumbing

interface Server {
  name: '百度地图' | '邻至';
  client: Client;
  tools: Tool[];
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}在 ${ms / 1000} 秒内没有响应（timeout）`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function connectBaidu(transport: 'sse' | 'http'): Promise<Server | BaiduFailure> {
  if (!AK) return { kind: '没有配置 BAIDU_MCP_AK 或 BAIDU_SERVER_AK', detail: '', auth: true };
  const url = new URL(transport === 'sse' ? BAIDU_SSE : BAIDU_HTTP);
  url.searchParams.set('ak', AK);
  let lastStatus: number | null = null;
  // observe HTTP statuses (for the error class) without ever logging the URL
  const observed = async (input: string | URL, init?: RequestInit) => {
    const res = await fetch(input, init);
    lastStatus = res.status;
    return res;
  };
  const client = new Client({ name: 'zoudedao-combo-demo', version: '0.1.0' });
  try {
    await withTimeout(
      client.connect(
        transport === 'sse'
          ? new SSEClientTransport(url, { fetch: observed })
          : new StreamableHTTPClientTransport(url, { fetch: observed }),
      ),
      20_000,
      '百度地图 MCP ',
    );
    const { tools } = await withTimeout(client.listTools(), 20_000, '百度地图 MCP 的工具列表');
    return { name: '百度地图', client, tools };
  } catch (err) {
    await client.close().catch(() => undefined);
    return classifyConnect(err, lastStatus, redact);
  }
}

async function connectZdd(api: string | null): Promise<Server> {
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, ...(api ? ['--api', api] : [])],
    stderr: 'pipe',
  });
  const client = new Client({ name: 'zoudedao-combo-demo', version: '0.1.0' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  return { name: '邻至', client, tools };
}

function openAITool(t: Tool, server: Server['name']): OpenAITool {
  const description = `【${server === '百度地图' ? '百度地图官方 MCP' : '邻至 MCP'}】${t.description ?? t.title ?? t.name}`;
  return {
    type: 'function',
    function: {
      name: t.name,
      description: clip(description, 1500),
      parameters: t.inputSchema as Record<string, unknown>,
    },
  };
}

// -------------------------------------------------------------------------------------- main

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      api: { type: 'string' },
      'baidu-transport': { type: 'string' },
      'max-baidu-calls': { type: 'string' },
      'max-steps': { type: 'string' },
      'allow-live': { type: 'boolean' },
      'no-baidu': { type: 'boolean' },
      list: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  const question = positionals.join(' ').trim() || DEFAULT_QUESTION;
  const api = values.api === 'none' ? null : (values.api ?? 'http://localhost:8787').replace(/\/+$/, '');
  const transport = values['baidu-transport'] === 'http' ? 'http' : 'sse';
  const maxBaidu = Number(values['max-baidu-calls'] ?? 5);
  const maxSteps = Number(values['max-steps'] ?? 10);
  const allowLive = !!values['allow-live'];
  const started = Date.now();

  // ---- connect
  const baidu: Server | BaiduFailure = values['no-baidu']
    ? { kind: '按 --no-baidu 未连接', detail: '', auth: false }
    : await connectBaidu(transport);
  const zdd = await connectZdd(api);
  const baiduOk = 'client' in baidu;
  let baiduDown: BaiduFailure | null = baiduOk ? null : baidu;
  out(`## 连接`);
  out();
  // which variable, never the value
  if (MCP_AK.from === 'BAIDU_SERVER_AK')
    out(
      '- 百度地图 MCP 用 BAIDU_SERVER_AK（未设置 BAIDU_MCP_AK；SN 校验方式的 AK 会在第一次调用工具时被拒）',
    );
  else if (MCP_AK.from) out('- 百度地图 MCP 用 BAIDU_MCP_AK');
  out(
    baiduOk
      ? `- 百度地图官方 MCP（${transport === 'sse' ? 'SSE' : 'Streamable HTTP'}，${baidu.client.getServerVersion()?.name ?? 'baidu-map'}）：${baidu.tools.length} 个工具——${baidu.tools.map((t) => t.name).join('、')}`
      : `- 百度地图官方 MCP 未连接：${baidu.kind}${baidu.detail ? `（${baidu.detail}）` : ''}。以下只演示邻至 MCP。`,
  );
  out(
    `- 邻至 MCP（stdio，${api ? `--api ${api}` : '仓库样例'}）：${zdd.tools.length} 个工具——${zdd.tools.map((t) => t.name).join('、')}`,
  );
  if (values.list) {
    await Promise.all([baiduOk ? baidu.client.close() : undefined, zdd.client.close()]);
    return;
  }

  const cfg = llmConfigFromEnv();
  if (!cfg) throw new Error('没有配置大模型：请用 --env-file 提供 LLM_BASE_URL、LLM_MODEL、LLM_API_KEY');
  const llm = new ChatClient(cfg);

  // ---- what the model may use
  const samples = await zdd.client
    .readResource({ uri: 'zoudedao://samples' })
    .then((r) => {
      const c = r.contents[0];
      return (JSON.parse(c && 'text' in c ? c.text : '{}') as { analyses?: { id: string; name: string }[] })
        .analyses;
    })
    .catch(() => undefined);
  const catalogue = (samples ?? []).map((s) => `${s.id}（${s.name}）`).join('、') || '（未能读取样例列表）';
  const owner = new Map<string, Server>();
  const tools: OpenAITool[] = [];
  const offer = (server: Server, allow: string[]) => {
    for (const t of server.tools) {
      if (!allow.includes(t.name) || owner.has(t.name)) continue;
      owner.set(t.name, server);
      tools.push(openAITool(t, server.name));
    }
  };
  if (baiduOk) offer(baidu, BAIDU_TOOLS);
  offer(zdd, ZDD_TOOLS);
  out(
    `- 开放给模型的工具：${tools.map((t) => `${t.function.name}（${owner.get(t.function.name)!.name}）`).join('、')}`,
  );
  out(`- 大模型：${describeLlm(cfg)}`);
  out();

  const system = [
    '你是“邻至”的选房顾问，帮用户判断哪些小区适合老人步行生活。你可以同时使用两组 MCP 工具：',
    baiduOk
      ? `- 百度地图官方 MCP（map_ 开头）：地理编码、地点检索、路线规划。用它找到用户说的地点、附近的小区、医院和社区卫生服务中心。本次最多调用 ${maxBaidu} 次，先想清楚再调用；坐标用百度 BD-09。`
      : '- 百度地图官方 MCP 本次不可用，只能使用邻至的工具，并在回答里说明这一点。',
    `- 邻至 MCP：按百度地图实测步行路线做的 15 分钟生活圈体检。已体检的片区：${catalogue}；老年人画像的 analysis_id 在后面加 ~elder（按 0.9 m/s 步速换算）。list_service_gaps 逐个小区核对小学、菜市场、药店能否在 1 km 判定距离内步行走到，结果里的 by_community 每个小区一行（各类设施的判定：覆盖、伪覆盖、盲区、待核实，以及步行分钟 walk_min）；analyze_life_circle 给出片区的 15 分钟可达范围和圈内设施（含社区卫生，从片区中心出发）；compare_sites 并排对比片区。`,
    allowLive
      ? '- 允许对新地点实时体检（analyze_life_circle 的 center_bd09，约 1 分钟）。'
      : '- 本次演示不发起新的实时体检（会消耗百度配额），只用已体检的片区；用户说的地方不在这些片区里，就如实说明。',
    '',
    '规则：',
    '1. 数字只能原样来自工具结果，不要自己计算、换算或四舍五入；每个含数字的句子末尾标注来源编号，例如 [T2]（编号见每个工具结果的 id）。',
    '2. 百度地图的检索只说明“附近有什么、直线多远”；“老人步行能不能走到”以邻至按实测步行路线的核对为准。待核实不是缺口。',
    '3. 百度地图 MCP 不可用或拒绝调用时：不要猜测用户说的地点在哪个片区，先如实说明无法定位；再用邻至的工具在已体检的片区里回答（可以逐个片区查），并说明这些片区不一定就在用户说的地点附近。',
    '4. 回答用简体中文：第一行“结论：”直接回答，再列不超过 5 条要点；最后一行用一句话说明信息来源——只写实际用到的，百度地图没有返回结果就写“本次没有用到百度地图的数据”。',
  ].join('\n');
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: question },
  ];

  out(`## 问：${question}`);
  out();
  const sources: NumberSource[] = [];
  let baiduCalls = 0;
  let zddCalls = 0;
  let steps = 0;
  let answer = '';
  const run = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const server = owner.get(name);
    if (!server) return JSON.stringify({ error: `没有名为 ${name} 的工具` });
    const tag = `[${server.name}]`;
    if (server.name === '百度地图') {
      if (baiduDown) {
        out(`   ⛔ ${tag} ${name}：百度地图 MCP 不可用（${baiduDown.kind}），未调用`);
        return JSON.stringify({ error: `百度地图 MCP 不可用：${baiduDown.kind}` });
      }
      if (baiduCalls >= maxBaidu) {
        out(`   ⛔ ${tag} ${name}：本次演示的百度地图 MCP 调用已达上限 ${maxBaidu} 次，未调用`);
        return JSON.stringify({ error: `本次最多调用百度地图 MCP ${maxBaidu} 次，已用完；请用已有结果回答` });
      }
      baiduCalls++;
    } else {
      const live =
        name === 'analyze_life_circle' && (args.center_bd09 !== undefined || args.place !== undefined);
      if (live && !allowLive) {
        out(`   ⛔ ${tag} ${name}：演示不发起新的实时体检，已拦截`);
        return JSON.stringify({
          error: `演示不发起新的实时体检（每次约 1 分钟、消耗 100 多次百度路线规划配额）。请改用已体检片区的 sample_id 或 analysis_id：${catalogue}`,
        });
      }
      zddCalls++;
    }
    const id = `T${sources.length + 1}`;
    let result: CallToolResult;
    try {
      result = (await server.client.callTool({ name, arguments: args })) as CallToolResult;
    } catch (err) {
      const message = redact(err instanceof Error ? err.message : String(err));
      out(`   ✗ ${tag} ${name} 失败：${message}`);
      return JSON.stringify({ error: message });
    }
    const text = redact(textOf(result));
    if (server.name === '百度地图') {
      const failure = baiduFailureOf(result, redact);
      if (failure) {
        out(`   ✗ ${tag} ${name}：${failure.kind}（${failure.detail}）`);
        if (failure.auth) {
          baiduDown = failure;
          // no more Baidu tools for the rest of the run
          for (let i = tools.length - 1; i >= 0; i--) {
            if (owner.get(tools[i]!.function.name)?.name === '百度地图') tools.splice(i, 1);
          }
          out(`   ⚠ 百度地图 MCP 拒绝了这个 AK，本次改为只用邻至 MCP`);
          return JSON.stringify({
            error: `百度地图 MCP 拒绝了这个 AK（${failure.kind}），本次不能再用百度地图的工具。请按规则 3：如实说明无法定位用户说的地点，再只用邻至的工具在已体检的片区里回答。`,
          });
        }
        return JSON.stringify({ error: `百度地图 MCP：${failure.kind}` });
      }
      const json = parseJson(text);
      sources.push({
        id,
        text: json === undefined ? text : '',
        ...(json !== undefined ? { data: withUnits(json) } : {}),
      });
      out(`   ← ${id} ${clip(text.replace(/\s+/g, ' '), 220)}`);
      return JSON.stringify({ id, server: '百度地图', tool: name, result: clip(text, RESULT_MAX) });
    }
    if (result.isError) {
      out(`   ✗ ${tag} ${name}：${clip(text, 200)}`);
      return JSON.stringify({ error: text });
    }
    const facts = (result._meta as { 'zoudedao/facts'?: Fact[] } | undefined)?.['zoudedao/facts'] ?? [];
    const data = result.structuredContent;
    sources.push({ id, text, facts, data });
    out(`   ← ${id} ${clip(text, 220)}`);
    return JSON.stringify({
      id,
      server: '邻至',
      tool: name,
      summary: text,
      data: clip(JSON.stringify(data ?? {}), RESULT_MAX),
    });
  };

  for (let step = 0; step < maxSteps; step++) {
    const last = step === maxSteps - 1;
    const res = await llm.chat({ messages, tools, toolChoice: last ? 'none' : 'auto' });
    steps++;
    if (!res.toolCalls.length || last) {
      answer = (res.content ?? '').trim();
      messages.push({ role: 'assistant', content: answer });
      break;
    }
    messages.push({ role: 'assistant', content: res.content ?? '', tool_calls: res.toolCalls });
    for (const call of res.toolCalls) {
      const args = parseJson(call.function.arguments || '{}');
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ error: '参数不是合法的 JSON 对象' }),
        });
        continue;
      }
      const server = owner.get(call.function.name)?.name ?? '?';
      out(`${steps}. 模型 → [${server}] ${call.function.name} ${redact(JSON.stringify(args))}`);
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: await run(call.function.name, args as Record<string, unknown>),
      });
    }
  }

  // ---- the same number check as the 体检顾问: citation completion, then one repair round
  const pool = [...sources, { id: 'question', text: question }];
  const check = (text: string) => checkGrounding(text, pool);
  let g = check(answer);
  if (g.uncited.length) {
    const c = completeCitations(answer, pool);
    const g2 = c.added.length ? check(c.text) : g;
    if (g2.uncited.length < g.uncited.length && g2.unsupported.length === g.unsupported.length) {
      out(`   ✓ 系统补全引用编号：${c.added.join('、')}`);
      answer = c.text;
      g = g2;
    }
  }
  if (!g.ok || g.uncited.length) {
    out(
      `   ! 数字核验未通过（${[...g.unsupported, ...g.uncited.map((u) => `${u} 未标注`)].join('、')}），要求模型改写一次`,
    );
    messages.push({ role: 'user', content: repairPrompt(g) });
    const res = await llm.chat({ messages, tools, toolChoice: 'none' });
    steps++;
    const text = (res.content ?? '').trim();
    const g2 = text ? check(text) : null;
    if (g2 && g2.ok && (g2.uncited.length <= g.uncited.length || !g.ok)) {
      answer = text;
      g = g2;
    }
  }

  out();
  out('## 答');
  out();
  out(redact(answer));
  out();
  out(
    `数字核验：${g.ok ? '通过' : `未通过（${g.unsupported.join('、')}）`}，共 ${g.checked} 个数字${g.uncited.length ? `；未标注来源：${g.uncited.join('、')}` : ''}`,
  );
  out(
    `调用：大模型 ${steps} 次；百度地图 MCP ${baiduCalls} 次；邻至 MCP ${zddCalls} 次；用时 ${((Date.now() - started) / 1000).toFixed(1)} 秒`,
  );
  if (baiduDown) out(`百度地图 MCP：${baiduDown.kind}${baiduDown.detail ? `（${baiduDown.detail}）` : ''}`);
  await Promise.all([baiduOk ? baidu.client.close().catch(() => undefined) : undefined, zdd.client.close()]);
}

main().catch((err: unknown) => {
  process.stderr.write(`组合演示出错：${redact(err instanceof Error ? err.message : String(err))}\n`);
  process.exit(1);
});
