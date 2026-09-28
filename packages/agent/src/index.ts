/**
 * @zoudedao/agent — the AI layer of 走得到 (技术设计文档 §8): one tool registry shared by the 体检顾问
 * advisor and the MCP server, deterministic reports, and number grounding so an LLM can never state a
 * number that no tool produced.
 */
export * from './types.js';
export * from './format.js';
export * from './analysis.js';
export * from './summary.js';
export * from './rows.js';
export * from './geo.js';
export * from './siting.js';
export * from './report.js';
export * from './backend.js';
export * from './sse.js';
export * from './grounding.js';
export * from './llm.js';
export * from './intent.js';
export * from './advisor.js';
export * from './tools/types.js';
export * from './tools/context.js';
export * from './tools/registry.js';
export { analyzeLifeCircle, analysisSummary, type AnalyzeData } from './tools/analyze.js';
export { compareSites, type CompareRow } from './tools/compare.js';
export { listServiceGaps, type GapsData } from './tools/gaps.js';
export { getIsochrone, featureSummaries } from './tools/isochrone.js';
export { locatePlace } from './tools/locate.js';
export { exportReport, fileId, type ReportData, type ReportFormat } from './tools/report.js';
export { simulateFacility, type SimChange, type SimRow, type SimulateData } from './tools/simulate.js';
