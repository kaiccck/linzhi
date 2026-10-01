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

/**
 * zj-a with its pharmacy checks at 川杨新苑四期 and 虹御公寓 as they were before the nearest top-up
 * (augment-zj-a.ts, 2026-09-29): 待核实, a nearer pharmacy never routed. The sample has no pending
 * check any more; the tools' pending paths are tested on this copy.
 */
export function zjAWithPending(): AnalysisResult {
  const r = structuredClone(zjA());
  const pharmacy = (name: string) => r.communities.find((c) => c.name === name)!.checks['药店'];
  const nearer = (list: [string, string, number][]) =>
    list.map(([n, uid, straight_m]) => ({ name: n, uid, straight_m }));
  Object.assign(pharmacy('川杨新苑四期'), {
    route_m: 1031,
    dur_s: 881,
    via: '益丰大药房(铭康店)',
    via_uid: '46cdd39f831a37fefc0eb09f',
    via_straight_m: 488,
    status: '临界',
    status_main: '伪覆盖',
    borderline: true,
    route_upper_bound: true,
    verified: false,
    unrouted_nearer: nearer([
      ['益丰大药房(川杨店)', 'cbd273a8c6482fe807026f10', 177.9],
      ['雷允上(川杨新苑三期店)', '202f3669a65b2eeac7f0256f', 341.3],
      ['益丰大药房(孙桥路店)', '1615ed8d421936b22efaa703', 995],
    ]),
  });
  Object.assign(pharmacy('虹御公寓'), {
    route_m: 1124,
    dur_s: 962,
    via: '益丰大药房(高木桥店)',
    via_uid: 'ab6b2565b635c6ff3904b141',
    via_straight_m: 741.4,
    status: '伪覆盖',
    status_main: '伪覆盖',
    route_upper_bound: true,
    verified: false,
    unrouted_nearer: nearer([
      ['益丰大药房(孙桥路店)', '1615ed8d421936b22efaa703', 582.5],
      ['雷允上(川杨新苑三期店)', '202f3669a65b2eeac7f0256f', 603.4],
      ['养和堂药业连锁(孙桥店)', '881a28e7b494fd5ef942b257', 629.7],
    ]),
  });
  return r;
}

/** localCtx() whose zj-a is zjAWithPending(). */
export function pendingCtx(): ToolContext {
  const ctx = localCtx();
  ctx.store.put(zjAWithPending(), { id: 'zj-a', source: 'sample' });
  return ctx;
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
