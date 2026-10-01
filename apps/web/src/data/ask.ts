/**
 * 问询 → POST /api/ask (docs/api.md): one question about the analysis on screen, answered as an
 * event stream — which tools ran, then one `answer` with citations, grounding and attachments.
 */
import type { XY } from '@zoudedao/core';
import { ApiError, postEvents } from './api.js';

/**
 * A place a tool result names (docs/api.md `citations[].anchors`), for the map to light when its
 * citation is pointed at. `analysis_id` is the analysis the tool read (zj-a~elder is zj-a's place).
 */
export type AskAnchor =
  | { type: 'community'; analysis_id: string; name: string; code: string | null; xy: XY | null }
  | { type: 'poi'; analysis_id: string; name: string; category: string; xy: XY }
  | { type: 'gray_area'; analysis_id: string; id: string; kind: string; min_missing: number; index: number }
  | { type: 'site'; analysis_id: string; label: string; xy: XY };

export interface AskCitation {
  /** T1, T2 … */
  id: string;
  tool: string;
  /** Chinese tool name, e.g. 服务缺口清单 */
  title: string;
  summary: string;
  /** the places the result names (empty for tools about no place) */
  anchors: AskAnchor[];
}

export interface AskGrounding {
  /** every number in the answer was found in a tool result, the question or a domain constant */
  ok: boolean;
  /** numbers checked */
  checked: number;
  unsupported: string[];
  uncited: string[];
}

export interface AskAttachment {
  filename: string;
  mime_type: string;
  content: string;
}

export interface AskAnswer {
  answer: string;
  mode: 'llm' | 'template';
  /** configured model name (also on template fallbacks) */
  model?: string;
  citations: AskCitation[];
  grounding: AskGrounding;
  /** analysis the answer is about, e.g. zj-a~elder */
  analysis_id?: string;
  attachments?: AskAttachment[];
  /** the model's first draft failed the number check and its rewrite passed */
  repaired?: boolean;
  /** the template answered although a model is configured */
  fallback?: { reason: string; unsupported: string[] };
  /**
   * sources the server added where the model's numbers were all traceable but a citation was missing
   * or wrong, e.g. "1.88 倍 → T1" (no rewrite was asked for)
   */
  citations_added?: string[];
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const xyOf = (v: unknown): XY | null =>
  Array.isArray(v) && typeof v[0] === 'number' && typeof v[1] === 'number' ? [v[0], v[1]] : null;

/** Reads the anchors of a citation; unknown or broken ones are dropped (they are only for display). */
export function parseAnchors(v: unknown): AskAnchor[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((a): AskAnchor[] => {
    if (!a || typeof a !== 'object') return [];
    const o = a as Record<string, unknown>;
    const analysis_id = str(o.analysis_id);
    switch (o.type) {
      case 'community':
        return str(o.name) || str(o.code)
          ? [{ type: 'community', analysis_id, name: str(o.name), code: str(o.code) || null, xy: xyOf(o.xy) }]
          : [];
      case 'poi': {
        const xy = xyOf(o.xy);
        return xy ? [{ type: 'poi', analysis_id, name: str(o.name), category: str(o.category), xy }] : [];
      }
      case 'gray_area':
        return typeof o.index === 'number'
          ? [
              {
                type: 'gray_area',
                analysis_id,
                id: str(o.id),
                kind: str(o.kind),
                min_missing: typeof o.min_missing === 'number' ? o.min_missing : 1,
                index: o.index,
              },
            ]
          : [];
      case 'site': {
        const xy = xyOf(o.xy);
        return xy ? [{ type: 'site', analysis_id, label: str(o.label), xy }] : [];
      }
      default:
        return [];
    }
  });
}

/** The citations of an answer as the page reads them (anchors parsed, broken entries dropped). */
export function parseCitations(v: unknown): AskCitation[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((c): AskCitation[] => {
    if (!c || typeof c !== 'object') return [];
    const o = c as Record<string, unknown>;
    if (!str(o.id)) return [];
    return [
      {
        id: str(o.id),
        tool: str(o.tool),
        title: str(o.title) || str(o.tool),
        summary: str(o.summary),
        anchors: parseAnchors(o.anchors),
      },
    ];
  });
}

export interface HistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** Progress of one answer: a tool starts, a tool ends, or a plain note (repair, fallback, progress). */
export type AskStep =
  | { kind: 'tool'; tool: string; title: string; id?: string; done: boolean; error?: string }
  | { kind: 'note'; text: string };

/** Server limits (docs/api.md): the client trims before sending instead of being refused. */
export const QUESTION_MAX = 300;
export const HISTORY_MAX = 8;
export const HISTORY_CONTENT_MAX = 2000;

export async function ask(
  body: { question: string; analysis_id?: string; history: HistoryTurn[] },
  onStep: (step: AskStep) => void,
  signal: AbortSignal,
): Promise<AskAnswer> {
  let answer: AskAnswer | undefined;
  try {
    answer = await postEvents<AskAnswer>(
      '/api/ask',
      body,
      (event, p) => {
        switch (event) {
          case 'tool_call':
            onStep({ kind: 'tool', tool: str(p.tool), title: str(p.title) || str(p.tool), done: false });
            break;
          case 'tool_result':
            onStep({
              kind: 'tool',
              tool: str(p.tool),
              title: str(p.title) || str(p.tool),
              done: true,
              ...(str(p.id) ? { id: str(p.id) } : {}),
              ...(str(p.error) ? { error: str(p.error) } : {}),
            });
            break;
          case 'progress':
            if (str(p.message)) onStep({ kind: 'note', text: str(p.message) });
            break;
          case 'repair': {
            const bad = Array.isArray(p.unsupported)
              ? p.unsupported.filter((x) => typeof x === 'string')
              : [];
            onStep({
              kind: 'note',
              text: bad.length
                ? `大模型的初稿有数字找不到出处（${bad.join('、')}），已要求它按工具结果改写`
                : '大模型的初稿缺少出处标注，已要求它补上',
            });
            break;
          }
          case 'fallback':
            onStep({ kind: 'note', text: str(p.reason) || '改用模板回答' });
            break;
          case 'answer':
            return p as unknown as AskAnswer;
        }
        return undefined;
      },
      signal,
    );
  } catch (err) {
    if (signal.aborted || err instanceof ApiError) throw err;
    // fetch itself failed: no server behind /api (static build) or the connection dropped
    throw new ApiError('offline', '无法连接邻至服务端，请确认服务已启动');
  }
  if (!answer || typeof answer.answer !== 'string')
    throw new ApiError('upstream', '问询连接意外中断，请再问一次');
  const added: unknown = answer.citations_added;
  const out: AskAnswer = {
    ...answer,
    citations: parseCitations(answer.citations),
    grounding: answer.grounding ?? { ok: false, checked: 0, unsupported: [], uncited: [] },
  };
  delete out.citations_added;
  const notes = Array.isArray(added) ? added.filter((x): x is string => typeof x === 'string') : [];
  if (notes.length) out.citations_added = notes;
  return out;
}
