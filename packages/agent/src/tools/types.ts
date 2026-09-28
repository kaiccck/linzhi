/**
 * One tool registry serves both the advisor (OpenAI tool calling) and the MCP server. A tool is a
 * zod input schema plus a deterministic run() over analysis results: no LLM is involved, and every
 * number the tool asserts is listed in `facts`.
 */
import type * as z from 'zod';
import type { AnalysisStore, ZddBackend } from '../backend.js';
import type { Fact } from '../format.js';
import type { AnalyzeEvent } from '../types.js';

export type ToolName =
  | 'locate_place'
  | 'analyze_life_circle'
  | 'get_isochrone'
  | 'list_service_gaps'
  | 'simulate_facility'
  | 'compare_sites'
  | 'export_report';

export interface ToolResult<D = unknown> {
  /** Short Chinese text a person can read; every number in it is also in `facts`. */
  summary: string;
  /** Structured result (MCP structuredContent). */
  data: D;
  /** Every number the tool asserts. */
  facts: Fact[];
}

export interface ToolContext {
  backend: ZddBackend;
  store: AnalysisStore;
  signal?: AbortSignal;
  /** Progress of a live analysis (stage / partial / quota events). */
  onProgress?: (event: AnalyzeEvent) => void;
}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ZddTool<S extends z.ZodObject = z.ZodObject, D = unknown> {
  readonly name: ToolName;
  /** Chinese display name. */
  readonly title: string;
  /** Chinese, written for an LLM: when to use it, what it returns, caveats. */
  readonly description: string;
  readonly inputSchema: S;
  /** Loose shape of `data` (MCP outputSchema / structuredContent); extra fields are allowed. */
  readonly outputSchema?: z.ZodObject;
  readonly annotations?: ToolAnnotations;
  run(args: z.output<S>, ctx: ToolContext): Promise<ToolResult<D>>;
  /** Compact form for LLM tool messages (geometry left out); default: data itself. */
  llmView?(data: D): unknown;
}

export type AnyTool = ZddTool<z.ZodObject, unknown>;

/** An expected failure with a Chinese message for the user or the calling model. */
export class ToolError extends Error {
  override name = 'ToolError';
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

export function defineTool<S extends z.ZodObject, D>(tool: ZddTool<S, D>): ZddTool<S, D> {
  return tool;
}
