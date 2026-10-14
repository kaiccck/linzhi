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
export { BROWSER_KEYWORDS, detailBrowserPois, withBrowserRows } from './browser.js';
export type { BrowserDetail, BrowserPoiStats } from './browser.js';
export * from './constants.js';
export { EngineError, toEngineError } from './errors.js';
export type { EngineErrorCode } from './errors.js';
export {
  facilityGroups,
  groupIndex,
  inventoryOf,
  knownRadius,
  LIVELIHOOD_CATEGORIES,
  LIVELIHOOD_GROUPS,
  LIVELIHOOD_KEYWORDS,
  livelihoodPois,
  searchLivelihood,
  searchServices,
  SERVICE_CATEGORIES,
  SERVICE_QUERIES,
  toPlaceResult,
} from './facilities.js';
export type {
  FacilityGroup,
  FacilitySearch,
  FreshGroupKey,
  GroupKey,
  Inventory,
  InventoryInfo,
  LivelihoodKey,
  LivelihoodSearch,
  PlaceQueryLog,
  ServiceKey,
  ServiceSearch,
} from './facilities.js';
export { FRESH_GROUPS, FRESH_KEYWORDS, freshPool, runFreshAlternatives } from './fresh.js';
export type { FreshCounts, FreshOutcome } from './fresh.js';
export { BROWSER_POIS_MAX, browserPois, validateInput } from './input.js';
export { abortable, Meter } from './meter.js';
export {
  branchToken,
  fuseOfficial,
  OFFICIAL_MATCH_M,
  OFFICIAL_MATCH_MAX_M,
  OFFICIAL_MATCH_RADII,
  officialNameKey,
  radiiOf,
  sameStreet,
  streetAddress,
} from './official.js';
export type { FusionResult, MatchRadii, OfficialEntry, OfficialList, OfficialSummary } from './official.js';
export { runCatchment } from './catchment.js';
export type { CatchmentOutcome, CatchmentStats } from './catchment.js';
export type { Job } from './input.js';
export { runCoverage, setCategories, statusCounts, worstStatus, communityGrayAreas } from './coverage.js';
export type { CheckSet, CoverageOutcome, LiveCommunity, MatrixFn } from './coverage.js';
export {
  areaName,
  beijingDate,
  browserNote,
  buildMeta,
  centerLabel,
  exclusionNote,
  freshNote,
  isochroneNotes,
  liveNotes,
  profileSpeed,
  residentialNote,
} from './report.js';
export type { LiveMeta, LivelihoodNote } from './report.js';
export {
  ALIAS_RADIUS_M,
  baseName,
  compoundKey,
  MISPLACED_RADIUS_M,
  residentialDemand,
} from './residential.js';
export type {
  DedupeItem,
  DemandSite,
  GateSource,
  ResidentialDedupe,
  ResidentialOptions,
  ResidentialResult,
} from './residential.js';
export { matrixSample, pathLabel, SampleSet, walkedRoute } from './samples.js';
export type { LiveWalkPath } from './samples.js';
export { direction8, pathCandidates, runSiting } from './siting.js';
export * from './types.js';
