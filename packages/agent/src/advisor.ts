/**
 * 体检顾问 (技术设计文档 §8.1). With an LLM: the model plans tool calls, every tool result gets a
 * citation id (T1, T2 …), and the final answer must pass the number grounding check — one repair
 * round, then the template answer. Without an LLM (or when the model fails): a keyword router calls
 * the same tools and composes the answer from their results, with the same citations.
 */
import type { FacilityCategory, HardCategory } from '@zoudedao/core';
import type { Anchor } from './anchors.js';
import {
  CHECKED_SCOPE,
  COUNTED_ONLY,
  HARD_CATEGORIES,
  TASK_CATEGORIES,
  checkedCategories,
  findCommunity,
  normName,
} from './analysis.js';
import { AnalysisStore, type ZddBackend } from './backend.js';
import { fmtNumber, joinZh, type Fact } from './format.js';
import {
  checkGrounding,
  completeCitations,
  type GroundingReport,
  type NumberSource,
  type TokenCheck,
} from './grounding.js';
import { parseIntent, resolveSite, type Intent } from './intent.js';
import { ChatClient, LlmError, describeLlm, type ChatMessage, type LlmConfig } from './llm.js';
import { availableText, resolveAnalysis } from './tools/context.js';
import type { CompareRow } from './tools/compare.js';
import type { GapsData } from './tools/gaps.js';
import type { ReportData } from './tools/report.js';
import { createToolRegistry, type ToolRegistry } from './tools/registry.js';
import type { SimulateData } from './tools/simulate.js';
import type { ToolContext, ToolResult } from './tools/types.js';
import type { FacilityRow, Overview } from './summary.js';
import type { LocateResult } from './types.js';

export interface Citation {
  /** T1, T2 … in call order within one answer. */
  id: string;
  tool: string;
  args: unknown;
  summary: string;
  facts: Fact[];
  /** Places the tool result talks about, for the map (anchors.ts); empty when it names none. */
  anchors: Anchor[];
}

export interface Attachment {
  filename: string;
  mime_type: string;
  content: string;
}

export type AdvisorEvent =
  | { type: 'tool_call'; tool: string; args: unknown }
  | { type: 'tool_result'; tool: string; id?: string; summary?: string; error?: string }
  | { type: 'progress'; message: string; progress?: number }
  | { type: 'repair'; unsupported: string[]; uncited: string[] }
  | { type: 'fallback'; reason: string }
  | { type: 'answer'; answer: AdvisorAnswer };

export interface AskOptions {
  history?: { role: 'user' | 'assistant'; content: string }[];
  /** The analysis the user is looking at; used when the question names none. */
  analysisId?: string;
  onEvent?: (event: AdvisorEvent) => void;
  signal?: AbortSignal;
}

export interface AdvisorAnswer {
  answer: string;
  mode: 'llm' | 'template';
  citations: Citation[];
  grounding: GroundingReport;
  /** Analysis the answer is about, for follow-up questions. */
  analysisId?: string;
  /** Files produced by export_report. */
  attachments?: Attachment[];
  /** The model's first answer failed the check and its rewrite passed. */
  repaired?: boolean;
  /**
   * Citation completion: numbers that were real but cited in the wrong place (or not at all), whose
   * source ids the system appended instead of asking for a rewrite, e.g. "5 个 → T1".
   */
  citationsAdded?: string[];
  /** Why the template answered although an LLM is configured. */
  fallback?: { reason: string; unsupported: string[]; llmAnswer?: string };
  /** "model @ host" when an LLM was used. */
  llm?: string;
  /** LLM calls made. */
  steps?: number;
}

export interface AdvisorOptions {
  backend: ZddBackend;
  /** null/undefined: template mode only. */
  llm?: LlmConfig | null;
  /** LLM calls per question before the answer is forced (default 6). */
  maxSteps?: number;
  store?: AnalysisStore;
  registry?: ToolRegistry;
}

export interface Advisor {
  readonly mode: 'llm' | 'template';
  readonly store: AnalysisStore;
  readonly registry: ToolRegistry;
  ask(question: string, opts?: AskOptions): Promise<AdvisorAnswer>;
}

// ------------------------------------------------------------------------------------ turn

/** One question: tool calls with citation ids, the numbers they carry, attachments. */
class Turn {
  readonly citations: Citation[] = [];
  readonly sources: NumberSource[] = [];
  readonly attachments: Attachment[] = [];
  analysisId: string | undefined;

  constructor(
    readonly registry: ToolRegistry,
    readonly ctx: ToolContext,
    readonly emit: (e: AdvisorEvent) => void,
  ) {}

  async run<D = unknown>(
    tool: string,
    args: unknown,
  ): Promise<{ id: string; result: ToolResult<D>; view: unknown }> {
    this.emit({ type: 'tool_call', tool, args });
    let result: ToolResult;
    try {
      result = await this.registry.run(tool, args, this.ctx);
    } catch (err) {
      this.emit({ type: 'tool_result', tool, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
    const id = `T${this.citations.length + 1}`;
    const def = this.registry.get(tool);
    const view = def?.llmView ? def.llmView(result.data) : result.data;
    this.citations.push({
      id,
      tool,
      args,
      summary: result.summary,
      facts: result.facts,
      anchors: result.anchors ?? [],
    });
    this.sources.push({ id, text: result.summary, facts: result.facts, data: view });
    const data = result.data as { analysis_id?: unknown } | null;
    if (data && typeof data.analysis_id === 'string') this.analysisId = data.analysis_id;
    if (tool === 'export_report') {
      const r = result.data as ReportData;
      this.attachments.push({
        filename: r.filename,
        mime_type: r.mime_type,
        content: typeof r.content === 'string' ? r.content : JSON.stringify(r.content, null, 2),
      });
    }
    this.emit({ type: 'tool_result', tool, id, summary: result.summary });
    return { id, result: result as ToolResult<D>, view };
  }

  groundingSources(question: string, extra: string[] = []): NumberSource[] {
    return [...this.sources, { id: 'question', text: [question, ...extra].join('\n') }];
  }
}

// -------------------------------------------------------------------------------- template

/** Sentences of a tool summary, each ending with its citation: "…… [T1]。" */
function citeSentences(summary: string, id: string): string[] {
  return summary
    .split(/(?<=。)/)
    .map((s) => s.trim())
    .filter((s) => s.replace(/。/g, '').trim())
    .map((s) => (s.endsWith('。') ? `${s.slice(0, -1)} [${id}]。` : `${s} [${id}]。`));
}

/** Drops the "名称（analysis_id: …）：" lead-in of a summary's first sentence. */
const stripHeader = (s: string) => s.replace(/^[^：（]{0,60}（analysis_id:[^：]*?）：/, '');

const FOOTER_TEMPLATE = '（未配置大模型：以上回答由模板根据工具结果生成，[T#] 是工具结果编号。）';
const FOOTER_FALLBACK = '（大模型的回答未通过数字核验，以上改由模板根据工具结果生成，[T#] 是工具结果编号。）';
const FOOTER_LLM_DOWN = '（大模型暂时不可用，以上改由模板根据工具结果生成，[T#] 是工具结果编号。）';

interface Target {
  id: string;
  note: string;
  /** Community the question is about, if it names one. */
  community?: string;
}

async function pickTarget(
  turn: Turn,
  question: string,
  intent: Intent,
  given?: string,
): Promise<Target | string> {
  const { backend, store } = turn.ctx;
  const q = normName(question);
  const samples = await backend.listSamples(turn.ctx.signal).catch(() => []);
  let best: { id: string; len: number; community?: string } | null = null;
  const consider = (id: string, key: string, community?: string) => {
    const k = normName(key);
    if (k.length >= 2 && q.includes(k) && (!best || k.length > best.len)) {
      best = { id, len: k.length, ...(community ? { community } : {}) };
    }
  };
  for (const s of samples) {
    consider(s.id, s.name);
    consider(s.id, s.name.replace(/片区$|周边$/, ''));
    for (const part of (s.center_label ?? '').split(/[×xX、和与/]/)) consider(s.id, part.trim());
    // through the store: a sample is fetched once, not once per question
    const r = await resolveAnalysis(turn.ctx, s.id).catch(() => undefined);
    for (const c of r?.result.communities ?? []) consider(s.id, c.name, c.name);
  }
  for (const s of store.list()) {
    if (s.source !== 'live') continue;
    consider(s.id, s.result.meta.name);
    for (const c of s.result.communities) consider(s.id, c.name, c.name);
  }
  const hit = best as { id: string; len: number; community?: string } | null;
  if (hit) return { id: hit.id, note: '', ...(hit.community ? { community: hit.community } : {}) };
  if (given) {
    // a place the question names that is neither the analysis on screen nor one of its communities:
    // say so instead of silently answering about the screen
    if (intent.placeText) {
      const r = await resolveAnalysis(turn.ctx, given).catch(() => undefined);
      const name = r?.result.meta.name ?? given;
      return {
        id: given,
        note: `“${intent.placeText}”不在当前分析里，以下按正在查看的“${name}”回答；要体检新的地点，请先用搜索框定位。`,
      };
    }
    return { id: given, note: '' };
  }

  if (intent.placeText && backend.locate) {
    const loc = await turn.run<LocateResult>('locate_place', { query: intent.placeText });
    const data = loc.result.data;
    if (!data.candidates.length || data.needs_confirmation || !data.best) {
      return citeSentences(loc.result.summary, loc.id).join('');
    }
    if (data.best.sample_id) return { id: data.best.sample_id, note: '' };
    if (!backend.analyze) {
      return `${citeSentences(loc.result.summary, loc.id).join('')}当前的数据源只有内置样例，不能分析新地点。${await availableText(turn.ctx)}`;
    }
    const a = await turn.run<{ analysis_id: string }>('analyze_life_circle', {
      center_bd09: data.best.center_bd09,
      label: data.best.name,
      profile: intent.profile,
    });
    return { id: a.result.data.analysis_id, note: '' };
  }
  const first = samples[0];
  if (first) return { id: first.id, note: `没有指明社区，以下按样例“${first.name}”（${first.id}）回答。` };
  return `当前没有可用的分析数据。${await availableText(turn.ctx)}`;
}

/** The analysis id for the requested profile (runs analyze_life_circle, which the answer cites). */
async function profiled(
  turn: Turn,
  id: string,
  intent: Intent,
): Promise<{ id: string; cite?: { id: string; summary: string } }> {
  if (intent.profile !== 'elder' || id.endsWith('~elder')) return { id };
  const a = await turn.run<{ analysis_id: string }>('analyze_life_circle', {
    analysis_id: id,
    profile: 'elder',
  });
  return { id: a.result.data.analysis_id, cite: { id: a.id, summary: a.result.summary } };
}

function gapsAnswer(
  data: GapsData,
  cite: string,
  category: HardCategory | undefined,
): { lead: string; bullets: string[] } {
  const n = data.counts;
  const bullets: string[] = [];
  const m1 = (v: number) => fmtNumber(v, 1, true);
  /** "直线 818.5 m，实际步行 1,676 m，约 23.9 分钟", or the lower-bound wording when nothing was routed. */
  const walk = (g: GapsData['gaps'][number]) =>
    g.walk_min === null
      ? `直线 ${m1(g.straight_m)} m，判定距离内没有这类设施`
      : `直线 ${m1(g.straight_m)} m，实际步行 ${m1(g.route_m)} m，约 ${m1(g.walk_min)} 分钟`;
  const community = data.filter.community;
  let lead: string;
  if (community) {
    const cats = category ? [category] : data.checked_categories;
    const parts = cats.map((cat) => {
      const gap = data.gaps.find((g) => g.category === cat);
      if (gap)
        return `${cat}步行 ${fmtNumber(gap.rule_m)} m 内走不到（${gap.status}）：${gap.via ? `${cat === '小学' ? '对口学校是' : '最近能走到的是'}${gap.via}，` : ''}${walk(gap)}`;
      const ok = data.covered.find((c) => c.category === cat);
      if (ok)
        return `${cat}能走到：${ok.via ?? '最近的设施'}，步行 ${m1(ok.route_m)} m，约 ${m1(ok.walk_min)} 分钟`;
      return data.pending.some((p) => p.category === cat) ? `${cat}待核实` : `${cat}没有检查结果`;
    });
    const verdict = n.gaps
      ? '不太方便'
      : data.pending.length
        ? data.covered.length
          ? '已核实的部分方便'
          : '尚待核实'
        : '方便';
    lead = `${verdict}：${community}${parts.length > 1 ? '——' : '的'}${parts.join('；')} [${cite}]。`;
  } else if (category) {
    const rule = fmtNumber(data.rule_m[category]);
    lead = n.gaps
      ? `不太方便：${data.name} ${n.checks} 个小区中，有 ${n.gaps} 个步行 ${rule} m 内走不到${category}（伪覆盖 ${n.pseudo}、盲区 ${n.blind}）[${cite}]。`
      : n.pending === n.checks
        ? `${data.name}的${category}尚待核实，暂不能判断步行是否方便 [${cite}]。`
        : `比较方便：${data.name} 已核实的检查里，没有步行 ${rule} m 内走不到${category}的小区 [${cite}]。`;
  } else {
    lead = n.gaps
      ? `${data.name} 按实测步行距离有 ${n.gaps} 个已核实的服务缺口（伪覆盖 ${n.pseudo}、盲区 ${n.blind}），涉及 ${data.communities_with_gaps.length} 个小区 [${cite}]。`
      : `${data.name} 在已核实的检查里没有服务缺口 [${cite}]。`;
  }
  const w = category ? data.within_15min[category] : undefined;
  if (data.profile === 'elder' && w) {
    bullets.push(
      `按老年人步速 ${fmtNumber(data.speed_mps, 2, true)} m/s，15 分钟最多走 ${fmtNumber(w.limit_m)} m，整个片区 ${w.total} 个小区里有 ${w.within} 个能在 15 分钟内走到${category}${w.undetermined ? `（另有 ${w.undetermined} 个待核实）` : ''} [${cite}]。`,
    );
  }
  if (!community) {
    for (const g of data.gaps.slice(0, 3)) {
      bullets.push(
        `${g.community}：到${g.category}${walk(g)}（${g.status}${g.borderline ? '，临界' : ''}）[${cite}]。`,
      );
    }
  }
  if (data.pending.length) {
    bullets.push(
      `待核实、不计入缺口：${data.pending.map((p) => `${p.community}的${p.category}（${p.reason}）`).join('、')} [${cite}]。`,
    );
  }
  return { lead, bullets };
}

/**
 * "圈里有几家药店", "附近有什么设施": the 圈内设施统计 of analyze_life_circle, per named category
 * (walkable vs inside the straight circle vs listed, and the nearest one), or the whole list.
 */
function facilitiesAnswer(
  o: Overview,
  summary: string,
  cite: string,
  categories: readonly FacilityCategory[],
): { lead: string; bullets: string[] } {
  const f = o.facilities;
  const who = o.profile === 'elder' ? `按老年人步速 ${fmtNumber(o.speed_mps, 2, true)} m/s，` : '';
  if (!f?.rows.length) {
    return { lead: `${o.name}的分析结果里没有设施清单，统计不了圈内设施 [${cite}]。`, bullets: [] };
  }
  const sentences = citeSentences(stripHeader(summary), cite);
  const pick = (re: RegExp) => sentences.filter((x) => re.test(x));
  const bullets: string[] = [];
  if (!categories.length) {
    const [lead = ''] = pick(/^圈内设施/);
    bullets.push(...pick(/^15 分钟内一处也走不到|^最近一处的步行时间|^灰色区域/));
    const cut = f.rows.filter((r) => r.complete === false);
    if (cut.length) bullets.push(...cut.map((r) => cutNote(r, cite)));
    return { lead: `${who}${o.name}的${lead}`, bullets };
  }
  const at = (r: FacilityRow, n: number) => `${r.complete === false ? '至少 ' : ''}${n} ${r.unit}`;
  const parts = categories.map((cat) => {
    const r = f.rows.find((x) => x.category === cat);
    if (!r) return `设施清单里没有${cat}`;
    const near =
      r.nearest && r.nearest_min !== null
        ? `，最近的是${r.nearest}，步行约 ${fmtNumber(r.nearest_min, 1)} 分钟`
        : '';
    if (r.complete === false) bullets.push(cutNote(r, cite));
    return r.walk > 0
      ? `15 分钟步行能走到${cat} ${at(r, r.walk)}（直线 15 分钟圆内 ${at(r, r.circle)}，清单共 ${at(r, r.found)}）${near}`
      : `15 分钟内走不到${cat}：直线 15 分钟圆内有 ${at(r, r.circle)}，清单共 ${at(r, r.found)}${near}`;
  });
  bullets.push(
    `直线 15 分钟圆（半径 ${fmtNumber(f.circle_r_m)} m）里的设施，步行 15 分钟不一定走得到：河道、高架和封闭小区会让路绕远 [${cite}]。`,
  );
  return { lead: `${who}${o.name}：${parts.join('；')} [${cite}]。`, bullets };
}

const cutNote = (r: FacilityRow, cite: string) =>
  `${r.category}的清单只统计到离中心 ${fmtNumber(r.known_radius_m ?? 0)} m（检索页数用完），实际可能更多 [${cite}]。`;

/**
 * What a question is read against: the names it may use for the analysis (its name, centre label and
 * communities) and the categories the analysis checked per community.
 */
async function topicOf(turn: Turn, id: string): Promise<{ names: string[]; checked: HardCategory[] }> {
  const r = await resolveAnalysis(turn.ctx, id).catch(() => undefined);
  if (!r) return { names: [], checked: [...TASK_CATEGORIES] };
  const m = r.result.meta;
  return {
    names: [
      m.name,
      m.name.replace(/片区$|周边$/, ''),
      ...(m.center_label ?? '').split(/[×xX、和与/（）()]/).map((p) => p.trim()),
      ...r.result.communities.map((c) => c.name),
    ].filter((n) => n.length >= 2),
    checked: checkedCategories(r.result),
  };
}

/** "申城佳苑片区没有逐小区检查幼儿园：这份分析只逐小区检查了小学、菜市场、药店" — no gaps, no "none". */
const uncheckedText = (name: string, unchecked: readonly HardCategory[], checked: readonly HardCategory[]) =>
  `${name}没有逐小区检查${joinZh(unchecked)}：这份分析只逐小区检查了${checked.join('、')}`;

/** Where a per-community check of those categories comes from. */
const recheckText = (unchecked: readonly HardCategory[]) =>
  `新的体检会逐小区检查${HARD_CATEGORIES.join('、')}；要看${joinZh(unchecked)}，可以重新体检这个地点。`;

async function templateAnswer(turn: Turn, question: string, opts: AskOptions): Promise<string> {
  const first = parseIntent(question);
  const target = await pickTarget(turn, question, first, opts.analysisId);
  if (typeof target === 'string') return target;
  turn.analysisId ??= target.id;
  // the topic, read again without the analysis' own names ("万科翡翠公园" is not about parks) and
  // against the categories it checked per community
  const topic = await topicOf(turn, target.id);
  const { checked } = topic;
  const second = parseIntent(question, topic.names, checked);
  const intent: Intent = { ...second, profile: first.profile, profileCompare: first.profileCompare };
  if (first.placeText) intent.placeText = first.placeText;
  else delete intent.placeText;
  // categories the question names that this analysis never checked per community
  const unchecked = intent.categories.filter((c) => !checked.includes(c));
  const lines: string[] = [];
  let lead: string;
  const bullets: string[] = [];

  switch (intent.kind) {
    case 'compare': {
      const ids = new Set<string>();
      const samples = await turn.ctx.backend.listSamples(turn.ctx.signal).catch(() => []);
      const q = normName(question);
      for (const s of samples) if (q.includes(normName(s.name.replace(/片区$/, '')))) ids.add(s.id);
      for (const s of turn.ctx.store.list())
        if (s.source === 'live' && q.includes(normName(s.result.meta.name))) ids.add(s.id);
      ids.add(target.id);
      if (ids.size < 2 && (intent.profile === 'elder' || intent.profileCompare))
        ids.add(`${target.id.replace(/~elder$/, '')}~elder`);
      if (ids.size < 2) {
        return `对比至少需要两个分析。${await availableText(turn.ctx)}可以问“对比申城佳苑的成人和老人”，或先体检另一个社区。`;
      }
      const r = await turn.run<{ rows: CompareRow[] }>('compare_sites', {
        analysis_ids: [...ids].slice(0, 4),
      });
      const rows = r.result.data.rows;
      const adult = rows.find((x) => x.profile === 'adult');
      const elder = rows.find((x) => x.profile === 'elder');
      const km2 = (v: number) => `${fmtNumber(v, 3)} km²`;
      if (rows.length === 2 && adult && elder && adult.name === elder.name) {
        lead = `按老年人步速，${adult.name} 15 分钟步行可达 ${km2(elder.area_iso15_km2)}，成人是 ${km2(adult.area_iso15_km2)}；缺口按步行距离判定，两种画像的已核实缺口都是 ${elder.walking_gaps} 个 [${r.id}]。`;
        bullets.push(...citeSentences(r.result.summary, r.id));
      } else {
        const s = citeSentences(r.result.summary, r.id);
        lead = s[s.length - 1] ?? '';
        bullets.push(...s.slice(0, -1));
      }
      break;
    }
    case 'report': {
      const p = await profiled(turn, target.id, intent);
      const r = await turn.run<ReportData>('export_report', { analysis_id: p.id, format: intent.format });
      const s = citeSentences(r.result.summary, r.id);
      lead = s[0] ?? '';
      bullets.push(...s.slice(1), `报告全文见附件 ${r.result.data.filename}（与工具结果 ${r.id} 相同）。`);
      break;
    }
    case 'simulate': {
      const category = intent.categories[0]!;
      const { result } = await resolveAnalysis(turn.ctx, target.id);
      if (unchecked.includes(category)) {
        // no per-community check of the category: nothing is known that a new one could fix
        lead = `没法估算新增${category}的效果——${uncheckedText(result.meta.name, [category], checked)}，不知道哪些小区现在走不到${category}。`;
        bullets.push(recheckText([category]));
        break;
      }
      if (!intent.siteText) {
        return `要模拟新增${category}，请说明位置：小区名（如${result.communities[0]?.name ?? '某小区'}旁）、路名或路口，或给出 BD-09 坐标。`;
      }
      const site = resolveSite(result, intent.siteText);
      if (!site) {
        return `没能在“${result.meta.name}”的分析范围里找到“${intent.siteText}”。可以换成小区名（如${result.communities
          .slice(0, 3)
          .map((c) => c.name)
          .join(
            '、',
          )}）、分析中心路口（${result.meta.center_label ?? result.meta.name}），或直接给出 BD-09 坐标。`;
      }
      const r = await turn.run<SimulateData>('simulate_facility', {
        analysis_id: target.id,
        category,
        label: intent.siteText,
        ...(site.near_community
          ? { near_community: site.near_community }
          : { center_bd09: site.center_bd09 }),
      });
      const s = citeSentences(r.result.summary, r.id);
      lead = s[0] ?? '';
      bullets.push(
        ...s.slice(1),
        `位置理解：“${intent.siteText}”${site.how}；如果指的是别处，请告诉我小区名或坐标。`,
      );
      break;
    }
    case 'isochrone': {
      const p = await profiled(turn, target.id, intent);
      const r = await turn.run('get_isochrone', { analysis_id: p.id });
      const s = citeSentences(r.result.summary, r.id);
      lead = s[0] ?? '';
      bullets.push(...s.slice(1), `GeoJSON 在工具结果 ${r.id} 的 data 中，可粘贴到 geojson.io 查看。`);
      break;
    }
    case 'facilities': {
      const r = await turn.run<Overview>('analyze_life_circle', {
        analysis_id: target.id,
        ...elderArg(intent),
      });
      const f = facilitiesAnswer(r.result.data, r.result.summary, r.id, intent.facilityCategories);
      lead = f.lead;
      bullets.push(...f.bullets);
      if (unchecked.length) {
        bullets.push(
          `${uncheckedText(r.result.data.name, unchecked, checked)}，以上是从分析中心出发的圈内设施统计，不是逐小区的判定。`,
        );
      }
      break;
    }
    case 'reach': {
      const r = await turn.run('analyze_life_circle', { analysis_id: target.id, ...elderArg(intent) });
      const s = citeSentences(stripHeader(r.result.summary), r.id);
      const reach = s.filter((x) => /15 分钟步行实际可达|有效步行半径|老年人步速/.test(x));
      lead = reach[0] ?? s[0] ?? '';
      bullets.push(...reach.slice(1), ...s.filter((x) => x.startsWith('画圆法')));
      break;
    }
    case 'gaps': {
      const asked = intent.categories.filter((c) => checked.includes(c));
      if (unchecked.length && !asked.length) {
        // nothing checked per community to list: say so (never "no gaps"), then what the
        // 圈内设施统计 knows from the analysis centre
        const r = await turn.run<Overview>('analyze_life_circle', {
          analysis_id: target.id,
          ...elderArg(intent),
        });
        const o = r.result.data;
        lead = `${uncheckedText(o.name, unchecked, o.checked_categories)}，说不出哪些小区步行 ${o.rule_text} 内走不到${joinZh(unchecked, '或')} [${r.id}]。`;
        const f = facilitiesAnswer(o, r.result.summary, r.id, unchecked);
        bullets.push(`圈内设施统计（从分析中心出发）——${f.lead}`, ...f.bullets, recheckText(unchecked));
        break;
      }
      const p = await profiled(turn, target.id, intent);
      const category = asked.length === 1 ? asked[0] : undefined;
      const community = target.community ?? (await communityIn(turn, p.id, question));
      const r = await turn.run<GapsData>('list_service_gaps', {
        analysis_id: p.id,
        ...(category ? { category } : {}),
        ...(community ? { community } : {}),
      });
      const g = gapsAnswer(r.result.data, r.id, category);
      lead = g.lead;
      bullets.push(...g.bullets);
      if (unchecked.length) {
        bullets.push(
          `${uncheckedText(r.result.data.name, unchecked, checked)}，以上不含${joinZh(unchecked)}。`,
        );
      }
      if (p.cite) {
        const reach = citeSentences(p.cite.summary, p.cite.id).find((x) => x.includes('15 分钟步行实际可达'));
        if (reach) bullets.push(`整个片区（老年人步速）：${reach}`);
      }
      break;
    }
    default: {
      const r = await turn.run('analyze_life_circle', { analysis_id: target.id, ...elderArg(intent) });
      const s = citeSentences(stripHeader(r.result.summary), r.id);
      lead = s[0] ?? '';
      bullets.push(...s.slice(1));
    }
  }
  if (target.note) lines.push(target.note);
  lines.push(lead.startsWith('估算') ? lead : `结论：${lead}`);
  if (bullets.length) lines.push('', ...bullets.map((b) => `- ${b}`));
  return lines.join('\n');
}

/** Switch to the elderly profile only when asked; otherwise keep the analysis' own profile. */
const elderArg = (intent: Intent) => (intent.profile === 'elder' ? { profile: 'elder' as const } : {});

async function communityIn(turn: Turn, id: string, question: string): Promise<string | undefined> {
  const stored = turn.ctx.store.get(id);
  if (!stored) return undefined;
  // "万科翡翠公园片区" names the area, not its community "万科翡翠公园"
  let q = normName(question);
  for (const n of [stored.result.meta.name, stored.result.meta.center_label ?? '']) {
    const k = normName(n);
    if (k.length >= 2) q = q.split(k).join('|');
  }
  const c = stored.result.communities
    .filter((x) => q.includes(normName(x.name)))
    .sort((a, b) => b.name.length - a.name.length)[0];
  return c ? findCommunity(stored.result, c.name)?.name : undefined;
}

// ------------------------------------------------------------------------------------- LLM

/**
 * System prompt of the model mode. Every rule answers a failure seen with real models (see
 * test/fixtures/llm-eval and README「真实模型评测」): rounding (23.9 → 24 分钟), counting a list
 * itself ("4 个样例"), reusing numbers and [T#] of an earlier turn, invented ratings, answering about
 * the analysis on screen when the user named another place, and long answers without a lead.
 */
export function systemPrompt(available: string, current?: string): string {
  return [
    '你是「邻至」15 分钟生活圈体检顾问，服务街道和社区的规划工作者。你只根据本轮工具返回的结果回答，这些结果来自百度地图的实测步行路线。',
    '',
    '## 数字规则（系统会逐个核对回答里的数字，不合规的回答会被退回）',
    '1. 回答里的每个阿拉伯数字都必须原样出现在本轮的工具结果里：照抄数值和单位，不要四舍五入或换单位（23.9 分钟不能写成 24 分钟，1,676 m 不能写成 1.7 公里）；不要自己加减乘除、求差值或比例；也不要自己数个数（比如列表里有几个样例、几个小区）。',
    '2. 问“差多少、少了多少、占几成”时，并列写出工具里的两个原值；工具已经算好的倍数、比例、超出距离（如 overstate_x、reach_share_pct、excess_m）可以直接引用。',
    '3. 每一句含数字的话（以“。”结尾的一句，或列表的一行）末尾都要标注数字来自哪个工具结果，如“……1.857 km² [T1]。”，编号见工具结果的 "id"；第一行的结论也一样。',
    '4. 历史对话里的数字和 [T#] 编号只属于那一轮：本轮要用，就重新调用工具，本轮的编号从 T1 重新开始。',
    '5. 体检评分只引用 analyze_life_circle 的 score：walk 是实测评分、circle 是按直线距离算的评分、grade 是等级（≥90 良好、≥75 基本达标、≥60 需关注、其余待改善），coverage 是各类设施的覆盖率（走得到的小区 ÷ 已核实的小区）；评分＝各类覆盖率的平均。工具没有的数据（排名、房价、人口等）不要编造，也不要自己给出别的评级：直说现有工具没有这项数据，再给出相关的实测指标。',
    '',
    '## 口径',
    '6. verified=false 的检查是“待核实”，不是缺口：不能算进伪覆盖或盲区，也不能说成走不到。小学一项标为“不适用”的是商办产权的小区（没有对口小学），既不是缺口，也不是待核实。',
    '7. simulate_facility 的结果都是估算（L̂）：回答以“估算（未经实测核验）：”开头，并提醒落地前需要实测核验。',
    '8. 术语：伪覆盖＝直线距离在判定距离内、实际步行超出；盲区＝直线距离就已超出；临界＝步行距离与判定距离相差不超过 50 m。界面上把伪覆盖叫“绕路太远”、盲区叫“直线也远”：回答里用这两个说法，第一次出现时括号注明（伪覆盖）（盲区）。',
    '9. 问到老人时用老年人画像：在 analysis_id 后加 ~elder（如 zj-a~elder），所有工具都可以直接使用它。',
    `10. 体检的范围：list_service_gaps 逐个小区核对各类设施能否在判定距离内步行走到，核对了哪些见工具结果的 checked_categories——${CHECKED_SCOPE}；分析没有核对的类别不能说成“没有缺口”，要说明这份分析没有逐小区检查它。圈内设施统计（analyze_life_circle 的 facilities）按从分析中心出发的步行时间统计清单里的设施，除了逐小区检查的类别，还统计${COUNTED_ONLY.join('、')}。“看病”看社区卫生和药店，没有医院的数据。`,
    '10a. 菜市场缺口可能带 alt（买菜替代：判定距离内步行能到的能买菜的店及步行距离）：它不算覆盖，缺口仍是缺口，任何计数都不变；只能写成“可在××买菜（步行 ×× m）”，alt 为 null 就说判定距离内步行也没有能买菜的店。',
    '',
    '## 调用工具',
    '11. 已知 analysis_id 就直接调用需要的工具，不必先调用 analyze_life_circle；需要几个工具就在同一轮一起调用。',
    '12. 问某个小区：list_service_gaps 传 community；问“圈里有几家、最近的走多久”：analyze_life_circle 的 facilities；问新增设施：simulate_facility；问对比：compare_sites。',
    '13. 用户说的地点不是可用的分析、也不是其中的小区时，先用 locate_place 查找；找不到就如实说明：这个地点不在已有的体检分析里，问询不会发起新的体检，请先用地图左上角的搜索框体检该地点，再来提问。不要拿其他分析的结果冒充那个地点。',
    '',
    '## 回答格式',
    '14. 第一行以“结论：”开头，一句话直接回答问题（新增设施的估算以“估算（未经实测核验）：”开头）。',
    '15. 然后最多 5 条以“- ”开头的要点，每条一句话。不用标题、加粗和表格，不复述坐标或 JSON，结尾不加客套话或提议；全文尽量不超过 250 字。',
    '16. 不写英文字段名（detour_x、route_m、overstate_x 之类）：用中文说出含义，数字照抄，如“绕路 2.05 倍”“步行 1,676 m”。',
    '',
    `可用的数据：${available}`,
    current ? `用户当前查看的分析：analysis_id = ${current}（问题没有指明其他地点时，就回答这个分析）。` : '',
  ]
    .filter((l, i, a) => l || a[i - 1])
    .join('\n');
}

/**
 * What the model is told when its draft fails the number check: per number, what is wrong and what
 * to do. An unsupported number that is a rounding of a tool value gets that value to copy (the
 * checker's `near`); any other one is to be deleted. An uncited number gets the ids that contain it.
 */
export function repairPrompt(
  g: Pick<GroundingReport, 'unsupported' | 'uncited'> & { details?: readonly TokenCheck[] },
): string {
  const lines = ['【数字核验未通过】'];
  if (g.unsupported.length) {
    lines.push('这些数字在本轮工具结果里找不到原值（四舍五入、换算、自己计算或数出来的，或来自历史对话）：');
    for (const u of g.unsupported) {
      const near = g.details?.find((d) => d.token === u && !d.supported)?.near;
      lines.push(
        near?.length
          ? `- ${u}：工具结果里的原值是 ${near.join(' 或 ')}，请照抄原值`
          : `- ${u}：工具结果里没有这个数，请删掉它（或换成工具结果里的原值）`,
      );
    }
  }
  if (g.uncited.length) {
    lines.push('这些数字所在的句子没有标注来源：');
    for (const u of g.uncited) {
      const ids = g.details?.find((d) => d.token === u && d.cited === false)?.sources ?? [];
      lines.push(
        ids.length
          ? `- ${u}：它出现在 ${ids.join('、')}，请在这一句末尾加上 [${ids[0]}]`
          : `- ${u}：请在这一句末尾加上包含它的工具结果编号`,
      );
    }
  }
  lines.push(
    '请输出改写后的完整回答：保持“结论：”开头和原来的结构，只改上面列出的问题，不要新增数字，只输出回答本身。',
  );
  return lines.join('\n');
}

function toolMessage(id: string, tool: string, r: ToolResult, view: unknown): string {
  return JSON.stringify({ id, tool, summary: r.summary, facts: r.facts, data: view });
}

// --------------------------------------------------------------------------------- advisor

export function createAdvisor(opts: AdvisorOptions): Advisor {
  const store = opts.store ?? new AnalysisStore();
  const registry = opts.registry ?? createToolRegistry();
  const client = opts.llm ? new ChatClient(opts.llm) : null;
  const maxSteps = Math.max(1, opts.maxSteps ?? 6);

  async function template(turn: Turn, question: string, ask: AskOptions, footer: string): Promise<string> {
    try {
      const text = await templateAnswer(turn, question, ask);
      return `${text}\n\n${footer}`;
    } catch (err) {
      return `抱歉，这个问题没能用现有工具回答：${err instanceof Error ? err.message : String(err)}`;
    }
  }

  async function ask(question: string, ask: AskOptions = {}): Promise<AdvisorAnswer> {
    const emit = (e: AdvisorEvent) => ask.onEvent?.(e);
    const ctx: ToolContext = {
      backend: opts.backend,
      store,
      ...(ask.signal ? { signal: ask.signal } : {}),
      onProgress: (e) => {
        if (e.type === 'stage') emit({ type: 'progress', message: e.message, progress: e.progress });
      },
    };
    const history = ask.history ?? [];
    const userWords = history.filter((h) => h.role === 'user').map((h) => h.content);
    const finish = (a: AdvisorAnswer): AdvisorAnswer => {
      emit({ type: 'answer', answer: a });
      return a;
    };

    const templateTurn = async (reason?: { reason: string; unsupported: string[]; llmAnswer?: string }) => {
      if (reason) emit({ type: 'fallback', reason: reason.reason });
      const turn = new Turn(registry, ctx, emit);
      // only a grounding failure lists unsupported numbers; a failed or empty call is not the model's numbers
      const footer = !reason
        ? FOOTER_TEMPLATE
        : reason.unsupported.length
          ? FOOTER_FALLBACK
          : FOOTER_LLM_DOWN;
      const text = await template(turn, question, ask, footer);
      const answer: AdvisorAnswer = {
        answer: text,
        mode: 'template',
        citations: turn.citations,
        grounding: checkGrounding(text, turn.groundingSources(question, userWords)),
      };
      const analysisId = turn.analysisId ?? ask.analysisId;
      if (analysisId) answer.analysisId = analysisId;
      if (turn.attachments.length) answer.attachments = turn.attachments;
      if (reason) answer.fallback = reason;
      if (client) answer.llm = describeLlm(client.config);
      return finish(answer);
    };

    if (!client) return templateTurn();

    const turn = new Turn(registry, ctx, emit);
    const available = await availableText(ctx);
    const system = systemPrompt(available, ask.analysisId);
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      // earlier answers keep their [T#]: stripped, the model copied the uncited style into its
      // own conclusion; a stale id is caught by the citation check like any wrong one
      ...history.map((h) => ({ role: h.role, content: h.content }) as ChatMessage),
      { role: 'user', content: question },
    ];
    const tools = registry.openAITools();
    // the system prompt is not a source: numbers must come from tools, the question or the constants
    const sources = () => turn.groundingSources(question, userWords);
    let steps = 0;
    let final = '';
    let finalReasoning: string | null = null;
    const withReasoning = (reasoning: string | null) => (reasoning ? { reasoning_content: reasoning } : {});
    try {
      for (let step = 0; step < maxSteps; step++) {
        const last = step === maxSteps - 1;
        const res = await client.chat({
          messages,
          tools,
          toolChoice: last ? 'none' : 'auto',
          ...(ask.signal ? { signal: ask.signal } : {}),
        });
        steps++;
        if (res.toolCalls.length && !last) {
          messages.push({
            role: 'assistant',
            content: res.content ?? '',
            tool_calls: res.toolCalls,
            ...withReasoning(res.reasoning),
          });
          for (const call of res.toolCalls) {
            let args: unknown;
            try {
              args = JSON.parse(call.function.arguments || '{}');
            } catch {
              messages.push({
                role: 'tool',
                tool_call_id: call.id,
                content: JSON.stringify({ error: '参数不是合法的 JSON' }),
              });
              continue;
            }
            try {
              const { id, result, view } = await turn.run(call.function.name, args);
              messages.push({
                role: 'tool',
                tool_call_id: call.id,
                content: toolMessage(id, call.function.name, result, view),
              });
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              messages.push({
                role: 'tool',
                tool_call_id: call.id,
                content: JSON.stringify({ error: message }),
              });
            }
          }
          continue;
        }
        final = (res.content ?? '').trim();
        finalReasoning = res.reasoning;
        break;
      }
    } catch (err) {
      if (ask.signal?.aborted) throw err;
      const why =
        err instanceof LlmError
          ? err.message
          : `大模型调用失败：${err instanceof Error ? err.message : String(err)}`;
      return templateTurn({ reason: why, unsupported: [] });
    }
    if (!final) return templateTurn({ reason: '大模型没有给出回答', unsupported: [] });

    let first = checkGrounding(final, sources());
    // numbers all real, only their source ids missing or wrong: append the ids, no rewrite round
    let citationsAdded: string[] = [];
    if (first.uncited.length) {
      const c = completeCitations(final, sources());
      const g = c.added.length ? checkGrounding(c.text, sources()) : first;
      if (g.uncited.length < first.uncited.length && g.unsupported.length === first.unsupported.length) {
        final = c.text;
        first = g;
        citationsAdded = c.added;
      }
    }
    const done = (text: string, g: GroundingReport, repaired: boolean): AdvisorAnswer => {
      const answer: AdvisorAnswer = {
        answer: text,
        mode: 'llm',
        citations: turn.citations,
        grounding: g,
        llm: describeLlm(client.config),
        steps,
      };
      if (repaired) answer.repaired = true;
      if (citationsAdded.length && text === final) answer.citationsAdded = citationsAdded;
      const analysisId = turn.analysisId ?? ask.analysisId;
      if (analysisId) answer.analysisId = analysisId;
      if (turn.attachments.length) answer.attachments = turn.attachments;
      return finish(answer);
    };
    if (first.ok && !first.uncited.length) return done(final, first, false);

    emit({ type: 'repair', unsupported: first.unsupported, uncited: first.uncited });
    messages.push(
      { role: 'assistant', content: final, ...withReasoning(finalReasoning) },
      { role: 'user', content: repairPrompt(first) },
    );
    let second: { text: string; g: GroundingReport } | null = null;
    try {
      const res = await client.chat({
        messages,
        tools,
        toolChoice: 'none',
        ...(ask.signal ? { signal: ask.signal } : {}),
      });
      steps++;
      const text = (res.content ?? '').trim();
      if (text) second = { text, g: checkGrounding(text, sources()) };
    } catch (err) {
      if (ask.signal?.aborted) throw err;
    }
    // the rewrite wins when its numbers are all real and its citations are no worse than the draft's
    if (second?.g.ok && (!first.ok || second.g.uncited.length <= first.uncited.length)) {
      return done(second.text, second.g, true);
    }
    // citations imperfect but every number real: keep the model's own answer
    if (first.ok) return done(final, first, false);
    const bad = second?.g.unsupported.length ? second.g.unsupported : first.unsupported;
    return templateTurn({
      reason: `大模型回答中的数字（${bad.join('、')}）在工具结果中找不到，修正一次后仍未通过核验，已改用模板回答`,
      unsupported: bad,
      llmAnswer: second?.text ?? final,
    });
  }

  return { mode: client ? 'llm' : 'template', store, registry, ask };
}
