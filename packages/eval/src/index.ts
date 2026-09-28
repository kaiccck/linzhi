/**
 * @zoudedao/eval — the accuracy–quota evaluation of 走得到 (技术设计文档 §5.9 / §11): how close the
 * isochrone gets to a dense measured reference as a function of Baidu route quota, against the
 * straight-line circle and the 16-bearing ray method. The CLI is src/cli.ts (plan / run / score).
 */
export { AREAS, areaById } from './areas.js';
export type { EvalArea } from './areas.js';
export * from './artefacts.js';
export { CeilingLedger, EvalCeilingError, emptyTally, tallyClient } from './ceiling.js';
export type { Ceilings, Tally } from './ceiling.js';
export { runEngineMethod } from './engineRun.js';
export type { EngineRun } from './engineRun.js';
export * from './lattice.js';
export { cellOf, isFatal, MATRIX_CHUNK, measureFromCenter } from './measure.js';
export type { CellStatus, MatrixClient, MeasuredCell, MeasureResult, MeasureStats } from './measure.js';
export * from './methods.js';
export * from './metrics.js';
export { ALL_STEPS, chunks, displayWidth, formatPlan, methodCalls, planArea } from './plan.js';
export type { AreaPlan, PlanStep } from './plan.js';
export {
  loadOrCreateReference,
  newReference,
  pendingPoints,
  REF_RADIUS_M,
  REF_SPACING_M,
  referenceField,
  referenceSamples,
  runReference,
} from './reference.js';
export type { ReferenceField, ReferenceOptions, ReferenceRun } from './reference.js';
export { markdownReport } from './report.js';
export { isCeilingStop, runArea } from './run.js';
export type { RunReport, StepReport, StepStatus } from './run.js';
export { estimatorOf, RESULTS_VERSION, scoreArea, ScoreNotReady, truthPoints } from './score.js';
export type { MethodResult, ReferenceSummary, Results, ScoreOutput } from './score.js';
export { rayReach, runStar16, starPoints, starPolygon, starRays } from './star16.js';
export type { Star16Run, StarPoint } from './star16.js';
export { accuracyChart, chartSeries, niceCeil, overlayEngineId, overlayMap, textWidth } from './svg.js';
