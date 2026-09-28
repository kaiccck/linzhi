/** Test helpers: the zj-a sample through LocalBackend, tool contexts, and a scripted fake LLM endpoint. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AnalysisResult } from '@zoudedao/core';
import { AnalysisStore, LocalBackend } from '../src/backend.js';
import type { ToolCall } from '../src/llm.js';
import type { ToolContext } from '../src/tools/types.js';

export const SAMPLES_DIR = fileURLToPath(new URL('../../../data/samples/', import.meta.url));

let cached: AnalysisResult | undefined;

/** data/samples/zj-a.json (申城佳苑片区), parsed once. Treat as read-only. */
export function zjA(): AnalysisResult {
  return (cached ??= JSON.parse(readFileSync(`${SAMPLES_DIR}zj-a.json`, 'utf8')) as AnalysisResult);
}

export function localCtx(): ToolContext {
  return { backend: new LocalBackend({ samplesDir: SAMPLES_DIR }), store: new AnalysisStore() };
}

/** Shanghai, generously (all of the municipality). */
export const SHANGHAI = { minLng: 120.85, maxLng: 122.2, minLat: 30.66, maxLat: 31.88 };

/**
 * Area of a lng/lat ring on the sphere (m²), the small-polygon formula used by turf:
 * A = −R²/2 · Σ (λ2 − λ1)(2 + sin φ1 + sin φ2), signed so that counter-clockwise rings are positive.
 */
export function sphericalRingArea(ring: readonly (readonly number[])[]): number {
  const R = 6371008.8;
  const rad = Math.PI / 180;
  let sum = 0;
  for (let i = 0; i + 1 < ring.length; i++) {
    const [l1, p1] = ring[i]!;
    const [l2, p2] = ring[i + 1]!;
    sum += (l2! - l1!) * rad * (2 + Math.sin(p1! * rad) + Math.sin(p2! * rad));
  }
  return (-sum * R * R) / 2;
}

// ---------------------------------------------------------------------------- fake OpenAI

export interface ScriptedTurn {
  content?: string | null;
  tool_calls?: { name: string; arguments: unknown }[];
  /** reasoning_content of a thinking model. */
  reasoning?: string;
  /** HTTP status to answer with instead of a completion. */
  status?: number;
  body?: string;
}

export interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  body: {
    model: string;
    messages: {
      role: string;
      content: string | null;
      tool_calls?: ToolCall[];
      tool_call_id?: string;
      reasoning_content?: string;
    }[];
    tools?: {
      type: string;
      function: { name: string; description: string; parameters: Record<string, unknown> };
    }[];
    tool_choice?: string;
    [k: string]: unknown;
  };
}

/** A stub fetch that answers /chat/completions from a script, recording every request. */
export function scriptedLlm(script: ScriptedTurn[]): { fetch: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  let i = 0;
  const stub = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    requests.push({ url, headers, body: JSON.parse(String(init?.body)) as RecordedRequest['body'] });
    const turn = script[i++];
    if (!turn)
      return new Response(JSON.stringify({ error: { message: 'script exhausted' } }), { status: 500 });
    if (turn.status) return new Response(turn.body ?? '', { status: turn.status });
    const message: Record<string, unknown> = { role: 'assistant', content: turn.content ?? null };
    if (turn.reasoning) message.reasoning_content = turn.reasoning;
    if (turn.tool_calls) {
      message.tool_calls = turn.tool_calls.map((c, k) => ({
        id: `call_${i}_${k}`,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.arguments) },
      }));
    }
    return Response.json({
      id: `chatcmpl-${i}`,
      object: 'chat.completion',
      choices: [{ index: 0, message, finish_reason: turn.tool_calls ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    });
  };
  return { fetch: stub as typeof fetch, requests };
}
