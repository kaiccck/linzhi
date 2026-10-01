/**
 * The real-model evaluation of the 体检顾问: the question set, answer checks and metrics. Shared by
 * scripts/eval-llm.ts (live runs, through POST /api/ask or in-process) and test/llm-eval.test.ts
 * (offline replay of the recorded run). Pure functions, no I/O, no imports: runs under Node's type
 * stripping as well as in vitest.
 */

export interface EvalCase {
  id: string;
  /** The analysis on screen (POST /api/ask analysis_id). */
  analysis_id?: string;
  question: string;
  /** Earlier turns as the web sends them (footers stripped). */
  history?: { role: 'user' | 'assistant'; content: string }[];
  /** What the question exercises: 买菜、上学、药店、老人、对比、假如新增、导出报告、附近设施、超出范围、追问、陷阱 … */
  tags: string[];
  expect?: {
    /** A what-if: the answer must say 估算. */
    estimate?: boolean;
    /** A place outside every analysis: the answer must say so and point to the search box. */
    outOfScope?: string;
    /** No invented score ("85 分"). */
    noScore?: boolean;
    /** An export: a file must come back. */
    attachment?: boolean;
  };
}

export interface AnswerShape {
  /** First line starts with 结论 or 估算. */
  conclusionFirst: boolean;
  /** List items ("- ", "1. "). */
  bullets: number;
  chars: number;
  /** Carries at least one [T#]. */
  cites: boolean;
  /** Broken expectations, in words. */
  issues: string[];
}

export const MAX_BULLETS = 6;

/** Stable JSON (sorted keys): how a tool call is keyed in the recording. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Key of one tool call: name and arguments. */
export const toolKey = (tool: string, args: unknown): string => `${tool} ${stableJson(args ?? {})}`;

const FOOTER = /\n*（(?:未配置大模型|大模型[^：]{0,24})：以上.{0,80}）\s*$/;
const BULLET = /^\s*(?:[-*•·]|\d{1,2}[.、)）])\s+/;
// "85 分", "8.5分": a score, not 分钟/分析/分布/分类/分区/分项/分数线
const SCORE = /\d+(?:\.\d+)?\s*分(?![钟析布类区项别数])/;
const REFUSAL = /不在|没有找到|找不到|无法|不能|没有.{0,8}(?:数据|分析|结果|样例)|超出/;
// says the tools have no score, instead of giving one ("中等偏弱" is a rating too)
const NO_SCORE =
  /没有.{0,8}(?:评分|打分|分数|等级|评级)|无法(?:打分|评分|给出.{0,4}(?:评分|分数))|不(?:提供|给出).{0,6}(?:评分|分数|等级)/;

/** How an answer reads, against the case's expectations. */
export function answerShape(c: EvalCase, answer: string, attachments = 0): AnswerShape {
  const text = answer.replace(FOOTER, '').trim();
  const lines = text.split('\n').filter((l) => l.trim());
  const first = (lines[0] ?? '').replace(/^\*\*|\*\*$/g, '').trim();
  const shape: AnswerShape = {
    conclusionFirst: /^(?:\*\*)?(?:结论|估算)/.test(first),
    bullets: lines.filter((l) => BULLET.test(l)).length,
    chars: [...text].length,
    cites: /[[【]\s*T\d+/.test(text),
    issues: [],
  };
  if (!shape.conclusionFirst) shape.issues.push('首行不是结论');
  if (shape.bullets > MAX_BULLETS) shape.issues.push(`要点 ${shape.bullets} 条（上限 ${MAX_BULLETS}）`);
  const e = c.expect ?? {};
  if (e.estimate && !text.includes('估算')) shape.issues.push('新增设施的结果没有标注“估算”');
  if (e.outOfScope && !(text.includes(e.outOfScope) && REFUSAL.test(text) && /搜索/.test(text))) {
    shape.issues.push(`没有如实说明“${e.outOfScope}”不在已有分析中、也没有指向搜索框`);
  }
  if (e.noScore && SCORE.test(text)) shape.issues.push('自创了评分');
  else if (e.noScore && !NO_SCORE.test(text)) shape.issues.push('没有说明工具不提供评分');
  if (e.attachment && !attachments) shape.issues.push('没有生成文件');
  return shape;
}

export interface EvalRecord {
  id: string;
  question: string;
  tags: string[];
  mode: 'llm' | 'template' | 'error';
  /** Tools in call order. */
  tools: { tool: string; args: unknown; error?: string }[];
  latency_ms: number;
  /** Model calls: exact in-process; through the API an upper bound (tool calls + answer + repair). */
  llm_calls: number;
  llm_calls_exact: boolean;
  grounding: { ok: boolean; checked: number; unsupported: string[]; uncited: string[] };
  /** The first draft failed the number check: what was wrong with it. */
  repair: { unsupported: string[]; uncited: string[] } | null;
  repaired: boolean;
  /** Citation completion: numbers whose missing source ids the system appended (in-process only). */
  citations_added?: string[];
  fallback: string | null;
  answer: string;
  attachments: number;
  shape: AnswerShape;
  error?: string;
}

export interface EvalSummary {
  n: number;
  /** Answered by the model (no fallback, no error). */
  llm: number;
  /** Passed the number and citation check without a repair round. */
  firstPass: number;
  repaired: number;
  /** Answers whose citations the system completed. */
  completed: number;
  fallback: number;
  errors: number;
  /** Final answers whose numbers are all grounded / all cited. */
  grounded: number;
  cited: number;
  conclusionFirst: number;
  withinBullets: number;
  /** No broken expectation at all (shape and grounding). */
  clean: number;
  llmCalls: number;
  toolCalls: number;
  latency: { median: number; p90: number; max: number };
  chars: { median: number; max: number };
}

const pct = (a: number, n: number) => (n ? `${((a / n) * 100).toFixed(0)}%` : '—');

function quantile(values: number[], q: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))]!;
}

export const firstPass = (r: EvalRecord): boolean => r.mode === 'llm' && !r.repair && !r.fallback;

export function summarize(records: readonly EvalRecord[]): EvalSummary {
  const ok = (r: EvalRecord) => r.grounding.ok && !r.grounding.uncited.length && !r.shape.issues.length;
  return {
    n: records.length,
    llm: records.filter((r) => r.mode === 'llm').length,
    firstPass: records.filter(firstPass).length,
    repaired: records.filter((r) => r.repaired).length,
    completed: records.filter((r) => r.citations_added?.length).length,
    fallback: records.filter((r) => r.fallback).length,
    errors: records.filter((r) => r.mode === 'error').length,
    grounded: records.filter((r) => r.grounding.ok).length,
    cited: records.filter((r) => r.grounding.ok && !r.grounding.uncited.length).length,
    conclusionFirst: records.filter((r) => r.shape.conclusionFirst).length,
    withinBullets: records.filter((r) => r.shape.bullets <= MAX_BULLETS).length,
    clean: records.filter(ok).length,
    llmCalls: records.reduce((s, r) => s + r.llm_calls, 0),
    toolCalls: records.reduce((s, r) => s + r.tools.length, 0),
    latency: {
      median: quantile(
        records.map((r) => r.latency_ms),
        0.5,
      ),
      p90: quantile(
        records.map((r) => r.latency_ms),
        0.9,
      ),
      max: Math.max(0, ...records.map((r) => r.latency_ms)),
    },
    chars: {
      median: quantile(
        records.map((r) => r.shape.chars),
        0.5,
      ),
      max: Math.max(0, ...records.map((r) => r.shape.chars)),
    },
  };
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** Chinese Markdown: the summary, then one row per question. */
export function markdownReport(records: readonly EvalRecord[], title: string): string {
  const s = summarize(records);
  const exact = records.every((r) => r.llm_calls_exact);
  const lines = [
    `### ${title}`,
    '',
    `| 指标 | 结果 |`,
    `| --- | --- |`,
    `| 问题数 | ${s.n} |`,
    `| 大模型作答（无回退、无出错） | ${s.llm}（${pct(s.llm, s.n)}） |`,
    `| **一次通过数字核验（无需修正）** | **${s.firstPass}（${pct(s.firstPass, s.n)}）** |`,
    `| 修正后通过 / 回退模板 / 出错 | ${s.repaired} / ${s.fallback} / ${s.errors} |`,
    `| 其中由系统补全引用编号（不需要模型重写） | ${s.completed} |`,
    `| 最终回答数字全部有出处 / 且全部标注来源 | ${s.grounded} / ${s.cited} |`,
    `| 结论先行 / 要点不超过 ${MAX_BULLETS} 条 | ${s.conclusionFirst} / ${s.withinBullets} |`,
    `| 全部检查通过 | ${s.clean}（${pct(s.clean, s.n)}） |`,
    `| 大模型调用${exact ? '' : '（上限估计）'} / 工具调用 | ${s.llmCalls} / ${s.toolCalls} |`,
    `| 耗时中位数 / P90 / 最长 | ${(s.latency.median / 1000).toFixed(1)} s / ${(s.latency.p90 / 1000).toFixed(1)} s / ${(s.latency.max / 1000).toFixed(1)} s |`,
    `| 回答长度中位数 / 最长（字） | ${s.chars.median} / ${s.chars.max} |`,
    '',
    '| # | 标签 | 模式 | 工具 | 耗时 | 核验 | 修正 | 结论先行 / 要点 | 问题 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of records) {
    const g = r.grounding;
    const check = g.ok
      ? g.uncited.length
        ? `未标注 ${g.uncited.join('、')}`
        : `通过（${g.checked}）`
      : `无出处 ${g.unsupported.join('、')}`;
    const repair = r.repair
      ? `${r.repaired ? '修正后通过' : '修正失败'}：${[...r.repair.unsupported, ...r.repair.uncited.map((u) => `${u}（未标注）`)].join('、')}`
      : r.citations_added?.length
        ? `补全引用：${r.citations_added.join('、')}`
        : '—';
    const mode = r.fallback
      ? `模板（回退：${r.fallback}）`
      : r.mode === 'error'
        ? `出错：${r.error}`
        : r.mode;
    lines.push(
      `| ${r.id} | ${r.tags.join('、')} | ${cell(mode)} | ${r.tools.map((t) => t.tool + (t.error ? '（失败）' : '')).join(' → ') || '—'} | ${(r.latency_ms / 1000).toFixed(1)} s | ${cell(check)} | ${cell(repair)} | ${r.shape.conclusionFirst ? '是' : '否'} / ${r.shape.bullets} | ${cell(r.shape.issues.join('；') || '—')} |`,
    );
  }
  return lines.join('\n');
}
