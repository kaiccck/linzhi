#!/usr/bin/env node
/**
 * zoudedao-advisor: ask the 体检顾问 from a terminal. Without LLM_BASE_URL / LLM_MODEL it answers in
 * template mode, so it works with no keys at all; ZDD_API_URL (or --api) connects a running server.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createAdvisor } from './advisor.js';
import { HttpBackend, LocalBackend } from './backend.js';
import { describeLlm, llmConfigFromEnv } from './llm.js';

const HELP = `走得到 · 体检顾问（命令行）

用法：
  zoudedao-advisor "申城佳苑的老人买菜方便吗？"
  zoudedao-advisor "导出体检报告" --out ./reports

选项：
  --analysis <id>   当前查看的分析（如 zj-a、zj-a~elder、live-xxxx）
  --samples <目录>  样例目录，默认仓库的 data/samples（或环境变量 ZDD_SAMPLES_DIR）
  --api <地址>      连接运行中的邻至服务（同环境变量 ZDD_API_URL）
  --out <目录>      保存 export_report 生成的报告文件
  --json            输出完整的 JSON（回答、引用、数字核验）
  -h, --help        显示本帮助

大模型（可选，OpenAI 兼容接口）：LLM_BASE_URL、LLM_API_KEY、LLM_MODEL，可选 LLM_EXTRA_BODY。
未配置时使用模板模式：同样调用工具、同样标注 [T#] 来源，只是措辞由模板生成。
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      analysis: { type: 'string' },
      samples: { type: 'string' },
      api: { type: 'string' },
      out: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const question = positionals.join(' ').trim();
  if (values.help || !question) {
    process.stdout.write(HELP);
    return;
  }
  const api = values.api ?? process.env.ZDD_API_URL?.trim();
  const samplesDir = resolve(
    values.samples ??
      process.env.ZDD_SAMPLES_DIR ??
      fileURLToPath(new URL('../../../data/samples/', import.meta.url)),
  );
  const backend = api ? new HttpBackend(api) : new LocalBackend({ samplesDir });
  const llm = llmConfigFromEnv();
  const advisor = createAdvisor({ backend, llm });
  process.stderr.write(
    `[体检顾问] ${llm ? `大模型：${describeLlm(llm)}` : '模板模式（未配置大模型）'}；数据：${api ?? samplesDir}\n`,
  );

  const answer = await advisor.ask(question, {
    ...(values.analysis ? { analysisId: values.analysis } : {}),
    onEvent: (e) => {
      if (e.type === 'tool_call') process.stderr.write(`  → ${e.tool} ${JSON.stringify(e.args)}\n`);
      if (e.type === 'progress') process.stderr.write(`  … ${e.message}\n`);
      if (e.type === 'repair')
        process.stderr.write(`  ! 数字核验未通过，要求模型修正：${e.unsupported.join('、')}\n`);
      if (e.type === 'fallback') process.stderr.write(`  ! ${e.reason}\n`);
    },
  });

  if (values.out && answer.attachments?.length) {
    await mkdir(values.out, { recursive: true });
    for (const a of answer.attachments) {
      await writeFile(join(values.out, a.filename), a.content, 'utf8');
      process.stderr.write(`  已保存 ${join(values.out, a.filename)}\n`);
    }
  }
  if (values.json) {
    process.stdout.write(`${JSON.stringify(answer, null, 2)}\n`);
    return;
  }
  const g = answer.grounding;
  const lines = [
    answer.answer,
    '',
    '来源：',
    ...answer.citations.map((c) => `  [${c.id}] ${c.tool} ${JSON.stringify(c.args)}`),
    `数字核验：${g.ok ? '通过' : `未通过（${g.unsupported.join('、')}）`}，共 ${g.checked} 个数字${g.uncited.length ? `；未标注来源：${g.uncited.join('、')}` : ''}`,
  ];
  if (answer.attachments?.length && !values.out) {
    lines.push(`附件：${answer.attachments.map((a) => a.filename).join('、')}（加 --out <目录> 保存）`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`[体检顾问] 出错：${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
