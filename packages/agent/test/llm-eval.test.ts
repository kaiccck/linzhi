/**
 * Offline replay of the real-model evaluation (scripts/eval-llm.ts --record): every question runs
 * through the advisor again, with the recorded model responses in place of the model and the
 * recorded tool results in place of the tools, and must end exactly as it did live — same tool
 * calls, same answer, same number check. The aggregate targets of the evaluation are asserted on
 * the replayed records, so a change to grounding.ts or the advisor loop that would have rejected
 * (or let through) a real model answer shows up here without any network.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createAdvisor, repairPrompt, systemPrompt, type AdvisorEvent } from '../src/advisor.js';
import { LocalBackend } from '../src/backend.js';
import type { Fact } from '../src/format.js';
import { createToolRegistry, type ToolRegistry } from '../src/tools/registry.js';
import { ToolError } from '../src/tools/types.js';
import {
  answerShape,
  firstPass,
  summarize,
  toolKey,
  type EvalCase,
  type EvalRecord,
} from '../scripts/eval-lib.ts';
import { SAMPLES_DIR } from './helpers.js';

interface RecordedTool {
  tool: string;
  args: unknown;
  summary?: string;
  facts?: Fact[];
  view?: unknown;
  error?: { code: string; message: string };
}

interface RecordedCase extends EvalCase {
  recorded_at: string;
  /** Fingerprint of the system prompt, repair prompt and tool definitions the model saw. */
  prompt_sha: string;
  responses: {
    status: number;
    message?: Record<string, unknown>;
    finish_reason?: string | null;
    error?: string;
  }[];
  tool_calls: string[];
  record: EvalRecord;
}

interface Recording {
  llm: string;
  cases: RecordedCase[];
  tools: Record<string, RecordedTool>;
}

const recording = JSON.parse(
  readFileSync(new URL('./fixtures/llm-eval/recorded.json', import.meta.url), 'utf8'),
) as Recording;
const evalSet = JSON.parse(
  readFileSync(new URL('./fixtures/llm-eval/cases.json', import.meta.url), 'utf8'),
) as { cases: EvalCase[] };

/** Chat completions from the recording, in order; anything beyond it is a 500. */
function replayFetch(c: RecordedCase): { fetch: typeof fetch; calls: () => number } {
  let i = 0;
  const stub = async (): Promise<Response> => {
    const r = c.responses[i++];
    if (!r) return new Response('{"error":"recording exhausted"}', { status: 500 });
    if (!r.message) return new Response(r.error ?? '', { status: r.status });
    return Response.json({
      choices: [{ index: 0, message: r.message, finish_reason: r.finish_reason ?? null }],
    });
  };
  return { fetch: stub as typeof fetch, calls: () => i };
}

/** Tool results from the recording, looked up by name and arguments; the view is the data. */
function replayRegistry(tools: Record<string, RecordedTool>, order: string[]): ToolRegistry {
  const base = createToolRegistry();
  return {
    tools: base.tools,
    openAITools: () => base.openAITools(),
    // the recorded view is already what llmView made of the data
    get: (name) => {
      const def = base.get(name);
      return def ? { ...def, llmView: undefined } : undefined;
    },
    async run(name, args) {
      const key = toolKey(name, args);
      order.push(key);
      const t = tools[key];
      if (!t) throw new ToolError('not_recorded', `录制中没有这次调用：${key}`);
      if (t.error) throw new ToolError(t.error.code, t.error.message);
      return { summary: t.summary ?? '', facts: t.facts ?? [], data: t.view };
    },
  };
}

async function replay(c: RecordedCase): Promise<{ record: EvalRecord; order: string[]; calls: number }> {
  const llm = replayFetch(c);
  const order: string[] = [];
  const advisor = createAdvisor({
    backend: new LocalBackend({ samplesDir: SAMPLES_DIR }),
    llm: { baseUrl: 'https://replay.invalid/v1', model: 'replay', fetch: llm.fetch },
    registry: replayRegistry(recording.tools, order),
  });
  const events: AdvisorEvent[] = [];
  const a = await advisor.ask(c.question, {
    ...(c.analysis_id ? { analysisId: c.analysis_id } : {}),
    ...(c.history ? { history: c.history } : {}),
    onEvent: (e) => events.push(e),
  });
  const repair = events.find((e) => e.type === 'repair');
  const record: EvalRecord = {
    ...c.record,
    mode: a.mode,
    grounding: {
      ok: a.grounding.ok,
      checked: a.grounding.checked,
      unsupported: a.grounding.unsupported,
      uncited: a.grounding.uncited,
    },
    repair: repair?.type === 'repair' ? { unsupported: repair.unsupported, uncited: repair.uncited } : null,
    repaired: !!a.repaired,
    ...(a.citationsAdded?.length ? { citations_added: a.citationsAdded } : {}),
    fallback: a.fallback?.reason ?? null,
    answer: a.answer,
    attachments: a.attachments?.length ?? 0,
    shape: answerShape(c, a.answer, a.attachments?.length ?? 0),
  };
  return { record, order, calls: llm.calls() };
}

describe('real-model evaluation, replayed offline', () => {
  it('covers the whole evaluation set, recorded without any key', () => {
    expect(recording.cases.map((c) => c.id)).toEqual(evalSet.cases.map((c) => c.id));
    for (const c of recording.cases) {
      const q = evalSet.cases.find((x) => x.id === c.id)!;
      expect({ question: c.question, analysis_id: c.analysis_id }).toEqual({
        question: q.question,
        analysis_id: q.analysis_id,
      });
    }
    expect(JSON.stringify(recording)).not.toMatch(/sk-[A-Za-z0-9]{10,}|Bearer\s+\w/);
  });

  const replayed: EvalRecord[] = [];
  for (const c of recording.cases) {
    it(`${c.id} ${c.question}`, async () => {
      const r = await replay(c);
      expect(r.order).toEqual(c.tool_calls);
      expect(r.calls).toBe(c.responses.length);
      expect(r.record.answer).toBe(c.record.answer);
      expect({
        mode: r.record.mode,
        repair: r.record.repair,
        repaired: r.record.repaired,
        citations_added: r.record.citations_added,
        fallback: r.record.fallback,
        grounding: r.record.grounding,
      }).toEqual({
        mode: c.record.mode,
        repair: c.record.repair,
        repaired: c.record.repaired,
        citations_added: c.record.citations_added,
        fallback: c.record.fallback,
        grounding: c.record.grounding,
      });
      replayed.push(r.record);
    });
  }

  it('meets the targets: ≥ 90 % grounded without repair, no fallback, concise and cited', () => {
    expect(replayed).toHaveLength(recording.cases.length);
    const s = summarize(replayed);
    expect(s.firstPass / s.n).toBeGreaterThanOrEqual(0.9);
    expect(s.fallback).toBe(0);
    expect(s.grounded).toBe(s.n);
    expect(s.conclusionFirst).toBe(s.n);
    expect(s.withinBullets).toBe(s.n);
    for (const r of replayed) {
      expect(r.shape.issues, `${r.id}: ${r.shape.issues.join('；')}`).toEqual([]);
      if (firstPass(r)) expect(r.grounding.uncited, r.id).toEqual([]);
    }
  });

  it('says which prompt the recording measured', () => {
    // same fingerprint as scripts/eval-llm.ts: a prompt change does not break the replay, it only
    // means the targets above describe the recorded prompt; rerun the script with --record
    const sha = createHash('sha256')
      .update(systemPrompt('{available}', '{analysis_id}'))
      .update(repairPrompt({ unsupported: ['{n}'], uncited: ['{m}'] }))
      .update(JSON.stringify(createToolRegistry().openAITools()))
      .digest('hex')
      .slice(0, 12);
    const recorded = [...new Set(recording.cases.map((c) => c.prompt_sha))];
    if (!recorded.includes(sha)) {
      console.info(`llm-eval: recorded with prompt ${recorded.join(', ')}, current prompt is ${sha}`);
    }
    expect(recorded.every((s) => /^[0-9a-f]{12}$/.test(s))).toBe(true);
  });
});
