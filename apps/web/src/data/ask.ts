/**
 * 问询 → POST /api/ask (docs/api.md): one question about the analysis on screen, answered as an
 * event stream — which tools ran, then one `answer` with citations, grounding and attachments.
 */
import { ApiError, postEvents } from './api.js';

export interface AskCitation {
  /** T1, T2 … */
  id: string;
  tool: string;
  /** Chinese tool name, e.g. 服务缺口清单 */
  title: string;
  summary: string;
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
        const str = (v: unknown) => (typeof v === 'string' ? v : '');
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
    throw new ApiError('offline', '无法连接走得到服务端，请确认服务已启动');
  }
  if (!answer || typeof answer.answer !== 'string')
    throw new ApiError('upstream', '问询连接意外中断，请再问一次');
  return {
    ...answer,
    citations: Array.isArray(answer.citations) ? answer.citations : [],
    grounding: answer.grounding ?? { ok: false, checked: 0, unsupported: [], uncited: [] },
  };
}
