#!/usr/bin/env node
/**
 * zoudedao-mcp: stdio by default (what Claude Desktop, Cursor and Cherry Studio launch), or
 * Streamable HTTP with --http. Logs go to stderr only: on stdio, stdout is the protocol channel.
 */
import { parseArgs } from 'node:util';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod';
import { createBackend, packageVersion } from './config.js';
import { startHttp } from './http.js';
import { createServerFactory } from './server.js';

const HELP = `邻至 MCP Server：15 分钟步行生活圈体检工具（定位、体检、等时圈、服务缺口、新增设施估算、社区对比、体检报告）

用法：
  zoudedao-mcp                                   stdio（默认），由 MCP 客户端启动
  zoudedao-mcp --http [--port 8788] [--host 127.0.0.1]
                                                 Streamable HTTP，端点 http://127.0.0.1:8788/mcp

选项：
  --samples <目录>  样例目录。默认依次取环境变量 ZDD_SAMPLES_DIR、仓库的 data/samples、./data/samples
  --api <地址>      连接运行中的邻至服务（同环境变量 ZDD_API_URL，如 http://localhost:8787）；
                    服务端配置了百度 Key 时可以体检任意地点，否则只能查看样例
  --port <端口>     HTTP 端口，默认 8788（或环境变量 ZDD_MCP_PORT）
  --host <地址>     HTTP 监听地址，默认 127.0.0.1；改成 0.0.0.0 会对局域网开放，请自行评估
  -v, --version     显示版本
  -h, --help        显示本帮助
`;

const log = (msg: string) => process.stderr.write(`[zoudedao-mcp] ${msg}\n`);

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      http: { type: 'boolean' },
      port: { type: 'string' },
      host: { type: 'string' },
      samples: { type: 'string' },
      api: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  const version = packageVersion();
  if (values.version) {
    process.stdout.write(`${version}\n`);
    return;
  }
  // argument errors the SDK reports to the client model read in Chinese too
  z.config(z.locales.zhCN());

  const { backend, describe } = createBackend({
    ...(values.api ? { api: values.api } : {}),
    ...(values.samples ? { samples: values.samples } : {}),
  });
  const samples = await backend.listSamples().catch((err: unknown) => {
    log(`读取样例列表失败：${err instanceof Error ? err.message : String(err)}`);
    return [];
  });
  if (!samples.length && backend.kind === 'local') {
    log(`警告：${describe} 里没有样例。请用 --samples 指定 data/samples 目录，或用 --api 连接邻至服务。`);
  }
  const factory = createServerFactory({ backend, version });
  const onError = (err: Error) => log(`错误：${err.message}`);
  const source = `数据源：${describe}，样例 ${samples.map((s) => `${s.id}（${s.name}）`).join('、') || '无'}`;

  if (values.http) {
    const port = Number(values.port ?? process.env.ZDD_MCP_PORT ?? 8788);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`端口不合法：${values.port}`);
    const host = values.host ?? '127.0.0.1';
    const running = await startHttp(factory, { host, port, onError });
    log(`Streamable HTTP 已启动：${running.url}；${source}`);
    if (host === '0.0.0.0' || host === '::')
      log('注意：已对局域网开放，任何能访问该端口的人都能调用这些工具。');
    const stop = () => {
      void running.close().then(() => process.exit(0));
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    return;
  }
  const handle = serveStdio(factory, { onerror: onError });
  log(`stdio 已启动 v${version}；${source}`);
  const stop = () => {
    void handle.close().then(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main().catch((err: unknown) => {
  log(`启动失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
