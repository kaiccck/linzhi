/**
 * The 体检顾问 inside the server (POST /api/ask): the agent package's advisor over an in-process
 * backend. Samples come from the SampleStore and live results from the LRU the analyze route fills;
 * this backend never calls Baidu and never starts a live analysis (quota is a design constraint:
 * the advisor answers about the analysis on screen, new places go through the search box).
 */
import { randomBytes } from 'node:crypto';
import {
  AnalysisStore,
  BackendError,
  createAdvisor,
  findCommunity,
  normName,
  toBd09,
  type AdvisorAnswer,
  type AdvisorEvent,
  type LlmConfig,
  type LocateResult,
  type PlaceCandidate,
  type SampleSummary,
  type ToolRegistry,
  type ZddBackend,
} from '@zoudedao/agent';
import type { AnalysisResult } from '@zoudedao/core';
import { untilAborted } from './abort.js';
import type { HistoryStore } from './history.js';
import type { SampleStore } from './samples.js';

/** Live results kept for the advisor; older ones must be analysed again. */
export const LIVE_RESULTS_MAX = 20;

/** A result as POST /api/analyze sends it: meta.analysis_id is the id the advisor knows it by. */
export type StoredResult = AnalysisResult & { meta: AnalysisResult['meta'] & { analysis_id: string } };

/** Enough of an analysis for the advisor's tools; anything less is streamed but not kept. */
function isStorable(result: AnalysisResult): boolean {
  const r = result as Partial<AnalysisResult> | null;
  return (
    !!r?.meta &&
    Array.isArray(r.meta.center_bd09) &&
    Array.isArray(r.communities) &&
    !!r.stats &&
    !!r.field &&
    !!r.contours
  );
}

/** Ids of live results: AnalysisStore.liveId (or a random fallback), `live-<8 hex>`. */
export const LIVE_ID = /^live-[0-9a-f]{8}$/;

export interface LiveResultsOptions {
  /**
   * The persistent history (history.ts): results are looked up there after they leave memory or after
   * a restart, and — with `persist` — every stored result is written there too.
   */
  history?: HistoryStore;
  /** Write results to `history` (off for the replay analyzer, whose results are the zj-a sample). */
  persist?: boolean;
  /** A result could not be written to the history (the analysis itself still succeeds). */
  warn?: (message: string, err: unknown) => void;
}

/**
 * The last results of POST /api/analyze by id (`live-<8 hex>`, AnalysisStore.liveId: same centre,
 * profile and generation time → same id), least recently used evicted first, in front of the
 * persistent history: with one, ids resolve for 30 days and across restarts; without, a restart
 * forgets them and the advisor asks the user to run the check again.
 */
export class LiveResults {
  readonly max: number;
  readonly #entries = new Map<string, StoredResult>();
  readonly #history: HistoryStore | undefined;
  readonly #persist: boolean;
  readonly #warn: LiveResultsOptions['warn'];

  constructor(max = LIVE_RESULTS_MAX, opts: LiveResultsOptions = {}) {
    this.max = max;
    this.#history = opts.history;
    this.#persist = opts.persist ?? true;
    this.#warn = opts.warn;
  }

  /** How live results are kept, for messages after “服务端”: 保存 30 天, or 只保留最近 20 个（重启后清空）. */
  retention(): string {
    return this.#history?.persistent
      ? `保存 ${this.#history.retentionDays} 天`
      : `只保留最近 ${this.max} 个（重启后清空）`;
  }

  /**
   * Keeps the result, writes it to the history, and returns the copy to send, with
   * meta.analysis_id; malformed results pass through. `input` is the POST /api/analyze body.
   */
  put(result: AnalysisResult, input: { label?: string; profile?: string } = {}): AnalysisResult {
    if (!isStorable(result)) return result;
    let id: string;
    try {
      id = AnalysisStore.liveId(result);
    } catch {
      id = `live-${randomBytes(4).toString('hex')}`;
    }
    const stored = { ...result, meta: { ...result.meta, analysis_id: id } } as StoredResult;
    this.#remember(id, stored);
    if (this.#history && this.#persist) {
      try {
        this.#history.saveAnalysis(id, stored, {
          ...(input.label !== undefined ? { label: input.label } : {}),
          ...(input.profile !== undefined ? { profile: input.profile } : {}),
        });
      } catch (err) {
        this.#warn?.('体检结果未能写入历史记录', err);
      }
    }
    return stored;
  }

  #remember(id: string, stored: StoredResult): void {
    this.#entries.delete(id);
    this.#entries.set(id, stored);
    for (const oldest of this.#entries.keys()) {
      if (this.#entries.size <= this.max) break;
      this.#entries.delete(oldest);
    }
  }

  /** In memory, else from the history (kept in memory again). */
  get(id: string): StoredResult | undefined {
    const hit = this.#entries.get(id);
    if (hit) {
      this.#entries.delete(id);
      this.#entries.set(id, hit);
      return hit;
    }
    if (!this.#history || !LIVE_ID.test(id)) return undefined;
    let found: AnalysisResult | undefined;
    try {
      found = this.#history.getAnalysis(id);
    } catch (err) {
      this.#warn?.('历史记录读取失败', err);
      return undefined;
    }
    if (!found || !isStorable(found)) return undefined;
    const stored = { ...found, meta: { ...found.meta, analysis_id: id } } as StoredResult;
    this.#remember(id, stored);
    return stored;
  }

  /** In memory only: the result object without touching the history. */
  peek(id: string): StoredResult | undefined {
    return this.#entries.get(id);
  }

  has(id: string): boolean {
    if (this.#entries.has(id)) return true;
    if (!this.#history || !LIVE_ID.test(id)) return false;
    try {
      return this.#history.hasAnalysis(id);
    } catch {
      return false;
    }
  }

  /** Results in memory. */
  get size(): number {
    return this.#entries.size;
  }
}

export const NO_LIVE_MESSAGE =
  '问询不会发起新的实时体检（每次体检都要消耗百度地图配额）。要体检新地点，请使用地图左上角的搜索框；体检完成后，再在这里提问。';
const LOCATE_NOTE = '问询只在内置样例中查找地点，不调用百度接口；要体检其他地点，请使用地图左上角的搜索框';
const PARSED_MAX = 8;

/**
 * ZddBackend of the server's advisor. Parsed samples are shared between requests (keyed by the
 * sample file's etag): the advisor's tools only read analysis results, never change them.
 */
export class ServerBackend implements ZddBackend {
  readonly kind = 'server';
  readonly #samples: SampleStore;
  readonly #live: LiveResults;
  readonly #parsed = new Map<string, { etag: string; result: AnalysisResult }>();

  constructor(samples: SampleStore, live: LiveResults) {
    this.#samples = samples;
    this.#live = live;
  }

  listSamples(): Promise<SampleSummary[]> {
    return this.#samples.list();
  }

  async getAnalysis(id: string): Promise<AnalysisResult> {
    const live = this.#live.get(id);
    if (live) return live;
    const sample = await this.#samples.get(id);
    if (!sample) throw new BackendError('not_found', `找不到分析 ${id}`, 404);
    const hit = this.#parsed.get(id);
    if (hit?.etag === sample.etag) {
      this.#parsed.delete(id);
      this.#parsed.set(id, hit);
      return hit.result;
    }
    const result = JSON.parse(sample.body.toString('utf8')) as AnalysisResult;
    this.#parsed.delete(id);
    this.#parsed.set(id, { etag: sample.etag, result });
    for (const oldest of this.#parsed.keys()) {
      if (this.#parsed.size <= PARSED_MAX) break;
      this.#parsed.delete(oldest);
    }
    return result;
  }

  /** Is `id` (or `<id>~elder`) something the advisor can answer about? */
  async knows(id: string): Promise<boolean> {
    const base = id.replace(/~elder$/, '');
    return this.#live.has(base) || (await this.#samples.get(base)) !== undefined;
  }

  /**
   * Sample catalogue only (names, centre labels, communities inside the samples), like the agent's
   * LocalBackend: a place outside the samples gets the search-box note instead of a Baidu call.
   */
  async locate(query: string, city?: string): Promise<LocateResult> {
    const needle = normName(query);
    const areas: PlaceCandidate[] = [];
    const inside: PlaceCandidate[] = [];
    for (const s of needle ? await this.#samples.list() : []) {
      const name = normName(s.name);
      const label = normName(s.center_label ?? '');
      const bare = name.replace(/片区$|周边$/, '');
      if (name.includes(needle) || label.includes(needle) || (bare.length >= 2 && needle.includes(bare))) {
        areas.push({
          name: s.name,
          ...(s.center_label ? { address: s.center_label } : {}),
          center_bd09: s.center_bd09,
          source: 'sample',
          confidence: 1,
          reason: '样例社区的名称或中心点标注包含搜索词',
          sample_id: s.id,
        });
        continue;
      }
      const r = await this.getAnalysis(s.id).catch(() => undefined);
      const community = r && findCommunity(r, query);
      if (r && community) {
        inside.push({
          name: community.name,
          address: `样例 ${r.meta.name} 内的小区`,
          center_bd09: toBd09(r, community.centroid),
          source: 'sample',
          confidence: 0.8,
          reason: `属于样例社区“${r.meta.name}”`,
          sample_id: s.id,
        });
      }
    }
    const candidates = [...areas, ...inside];
    return {
      query,
      ...(city ? { city } : {}),
      best: candidates[0] ?? null,
      candidates,
      needs_confirmation: !(areas.length === 1 || (areas.length === 0 && inside.length === 1)),
      warnings: [LOCATE_NOTE],
    };
  }

  /** Never: a live check costs Baidu quota and belongs to the search box. */
  async analyze(): Promise<AnalysisResult> {
    throw new BackendError('live_disabled', NO_LIVE_MESSAGE);
  }
}

/** What /api/health says about the advisor: never the key or the base URL. */
export function advisorInfo(llm: LlmConfig | null | undefined): { mode: 'llm' | 'template'; model?: string } {
  return llm ? { mode: 'llm', model: llm.model } : { mode: 'template' };
}

// The agent's template footer, restated when the template stands in for a model that ran out of time.
const FOOTER_TEMPLATE = '（未配置大模型：以上回答由模板根据工具结果生成，[T#] 是工具结果编号。）';
const FOOTER_SLOW = '（大模型没有按时完成回答：以上改由模板根据工具结果生成，[T#] 是工具结果编号。）';
const LLM_SLOW = new Error('llm budget exhausted');

export interface AnswerOptions {
  backend: ServerBackend;
  live: LiveResults;
  registry: ToolRegistry;
  llm: LlmConfig | null;
  question: string;
  analysisId?: string;
  history: { role: 'user' | 'assistant'; content: string }[];
  signal: AbortSignal;
  /** Time the model may take before the template answers instead. */
  llmBudgetMs: number;
  onEvent(event: AdvisorEvent): void;
}

/**
 * One question. Every request gets its own AnalysisStore, primed with the live results it may
 * name, so one visitor's live checks never show up in another visitor's answers. With a model,
 * the model gets `llmBudgetMs`; when it has not finished by then, the template answers.
 */
export async function answerQuestion(o: AnswerOptions): Promise<AdvisorAnswer> {
  const store = new AnalysisStore();
  const named = [o.analysisId ?? '', o.question, ...o.history.map((h) => h.content)].join('\n');
  for (const [id] of named.matchAll(/live-[0-9a-f]{8}/g)) {
    const result = o.live.get(id);
    if (result && !store.has(id)) store.put(result, { id, source: 'live' });
  }
  const base = { backend: o.backend, store, registry: o.registry };
  const ask = {
    history: o.history,
    ...(o.analysisId ? { analysisId: o.analysisId } : {}),
  };
  if (!o.llm) {
    return createAdvisor({ ...base, llm: null }).ask(o.question, {
      ...ask,
      signal: o.signal,
      onEvent: o.onEvent,
    });
  }

  const budget = new AbortController();
  const timer = setTimeout(() => budget.abort(LLM_SLOW), o.llmBudgetMs);
  timer.unref();
  const signal = AbortSignal.any([o.signal, budget.signal]);
  let relay = true;
  try {
    return await untilAborted(
      createAdvisor({ ...base, llm: o.llm }).ask(o.question, {
        ...ask,
        signal,
        onEvent: (e) => {
          if (relay) o.onEvent(e);
        },
      }),
      signal,
    );
  } catch (err) {
    if (o.signal.aborted || !budget.signal.aborted) throw err;
    relay = false;
    const reason = `大模型在 ${Math.round(o.llmBudgetMs / 1000)} 秒内没有完成回答，已改用模板回答`;
    o.onEvent({ type: 'fallback', reason });
    const a = await createAdvisor({ ...base, llm: null }).ask(o.question, {
      ...ask,
      signal: o.signal,
      onEvent: o.onEvent,
    });
    return {
      ...a,
      answer: a.answer.replace(FOOTER_TEMPLATE, FOOTER_SLOW),
      fallback: { reason, unsupported: [] },
    };
  } finally {
    clearTimeout(timer);
  }
}
