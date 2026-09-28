/**
 * @zoudedao/engine — the live analysis pipeline of 走得到: a centre point → a complete AnalysisResult,
 * orchestrating @zoudedao/core's algorithms over an injected @zoudedao/baidu client, quota first.
 * Used by the server (SSE), the MCP server and the CLI.
 */
export { analyze, createEngineAnalyzer } from './analyze.js';
export {
  planQuota,
  resolveBudget,
  scopedBudget,
  serviceCaps,
  stepCaps,
  STEP_SERVICE,
  STEP_STAGE,
  TIER_BUDGETS,
} from './budget.js';
export type { QuotaPlanEstimate, QuotaPlanItem, Step } from './budget.js';
export * from './constants.js';
export { EngineError, toEngineError } from './errors.js';
export type { EngineErrorCode } from './errors.js';
export { facilityGroups, groupIndex, inventoryOf, knownRadius, toPlaceResult } from './facilities.js';
export type {
  FacilityGroup,
  FacilitySearch,
  GroupKey,
  Inventory,
  InventoryInfo,
  PlaceQueryLog,
} from './facilities.js';
export { validateInput } from './input.js';
export {
  branchToken,
  fuseOfficial,
  OFFICIAL_MATCH_M,
  OFFICIAL_MATCH_MAX_M,
  streetAddress,
} from './official.js';
export type { FusionResult, OfficialEntry, OfficialList, OfficialSummary } from './official.js';
export type { Job } from './input.js';
export { statusCounts, worstStatus } from './coverage.js';
export type { LiveCommunity } from './coverage.js';
export {
  areaName,
  beijingDate,
  buildMeta,
  centerLabel,
  isochroneNotes,
  liveNotes,
  profileSpeed,
} from './report.js';
export type { LiveMeta } from './report.js';
export { baseName, residentialDemand } from './residential.js';
export type { DemandSite, GateSource, ResidentialOptions, ResidentialResult } from './residential.js';
export { matrixSample, pathLabel, SampleSet, walkedRoute } from './samples.js';
export type { LiveWalkPath } from './samples.js';
export { direction8, pathCandidates } from './siting.js';
export * from './types.js';
