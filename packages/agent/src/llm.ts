/**
 * Minimal OpenAI-compatible Chat Completions client with tool calling, over fetch. Works with any
 * provider that speaks POST {base}/chat/completions (百度千帆 v2, DeepSeek, 通义千问 compatible-mode …;
 * presets in README). The API key only ever goes into the Authorization header: it is never logged,
 * and provider error texts are scrubbed before they reach an error message.
 */
import type { OpenAITool } from './tools/registry.js';

export interface LlmConfig {
  /** e.g. https://api.deepseek.com/v1 — "/chat/completions" is appended. */
  baseUrl: string;
  apiKey?: string;
  model: string;
  /** Per request; default 60 s. */
  timeoutMs?: number;
  /** Default 0.2: the advisor restates tool results, it should not be creative. */
  temperature?: number;
  /** Extra fields merged into every request body, e.g. { "enable_thinking": false } for Qwen3. */
  extraBody?: Record<string, unknown>;
  fetch?: typeof fetch;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: ToolCall[];
      /**
       * The model's own reasoning, echoed back unchanged: DeepSeek V4 and ERNIE 5 in thinking mode
       * reject a tool loop whose earlier assistant turns lost it. Only sent when the provider gave one.
       */
      reasoning_content?: string;
    }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: OpenAITool[];
  toolChoice?: 'auto' | 'none';
  signal?: AbortSignal;
}

export interface ChatResponse {
  content: string | null;
  toolCalls: ToolCall[];
  /** reasoning_content of thinking models; null when the provider sent none. */
  reasoning: string | null;
  finishReason: string | null;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export type LlmErrorCode = 'config' | 'http' | 'timeout' | 'network' | 'invalid_response' | 'aborted';

export class LlmError extends Error {
  override name = 'LlmError';
  readonly code: LlmErrorCode;
  readonly status: number | undefined;

  constructor(code: LlmErrorCode, message: string, status?: number, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.status = status;
  }
}

/**
 * LLM_BASE_URL + LLM_MODEL (+ LLM_API_KEY, optional LLM_EXTRA_BODY JSON, LLM_TIMEOUT_MS) →
 * config; null when not configured, so the advisor runs its template mode.
 */
export function llmConfigFromEnv(env: Record<string, string | undefined> = process.env): LlmConfig | null {
  const baseUrl = env.LLM_BASE_URL?.trim();
  const model = env.LLM_MODEL?.trim();
  if (!baseUrl || !model) return null;
  const cfg: LlmConfig = { baseUrl, model };
  const key = env.LLM_API_KEY?.trim();
  if (key) cfg.apiKey = key;
  const extra = env.LLM_EXTRA_BODY?.trim();
  if (extra) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(extra);
    } catch {
      throw new LlmError('config', 'LLM_EXTRA_BODY 不是合法的 JSON 对象');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new LlmError('config', 'LLM_EXTRA_BODY 须为 JSON 对象，例如 {"enable_thinking": false}');
    }
    cfg.extraBody = parsed as Record<string, unknown>;
  }
  const timeout = Number(env.LLM_TIMEOUT_MS);
  if (Number.isFinite(timeout) && timeout > 0) cfg.timeoutMs = timeout;
  return cfg;
}

/** Keys and bearer tokens out of any text that may reach a message or a log. */
export function scrubSecrets(text: string, secret?: string): string {
  let out = text;
  if (secret) out = out.split(secret).join('***');
  return out
    .replace(/Bearer\s+[\w./+=:-]+/gi, 'Bearer ***')
    .replace(/\b(sk-[\w-]{6,}|bce-v3\/[\w/-]+|ALTAK[\w/-]*)/g, '***');
}

function endpoint(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
}

/** "deepseek-chat @ api.deepseek.com" — safe to show and log. */
export function describeLlm(cfg: LlmConfig): string {
  let host = cfg.baseUrl;
  try {
    host = new URL(cfg.baseUrl).host;
  } catch {
    // keep as given
  }
  return `${cfg.model} @ ${host}`;
}

function textOf(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) =>
        p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string'
          ? (p as { text: string }).text
          : '',
      )
      .join('');
  }
  return null;
}

function toolCallsOf(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((c, i): ToolCall[] => {
    const fn = (c as { function?: { name?: unknown; arguments?: unknown } })?.function;
    if (!fn || typeof fn.name !== 'string') return [];
    const args = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {});
    const id =
      typeof (c as { id?: unknown }).id === 'string' && (c as { id: string }).id
        ? (c as { id: string }).id
        : `call_${i}`;
    return [{ id, type: 'function', function: { name: fn.name, arguments: args } }];
  });
}

export class ChatClient {
  readonly config: LlmConfig;
  readonly #fetch: typeof fetch;

  constructor(config: LlmConfig) {
    if (!config.baseUrl || !config.model) throw new LlmError('config', '需要配置 LLM_BASE_URL 和 LLM_MODEL');
    this.config = config;
    this.#fetch = config.fetch ?? ((input, init) => fetch(input, init));
  }

  describe(): string {
    return describeLlm(this.config);
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const cfg = this.config;
    const body: Record<string, unknown> = {
      ...cfg.extraBody,
      model: cfg.model,
      messages: req.messages,
      temperature: cfg.temperature ?? 0.2,
      stream: false,
    };
    if (req.tools?.length) {
      body.tools = req.tools;
      body.tool_choice = req.toolChoice ?? 'auto';
    }
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
    };
    if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
    const timeoutMs = cfg.timeoutMs ?? 60_000;

    for (let attempt = 0; ; attempt++) {
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
      let res: Response;
      try {
        res = await this.#fetch(endpoint(cfg.baseUrl), {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal,
        });
      } catch (err) {
        if (req.signal?.aborted) throw new LlmError('aborted', '已取消', undefined, { cause: err });
        if (timeout.aborted)
          throw new LlmError('timeout', `大模型在 ${Math.round(timeoutMs / 1000)} 秒内没有响应`);
        if (attempt === 0) continue;
        throw new LlmError('network', `无法连接大模型服务（${this.describe()}）`, undefined, { cause: err });
      }
      if (!res.ok) {
        const text = scrubSecrets(await res.text().catch(() => ''), cfg.apiKey).slice(0, 300);
        if ((res.status === 429 || res.status >= 500) && attempt === 0) {
          await new Promise((r) => setTimeout(r, 800));
          continue;
        }
        const hint = res.status === 401 || res.status === 403 ? '（请检查 LLM_API_KEY）' : '';
        throw new LlmError(
          'http',
          `大模型服务返回 HTTP ${res.status}${hint}${text ? `：${text}` : ''}`,
          res.status,
        );
      }
      let json: {
        choices?: { message?: Record<string, unknown>; finish_reason?: unknown }[];
        usage?: ChatResponse['usage'];
      };
      try {
        json = (await res.json()) as typeof json;
      } catch (err) {
        throw new LlmError('invalid_response', '大模型服务返回的不是合法 JSON', res.status, { cause: err });
      }
      const choice = json.choices?.[0];
      if (!choice?.message)
        throw new LlmError('invalid_response', '大模型服务的响应里没有 choices[0].message', res.status);
      return {
        content: textOf(choice.message.content),
        toolCalls: toolCallsOf(choice.message.tool_calls),
        reasoning:
          typeof choice.message.reasoning_content === 'string' ? choice.message.reasoning_content : null,
        finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
        ...(json.usage ? { usage: json.usage } : {}),
      };
    }
  }
}
