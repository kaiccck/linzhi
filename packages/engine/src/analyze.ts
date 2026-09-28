/**
 * The live analysis: a centre point → a complete AnalysisResult, reported stage by stage (docs/api.md)
 *
 *   locate → facilities → seed → paths → refine → reach → coverage → report
 *
 * Pure orchestration: every number comes from core's algorithms over the answers of the injected
 * client. Quota first (技术设计文档 §3.1): the run reserves its budget from the ledger, every call goes
 * through the Meter, and each stage stops early when more routes would not change the answer.
 */
import {
  BaiduConfigError,
  BaiduQuotaError,
  type QuotaBudget,
  type QuotaPlan,
  type ReverseGeocodeResult,
  type RouteMatrix,
  type WalkingRoute,
} from '@zoudedao/baidu';
import {
  acceptedCategories,
  barrierPieces,
  buildIsochrone,
  detectBarriers,
  facilitiesFor,
  fieldEstimator,
  HARD_CATEGORIES,
  localFrame,
  planPathProbes,
  planRefinement,
  polarSeed,
  ruleDistance,
  symmetricDifferenceShare,
  visibilityFilter,
  type AnalysisResult,
  type AnalysisStats,
  type Barriers,
  type BarrierPiece,
  type HardCategory,
  type IsochroneResult,
  type Poi,
} from '@zoudedao/core';

import { resolveBudget, scopedBudget, serviceCaps, stepCaps } from './budget.js';
import {
  COARSE_CELL_M,
  CONVERGED_SHARE,
  DEMAND_RADIUS_M,
  EXTENT_M,
  FACILITY_BUFFER_M,
  FINAL_CELL_M,
  LIMIT_S,
  MIN_BARRIER_SAMPLES,
  MIN_SEED_SAMPLES,
  PLACE_PAGE_SIZE,
  R15_M,
  WALK_SPEED,
} from './constants.js';
import { runCoverage, statusCounts, type CoverageOutcome, type MatrixFn } from './coverage.js';
import { describeError, EngineError, isDegradable, toEngineError } from './errors.js';
import { facilityCounts, knownRadius, searchFacilities, type FacilitySearch } from './facilities.js';
import { validateInput, type Job } from './input.js';
import { fuseOfficial, type FusionResult, type OfficialList } from './official.js';
import { Meter } from './meter.js';
import { buildMeta, isochroneNotes, liveNotes, profileSpeed } from './report.js';
import { residentialDemand, type DemandSite } from './residential.js';
import { r3 } from './round.js';
import { matrixSample, pathLabel, SampleSet, walkedRoute, type LiveWalkPath } from './samples.js';
import { runSiting } from './siting.js';
import type {
  BudgetBasis,
  Emit,
  EngineClient,
  EngineDeps,
  EngineInput,
  EngineOptions,
  EngineScope,
  PartialResult,
  QuotaEvent,
  Stage,
} from './types.js';

/**
 * Runs one health check. Progress goes to `emit` ('stage' | 'partial' | 'quota'); the promise resolves
 * with the result or rejects with an EngineError (quota_exhausted | auth | upstream | invalid_input) —
 * or with the signal's reason once `opts.signal` aborted, after which no Baidu call is started and
 * nothing is emitted. Any other exception is a bug and propagates unchanged.
 */
export async function analyze(
  input: EngineInput,
  deps: EngineDeps,
  emit: Emit,
  opts: EngineOptions = {},
): Promise<AnalysisResult> {
  const { signal } = opts;
  let reservation: QuotaBudget | undefined;
  try {
    const job = validateInput(input);
    signal?.throwIfAborted();
    const client = deps.client;
    const scope = opts.scope ?? 'full';
    const budget = scopedBudget(
      resolveBudget(opts.tier ?? client.ledger?.tier ?? 'personal', opts.budget),
      scope,
    );
    if (budget.seed < MIN_SEED_SAMPLES) {
      throw new EngineError(
        'invalid_input',
        `budget.seed 至少为 ${MIN_SEED_SAMPLES} 条路线，否则无法生成等时圈`,
      );
    }
    const caps = stepCaps(budget);
    const svcCaps = serviceCaps(budget);
    const warnings: string[] = [];
    if (client.ledger) {
      const plan: QuotaPlan = {};
      for (const [s, n] of Object.entries(svcCaps) as [keyof typeof svcCaps, number][])
        if (n > 0) plan[s] = n;
      // street names are nice to have: a nearly used-up reverse-geocoding quota must not block the run
      // (and must not be named as the reason when another service does)
      if (client.ledger.blockedBy(plan).includes('reverse_geocoding')) {
        delete plan.reverse_geocoding;
        caps.locate = svcCaps.reverse_geocoding = 0;
        warnings.push('逆地理编码今日配额接近上限：本次不查询街道与小区名称');
      }
      reservation = client.ledger.reserve(plan); // BaiduQuotaError (soft) when anything else is short
    }
    const out = emitter(emit, signal);
    const basis = opts.budgetBasis ?? 'billed';
    const meter = new Meter(caps, svcCaps, {
      ledger: client.ledger,
      budget: reservation,
      signal,
      onQuota: out.quota,
      basis,
    });
    const share = opts.convergeShare;
    return await pipeline({
      job,
      client,
      official: deps.official ?? [],
      now: deps.now?.() ?? new Date(),
      budget,
      meter,
      out,
      warnings,
      scope,
      basis,
      barriers: opts.barriers ?? true,
      convergeShare:
        typeof share === 'number' && Number.isFinite(share) ? Math.max(0, share) : CONVERGED_SHARE,
    });
  } catch (err) {
    if (signal?.aborted) throw signal.reason;
    throw toEngineError(err) ?? err;
  } finally {
    reservation?.release();
  }
}

/** Plugs straight into the server's Analyzer seam (apps/server/src/analyzer.ts). */
export function createEngineAnalyzer(deps: EngineDeps, opts: Omit<EngineOptions, 'signal'> = {}) {
  return {
    name: 'engine' as const,
    analyze: (input: EngineInput, emit: Emit, signal: AbortSignal): Promise<AnalysisResult> =>
      analyze(input, deps, emit, { ...opts, signal }),
  };
}

type Out = ReturnType<typeof emitter>;

/** Drops events after abort and keeps progress non-decreasing. */
function emitter(emit: Emit, signal: AbortSignal | undefined) {
  let progress = 0;
  const live = () => !signal?.aborted;
  return {
    stage(stage: Stage, message: string, p: number) {
      if (!live()) return;
      progress = Math.min(1, Math.max(progress, p));
      emit('stage', { stage, message, progress: Math.round(progress * 1000) / 1000 });
    },
    partial(data: PartialResult) {
      if (live()) emit('partial', data);
    },
    quota(q: QuotaEvent) {
      if (live()) emit('quota', q);
    },
  };
}

interface Coarse {
  /** Adult (routematrix) seconds: what refinement plans on. */
  plan: IsochroneResult;
  /** What partial events show; results always stay in adult seconds (the web converts profiles). */
  view: IsochroneResult;
}

function coarse(samples: SampleSet, barriers: Barriers | null): Coarse {
  const base = {
    extent_m: EXTENT_M,
    cell_m: COARSE_CELL_M,
    loo: false,
    ...(barriers?.segments.length ? { field: { visible: visibilityFilter(barriers) } } : {}),
  };
  const plan = buildIsochrone(samples.list, base);
  return { plan, view: plan };
}

const fieldPart = (iso: IsochroneResult) => ({
  field: iso.field,
  contours: iso.contours,
  contours_meta: iso.contours_meta,
  baseline: iso.baseline,
});

const piecesOf = (b: Barriers | null): BarrierPiece[] => (b ? barrierPieces(b) : []);

async function pipeline(r: {
  job: Job;
  client: EngineClient;
  official: readonly OfficialList[];
  now: Date;
  budget: ReturnType<typeof resolveBudget>;
  meter: Meter;
  out: Out;
  warnings: string[];
  scope: EngineScope;
  basis: BudgetBasis;
  /** Barrier detection on (§5.3); off only for the evaluation's ablation. */
  barriers: boolean;
  convergeShare: number;
}): Promise<AnalysisResult> {
  const { job, client, meter, out, warnings, budget: b } = r;
  const full = r.scope === 'full';
  const barriersOf = (samples: SampleSet): Barriers | null =>
    r.barriers && samples.size >= MIN_BARRIER_SAMPLES ? detectBarriers(samples.timed()) : null;
  const center = job.center;
  const [lng, lat] = center;
  const frame = localFrame(lng, lat);
  const speed = profileSpeed(job.profile);
  // refinement works in routematrix (adult) seconds: the profile's 15 minutes sit at 900 · v / 1.17
  const target = (LIMIT_S * speed) / WALK_SPEED;
  const rule = Object.fromEntries(
    HARD_CATEGORIES.map((c) => [c, ruleDistance(c, job.rules) ?? 1000]),
  ) as Record<HardCategory, number>;
  const facilityRadius = DEMAND_RADIUS_M + FACILITY_BUFFER_M;

  const matrix: MatrixFn = async (step, origins, destinations) => {
    const m = await meter.run(
      step,
      origins.length * destinations.length,
      (o) => client.routeMatrixWalking(origins, destinations, { ...o, partial: true }),
      (res) => res.stats.routesRequested,
    );
    // failed cells are survivable; a key, permission or quota error is not
    const fatal = m.errors.find((e) => e instanceof BaiduConfigError || e instanceof BaiduQuotaError);
    if (fatal) throw fatal;
    return m;
  };

  // 1. locate: the frame is local metres around the centre; reverse geocoding names the place
  out.stage(
    'locate',
    `定位：以 ${lng.toFixed(6)}, ${lat.toFixed(6)} 为中心建立局部坐标系，查询所在街道`,
    0.02,
  );
  let reverse: ReverseGeocodeResult | null = null;
  if (meter.room('locate') >= 1) {
    try {
      reverse = await meter.run(
        'locate',
        1,
        (o) => client.reverseGeocode(center, { ...o, pois: true, radius: 300 }),
        (res) => (res?.via === 'cache' ? 0 : 1),
      );
    } catch (err) {
      if (!isDegradable(err)) throw err;
      warnings.push(`逆地理编码失败，名称改用输入的标签：${describeError(err)}`);
    }
  }
  const metaArgs = {
    center,
    label: job.label,
    reverse,
    profile: job.profile,
    rules: job.rules,
    rule_m: rule,
    facility_radius_m: facilityRadius,
    now: r.now,
  };
  out.partial({ meta: buildMeta({ ...metaArgs, warnings: warnings.slice() }) });

  // 2. facilities (an isochrone-only run skips them and never calls place search)
  let facilityStage: { fac: FacilitySearch; fused: FusionResult; counts: Record<string, number> } | null =
    null;
  if (full) {
    out.stage(
      'facilities',
      `设施检索：小学、菜市场、药店，半径 ${(facilityRadius / 1000).toFixed(1)} 公里`,
      0.05,
    );
    const fac = await searchFacilities({
      meter,
      client,
      center,
      frame,
      rules: job.rules,
      radius_m: facilityRadius,
      warn: (m) => warnings.push(m),
    });
    // official lists: confirm, re-classify or add facilities Baidu mis-tags or misses
    const fused = fuseOfficial({
      lists: r.official,
      pois: fac.pois,
      dropped: fac.dropped,
      pool: fac.rows,
      frame,
      radius_m: facilityRadius,
    });
    warnings.push(...fused.warnings);
    const counts = facilityCounts(fused.pois);
    out.partial({ pois: fused.pois });
    out.stage(
      'facilities',
      `设施：小学 ${counts['小学']} 所、菜市场 ${counts['菜市场']} 个、药店 ${counts['药店']} 家（菜场摊位已并入菜市场）`,
      0.1,
    );
    facilityStage = { fac, fused, counts };
  }

  // 3. seed: 16 bearings × 3 rings in one request; first field as soon as it is back
  const samples = new SampleSet();
  const seedPts = polarSeed({ radius: R15_M }).slice(0, meter.room('seed'));
  out.stage('seed', `粗采样：16 个方位 × 3 个半径，共 ${seedPts.length} 条步行路线`, 0.12);
  if (seedPts.length) {
    const m = await matrix(
      'seed',
      [center],
      seedPts.map((p) => frame.toLngLat(p.xy[0], p.xy[1])),
    );
    seedPts.forEach((p, j) => {
      const s = matrixSample(p.xy, m.cells[0]?.[j], 'seed');
      if (s) samples.add(s);
    });
  }
  if (samples.size < MIN_SEED_SAMPLES) {
    throw new EngineError(
      'upstream',
      `粗采样只得到 ${samples.size} 条可用路线（共 ${seedPts.length} 条），无法生成等时圈，请稍后重试`,
    );
  }
  let iso = coarse(samples, null);
  out.partial({ samples: samples.snapshot(), ...fieldPart(iso.view) });

  // 4. paths: walk the directions with the largest detour; every vertex is a timed sample
  const probes = planPathProbes(samples.list, { radius: R15_M, count: meter.room('paths') });
  out.stage('paths', `路径采集：沿绕行最明显的 ${Math.min(b.paths, probes.length)} 个方向请求步行路线`, 0.18);
  const paths: LiveWalkPath[] = [];
  for (const probe of probes) {
    if (paths.length >= b.paths || meter.room('paths') < 1) break;
    let route: WalkingRoute | null;
    try {
      route = await meter.run(
        'paths',
        1,
        (o) =>
          client.walkingRoute(center, frame.toLngLat(probe.xy[0], probe.xy[1]), { ...o, stepsInfo: true }),
        (res) => (res?.via === 'cache' ? 0 : 1),
      );
    } catch (err) {
      if (!isDegradable(err)) throw err;
      warnings.push(`步行路线 ${pathLabel(probe.bearing_deg)} 失败：${describeError(err)}`);
      continue;
    }
    if (!route?.steps.length) continue; // no route that way: the next probe takes its place
    const w = walkedRoute(route, frame, probe, paths.length, EXTENT_M);
    paths.push(w.path);
    for (const s of w.samples) samples.add(s);
  }
  let barriers = barriersOf(samples);
  iso = coarse(samples, barriers);
  out.partial({
    paths: paths.slice(),
    samples: samples.snapshot(),
    ...fieldPart(iso.view),
    barriers: piecesOf(barriers),
  });

  // 5. refine: rounds of points near the uncertain boundary and the detected barriers
  let rounds = 0;
  let converged = false;
  let lastChange: number | null = null;
  for (let round = 1; round <= b.refineRounds; round++) {
    const room = meter.room('refine');
    if (room < 1) break;
    const picks = planRefinement(samples.list, iso.plan.grid, {
      batch: Math.min(48, room),
      target,
      barriers,
      speed: WALK_SPEED,
    });
    if (!picks.length) break;
    const nearBarrier = barriers?.segments.length ? '，优先靠近已发现的阻隔' : '';
    out.stage(
      'refine',
      `边界加密第 ${round} 轮：${picks.length} 个点${nearBarrier}`,
      0.24 + 0.08 * (round - 1),
    );
    let m: RouteMatrix;
    try {
      m = await matrix(
        'refine',
        [center],
        picks.map((c) => frame.toLngLat(c.xy[0], c.xy[1])),
      );
    } catch (err) {
      if (!isDegradable(err)) throw err;
      warnings.push(`边界加密第 ${round} 轮失败，等时圈按已有样本生成：${describeError(err)}`);
      break;
    }
    let added = 0;
    picks.forEach((c, j) => {
      const s = matrixSample(c.xy, m.cells[0]?.[j], `refine${round}`);
      if (s && samples.add(s)) added++;
    });
    if (!added) {
      warnings.push(`边界加密第 ${round} 轮没有拿到可用路线，停止加密`);
      break;
    }
    rounds = round;
    barriers = barriersOf(samples);
    const next = coarse(samples, barriers);
    lastChange = symmetricDifferenceShare(iso.plan.grid, next.plan.grid, target);
    iso = next;
    out.partial({ samples: samples.snapshot(), ...fieldPart(iso.view), barriers: piecesOf(barriers) });
    if (lastChange < r.convergeShare) {
      converged = true;
      break;
    }
  }

  // 6. reach: the final field in routematrix (adult) seconds, whatever the profile: one canonical
  // result per centre, and clients derive the elder view by scaling times (no new routes either way)
  out.stage(
    'reach',
    job.profile === 'elder'
      ? '等时圈：按百度实测步速 1.17 米/秒生成，老年人视图按 0.9 米/秒换算'
      : '等时圈：按百度实测步速 1.17 米/秒生成 5、10、15 分钟范围',
    0.6,
  );
  const visible = barriers?.segments.length ? visibilityFilter(barriers) : undefined;
  const reach = buildIsochrone(samples.list, {
    extent_m: EXTENT_M,
    cell_m: FINAL_CELL_M,
    ...(visible ? { field: { visible } } : {}),
  });
  const pieces = piecesOf(barriers);
  const isoStats: AnalysisStats = { ...reach.stats };
  out.partial({ ...fieldPart(reach), stats: isoStats, barriers: pieces });
  const refineStats = {
    refine_rounds: rounds,
    refine_converged: converged,
    refine_last_change: lastChange === null ? null : r3(lastChange),
    barrier_segments: barriers?.segments.length ?? 0,
  };
  // with the requested basis the budgets count cache hits too: say what the run asked for
  const requestedStats = () =>
    r.basis === 'requested'
      ? {
          budget_basis: r.basis,
          quota_requested: { ...meter.requested },
          quota_requested_by_step: { ...meter.requestedByStep },
        }
      : {};
  const ruleRadius = Math.max(...HARD_CATEGORIES.map((c) => rule[c]));
  const baseline = {
    ...reach.baseline,
    rule_radius_m: ruleRadius,
    ...(job.rules === 'gb50180'
      ? { note: `${reach.baseline.note}; rules = GB 50180-2018: 小学/菜市场 500 m, 药店 300 m` }
      : {}),
  };

  if (!facilityStage) {
    // isochrone scope: the result ends with the field; no facilities, demand points or verdicts
    out.stage('report', '生成等时圈结果（本次只生成等时圈，不做设施与盲区分析）', 0.96);
    return {
      meta: buildMeta({ ...metaArgs, notes: isochroneNotes(job.profile), warnings }),
      communities: [],
      pois: [],
      samples: samples.snapshot(),
      paths,
      field: reach.field,
      contours: reach.contours,
      contours_meta: reach.contours_meta,
      baseline,
      stats: {
        ...isoStats,
        scope: r.scope,
        ...refineStats,
        quota_used: { ...meter.used },
        quota_by_step: { ...meter.byStep },
        ...requestedStats(),
      },
      barriers: pieces,
      gray_areas: [],
      site_suggestions: {},
    };
  }
  const { fac, fused, counts } = facilityStage;
  const pois = fused.pois;

  // 7. coverage: residential gates × candidate facilities
  out.stage('coverage', '盲区判定：检索住宅小区及其出入口', 0.66);
  let demand: DemandSite[] = [];
  let demandFound = 0;
  const resPages = meter.room('residential');
  if (resPages >= 1) {
    try {
      const res = await meter.run(
        'residential',
        resPages,
        (o) =>
          client.placeAround(['住宅区', '小区'], center, {
            ...o,
            radius: DEMAND_RADIUS_M,
            maxPages: resPages,
            pageSize: PLACE_PAGE_SIZE,
          }),
        (x) => x.apiCalls,
        (x) => x.pages,
      );
      const found = residentialDemand(res.pois, { frame, extent_m: DEMAND_RADIUS_M, max: b.communities });
      demand = found.demand;
      demandFound = found.found;
    } catch (err) {
      if (!isDegradable(err)) throw err;
      warnings.push(`小区检索失败，本次不做盲区判定：${describeError(err)}`);
    }
  } else {
    warnings.push('本次分析没有留出小区检索的预算，不做盲区判定');
  }
  const facilities = Object.fromEntries(
    HARD_CATEGORIES.map((c) => [c, facilitiesFor(pois, acceptedCategories(c, job.rules))]),
  ) as Record<HardCategory, Poi[]>;
  const known = Object.fromEntries(
    HARD_CATEGORIES.map((c) => [c, knownRadius(fac.inventory, c, job.rules)]),
  ) as Record<HardCategory, number>;
  let cov: CoverageOutcome = {
    communities: [],
    gray_areas: [],
    rounds: 0,
    budget_limited: false,
    failed_cells: 0,
    unverified_by_inventory: 0,
  };
  if (demand.length) {
    out.stage('coverage', `盲区判定：${demand.length} 个小区 × 3 类设施，逐轮算路，找到覆盖即停`, 0.7);
    cov = await runCoverage({
      meter,
      frame,
      matrix,
      demand,
      facilities,
      rule,
      knownRadius: known,
      onRound: (round, routes) =>
        out.stage('coverage', `盲区判定第 ${round} 轮：${routes} 条小区到设施的路线`, 0.7 + 0.04 * round),
      warn: (m) => warnings.push(m),
    });
  }
  out.partial({ communities: cov.communities, gray_areas: cov.gray_areas });

  // 8. siting: candidates along the walked routes, the top ones verified with measured routes
  out.stage('coverage', '规划建议：在步行路线沿线为有缺口的设施类别选址', 0.88);
  const siting = await runSiting({
    meter,
    frame,
    matrix,
    communities: cov.communities,
    gates: new Map(demand.map((d) => [d.name, d.bd09])),
    paths,
    rule,
    estimator: fieldEstimator(reach.rho, visible ? { visible } : {}),
    warn: (m) => warnings.push(m),
  });
  out.partial({ site_suggestions: siting.suggestions });

  // 9. report
  out.stage('report', '生成体检报告', 0.96);
  const stats: AnalysisStats = {
    ...isoStats,
    community_status_counts: statusCounts(cov.communities),
    facility_counts: counts,
    pois_dropped: fused.dropped.length,
    official: fused.summaries,
    facility_inventory: fac.inventory,
    place_queries: fac.queries,
    demand_points: demand.length,
    demand_found: demandFound,
    ...refineStats,
    coverage_rounds: cov.rounds,
    coverage_budget_limited: cov.budget_limited,
    coverage_failed_cells: cov.failed_cells,
    unverified_by_inventory: cov.unverified_by_inventory,
    siting_verified_sites: siting.verified_sites,
    quota_used: { ...meter.used },
    quota_by_step: { ...meter.byStep },
    ...requestedStats(),
  };
  const meta = buildMeta({
    ...metaArgs,
    notes: liveNotes({
      profile: job.profile,
      rules: job.rules,
      facility_radius_m: facilityRadius,
      demand: demand.length,
      demand_found: demandFound,
      communities_max: b.communities,
    }).concat(fused.notes),
    warnings,
    sources: fused.attribution,
  });
  return {
    meta,
    communities: cov.communities,
    pois,
    samples: samples.snapshot(),
    paths,
    field: reach.field,
    contours: reach.contours,
    contours_meta: reach.contours_meta,
    baseline,
    stats,
    barriers: pieces,
    gray_areas: cov.gray_areas,
    site_suggestions: siting.suggestions,
  };
}
