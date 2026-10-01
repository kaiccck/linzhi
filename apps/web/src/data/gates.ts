/**
 * What the server lets this page do with the analysis on screen: ask the advisor about it, and
 * measure a planned site (实测核验). Each gate answers null when it is open, or the reason it is not.
 */
import type { Health } from './api.js';
import type { DataSource } from './loadAnalysis.js';

/** The id POST /api/ask and /api/whatif take: a sample by its id, a live check by the id the server stamped. */
export function analysisIdOf(source: DataSource, id: string, stamped: unknown): string | null {
  const liveId = typeof stamped === 'string' && stamped ? stamped : null;
  if (source === 'api') return id;
  if (source === 'bundled') return null;
  return liveId ?? (source === 'replay' ? id : null);
}

export function askGate(source: DataSource, analysisId: string | null): string | null {
  if (source === 'bundled')
    return '当前页面没有连接服务端，数据来自内置样例文件；用 pnpm dev 或 docker compose up 启动服务后刷新页面即可提问。';
  if (analysisId === null)
    return '这次实时体检的结果没有编号（服务端版本较旧），问询暂时回答不了它；切换到样例后可以提问。';
  return null;
}

/**
 * 实测核验 routes new walks with Baidu: only a live server running the Baidu engine can (sample mode
 * answers 409; the replay analyzer has nothing to measure with). Anything else keeps the button off,
 * so the page never spends quota it was not meant to.
 */
export function measureGate(
  source: DataSource,
  health: Health | null,
  analysisId: string | null,
): string | null {
  if (source === 'bundled' || !health) return '实测核验需要连接邻至服务端。';
  if (health.mode !== 'live') return '服务端为样例模式，不能实测核验；配置百度 Key 后以 live 模式启动即可。';
  if (health.analyzer !== 'engine') return '服务端当前为样例回放，不能实测核验。';
  if (analysisId === null) return '这次结果没有编号，服务端找不到它，不能实测核验。';
  return null;
}
