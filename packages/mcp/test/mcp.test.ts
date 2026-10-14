import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { request } from 'node:http';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { AnalysisStore, LocalBackend, type ZddBackend } from '@zoudedao/agent';
import { HARD_CATEGORIES, TASK_CATEGORIES } from '@zoudedao/core';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import {
  InMemoryTransport,
  ReadBuffer,
  serializeMessage,
  type JSONRPCMessage,
  type Transport,
} from '@modelcontextprotocol/server';
import { StdioServerTransport, serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterAll, describe, expect, it } from 'vitest';
import { createServerFactory } from '../src/server.js';
import { startHttp } from '../src/http.js';
import { createBackend, resolveSamplesDir } from '../src/config.js';

const SAMPLES = fileURLToPath(new URL('../../../data/samples/', import.meta.url));
const backend = () => new LocalBackend({ samplesDir: SAMPLES });

async function connect(factory = createServerFactory({ backend: backend() })) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await factory().connect(serverSide);
  const client = new Client({ name: 'zdd-test', version: '1.0.0' });
  await client.connect(clientSide);
  return client;
}

type Structured = Record<string, unknown>;
const textOf = (r: { content: unknown }) =>
  (r.content as { type: string; text?: string }[]).find((c) => c.type === 'text')?.text ?? '';

describe('MCP server over an in-memory transport', () => {
  it('lists the seven tools with Chinese titles, input and output schemas', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      'locate_place',
      'analyze_life_circle',
      'get_isochrone',
      'list_service_gaps',
      'simulate_facility',
      'compare_sites',
      'export_report',
    ]);
    for (const t of tools) {
      expect(t.title).toMatch(/[一-鿿]/);
      expect(t.description).toMatch(/[一-鿿]/);
      expect(t.inputSchema.type).toBe('object');
      expect(t.outputSchema?.type).toBe('object');
      expect(t.annotations?.readOnlyHint).toBe(true);
    }
    expect(client.getServerVersion()).toMatchObject({ name: 'zoudedao' });
    expect(client.getInstructions()).toContain('verified=false');
    await client.close();
  });

  it('analyze_life_circle {sample_id: "zj-a"} returns the headline as text and structured content', async () => {
    const client = await connect();
    const r = await client.callTool({ name: 'analyze_life_circle', arguments: { sample_id: 'zj-a' } });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain(
      '画圆法（直线 1 km）只找到 0 个服务缺口，按实测步行距离已核实 3 个，画圆漏掉了其中 3 个（100%）',
    );
    const data = r.structuredContent as Structured;
    expect(data).toMatchObject({
      status: 'ok',
      analysis_id: 'zj-a',
      checked_categories: [...HARD_CATEGORIES],
      headline: { categories: 5, straight_gaps: 0, walking_gaps: 3, missed_share_pct: 100, pending: 12 },
      isochrone: { area_iso15_km2: 1.857, area_circle15_km2: 3.483, overstate_x: 1.88 },
    });
    const facts = (r._meta as { 'zoudedao/facts': { label: string; value: number }[] })['zoudedao/facts'];
    expect(facts.find((f) => f.label === '画圆漏掉的比例')?.value).toBe(100);
    await client.close();
  });

  it('get_isochrone returns GeoJSON plus a link to it as a resource', async () => {
    const client = await connect();
    const r = await client.callTool({
      name: 'get_isochrone',
      arguments: { analysis_id: 'zj-a', levels: [15] },
    });
    const fc = r.structuredContent as {
      type: string;
      coordinate_system: string;
      features: { properties: Structured }[];
    };
    expect(fc.type).toBe('FeatureCollection');
    expect(fc.coordinate_system).toBe('wgs84');
    expect(fc.features[0]!.properties).toMatchObject({ kind: 'isochrone', minutes: 15, area_km2: 1.857 });
    const link = (r.content as { type: string; uri?: string }[]).find((c) => c.type === 'resource_link');
    expect(link?.uri).toBe('zoudedao://analysis/zj-a/isochrone.geojson');
    const read = await client.readResource({ uri: link!.uri! });
    const linked = JSON.parse((read.contents[0] as { text: string }).text) as { features: unknown[] };
    expect(linked.features.length).toBe(5);
    await client.close();
  });

  it('export_report embeds the Markdown report as a resource', async () => {
    const client = await connect();
    const r = await client.callTool({ name: 'export_report', arguments: { analysis_id: 'zj-a' } });
    const resource = (
      r.content as { type: string; resource?: { uri: string; mimeType: string; text: string } }[]
    ).find((c) => c.type === 'resource')!.resource!;
    expect(resource.uri).toBe('zoudedao://analysis/zj-a/report.md');
    expect(resource.mimeType).toBe('text/markdown');
    expect(resource.text.startsWith('# 申城佳苑片区 · 15 分钟生活圈体检报告')).toBe(true);
    expect(resource.text).toContain('画圆漏掉了其中 3 个（100%）');
    const geo = await client.callTool({
      name: 'export_report',
      arguments: { analysis_id: 'zj-a', format: 'geojson' },
    });
    const geoRes = (geo.content as { type: string; resource?: { uri: string; mimeType: string } }[]).find(
      (c) => c.type === 'resource',
    )!.resource!;
    expect(geoRes).toMatchObject({
      uri: 'zoudedao://analysis/zj-a/report.geojson',
      mimeType: 'application/geo+json',
    });
    await client.close();
  });

  it('serves samples, analyses and reports as resources, with templates', async () => {
    const client = await connect();
    const samples = await client.readResource({ uri: 'zoudedao://samples' });
    const { analyses } = JSON.parse((samples.contents[0] as { text: string }).text) as {
      analyses: { id: string; name: string; kind: string }[];
    };
    expect(analyses).toContainEqual({ id: 'zj-a', name: '申城佳苑片区', kind: 'sample' });
    const templates = await client.listResourceTemplates();
    expect(templates.resourceTemplates.map((t) => t.uriTemplate)).toEqual([
      'zoudedao://analysis/{id}',
      'zoudedao://analysis/{id}/report.md',
      'zoudedao://analysis/{id}/report.geojson',
      'zoudedao://analysis/{id}/isochrone.geojson',
    ]);
    const analysis = await client.readResource({ uri: 'zoudedao://analysis/zj-a' });
    expect(JSON.parse((analysis.contents[0] as { text: string }).text).meta.name).toBe('申城佳苑片区');
    const report = await client.readResource({ uri: 'zoudedao://analysis/zj-a~elder/report.md' });
    expect((report.contents[0] as { text: string }).text).toContain('（老年人画像）');
    const listed = await client.listResources();
    expect(listed.resources.map((r) => r.uri)).toContain('zoudedao://analysis/zj-a/report.md');
    await expect(client.readResource({ uri: 'zoudedao://analysis/nope' })).rejects.toThrow(/找不到分析 nope/);
    await client.close();
  });

  it('offers the life_circle_check prompt', async () => {
    const client = await connect();
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(['life_circle_check']);
    expect(prompts[0]!.arguments).toEqual([expect.objectContaining({ name: 'place', required: true })]);
    const p = await client.getPrompt({ name: 'life_circle_check', arguments: { place: '申城佳苑' } });
    const text = (p.messages[0]!.content as { text: string }).text;
    expect(text).toContain('为“申城佳苑”做一次 15 分钟步行生活圈体检');
    expect(text).toContain('locate_place');
    expect(text).toContain('export_report');
    expect(text).toContain('待核实');
    await client.close();
  });

  it('reports tool failures as Chinese error results', async () => {
    const client = await connect();
    const far = await client.callTool({
      name: 'simulate_facility',
      arguments: { analysis_id: 'zj-a', category: '药店', center_bd09: [121.5, 31.1] },
    });
    expect(far.isError).toBe(true);
    expect(textOf(far)).toContain('范围之外');
    const bad = await client.callTool({ name: 'compare_sites', arguments: { analysis_ids: ['zj-a'] } });
    expect(bad.isError).toBe(true);
    await client.close();
  });

  it('takes every checked category and says when an analysis did not check one', async () => {
    // zj-a as an analysis made before 幼儿园 and 社区卫生 were checked: the task's three only
    const older = structuredClone(await backend().getAnalysis('zj-a'));
    for (const c of older.communities) {
      c.checks = Object.fromEntries(TASK_CATEGORIES.map((k) => [k, c.checks[k]])) as typeof c.checks;
    }
    const store = new AnalysisStore();
    store.put(older, { id: 'zj-a-older', source: 'sample' });
    const client = await connect(createServerFactory({ backend: backend(), store }));
    const { tools } = await client.listTools();
    const categoryEnum = (name: string) =>
      (tools.find((t) => t.name === name)!.inputSchema.properties as Record<string, { enum?: unknown[] }>)
        .category!.enum;
    expect(categoryEnum('list_service_gaps')).toEqual([...HARD_CATEGORIES]);
    expect(categoryEnum('simulate_facility')).toEqual([...HARD_CATEGORIES]);
    expect(client.getInstructions()).toContain('checked_categories');
    // the stored zj-a checks 幼儿园: checked and clean
    const kinder = await client.callTool({
      name: 'list_service_gaps',
      arguments: { analysis_id: 'zj-a', category: '幼儿园' },
    });
    expect(kinder.isError).toBeFalsy();
    expect(kinder.structuredContent).toMatchObject({
      checked_categories: [...HARD_CATEGORIES],
      counts: { checks: 12, gaps: 0 },
    });
    // the older copy never checked it: not "no gaps", but "not checked"
    const r = await client.callTool({
      name: 'list_service_gaps',
      arguments: { analysis_id: 'zj-a-older', category: '幼儿园' },
    });
    expect(r.isError).toBe(true);
    expect(r._meta).toMatchObject({ 'zoudedao/error_code': 'not_checked' });
    expect(textOf(r)).toContain('没有逐小区检查幼儿园：这份分析只逐小区检查了小学、菜市场、药店');
    const ok = await client.callTool({ name: 'list_service_gaps', arguments: { analysis_id: 'zj-a-older' } });
    expect((ok.structuredContent as { checked_categories: string[] }).checked_categories).toEqual([
      ...TASK_CATEGORIES,
    ]);
    await client.close();
  });

  it('shares analysis ids between connections of one server factory', async () => {
    const base = backend();
    const live: ZddBackend = {
      kind: 'fake',
      listSamples: () => base.listSamples(),
      getAnalysis: (id) => base.getAnalysis(id),
      analyze: async () => {
        const r = await base.getAnalysis('zj-a');
        return { ...r, meta: { ...r.meta, name: '实时片区', center_bd09: [121.61, 31.2] } };
      },
    };
    const factory = createServerFactory({ backend: live });
    const a = await connect(factory);
    const r = await a.callTool({ name: 'analyze_life_circle', arguments: { center_bd09: [121.61, 31.2] } });
    const id = (r.structuredContent as { analysis_id: string }).analysis_id;
    expect(id).toMatch(/^live-/);
    await a.close();
    const b = await connect(factory);
    const gaps = await b.callTool({ name: 'list_service_gaps', arguments: { analysis_id: id } });
    expect(gaps.isError).toBeFalsy();
    expect(textOf(gaps)).toContain('实时片区');
    await b.close();
  });
});

describe('Streamable HTTP', () => {
  const running = startHttp(createServerFactory({ backend: backend() }), { port: 0 });
  afterAll(async () => (await running).close());

  it('serves 2025-era clients and 2026-07-28 clients at /mcp on 127.0.0.1', async () => {
    const { url } = await running;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    for (const mode of ['legacy', 'auto'] as const) {
      const client = new Client({ name: 'zdd-http', version: '1.0.0' }, { versionNegotiation: { mode } });
      await client.connect(new StreamableHTTPClientTransport(new URL(url)));
      expect((await client.listTools()).tools).toHaveLength(7);
      const r = await client.callTool({ name: 'analyze_life_circle', arguments: { sample_id: 'zj-a' } });
      expect((r.structuredContent as { headline: { walking_gaps: number } }).headline.walking_gaps).toBe(3);
      await client.close();
    }
  });

  it('answers /health, 404 elsewhere, and 403 to a foreign Host header', async () => {
    const { url } = await running;
    const base = new URL(url);
    expect(await (await fetch(new URL('/health', base))).json()).toMatchObject({ ok: true, path: '/mcp' });
    expect((await fetch(new URL('/other', base))).status).toBe(404);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: base.hostname,
          port: base.port,
          path: '/mcp',
          method: 'POST',
          headers: { host: 'evil.example', 'content-type': 'application/json' },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end('{}');
    });
    expect(status).toBe(403);
  });
});

/** A client transport over two in-process streams, speaking the stdio framing (one JSON message per line). */
function streamTransport(input: PassThrough, output: PassThrough): Transport {
  const buffer = new ReadBuffer();
  const t: Transport = {
    async start() {
      input.on('data', (chunk: Buffer) => {
        buffer.append(chunk);
        for (let m = buffer.readMessage(); m; m = buffer.readMessage()) t.onmessage?.(m);
      });
    },
    async send(message: JSONRPCMessage) {
      output.write(serializeMessage(message));
    },
    async close() {
      output.end();
      t.onclose?.();
    },
  };
  return t;
}

describe('stdio', () => {
  it('serves a connection through serveStdio (the entry the CLI uses)', async () => {
    const toServer = new PassThrough();
    const toClient = new PassThrough();
    const handle = serveStdio(createServerFactory({ backend: backend() }), {
      transport: new StdioServerTransport(toServer, toClient),
    });
    const client = new Client({ name: 'zdd-stdio', version: '1.0.0' });
    await client.connect(streamTransport(toClient, toServer));
    const r = await client.callTool({
      name: 'get_isochrone',
      arguments: { analysis_id: 'zj-a', levels: [5] },
    });
    expect(textOf(r)).toContain('5 分钟 0.268 km²（直线圆 0.387 km²）');
    await client.close();
    await handle.close();
  });

  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  it.skipIf(!existsSync(cli))(
    'runs the built zoudedao-mcp binary over real stdio',
    async () => {
      const client = new Client({ name: 'zdd-cli', version: '1.0.0' });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [cli, '--samples', SAMPLES],
        stderr: 'pipe',
      });
      await client.connect(transport);
      const r = await client.callTool({
        name: 'export_report',
        arguments: { analysis_id: 'zj-a', format: 'json' },
      });
      expect((r.structuredContent as { format: string }).format).toBe('json');
      await client.close();
    },
    20_000,
  );

  it.skipIf(!existsSync(cli))('prints help and version without starting a server', async () => {
    const run = (args: string[]) =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, [cli, ...args]);
        let out = '';
        child.stdout.on('data', (d: Buffer) => (out += d.toString()));
        child.on('error', reject);
        child.on('close', () => resolve(out));
      });
    expect(await run(['--help'])).toContain('zoudedao-mcp --http');
    expect((await run(['--version'])).trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('configuration', () => {
  it('finds the repository samples and prefers explicit settings', () => {
    expect(resolveSamplesDir(undefined, {})).toBe(SAMPLES.replace(/\/$/, ''));
    expect(resolveSamplesDir('/tmp', {})).toBe('/tmp');
    expect(createBackend({}, { ZDD_API_URL: 'http://localhost:8787' }).backend.kind).toBe('http');
    expect(createBackend({}, {}).backend.kind).toBe('local');
  });
});
