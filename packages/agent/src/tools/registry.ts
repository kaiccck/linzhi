/**
 * The tool registry shared by the advisor (OpenAI tool calling) and the MCP server. Arguments are
 * validated with the tool's zod schema (Chinese messages) before run().
 */
import * as z from 'zod';
import { BackendError } from '../backend.js';
import { analyzeLifeCircle } from './analyze.js';
import { compareSites } from './compare.js';
import { listServiceGaps } from './gaps.js';
import { getIsochrone } from './isochrone.js';
import { locatePlace } from './locate.js';
import { exportReport } from './report.js';
import { simulateFacility } from './simulate.js';
import { ToolError, type AnyTool, type ToolContext, type ToolName, type ToolResult } from './types.js';

/** Names fixed by 技术设计文档 §8.2, in the order a health check uses them. */
export const zddTools: readonly AnyTool[] = [
  locatePlace,
  analyzeLifeCircle,
  getIsochrone,
  listServiceGaps,
  simulateFacility,
  compareSites,
  exportReport,
] as AnyTool[];

export const TOOL_NAMES: readonly ToolName[] = zddTools.map((t) => t.name);

export type JsonSchema = Record<string, unknown>;

/** JSON Schema of the tool input (what callers may send; defaults optional). */
export function toolJsonSchema(tool: AnyTool): JsonSchema {
  const schema = z.toJSONSchema(tool.inputSchema, { io: 'input' }) as JsonSchema;
  delete schema.$schema;
  return schema;
}

export interface OpenAITool {
  type: 'function';
  function: { name: string; description: string; parameters: JsonSchema };
}

export function toOpenAITools(tools: readonly AnyTool[] = zddTools): OpenAITool[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: `${t.title}：${t.description}`, parameters: toolJsonSchema(t) },
  }));
}

const zh = z.locales.zhCN().localeError;

/** Chinese text of a zod failure: "参数 analysis_id：…；参数 levels.0：…". */
export function describeInvalid(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.length ? `参数 ${i.path.join('.')}` : '参数'}：${i.message}`)
    .join('；');
}

export interface ToolRegistry {
  readonly tools: readonly AnyTool[];
  get(name: string): AnyTool | undefined;
  /** Validates `args` and runs the tool; failures become ToolError with a Chinese message. */
  run(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult>;
  openAITools(): OpenAITool[];
}

export function createToolRegistry(tools: readonly AnyTool[] = zddTools): ToolRegistry {
  const byName = new Map(tools.map((t) => [t.name as string, t]));
  return {
    tools,
    get: (name) => byName.get(name),
    openAITools: () => toOpenAITools(tools),
    async run(name, args, ctx) {
      const tool = byName.get(name);
      if (!tool)
        throw new ToolError(
          'unknown_tool',
          `没有名为 ${name} 的工具。可用：${[...byName.keys()].join('、')}`,
        );
      const parsed = tool.inputSchema.safeParse(args ?? {}, { error: zh });
      if (!parsed.success) throw new ToolError('invalid_input', `${name} ${describeInvalid(parsed.error)}`);
      try {
        return await tool.run(parsed.data, ctx);
      } catch (err) {
        if (err instanceof ToolError) throw err;
        if (err instanceof BackendError) throw new ToolError(err.code, err.message, { cause: err });
        if (ctx.signal?.aborted) throw new ToolError('aborted', '已取消', { cause: err });
        throw new ToolError(
          'internal',
          `${name} 执行失败：${err instanceof Error ? err.message : String(err)}`,
          {
            cause: err,
          },
        );
      }
    },
  };
}
