#!/usr/bin/env node
/**
 * Live evaluation of the 体检顾问 with a real model over test/fixtures/llm-eval/cases.json.
 *
 *   pnpm --filter @zoudedao/agent build                      # the script runs the built package
 *   cd packages/agent
 *   node --env-file=../../.env.local scripts/eval-llm.ts                 # in-process, like POST /api/ask
 *   node --env-file=../../.env.local scripts/eval-llm.ts --record        # … and rewrite recorded.json
 *   node scripts/eval-llm.ts --api http://localhost:8787 --out /tmp/eval.json   # through the server
 *
 * In-process runs use the advisor exactly as apps/server does (fresh store per question, samples
 * only, no live analyses, no Baidu calls) and record every raw model response and tool result, so
 * test/llm-eval.test.ts can replay the run offline. The key stays in the environment: it is never
 * printed, recorded or written anywhere.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  BackendError,
  LocalBackend,
  createAdvisor,
  createToolRegistry,
  describeLlm,
  llmConfigFromEnv,
  readSse,
  repairPrompt,
  scrubSecrets,
  systemPrompt,
  ToolError,
  type AdvisorAnswer,
  type AdvisorEvent,
  type Fact,
  type LlmConfig,
  type ToolRegistry,
  type ZddBackend,
} from '@zoudedao/agent';
import {
  answerShape,
  markdownReport,
  summarize,
  toolKey,
  type EvalCase,
  type EvalRecord,
} from './eval-lib.ts';

const HELP = `体检顾问 · 真实模型评测

用法（在 packages/agent 目录，先 pnpm --filter @zoudedao/agent build）：
  node --env-file=../../.env.local scripts/eval-llm.ts [--record] [--only q01,q07]
  node scripts/eval-llm.ts --api http://localhost:8787 [--out 结果.json]

选项：
  --api <地址>     通过运行中的走得到服务的 POST /api/ask 评测（与 Web 完全相同的路径；遇到限流会等待）
  --record         本进程模式：把模型原始响应与工具结果写入 test/fixtures/llm-eval/recorded.json（供 vitest 离线回放）
  --out <文件>     把逐题结果写成 JSON
  --only <id,…>    只跑这些题
  --model <名称>   覆盖 LLM_MODEL
  --max-calls <n>  大模型调用上限（默认 80），用完即停
  --report <文件>  不调用模型：用当前的检查重新评分已有结果（--out 的 JSON 或 recorded.json）并输出表格
  -h, --help       显示本帮助
`;

const FIXTURES = new URL('../test/fixtures/llm-eval/', import.meta.url);
const SAMPLES_DIR = fileURLToPath(new URL('../../../data/samples/', import.meta.url));
/** Same budget as the server gives the model (45 s of the 60 s ask timeout). */
const LLM_BUDGET_MS = 45_000;

// What apps/server/src/advisor.ts (ServerBackend) tells the model: kept in step by hand, so an
// in-process run reads exactly like POST /api/ask.
const LOCATE_NOTE = '问询只在内置样例中查找地点，不调用百度接口；要体检其他地点，请使用地图左上角的搜索框';
const NO_LIVE_MESSAGE =
  '问询不会发起新的实时体检（每次体检都要消耗百度地图配额）。要体检新地点，请使用地图左上角的搜索框；体检完成后，再在这里提问。';

const log = (msg: string) => process.stderr.write(`${msg}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The server's advisor backend: samples only, locate in the samples, never a live analysis. */
function askBackend(): ZddBackend {
  const local = new LocalBackend({ samplesDir: SAMPLES_DIR });
  return {
    kind: 'server',
    listSamples: () => local.listSamples(),
    getAnalysis: (id) => local.getAnalysis(id),
    locate: async (query, city) => ({ ...(await local.locate(query, city)), warnings: [LOCATE_NOTE] }),
    analyze: async () => {
      throw new BackendError('live_disabled', NO_LIVE_MESSAGE);
    },
  };
}

// ---------------------------------------------------------------------------------- recording

interface RecordedTool {
  tool: string;
  args: unknown;
  summary?: string;
  facts?: Fact[];
  /** What the model saw of `data` (the tool's llmView), which is also the grounding source. */
  view?: unknown;
  error?: { code: string; message: string };
}

interface RecordedResponse {
  status: number;
  message?: Record<string, unknown>;
  finish_reason?: string | null;
  usage?: unknown;
  error?: string;
}

function recordingRegistry(tools: Map<string, RecordedTool>, order: string[]): ToolRegistry {
  const base = createToolRegistry();
  return {
    tools: base.tools,
    get: (name) => base.get(name),
    openAITools: () => base.openAITools(),
    async run(name, args, ctx) {
      const key = toolKey(name, args);
      order.push(key);
      try {
        const result = await base.run(name, args, ctx);
        const def = base.get(name);
        const view = def?.llmView ? def.llmView(result.data) : result.data;
        tools.set(key, { tool: name, args, summary: result.summary, facts: result.facts, view });
        return result;
      } catch (err) {
        const code = err instanceof ToolError ? err.code : 'internal';
        tools.set(key, {
          tool: name,
          args,
          error: { code, message: err instanceof Error ? err.message : String(err) },
        });
        throw err;
      }
    },
  };
}

interface Completion {
  choices?: { message?: Record<string, unknown>; finish_reason?: string | null }[];
  usage?: unknown;
}

function parseCompletion(text: string): Completion | null {
  try {
    return JSON.parse(text) as Completion;
  } catch {
    return null;
  }
}

function recordingFetch(calls: RecordedResponse[], secret?: string): typeof fetch {
  return async (input, init) => {
    const res = await fetch(input, init);
    const text = await res.text();
    const json = parseCompletion(text);
    const choice = json?.choices?.[0];
    calls.push(
      res.ok && choice
        ? {
            status: res.status,
            message: choice.message ?? {},
            finish_reason: choice.finish_reason ?? null,
            usage: json?.usage,
          }
        : // not a completion: keep a scrubbed excerpt
          { status: res.status, error: scrubSecrets(text, secret).slice(0, 300) },
    );
    return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}

// ---------------------------------------------------------------------------------- runners

interface Run {
  record: EvalRecord;
  responses?: RecordedResponse[];
  toolKeys?: string[];
}

function baseRecord(c: EvalCase): Omit<EvalRecord, 'shape'> {
  return {
    id: c.id,
    question: c.question,
    tags: c.tags,
    mode: 'error',
    tools: [],
    latency_ms: 0,
    llm_calls: 0,
    llm_calls_exact: true,
    grounding: { ok: false, checked: 0, unsupported: [], uncited: [] },
    repair: null,
    repaired: false,
    fallback: null,
    answer: '',
    attachments: 0,
  };
}

async function runInProcess(c: EvalCase, cfg: LlmConfig, tools: Map<string, RecordedTool>): Promise<Run> {
  const responses: RecordedResponse[] = [];
  const toolKeys: string[] = [];
  const advisor = createAdvisor({
    backend: askBackend(),
    llm: { ...cfg, fetch: recordingFetch(responses, cfg.apiKey) },
    registry: recordingRegistry(tools, toolKeys),
  });
  const rec = baseRecord(c);
  const events: AdvisorEvent[] = [];
  const started = Date.now();
  let answer: AdvisorAnswer | null = null;
  try {
    answer = await advisor.ask(c.question, {
      ...(c.analysis_id ? { analysisId: c.analysis_id } : {}),
      ...(c.history ? { history: c.history } : {}),
      signal: AbortSignal.timeout(LLM_BUDGET_MS),
      onEvent: (e) => events.push(e),
    });
  } catch (err) {
    rec.error = err instanceof Error ? err.message : String(err);
  }
  rec.latency_ms = Date.now() - started;
  rec.llm_calls = responses.length;
  const results = events.filter((e) => e.type === 'tool_result');
  rec.tools = events.flatMap((e) => (e.type === 'tool_call' ? [{ tool: e.tool, args: e.args ?? {} }] : []));
  rec.tools.forEach((t, i) => {
    const r = results[i];
    if (r?.type === 'tool_result' && r.error) t.error = r.error;
  });
  const repair = events.find((e) => e.type === 'repair');
  if (repair?.type === 'repair') rec.repair = { unsupported: repair.unsupported, uncited: repair.uncited };
  if (answer) {
    rec.mode = answer.mode;
    rec.grounding = {
      ok: answer.grounding.ok,
      checked: answer.grounding.checked,
      unsupported: answer.grounding.unsupported,
      uncited: answer.grounding.uncited,
    };
    rec.repaired = !!answer.repaired;
    if (answer.citationsAdded?.length) rec.citations_added = answer.citationsAdded;
    rec.fallback = answer.fallback?.reason ?? null;
    rec.answer = answer.answer;
    rec.attachments = answer.attachments?.length ?? 0;
  }
  return {
    record: { ...rec, shape: answerShape(c, rec.answer, rec.attachments) },
    responses,
    toolKeys,
  };
}

interface ApiAnswer {
  answer: string;
  mode: 'llm' | 'template';
  grounding: { ok: boolean; checked: number; unsupported: string[]; uncited: string[] };
  repaired?: boolean;
  fallback?: { reason: string };
  attachments?: unknown[];
}

async function runApi(c: EvalCase, api: string): Promise<Run> {
  const rec = baseRecord(c);
  rec.llm_calls_exact = false;
  for (let attempt = 0; ; attempt++) {
    const started = Date.now();
    const res = await fetch(`${api}/api/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({
        question: c.question,
        ...(c.analysis_id ? { analysis_id: c.analysis_id } : {}),
        ...(c.history ? { history: c.history } : {}),
      }),
    });
    if ((res.status === 429 || res.status === 503) && attempt < 30) {
      const wait = Math.max(5, Number(res.headers.get('retry-after')) || 30);
      log(`  … HTTP ${res.status}（${(await res.text()).slice(0, 80)}），${wait} 秒后重试`);
      await sleep(wait * 1000 + 500);
      continue;
    }
    if (!res.ok || !res.body) {
      rec.error = `HTTP ${res.status} ${(await res.text()).slice(0, 200)}`;
      break;
    }
    let answer: ApiAnswer | null = null;
    let repairs = 0;
    for await (const m of readSse(res.body)) {
      const data = JSON.parse(m.data) as Record<string, unknown>;
      if (m.event === 'tool_call') rec.tools.push({ tool: String(data.tool), args: data.args ?? {} });
      else if (m.event === 'tool_result' && typeof data.error === 'string') {
        const last = [...rec.tools].reverse().find((t) => t.tool === data.tool && !t.error);
        if (last) last.error = data.error;
      } else if (m.event === 'repair') {
        repairs++;
        rec.repair = { unsupported: data.unsupported as string[], uncited: data.uncited as string[] };
      } else if (m.event === 'answer') answer = data as unknown as ApiAnswer;
      else if (m.event === 'error') rec.error = String(data.message ?? data.code);
    }
    rec.latency_ms = Date.now() - started;
    if (answer) {
      rec.mode = answer.mode;
      rec.grounding = answer.grounding;
      rec.repaired = !!answer.repaired;
      rec.fallback = answer.fallback?.reason ?? null;
      rec.answer = answer.answer;
      rec.attachments = answer.attachments?.length ?? 0;
    }
    // upper bound: one call per tool call, the answer, the repair
    rec.llm_calls = rec.tools.length + 1 + repairs;
    break;
  }
  return { record: { ...rec, shape: answerShape(c, rec.answer, rec.attachments) } };
}

// -------------------------------------------------------------------------------------- main

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      api: { type: 'string' },
      record: { type: 'boolean' },
      out: { type: 'string' },
      only: { type: 'string' },
      model: { type: 'string' },
      'max-calls': { type: 'string' },
      report: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  const set = JSON.parse(readFileSync(new URL('cases.json', FIXTURES), 'utf8')) as { cases: EvalCase[] };
  if (values.report) {
    const saved = JSON.parse(readFileSync(values.report, 'utf8')) as {
      title?: string;
      llm?: string;
      records?: EvalRecord[];
      cases?: { record: EvalRecord }[];
    };
    const records = (saved.records ?? saved.cases?.map((c) => c.record) ?? []).map((r) => {
      const c = set.cases.find((x) => x.id === r.id) ?? { id: r.id, question: r.question, tags: r.tags };
      return { ...r, tags: c.tags, shape: answerShape(c, r.answer, r.attachments) };
    });
    process.stdout.write(`${markdownReport(records, saved.title ?? `录制结果（${saved.llm ?? ''}）`)}\n`);
    return;
  }
  const only = values.only ? new Set(values.only.split(',').map((s) => s.trim())) : null;
  const cases = set.cases.filter((c) => !only || only.has(c.id));
  const maxCalls = Number(values['max-calls'] ?? 80);
  const api = values.api?.replace(/\/+$/, '');

  let cfg: LlmConfig | null = null;
  if (!api) {
    cfg = llmConfigFromEnv();
    if (!cfg) throw new Error('没有配置大模型：请用 --env-file 提供 LLM_BASE_URL、LLM_MODEL、LLM_API_KEY');
    if (values.model) cfg = { ...cfg, model: values.model };
  }
  if (values.record && api) throw new Error('--record 只能用于本进程模式（需要模型的原始响应）');
  log(`体检顾问评测：${cases.length} 题，${api ? `POST ${api}/api/ask` : `本进程，${describeLlm(cfg!)}`}`);

  const tools = new Map<string, RecordedTool>();
  const runs: { c: EvalCase; run: Run }[] = [];
  let calls = 0;
  for (const c of cases) {
    if (calls >= maxCalls) {
      log(`大模型调用已达上限 ${maxCalls}，停止`);
      break;
    }
    const run = api ? await runApi(c, api) : await runInProcess(c, cfg!, tools);
    calls += run.record.llm_calls;
    runs.push({ c, run });
    const r = run.record;
    const g = r.grounding;
    log(
      `${c.id} ${r.mode}${r.fallback ? '（回退）' : ''} ${(r.latency_ms / 1000).toFixed(1)} s ${r.tools.map((t) => t.tool).join('→') || '—'} 核验${g.ok ? '通过' : `未通过 ${g.unsupported.join('、')}`}${g.uncited.length ? ` 未标注 ${g.uncited.join('、')}` : ''}${r.repair ? ` 修正${r.repaired ? '成功' : '失败'}` : ''}${r.shape.issues.length ? ` ⚠ ${r.shape.issues.join('；')}` : ''}`,
    );
  }
  const records = runs.map((x) => x.run.record);
  const title = api ? `POST /api/ask（${api}）` : `本进程（${describeLlm(cfg!)}）`;
  process.stdout.write(`${markdownReport(records, title)}\n`);
  const s = summarize(records);
  log(`大模型调用 ${s.llmCalls} 次${records.every((r) => r.llm_calls_exact) ? '' : '（上限估计）'}`);

  if (values.out) {
    writeFileSync(values.out, `${JSON.stringify({ title, records }, null, 2)}\n`);
    log(`已写入 ${values.out}`);
  }
  if (values.record && cfg) {
    const file = new URL('recorded.json', FIXTURES);
    const now = new Date().toISOString();
    const fresh = runs.map(({ c, run }) => ({
      ...c,
      recorded_at: now,
      prompt_sha: promptSha(),
      responses: run.responses ?? [],
      tool_calls: run.toolKeys ?? [],
      record: run.record,
    }));
    // --only re-records some questions: the others and their tool results stay as they were
    let cases: { id: string; tool_calls: string[] }[] = fresh;
    let pool = new Map(tools);
    if (only) {
      const old = JSON.parse(readFileSync(file, 'utf8')) as {
        cases: { id: string; tool_calls: string[] }[];
        tools: Record<string, RecordedTool>;
      };
      cases = set.cases.flatMap((c) => {
        const hit = fresh.find((f) => f.id === c.id) ?? old.cases.find((o) => o.id === c.id);
        return hit ? [hit] : [];
      });
      pool = new Map([...Object.entries(old.tools), ...tools]);
    }
    const used = new Set(cases.flatMap((c) => c.tool_calls));
    const fixture = {
      description:
        '体检顾问真实模型评测的录制结果：每题的模型原始响应（按调用顺序）与工具结果（模型看到的视图），供 test/llm-eval.test.ts 离线回放。由 scripts/eval-llm.ts --record 生成，不含任何 Key。',
      llm: describeLlm(cfg),
      cases,
      tools: Object.fromEntries(
        [...pool].filter(([k]) => used.has(k)).sort(([a], [b]) => a.localeCompare(b)),
      ),
    };
    writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
    log(`已写入 ${fileURLToPath(file)}（请再运行 prettier --write 格式化）`);
  }
}

/** Fingerprint of what the model is told: system prompt, repair prompt, tool definitions. */
function promptSha(): string {
  return createHash('sha256')
    .update(systemPrompt('{available}', '{analysis_id}'))
    .update(repairPrompt({ unsupported: ['{n}'], uncited: ['{m}'] }))
    .update(JSON.stringify(createToolRegistry().openAITools()))
    .digest('hex')
    .slice(0, 12);
}

main().catch((err: unknown) => {
  log(`评测出错：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
