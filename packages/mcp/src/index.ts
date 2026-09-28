/**
 * @zoudedao/mcp — 走得到 as an MCP server (技术设计文档 §8.2). The tools are the same registry the
 * 体检顾问 advisor uses; transports are stdio (cli.ts) and Streamable HTTP (http.ts).
 */
export {
  INSTRUCTIONS,
  SERVER_NAME,
  createServerFactory,
  createZddMcpServer,
  exportUri,
  type ZddMcpOptions,
} from './server.js';
export { startHttp, type HttpOptions, type RunningHttp } from './http.js';
export { createBackend, packageVersion, resolveSamplesDir, type BackendChoice } from './config.js';
