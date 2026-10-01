/**
 * The MCP server of 邻至: the same tool registry as the 体检顾问 advisor (@zoudedao/agent), plus
 * resources for samples, analyses and reports, and a prompt that walks a client model through a
 * health check. One factory builds a fresh McpServer per connection (stdio) or per request (HTTP);
 * the analysis store is shared, so ids from one call work in the next.
 */
import {
  AnalysisStore,
  CHECKED_SCOPE,
  ToolError,
  createToolRegistry,
  isochroneCollection,
  reportCollection,
  reportMarkdown,
  resolveAnalysis,
  type AnyTool,
  type ReportData,
  type ToolContext,
  type ToolRegistry,
  type ToolResult,
  type ZddBackend,
} from '@zoudedao/agent';
import {
  McpServer,
  ResourceTemplate,
  type CallToolResult,
  type ContentBlock,
  type ServerContext,
} from '@modelcontextprotocol/server';
import * as z from 'zod';

export const SERVER_NAME = 'zoudedao';

export const INSTRUCTIONS = [
  '邻至：15 分钟步行生活圈体检。可达范围和设施距离来自百度地图的实测步行路线，而不是以小区为圆心画圆。',
  '典型流程：locate_place（地名 → 候选）→ analyze_life_circle（体检，得到 analysis_id 和核心数字）→ list_service_gaps（服务缺口）→ simulate_facility（新增设施的估算）或 compare_sites → export_report（Markdown / GeoJSON 报告）。',
  '内置样例（如 zj-a 上海张江申城佳苑片区，完整列表见资源 zoudedao://samples）可直接体检，不消耗地图配额；问到老人时用 profile=elder，或直接使用 <analysis_id>~elder。',
  '想知道哪些小区都方便：list_service_gaps 的 by_community 每个小区一行，给出各类设施的判定与步行分钟。',
  `逐小区检查了哪些设施以结果里的 checked_categories 为准——${CHECKED_SCOPE}；分析没有检查的类别不能说成没有缺口，从分析中心出发能走到几处见 analyze_life_circle 的圈内设施统计。`,
  '回答规则：数字一律原样引用工具结果，不要自己计算、换算或四舍五入；verified=false 的检查是“待核实”，不是缺口；simulate_facility 的结果是估算，必须注明“估算”。',
].join('\n');

export interface ZddMcpOptions {
  backend: ZddBackend;
  /** Shared across connections so analysis ids stay valid; default a new store. */
  store?: AnalysisStore;
  registry?: ToolRegistry;
  version?: string;
}

const enc = encodeURIComponent;

/** Where an export can be read again as a resource. */
export function exportUri(data: ReportData): string {
  const ext = data.format === 'markdown' ? 'md' : data.format;
  return `zoudedao://analysis/${enc(data.analysis_id)}/report.${ext}`;
}

function contentOf(tool: AnyTool, args: Record<string, unknown>, result: ToolResult): ContentBlock[] {
  const content: ContentBlock[] = [{ type: 'text', text: result.summary }];
  if (tool.name === 'export_report') {
    // exported documents travel as embedded resources, so clients can save or open them
    const data = result.data as ReportData;
    content.push({
      type: 'resource',
      resource: {
        uri: exportUri(data),
        mimeType: data.mime_type,
        text: typeof data.content === 'string' ? data.content : JSON.stringify(data.content, null, 2),
      },
    });
  } else if (tool.name === 'get_isochrone') {
    // the GeoJSON is already in structuredContent; link it instead of sending it twice
    content.push({
      type: 'resource_link',
      uri: `zoudedao://analysis/${enc(String(args.analysis_id))}/isochrone.geojson`,
      name: 'isochrone.geojson',
      title: '步行等时圈 GeoJSON（WGS84）',
      mimeType: 'application/geo+json',
    });
  }
  return content;
}

function errorResult(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  const code = err instanceof ToolError ? err.code : 'internal';
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
    _meta: { 'zoudedao/error_code': code },
  };
}

/** Relays live-analysis stages as MCP progress notifications when the client asked for them. */
function progressRelay(ctx: ServerContext): ToolContext['onProgress'] {
  const token = ctx.mcpReq._meta?.progressToken;
  if (token === undefined) return undefined;
  return (e) => {
    if (e.type !== 'stage') return;
    void ctx.mcpReq
      .notify({
        method: 'notifications/progress',
        params: { progressToken: token, progress: e.progress, total: 1, message: e.message },
      })
      .catch(() => undefined);
  };
}

async function listAnalyses(backend: ZddBackend, store: AnalysisStore) {
  const samples = await backend.listSamples().catch(() => []);
  const stored = store.list().filter((s) => s.source !== 'sample');
  return [
    ...samples.map((s) => ({ id: s.id, name: s.name, kind: 'sample' as const })),
    ...stored.map((s) => ({ id: s.id, name: s.result.meta.name, kind: s.source })),
  ];
}

/** Builds one McpServer with every tool, resource and prompt registered. */
export function createZddMcpServer(
  opts: ZddMcpOptions & { store: AnalysisStore; registry: ToolRegistry },
): McpServer {
  const { backend, store, registry } = opts;
  const server = new McpServer(
    { name: SERVER_NAME, title: '邻至 · 15 分钟生活圈体检', version: opts.version ?? '0.1.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} }, instructions: INSTRUCTIONS },
  );

  for (const tool of registry.tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
        ...(tool.annotations ? { annotations: { title: tool.title, ...tool.annotations } } : {}),
      },
      async (args: Record<string, unknown>, ctx: ServerContext): Promise<CallToolResult> => {
        const onProgress = progressRelay(ctx);
        const toolCtx: ToolContext = {
          backend,
          store,
          signal: ctx.mcpReq.signal,
          ...(onProgress ? { onProgress } : {}),
        };
        try {
          const result = await registry.run(tool.name, args, toolCtx);
          return {
            content: contentOf(tool, args, result),
            structuredContent: result.data as Record<string, unknown>,
            _meta: { 'zoudedao/facts': result.facts },
          };
        } catch (err) {
          return errorResult(err);
        }
      },
    );
  }

  const ctxOf = (): ToolContext => ({ backend, store });
  const complete = {
    id: async (value: string) =>
      (await listAnalyses(backend, store)).map((a) => a.id).filter((id) => id.startsWith(value)),
  };

  server.registerResource(
    'samples',
    'zoudedao://samples',
    {
      title: '可体检的样例与已有分析',
      description: '内置样例社区（sample）和本次会话里的实时或换算结果（live / derived）',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify({ analyses: await listAnalyses(backend, store) }, null, 2),
        },
      ],
    }),
  );

  const templates: {
    name: string;
    suffix: string;
    title: string;
    description: string;
    mimeType: string;
    read: (result: Awaited<ReturnType<typeof resolveAnalysis>>) => string;
  }[] = [
    {
      name: 'analysis',
      suffix: '',
      title: '体检分析结果（AnalysisResult JSON）',
      description: '一次体检的完整结果：等时圈、耗时场、样本、小区检查、设施点；约 400 KB',
      mimeType: 'application/json',
      read: (s) => JSON.stringify(s.result),
    },
    {
      name: 'report',
      suffix: '/report.md',
      title: '体检报告（Markdown）',
      description: '结论先行的中文体检报告，由分析结果确定性生成',
      mimeType: 'text/markdown',
      read: (s) => reportMarkdown(s.result, s.id),
    },
    {
      name: 'report-geojson',
      suffix: '/report.geojson',
      title: '体检地图数据（GeoJSON，WGS84）',
      description: '等时圈、小区检查结果、设施点、灰色区域、规划建议',
      mimeType: 'application/geo+json',
      read: (s) => JSON.stringify(reportCollection(s.result, 'wgs84')),
    },
    {
      name: 'isochrone',
      suffix: '/isochrone.geojson',
      title: '步行等时圈（GeoJSON，WGS84）',
      description: '5/10/15 分钟步行等时圈与直线 15 分钟圆',
      mimeType: 'application/geo+json',
      read: (s) => JSON.stringify(isochroneCollection(s.result)),
    },
  ];
  for (const t of templates) {
    server.registerResource(
      t.name,
      new ResourceTemplate(`zoudedao://analysis/{id}${t.suffix}`, {
        list: async () => ({
          resources: (await listAnalyses(backend, store)).map((a) => ({
            uri: `zoudedao://analysis/${enc(a.id)}${t.suffix}`,
            name: `${a.name}${t.suffix ? ` · ${t.title}` : ''}`,
            mimeType: t.mimeType,
          })),
        }),
        complete,
      }),
      { title: t.title, description: t.description, mimeType: t.mimeType },
      async (uri, variables) => {
        const raw = variables.id;
        const id = decodeURIComponent(Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? ''));
        const stored = await resolveAnalysis(ctxOf(), id);
        return { contents: [{ uri: uri.href, mimeType: t.mimeType, text: t.read(stored) }] };
      },
    );
  }

  server.registerPrompt(
    'life_circle_check',
    {
      title: '15 分钟生活圈体检',
      description:
        '引导模型用邻至的工具为一个地点做完整体检：定位 → 体检 → 服务缺口 → 报告，数字必须引用工具结果',
      argsSchema: z.object({
        place: z.string().min(1).max(60).describe('要体检的地名、地址或样例 id，例如“申城佳苑”'),
      }),
    },
    ({ place }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `请用邻至的工具为“${place}”做一次 15 分钟步行生活圈体检，并用中文向街道规划人员汇报。`,
              '',
              '步骤：',
              `1. 调用 locate_place 定位“${place}”。候选带 sample_id 就直接用它；needs_confirmation 为 true 时先把候选列给我确认，不要替我选。`,
              '2. 调用 analyze_life_circle 做体检，记下 analysis_id。',
              '3. 调用 list_service_gaps 列出服务缺口；如果我关心老人，再用 profile=elder 体检一次。',
              '4. 调用 export_report 生成 Markdown 体检报告。',
              '5. 汇报：先用一句话给出结论，再列 3–5 条要点，最后附上报告。',
              '',
              '规则：',
              '- 每个数字都必须原样来自工具结果，并在句末注明来源工具，例如“（analyze_life_circle）”；不要自己计算、换算或四舍五入。',
              '- verified=false 的检查是“待核实”，不是缺口，不能算进伪覆盖或盲区。',
              '- simulate_facility 的结果都是估算，提到时必须写明“估算”，并提醒需要实测核验。',
              '- 工具回答不了的问题直接说明，不要猜测。',
            ].join('\n'),
          },
        },
      ],
    }),
  );

  return server;
}

/** A factory for serveStdio / createMcpHandler: one shared store and registry, a fresh server each time. */
export function createServerFactory(opts: ZddMcpOptions): () => McpServer {
  const store = opts.store ?? new AnalysisStore();
  const registry = opts.registry ?? createToolRegistry();
  return () => createZddMcpServer({ ...opts, store, registry });
}
