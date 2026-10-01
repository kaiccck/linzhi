import { describe, expect, it } from 'vitest';
import { createAdvisor, repairPrompt, type AdvisorEvent } from '../src/advisor.js';
import { LocalBackend } from '../src/backend.js';
import { checkGrounding } from '../src/grounding.js';
import { parseIntent, placeTextOf } from '../src/intent.js';
import { ChatClient, LlmError, llmConfigFromEnv, scrubSecrets } from '../src/llm.js';
import { SAMPLES_DIR, scriptedLlm } from './helpers.js';

const backend = () => new LocalBackend({ samplesDir: SAMPLES_DIR });
const LLM = { baseUrl: 'https://llm.example.com/v1', apiKey: 'sk-test-secret-123456', model: 'test-model' };

describe('template mode (no LLM configured)', () => {
  const advisor = createAdvisor({ backend: backend() });

  it('answers 申城佳苑的老人买菜方便吗？ with the elderly profile and the market gaps', async () => {
    const events: AdvisorEvent[] = [];
    const a = await advisor.ask('申城佳苑的老人买菜方便吗？', { onEvent: (e) => events.push(e) });
    expect(a.mode).toBe('template');
    expect(a.citations.map((c) => [c.id, c.tool])).toEqual([
      ['T1', 'analyze_life_circle'],
      ['T2', 'list_service_gaps'],
    ]);
    expect(a.citations[0]!.args).toEqual({ analysis_id: 'zj-a', profile: 'elder' });
    expect(a.citations[1]!.args).toEqual({ analysis_id: 'zj-a~elder', category: '菜市场' });
    expect(a.analysisId).toBe('zj-a~elder');
    const [lead] = a.answer.split('\n');
    expect(lead).toBe(
      '结论：不太方便：申城佳苑片区 12 个小区中，有 2 个步行 1,000 m 内走不到菜市场（伪覆盖 2、盲区 0）[T2]。',
    );
    expect(a.answer).toContain(
      '按老年人步速 0.9 m/s，15 分钟最多走 810 m，整个片区 12 个小区里有 7 个能在 15 分钟内走到菜市场 [T2]',
    );
    expect(a.answer).toContain(
      '川杨新苑四期：到菜市场直线 733.7 m，实际步行 1,281 m，约 23.7 分钟（伪覆盖）[T2]',
    );
    expect(a.grounding).toMatchObject({ ok: true, unsupported: [], uncited: [] });
    expect(a.grounding.checked).toBeGreaterThan(15);
    expect(events.map((e) => e.type)).toEqual([
      'tool_call',
      'tool_result',
      'tool_call',
      'tool_result',
      'answer',
    ]);
  });

  it('answers 如果在孙环路口开一家药店呢？ with a labelled estimate at the 孙环路 crossing', async () => {
    const a = await advisor.ask('如果在孙环路口开一家药店呢？');
    expect(a.citations.map((c) => c.tool)).toEqual(['simulate_facility']);
    expect(a.citations[0]!.args).toMatchObject({
      analysis_id: 'zj-a',
      category: '药店',
      center_bd09: [121.644195, 31.19007],
      label: '孙环路口',
    });
    expect(a.answer.startsWith('估算（未经实测核验）')).toBe(true);
    expect(a.answer).toContain('当前没有已核实的药店缺口');
    expect(a.answer).toContain('需要实测算路核验');
    expect(a.answer).toContain('位置理解：“孙环路口”按分析中心（孙环路 × 高木桥路）的路口计算');
    expect(a.grounding).toMatchObject({ ok: true, uncited: [] });
  });

  it('answers 导出体检报告 with the Markdown report as an attachment', async () => {
    const a = await advisor.ask('导出体检报告');
    expect(a.citations.map((c) => c.tool)).toEqual(['export_report']);
    expect(a.answer).toContain('没有指明社区，以下按样例“申城佳苑片区”（zj-a）回答。');
    expect(a.answer).toContain('画圆漏掉了其中 8 个（88.9%）');
    expect(a.attachments).toHaveLength(1);
    expect(a.attachments![0]).toMatchObject({
      filename: 'zoudedao-zj-a-report.md',
      mime_type: 'text/markdown',
    });
    expect(a.attachments![0]!.content.startsWith('# 申城佳苑片区 · 15 分钟生活圈体检报告')).toBe(true);
    expect(a.grounding.ok).toBe(true);
  });

  it('answers 圈里有几家药店 / 附近有什么设施 from the 圈内设施统计, every number grounded', async () => {
    const one = await advisor.ask('申城佳苑圈里有几家药店？');
    expect(one.citations.map((c) => [c.tool, c.args])).toEqual([
      ['analyze_life_circle', { analysis_id: 'zj-a' }],
    ]);
    expect(one.answer.split('\n')[0]).toBe(
      '结论：申城佳苑片区：15 分钟步行能走到药店 8 家（直线 15 分钟圆内 9 家，清单共 11 家），最近的是医保药店(高木桥路店)，步行约 2.7 分钟 [T1]。',
    );
    const all = await advisor.ask('附近有什么设施？', { analysisId: 'zj-a' });
    expect(all.answer).toContain(
      '结论：申城佳苑片区的圈内设施（15 分钟步行可达 / 直线 15 分钟圆内）：小学 0 / 1，',
    );
    expect(all.answer).toContain('- 15 分钟内一处也走不到：小学、地铁 [T1]。');
    expect(all.answer).toContain('灰色区域');
    expect(all.answer).toContain('- 公交的清单只统计到离中心 324 m（检索页数用完），实际可能更多 [T1]。');
    // the elderly profile at 0.9 m/s, and a category none of which is walkable
    const elder = await advisor.ask('老人15分钟能走到几家超市', { analysisId: 'zj-a' });
    expect(elder.citations[0]!.args).toEqual({ analysis_id: 'zj-a', profile: 'elder' });
    expect(elder.answer).toContain('按老年人步速 0.9 m/s，申城佳苑片区：15 分钟步行能走到超市 3 家');
    const metro = await advisor.ask('玉兰香苑附近有地铁吗');
    expect(metro.answer).toContain('玉兰香苑片区：15 分钟内走不到地铁：直线 15 分钟圆内有 1 个');
    for (const a of [one, all, elder, metro]) {
      expect(a.grounding).toMatchObject({ ok: true, unsupported: [], uncited: [] });
      expect(a.grounding.checked).toBeGreaterThan(5);
    }
  });

  it('routes facility counts apart from community gaps', () => {
    const kind = (q: string) => parseIntent(q).kind;
    expect(kind('圈里有几家药店')).toBe('facilities');
    expect(kind('附近有什么设施')).toBe('facilities');
    expect(kind('15分钟能走到几家超市')).toBe('facilities');
    expect(kind('附近有地铁吗')).toBe('facilities');
    expect(kind('老人看病方便吗')).toBe('facilities');
    expect(parseIntent('附近有地铁和公园吗').facilityCategories).toEqual(['地铁', '公园']);
    expect(parseIntent('长者食堂远吗')).toMatchObject({
      kind: 'facilities',
      profile: 'adult',
      facilityCategories: ['养老'],
    });
    // community questions stay with the gap tools
    expect(kind('有几个小区走不到菜场')).toBe('gaps');
    expect(kind('申城佳苑的老人买菜方便吗？')).toBe('gaps');
    expect(kind('申城佳苑三期B块的孩子上学方便吗')).toBe('gaps');
    expect(kind('15分钟能走多远？')).toBe('reach');
    expect(kind('如果在孙环路口开一家药店呢？')).toBe('simulate');
  });

  it('reads the topic apart from place names: 万科翡翠公园 is not a question about parks', async () => {
    expect(parseIntent('万科翡翠公园片区买菜方便吗？').kind).toBe('facilities');
    expect(parseIntent('万科翡翠公园片区买菜方便吗？', ['万科翡翠公园片区', '万科翡翠公园']).kind).toBe(
      'gaps',
    );
    expect(parseIntent('万科翡翠公园附近有公园吗', ['万科翡翠公园']).facilityCategories).toEqual(['公园']);
    expect(placeTextOf('帮我看看徐家汇那边老人看病方便吗')).toBe('徐家汇');
    for (const q of ['万科翡翠公园片区买菜方便吗？', '万科翡翠公园片区有几个小区走不到菜市场？']) {
      const a = await advisor.ask(q, { analysisId: 'zj-c' });
      // the area, not its community named 万科翡翠公园
      expect(a.citations.map((c) => [c.tool, c.args])).toEqual([
        ['list_service_gaps', { analysis_id: 'zj-c', category: '菜市场' }],
      ]);
      expect(a.answer).toContain('万科翡翠公园片区 12 个小区中，有 12 个步行 1,000 m 内走不到菜市场');
      expect(a.grounding).toMatchObject({ ok: true, uncited: [] });
    }
  });

  it('handles communities, unknown places, reach and profile comparison', async () => {
    const school = await advisor.ask('申城佳苑三期B块的孩子上学方便吗');
    expect(school.answer).toContain(
      '结论：不太方便：申城佳苑三期B块的小学步行 1,000 m 内走不到（伪覆盖）：最近能走到的是孙桥小学(申江校区)，直线 818.5 m，实际步行 1,676 m，约 23.9 分钟 [T1]。',
    );
    const unknown = await advisor.ask('陆家嘴怎么样？');
    expect(unknown.answer).toContain('没有找到“陆家嘴”');
    expect(unknown.citations.map((c) => c.tool)).toEqual(['locate_place']);
    const reach = await advisor.ask('15分钟能走多远？');
    expect(reach.answer).toContain('15 分钟有效步行半径中位数 775 m');
    const compare = await advisor.ask('对比一下老人和成人');
    expect(compare.answer).toContain('两种画像的已核实缺口都是 9 个');
    for (const a of [school, unknown, reach, compare])
      expect(a.grounding).toMatchObject({ ok: true, uncited: [] });
  });
});

describe('LLM mode with a scripted OpenAI-compatible endpoint', () => {
  const analyzeCall = { tool_calls: [{ name: 'analyze_life_circle', arguments: { sample_id: 'zj-a' } }] };

  it('runs the tool loop and returns a grounded, cited answer', async () => {
    const llm = scriptedLlm([
      analyzeCall,
      {
        content:
          '结论：画圆法只找到 1 个缺口，按实测步行距离已核实 9 个 [T1]。\n- 15 分钟步行实际可达 1.857 km²，画圆高估 1.88 倍 [T1]。',
      },
    ]);
    const advisor = createAdvisor({ backend: backend(), llm: { ...LLM, fetch: llm.fetch } });
    expect(advisor.mode).toBe('llm');
    const a = await advisor.ask('申城佳苑的生活圈怎么样？');
    expect(a).toMatchObject({
      mode: 'llm',
      steps: 2,
      analysisId: 'zj-a',
      llm: 'test-model @ llm.example.com',
    });
    expect(a.grounding).toMatchObject({ ok: true, unsupported: [], uncited: [] });
    expect(a.citations.map((c) => [c.id, c.tool])).toEqual([['T1', 'analyze_life_circle']]);

    const [first, second] = llm.requests;
    expect(first!.url).toBe('https://llm.example.com/v1/chat/completions');
    expect(first!.headers.authorization).toBe('Bearer sk-test-secret-123456');
    expect(first!.body.model).toBe('test-model');
    expect(first!.body.tool_choice).toBe('auto');
    expect(first!.body.tools!.map((t) => t.function.name)).toEqual([
      'locate_place',
      'analyze_life_circle',
      'get_isochrone',
      'list_service_gaps',
      'simulate_facility',
      'compare_sites',
      'export_report',
    ]);
    expect(first!.body.messages[0]!.role).toBe('system');
    expect(first!.body.messages[0]!.content).toContain('不要四舍五入');
    expect(first!.body.messages[0]!.content).toContain('不要自己加减乘除');
    const toolMsg = second!.body.messages.find((m) => m.role === 'tool')!;
    expect(toolMsg.tool_call_id).toBe('call_1_0');
    const payload = JSON.parse(toolMsg.content!) as {
      id: string;
      tool: string;
      summary: string;
      facts: unknown[];
    };
    expect(payload).toMatchObject({ id: 'T1', tool: 'analyze_life_circle' });
    expect(payload.summary).toContain('画圆漏掉了其中 8 个（88.9%）');
  });

  it('repairs a hallucinated number once, listing it for the model', async () => {
    const llm = scriptedLlm([
      analyzeCall,
      { content: '画圆把面积高估了约 1.9 倍 [T1]。' },
      { content: '画圆把面积高估了 1.88 倍 [T1]。' },
    ]);
    const events: AdvisorEvent[] = [];
    const a = await createAdvisor({ backend: backend(), llm: { ...LLM, fetch: llm.fetch } }).ask(
      '画圆高估了多少？',
      {
        onEvent: (e) => events.push(e),
      },
    );
    expect(a).toMatchObject({ mode: 'llm', repaired: true, answer: '画圆把面积高估了 1.88 倍 [T1]。' });
    expect(events.find((e) => e.type === 'repair')).toEqual({
      type: 'repair',
      unsupported: ['1.9 倍'],
      uncited: [],
    });
    const repair = llm.requests[2]!.body;
    expect(repair.tool_choice).toBe('none');
    expect(repair.messages.at(-1)!.content).toContain('1.9 倍');
  });

  it('falls back to the template answer when the repair still invents numbers', async () => {
    const llm = scriptedLlm([
      analyzeCall,
      { content: '买菜最远要走 2,450 m [T1]。' },
      { content: '买菜最远要走 2,380 m [T1]。' },
    ]);
    const events: AdvisorEvent[] = [];
    const a = await createAdvisor({ backend: backend(), llm: { ...LLM, fetch: llm.fetch } }).ask(
      '申城佳苑的老人买菜方便吗？',
      { onEvent: (e) => events.push(e) },
    );
    expect(a.mode).toBe('template');
    expect(a.fallback).toMatchObject({ unsupported: ['2,380 m'], llmAnswer: '买菜最远要走 2,380 m [T1]。' });
    expect(a.fallback!.reason).toContain('修正一次后仍未通过核验');
    expect(a.answer).toContain('有 2 个步行 1,000 m 内走不到菜市场');
    expect(a.answer).toContain('大模型的回答未通过数字核验');
    expect(a.grounding.ok).toBe(true);
    // the template starts a fresh turn: its own citations, T1 first
    expect(a.citations[0]).toMatchObject({ id: 'T1', tool: 'analyze_life_circle' });
    expect(events.map((e) => e.type)).toContain('fallback');
  });

  it('completes missing or wrong citations of real numbers without a rewrite round', async () => {
    const llm = scriptedLlm([
      {
        tool_calls: [
          { name: 'analyze_life_circle', arguments: { sample_id: 'zj-a' } },
          { name: 'list_service_gaps', arguments: { analysis_id: 'zj-a', category: '小学' } },
        ],
      },
      // 1.88 倍 uncited; 23.9 分钟 is in T2 but cites T1 (a real draft had this shape)
      { content: '结论：画圆高估 1.88 倍。\n- 申城佳苑三期B块到小学约 23.9 分钟 [T1]。' },
    ]);
    const a = await createAdvisor({ backend: backend(), llm: { ...LLM, fetch: llm.fetch } }).ask(
      '高估多少？',
    );
    expect(a.answer).toBe('结论：画圆高估 1.88 倍 [T1]。\n- 申城佳苑三期B块到小学约 23.9 分钟 [T1][T2]。');
    expect(a.citationsAdded).toEqual(['1.88 倍 → T1', '23.9 分钟 → T2']);
    expect(a.grounding).toMatchObject({ ok: true, uncited: [] });
    expect(a.repaired).toBeUndefined();
    expect(llm.requests).toHaveLength(2);
  });

  it('keeps a correct answer whose only problem is a missing citation that the rewrite breaks', async () => {
    // a table is never completed automatically: its numbers go through the rewrite round
    const table = ['| 指标 | 数值 |', '| --- | --- |', '| 画圆高估 | 1.88 倍 |'].join('\n');
    const llm = scriptedLlm([analyzeCall, { content: table }, { content: '画圆高估 2 倍 [T1]。' }]);
    const a = await createAdvisor({ backend: backend(), llm: { ...LLM, fetch: llm.fetch } }).ask(
      '高估多少？',
    );
    expect(a).toMatchObject({ mode: 'llm', answer: table });
    expect(a.grounding).toMatchObject({ ok: true, uncited: ['1.88 倍'] });
    expect(a.citationsAdded).toBeUndefined();
  });

  it('says so when the question names a place outside the analysis on screen', async () => {
    const a = await createAdvisor({ backend: backend() }).ask('陆家嘴的老人买菜方便吗？', {
      analysisId: 'zj-a',
    });
    expect(a.answer).toContain('“陆家嘴”不在当前分析里');
    expect(a.answer).toContain('申城佳苑片区');
    expect(a.grounding.ok).toBe(true);
  });

  it('falls back without leaking the key when the provider rejects it', async () => {
    const llm = scriptedLlm([{ status: 401, body: '{"error":"invalid api key sk-test-secret-123456"}' }]);
    const a = await createAdvisor({ backend: backend(), llm: { ...LLM, fetch: llm.fetch } }).ask(
      '导出体检报告',
    );
    expect(a.mode).toBe('template');
    expect(a.fallback!.reason).toContain('HTTP 401');
    expect(a.fallback!.reason).toContain('LLM_API_KEY');
    expect(JSON.stringify(a)).not.toContain('sk-test-secret-123456');
    expect(a.attachments).toHaveLength(1);
    // a failed call is not a failed number check: the footer must not blame the model's numbers
    expect(a.answer).toContain('大模型暂时不可用');
    expect(a.answer).not.toContain('未通过数字核验');
  });

  it('echoes reasoning_content of thinking models back in the tool loop, and only then', async () => {
    const llm = scriptedLlm([
      { ...analyzeCall, reasoning: '先查申城佳苑的体检结果。' },
      { content: '画圆高估 1.9 倍 [T1]。', reasoning: '根据工具结果回答。' },
      { content: '画圆高估 1.88 倍 [T1]。' },
    ]);
    await createAdvisor({ backend: backend(), llm: { ...LLM, fetch: llm.fetch } }).ask('高估多少？');
    const assistants = (i: number) => llm.requests[i]!.body.messages.filter((m) => m.role === 'assistant');
    expect(assistants(1)[0]!.reasoning_content).toBe('先查申城佳苑的体检结果。');
    expect(assistants(2).map((m) => m.reasoning_content)).toEqual([
      '先查申城佳苑的体检结果。',
      '根据工具结果回答。',
    ]);
    const plain = scriptedLlm([analyzeCall, { content: '画圆高估 1.88 倍 [T1]。' }]);
    await createAdvisor({ backend: backend(), llm: { ...LLM, fetch: plain.fetch } }).ask('高估多少？');
    expect(plain.requests[1]!.body.messages.find((m) => m.role === 'assistant')).not.toHaveProperty(
      'reasoning_content',
    );
  });

  it('tells the model about bad tool arguments and continues', async () => {
    const llm = scriptedLlm([
      { tool_calls: [{ name: 'get_isochrone', arguments: { analysis_id: 'zj-a', crs: 'utm' } }] },
      { tool_calls: [{ name: 'get_isochrone', arguments: { analysis_id: 'zj-a' } }] },
      { content: '15 分钟步行可达 1.857 km² [T1]。' },
    ]);
    const a = await createAdvisor({ backend: backend(), llm: { ...LLM, fetch: llm.fetch } }).ask(
      '等时圈多大？',
    );
    expect(a.mode).toBe('llm');
    const err = JSON.parse(llm.requests[1]!.body.messages.at(-1)!.content!) as { error: string };
    expect(err.error).toMatch(/参数 crs/);
    expect(a.citations).toHaveLength(1);
  });
});

describe('repair prompt', () => {
  it('tells the model, number by number, what to copy, delete or cite', () => {
    const g = checkGrounding('结论：步行约 24 分钟，比判定距离多 676 m [T1]。\n- 共 8 个缺口。', [
      {
        id: 'T1',
        facts: [
          { label: '步行时间', value: 23.9, unit: '分钟' },
          { label: '已核实缺口数', value: 8, unit: '个' },
        ],
      },
    ]);
    const p = repairPrompt(g);
    expect(p).toContain('- 24 分钟：工具结果里的原值是 23.9 分钟（T1），请照抄原值');
    expect(p).toContain('- 676 m：工具结果里没有这个数，请删掉它');
    expect(p).toContain('- 8 个：它出现在 T1，请在这一句末尾加上 [T1]');
    expect(p).toContain('保持“结论：”开头');
  });
});

describe('LLM client configuration', () => {
  it('reads LLM_* variables and stays off when they are missing', () => {
    expect(llmConfigFromEnv({})).toBeNull();
    expect(llmConfigFromEnv({ LLM_BASE_URL: 'https://api.deepseek.com', LLM_MODEL: '' })).toBeNull();
    expect(
      llmConfigFromEnv({
        LLM_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        LLM_MODEL: 'qwen-plus',
        LLM_API_KEY: ' sk-x ',
        LLM_EXTRA_BODY: '{"enable_thinking": false}',
        LLM_TIMEOUT_MS: '30000',
      }),
    ).toEqual({
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen-plus',
      apiKey: 'sk-x',
      extraBody: { enable_thinking: false },
      timeoutMs: 30000,
    });
    expect(() => llmConfigFromEnv({ LLM_BASE_URL: 'x', LLM_MODEL: 'm', LLM_EXTRA_BODY: '[1]' })).toThrow(
      LlmError,
    );
  });

  it('scrubs keys from provider messages', () => {
    expect(scrubSecrets('bad key sk-abcdef123456 and Bearer xyz.123', 'custom-secret')).toBe(
      'bad key *** and Bearer ***',
    );
    expect(scrubSecrets('token custom-secret here', 'custom-secret')).toBe('token *** here');
    expect(scrubSecrets('bce-v3/ALTAK-abc/def')).toBe('***');
  });

  it('merges the extra body and retries once on 5xx', async () => {
    let n = 0;
    const bodies: Record<string, unknown>[] = [];
    const fetch = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (n++ === 0) return new Response('busy', { status: 503 });
      return Response.json({
        choices: [{ message: { content: [{ type: 'text', text: '你好' }] }, finish_reason: 'stop' }],
      });
    }) as typeof globalThis.fetch;
    const client = new ChatClient({
      baseUrl: 'https://x/v1/chat/completions',
      model: 'm',
      extraBody: { enable_thinking: false },
      fetch,
    });
    const r = await client.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(r.content).toBe('你好');
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ enable_thinking: false, model: 'm', stream: false });
    expect(bodies[0]).not.toHaveProperty('tools');
  });
});
