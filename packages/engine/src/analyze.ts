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
  type PlacePoi,
  type QuotaBudget,
  type QuotaPlan,
  type ReverseGeocodeResult,
  type RouteMatrix,
  type WalkingRoute,
} from '@zoudedao/baidu';
import {
  applyExclusions,
  barrierPieces,
  buildIsochrone,
  detectBarriers,
  excludedByPattern,
  facilitiesFor,
  facilityStats,
  fieldEstimator,
  HARD_CATEGORIES,
  localFrame,
  planPathProbes,
  planRefinement,
  polarSeed,
  ruleDistance,
  schoolCheck,
  symmetricDifferenceShare,
  visibilityFilter,
  type AnalysisResult,
  type AnalysisStats,
  type Barriers,
  type BarrierPiece,
  type CatchmentList,
  type ExcludedPoi,
  type CommunityReview,
  type FacilityExclusion,
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
  LIVELIHOOD_RADIUS_M,
  MIN_BARRIER_SAMPLES,
  MIN_SEED_SAMPLES,
  PLACE_PAGE_SIZE,
  R15_M,
  WALK_SPEED,
} from './constants.js';
import { detailBrowserPois, withBrowserRows, type BrowserPoiStats } from './browser.js';
import { runCatchment, type CatchmentOutcome } from './catchment.js';
import {
  runCoverage,
  statusCounts,
  worstStatus,
  communityGrayAreas,
  type CheckSet,
  type CoverageOutcome,
  type MatrixFn,
} from './coverage.js';
import { describeError, EngineError, isDegradable, toEngineError } from './errors.js';
import {
  facilityCounts,
  knownRadius,
  LIVELIHOOD_CATEGORIES,
  searchFacilities,
  searchLivelihood,
  searchServices,
  SERVICE_CATEGORIES,
  type FacilitySearch,
  type LivelihoodSearch,
  type ServiceSearch,
} from './facilities.js';
import { validateInput, type Job } from './input.js';
import { runFreshAlternatives } from './fresh.js';
import { fuseOfficial, type FusionResult, type OfficialList } from './official.js';
import { Meter } from './meter.js';
import {
  buildMeta,
  exclusionNote,
  freshNote,
  isochroneNotes,
  liveNotes,
  profileSpeed,
  browserNote,
  residentialNote,
} from './report.js';
import { residentialDemand, type DemandSite, type ResidentialDedupe } from './residential.js';
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
      { browserPois: job.browserPois.length > 0 },
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
      // so are the browser POIs' details, the 买菜替代 search, the 生活服务 and the 民生设施 union, given
      // up in that order: a place quota that fits the checks without them skips them, not the run
      if (client.ledger.blockedBy(plan).includes('place')) {
        const optional = [
          {
            step: 'detail' as const,
            warning: '地点检索今日配额接近上限：本次不查询地图前端补充的设施详情，设施清单只用服务端检索结果',
          },
          {
            step: 'fresh' as const,
            warning:
              '地点检索今日配额接近上限：本次不检索买菜替代（能买菜的超市、果蔬店），菜市场缺口只用已找到的超市与生鲜超市找替代',
          },
          {
            step: 'services' as const,
            warning: `地点检索今日配额接近上限：本次不检索${SERVICE_CATEGORIES.join('、')}，圈内设施统计不含这几类`,
          },
          {
            step: 'livelihood' as const,
            warning: `地点检索今日配额接近上限：本次不检索${LIVELIHOOD_CATEGORIES.join('、')}，圈内设施统计只含逐小区检查的${HARD_CATEGORIES.join('、')}与生鲜超市`,
          },
        ].filter((o) => caps[o.step] > 0);
        let place = svcCaps.place;
        for (const [i, o] of optional.entries()) {
          place -= caps[o.step];
          if (client.ledger.blockedBy({ ...plan, place }).includes('place')) continue;
          for (const skipped of optional.slice(0, i + 1)) {
            caps[skipped.step] = 0;
            warnings.push(skipped.warning);
          }
          svcCaps.place = place;
          if (place > 0) plan.place = place;
          else delete plan.place;
          break;
        }
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
      catchment: deps.catchment ?? [],
      exclusions: deps.exclusions ?? [],
      communityReviews: deps.communityReviews ?? [],
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
  catchment: readonly CatchmentList[];
  exclusions: readonly FacilityExclusion[];
  communityReviews: readonly CommunityReview[];
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
  const rule = Object.fromEntries(HARD_CATEGORIES.map((c) => [c, ruleDistance(c) ?? 1000])) as Record<
    HardCategory,
    number
  >;
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
    rule_m: rule,
    facility_radius_m: facilityRadius,
    now: r.now,
  };
  out.partial({ meta: buildMeta({ ...metaArgs, warnings: warnings.slice() }) });

  // 2. facilities (an isochrone-only run skips them and never calls place search)
  let facilityStage: {
    fac: FacilitySearch;
    browser: BrowserPoiStats | null;
    fused: FusionResult;
    livelihood: LivelihoodSearch | null;
    services: ServiceSearch | null;
    pois: Poi[];
    counts: Record<string, number>;
    excluded: ExcludedPoi[];
  } | null = null;
  if (full) {
    out.stage(
      'facilities',
      `设施检索：${HARD_CATEGORIES.join('、')}，半径 ${(facilityRadius / 1000).toFixed(1)} 公里`,
      0.05,
    );
    let fac = await searchFacilities({
      meter,
      client,
      center,
      frame,
      radius_m: facilityRadius,
      warn: (m) => warnings.push(m),
    });
    // POIs the browser's map found and the searches did not return: their details, cleaned in
    let browser: BrowserPoiStats | null = null;
    if (job.browserPois.length) {
      const known = new Set([
        ...fac.rows.flatMap((row) => (row.uid ? [row.uid] : [])),
        ...fac.pois.flatMap((p) => [p.uid, ...(p.merged_uids ?? [])]),
      ]);
      const found = await detailBrowserPois({
        meter,
        client,
        frame,
        radius_m: facilityRadius,
        offered: job.browserPois,
        known,
        exclusions: r.exclusions,
        onDetail: (fresh, asked) =>
          out.stage(
            'facilities',
            `设施补充：地图前端找到 ${fresh} 处服务端检索没有返回的设施，查询其中 ${asked} 处的地点详情，与检索结果一起清洗`,
            0.07,
          ),
        warn: (m) => warnings.push(m),
      });
      fac = withBrowserRows(fac, found.rows, frame);
      browser = found.stats;
    }
    // curated exclusions go first (and their rows leave the pool, so no list can bring them back) and
    // last (a list entry of the same name loses to the exclusion)
    const excluded: ExcludedPoi[] = [];
    const exclude = (list: readonly Poi[]) => {
      const x = applyExclusions(list, r.exclusions);
      for (const e of x.excluded) if (!excluded.some((y) => y.uid === e.uid)) excluded.push(e);
      return x.pois;
    };
    const excludedUids = new Set(r.exclusions.flatMap((x) => (x.uid ? [x.uid] : [])));
    // name patterns too (a delivery warehouse at a market's address must not be "confirmed" as it)
    const pool = (rows: readonly PlacePoi[]) =>
      rows.filter(
        (row) => !(row.uid && excludedUids.has(row.uid)) && !excludedByPattern(row.name, r.exclusions),
      );
    const district = reverse?.district ?? undefined;
    const counted = (l: OfficialList) => LIVELIHOOD_CATEGORIES.includes(l.category);
    // official lists: confirm, re-classify or add facilities Baidu mis-tags or misses
    const hard = fuseOfficial({
      lists: r.official.filter((l) => !counted(l)),
      pois: exclude(fac.pois),
      dropped: fac.dropped,
      pool: pool(fac.rows),
      frame,
      radius_m: facilityRadius,
      district,
    });
    const checked = exclude(hard.pois);
    // the other 民生设施, for the 圈内设施统计 (counted, never checked per community)
    if (meter.room('livelihood') >= 1) {
      out.stage('facilities', `设施检索：${LIVELIHOOD_CATEGORIES.join('、')}`, 0.08);
    }
    const livelihood = await searchLivelihood({
      meter,
      client,
      center,
      frame,
      existing: checked,
      warn: (m) => warnings.push(m),
    });
    // the everyday services (中学 … 餐饮) for a resident's own 15 minutes, counted like the 民生设施
    if (meter.room('services') >= 1) {
      out.stage('facilities', `设施检索：${SERVICE_CATEGORIES.join('、')}`, 0.09);
    }
    const services = await searchServices({
      meter,
      client,
      center,
      frame,
      existing: livelihood ? [...checked, ...livelihood.pois] : checked,
      warn: (m) => warnings.push(m),
    });
    // lists of counted categories (养老 …) match the 民生设施 rows, within that search's radius
    const soft = fuseOfficial({
      lists: r.official.filter(counted),
      pois: [...checked, ...(livelihood?.pois ?? []), ...(services?.pois ?? [])],
      dropped: hard.dropped,
      pool: pool([...(livelihood?.rows ?? []), ...(services?.rows ?? []), ...fac.rows]),
      frame,
      radius_m: LIVELIHOOD_RADIUS_M,
      district,
    });
    const pois = exclude(soft.pois);
    const fused: FusionResult = {
      pois,
      dropped: [
        ...soft.dropped,
        ...excluded.map((e) => ({ uid: e.uid, name: e.name, reason: `excluded:${e.reason}` })),
      ],
      summaries: [...hard.summaries, ...soft.summaries],
      notes: [...hard.notes, ...soft.notes],
      attribution: [...hard.attribution, ...soft.attribution],
      warnings: [...hard.warnings, ...soft.warnings],
    };
    warnings.push(...fused.warnings);
    const counts = facilityCounts(pois);
    if (browser) browser.kept = pois.filter((p) => p.found_by === 'jsapi').length;
    out.partial({ pois });
    const others =
      (livelihood ? `；${LIVELIHOOD_CATEGORIES.join('、')}共 ${livelihood.pois.length} 处` : '') +
      (services ? `；${SERVICE_CATEGORIES.join('、')}共 ${services.pois.length} 处` : '');
    const fromBrowser = browser?.kept ? `；其中 ${browser.kept} 处由地图前端补充` : '';
    out.stage(
      'facilities',
      `设施：幼儿园 ${counts['幼儿园']} 所、小学 ${counts['小学']} 所、菜市场 ${counts['菜市场']} 个、药店 ${counts['药店']} 家、社区卫生 ${counts['社区卫生']} 处（菜场摊位已并入菜市场）${others}${fromBrowser}`,
      0.1,
    );
    facilityStage = { fac, browser, fused, livelihood, services, pois, counts, excluded };
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
  // 圈内设施统计 needs only the POIs and the final field: it goes out with the isochrone
  if (facilityStage) {
    isoStats.facility_stats = facilityStats({
      pois: facilityStage.pois,
      field: reach.field,
      meta: buildMeta(metaArgs),
    });
  }
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
  const baseline = { ...reach.baseline, rule_radius_m: ruleRadius };

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
  const { fac, browser, fused, livelihood, services, pois, counts, excluded } = facilityStage;

  // 7. coverage: residential gates × candidate facilities
  out.stage('coverage', '盲区判定：检索住宅小区及其出入口', 0.66);
  let demand: DemandSite[] = [];
  /** Baidu's 住宅区 that are no one's home: committee offices and what the community review excluded. */
  let notHomes: { name: string; reason: string }[] = [];
  let demandFound = 0;
  let dedupe: ResidentialDedupe | null = null;
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
      const found = residentialDemand(res.pois, {
        frame,
        extent_m: DEMAND_RADIUS_M,
        max: b.communities,
        reviews: r.communityReviews,
      });
      demand = found.demand;
      notHomes = found.dropped.filter((d) => d.reason === 'committee' || d.reason.startsWith('reviewed:'));
      demandFound = found.found;
      dedupe = found.dedupe;
    } catch (err) {
      if (!isDegradable(err)) throw err;
      warnings.push(`小区检索失败，本次不做盲区判定：${describeError(err)}`);
    }
  } else {
    warnings.push('本次分析没有留出小区检索的预算，不做盲区判定');
  }
  const set: CheckSet = {
    rule,
    facilities: Object.fromEntries(
      HARD_CATEGORIES.filter((c) => c !== '小学').map((c) => [c, facilitiesFor(pois, [c])]),
    ) as Record<HardCategory, Poi[]>,
    knownRadius: Object.fromEntries(HARD_CATEGORIES.map((c) => [c, knownRadius(fac.inventory, c)])) as Record<
      HardCategory,
      number
    >,
  };
  let cov: CoverageOutcome = {
    communities: [],
    gray_areas: [],
    rounds: 0,
    budget_limited: false,
    nearest_routes: 0,
    failed_cells: 0,
    unverified_by_inventory: 0,
    routes: [],
  };
  if (demand.length) {
    out.stage('coverage', `盲区判定：${demand.length} 个小区，小学按官方对口，其余设施逐轮算路`, 0.7);
    cov = await runCoverage({
      meter,
      frame,
      matrix,
      demand,
      set,
      onRound: (round, routes) =>
        out.stage('coverage', `盲区判定第 ${round} 轮：${routes} 条小区到设施的路线`, 0.7 + 0.04 * round),
      onNearest: (routes) =>
        out.stage('coverage', `盲区判定补算：${routes} 条到直线更近设施的路线，取实际步行最近的一处`, 0.86),
      warn: (m) => warnings.push(m),
    });
  }
  for (const c of cov.communities)
    c.checks = Object.fromEntries(
      HARD_CATEGORIES.map((cat) => [cat, cat === '小学' ? schoolCheck(c, rule.小学) : c.checks[cat]]),
    ) as typeof c.checks;
  out.partial({ communities: cov.communities, gray_areas: cov.gray_areas });

  // 7a. 买菜替代: for each 菜市场 check that is a gap, the nearest shop within the rule on foot where
  // vegetables can be bought (informational: verdicts and counts stay)
  const fresh = await runFreshAlternatives({
    meter,
    client,
    center,
    frame,
    matrix,
    radius_m: facilityRadius,
    demand,
    communities: cov.communities,
    pois,
    rows: [...fac.rows, ...(livelihood?.rows ?? [])],
    set,
    routes: cov.routes,
    exclusions: r.exclusions,
    onSearch: (gaps) =>
      out.stage(
        'coverage',
        `买菜替代：${gaps} 个小区的菜市场有缺口，检索判定距离内能买菜的超市、果蔬店（只作参考，不改变判定）`,
        0.862,
      ),
    onRoutes: (routes) => out.stage('coverage', `买菜替代：${routes} 条到最近几家能买菜的店的路线`, 0.865),
    warn: (m) => warnings.push(m),
  });
  if (fresh.counts.gaps) out.partial({ communities: cov.communities });

  // 7b. 对口小学: where an official catchment table covers the centre, route each matched compound to
  // its assigned school's gate
  let catchment: CatchmentOutcome = { stats: null, notes: [] };
  if (cov.communities.length) {
    const region = reverse
      ? {
          ...(reverse.city ? { city: reverse.city } : {}),
          ...(reverse.district ? { district: reverse.district } : {}),
          ...(reverse.town ? { town: reverse.town } : {}),
        }
      : undefined;
    catchment = await runCatchment({
      meter,
      frame,
      matrix,
      lists: r.catchment,
      region,
      demand,
      communities: cov.communities,
      pois,
      official: r.official,
      routes: cov.routes,
      rule_m: rule.小学,
      warn: (m) => warnings.push(m),
    });
    if (catchment.stats) {
      out.stage(
        'coverage',
        `对口小学：${catchment.stats.matched} 个小区匹配到官方对口地段，算到对口学校校门的步行距离`,
        0.87,
      );
      out.partial({ communities: cov.communities });
    }
  }

  for (const c of cov.communities) {
    const worst = worstStatus(Object.values(c.checks));
    if (worst) c.worst_status = worst;
    else delete c.worst_status;
  }
  cov.gray_areas = communityGrayAreas(cov.communities);
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
    community_status_counts: statusCounts(cov.communities, HARD_CATEGORIES),
    facility_counts: counts,
    pois_dropped: fused.dropped.length,
    official: fused.summaries,
    excluded,
    facility_inventory: { ...fac.inventory, ...livelihood?.inventory, ...services?.inventory },
    place_queries: [
      ...fac.queries,
      ...(livelihood ? [livelihood.query] : []),
      ...(services?.queries ?? []),
      ...(fresh.query ? [fresh.query] : []),
    ],
    demand_points: demand.length,
    demand_found: demandFound,
    ...(dedupe ? { residential_dedupe: dedupe } : {}),
    ...(browser ? { browser_pois: browser } : {}),
    ...refineStats,
    coverage_rounds: cov.rounds,
    coverage_budget_limited: cov.budget_limited,
    coverage_nearest_routes: cov.nearest_routes,
    coverage_failed_cells: cov.failed_cells,
    unverified_by_inventory: cov.unverified_by_inventory,
    fresh_alternatives: fresh.counts,
    fresh_alt_routes: fresh.routes,
    fresh_alt_budget_limited: fresh.budget_limited,
    fresh_alt_failed_cells: fresh.failed_cells,
    siting_verified_sites: siting.verified_sites,
    ...(catchment.stats ? { catchment: catchment.stats } : {}),
    quota_used: { ...meter.used },
    quota_by_step: { ...meter.byStep },
    ...requestedStats(),
  };
  const meta = buildMeta({
    ...metaArgs,
    notes: liveNotes({
      profile: job.profile,
      facility_radius_m: facilityRadius,
      demand: demand.length,
      demand_found: demandFound,
      communities_max: b.communities,
      livelihood: livelihood && { found: livelihood.pois.length, inventory: livelihood.inventory },
      services: services && { found: services.pois.length, inventory: services.inventory },
    }).concat(
      residentialNote(dedupe),
      notHomesNote(notHomes),
      browserNote(browser, facilityRadius),
      fused.notes,
      exclusionNote(excluded),
      freshNote(fresh, { radius_m: facilityRadius }),
      catchment.notes,
    ),
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

/** What the demand step left out as no one's home, in a sentence (empty when nothing). */
function notHomesNote(items: readonly { name: string; reason: string }[]): string[] {
  if (!items.length) return [];
  const committees = items.filter((d) => d.reason === 'committee').map((d) => d.name);
  const reviewed = items.filter((d) => d.reason !== 'committee').map((d) => d.name);
  const parts = [
    committees.length ? `${committees.length} 个居委会（${committees.join('、')}）` : '',
    reviewed.length ? `${reviewed.length} 个经人工核实不是独立住宅小区的点（${reviewed.join('、')}）` : '',
  ].filter(Boolean);
  return [`小区识别：百度“住宅区”检索结果中去掉${parts.join('、')}，不计入小区。`];
}
