import { describeLlm, LlmError, llmConfigFromEnv, type LlmConfig } from '@zoudedao/agent';
import { createBaiduClient, loadBaiduConfig, type BaiduClient } from '@zoudedao/baidu';
import { buildApp } from './app.js';
import { ConfigError, findRepoRoot, loadConfig, loadEnvFiles, type ServerConfig } from './config.js';
import { createLiveAnalyzer } from './live.js';
import { loadOfficialData } from './official.js';

const root = findRepoRoot();
const envFiles = loadEnvFiles(root);

let config: ServerConfig;
// 体检顾问: LLM_BASE_URL + LLM_MODEL (+ LLM_API_KEY, LLM_EXTRA_BODY); none → template answers
let llm: LlmConfig | null;
try {
  config = loadConfig(process.env, root);
  llm = llmConfigFromEnv(process.env);
} catch (err) {
  if (!(err instanceof ConfigError) && !(err instanceof LlmError)) throw err;
  console.error(`配置错误：${err.message}`);
  process.exit(1);
}

// The client (with its SQLite cache and quota ledger) exists only when live calls are possible.
// Its warnings (e.g. node:sqlite missing → memory store) arrive before the app logger exists.
const early: string[] = [];
let warn = (message: string): void => void early.push(message);
let baidu: BaiduClient | undefined;
if (config.mode === 'live' && config.baidu.live) {
  baidu = createBaiduClient({
    config: loadBaiduConfig(process.env, { cwd: root }),
    onWarning: (message) => warn(message),
  });
}

const official = baidu
  ? loadOfficialData(config.officialDir, (message) => warn(message))
  : { lists: [], catchments: [], exclusions: [], communityReviews: [] };
const app = await buildApp({
  config,
  baidu,
  analyzer: baidu && createLiveAnalyzer(baidu, official),
  llm,
});
warn = (message) => app.log.warn(message);
early.forEach(warn);
app.log.info(
  {
    mode: config.mode,
    version: config.version,
    envFiles,
    baidu: baidu && { tier: config.baidu.tier, store: baidu.store.kind, cachePath: config.baidu.cachePath },
    // "model @ host" only: the key and the rest of the URL never reach the log
    advisor: llm ? { mode: 'llm', model: describeLlm(llm) } : { mode: 'template' },
    samplesDir: config.samplesDir,
    // live results (30 days), what-if branches and walking routes; 'memory' = gone on restart
    history: config.historyPath ?? 'memory',
    official: [
      ...official.lists.map((l) => `${l.id}（${l.entries.length} 条）`),
      ...official.catchments.map((c) => `${c.id}（对口地段，${c.schools.length} 所学校）`),
      ...(official.exclusions.length ? [`exclusions（${official.exclusions.length} 条）`] : []),
      ...(official.communityReviews.length ? [`小区核实（${official.communityReviews.length} 条）`] : []),
    ],
    webDistDir: config.webDistDir,
    trustProxy: config.trustProxy,
  },
  '配置已加载',
);

let closing = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, '正在关闭服务');
  setTimeout(() => {
    app.log.error('关闭超时，强制退出');
    process.exit(1);
  }, 10_000).unref();
  try {
    await app.close(); // stops accepting, ends open SSE streams, waits for requests, closes the Baidu client
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, '关闭失败');
    process.exit(1);
  }
}
// `once`: a second Ctrl-C falls back to Node's default and exits immediately.
process.once('SIGINT', (signal) => void shutdown(signal));
process.once('SIGTERM', (signal) => void shutdown(signal));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (err) {
  app.log.error({ err }, '启动失败');
  process.exit(1);
}
