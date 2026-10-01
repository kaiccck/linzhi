/**
 * What-if with measured routes (技术设计文档 §7.5 "what-if"): a facility of one hard category placed
 * at a site; every community within 1.5 × the rule distance of it (straight line) is routed from the
 * site (one routematrix request, ≤ 30 routes) and its check re-judged with core withNewFacility():
 * before and after under the task rule (1 km), and which communities the new facility newly covers.
 * The web's instant estimate (L̂ from the time field) stays the web's; this is the measured answer.
 */
import type { BaiduClient, RouteMatrix } from '@zoudedao/baidu';
import {
  localFrame,
  ruleDistance,
  shownStatus,
  withNewFacility,
  type AnalysisResult,
  type Community,
  type FacilityCheck,
  type HardCategory,
  type LngLat,
  type ShownStatus,
} from '@zoudedao/core';

/** The one Baidu call a what-if needs. */
export type WhatIfRouter = Pick<BaiduClient, 'routeMatrixWalking'>;

/** Most routes one what-if may spend (one routematrix request). */
export const WHATIF_MAX_ROUTES = 30;
/** Communities up to this multiple of the rule distance (straight line) are routed. */
export const WHATIF_REACH = 1.5;

export interface WhatIfInput {
  category: HardCategory;
  site_bd09: LngLat;
}

export interface WhatIfRow {
  community: string;
  /** Straight line from the community (its gate, or its outline centroid in zj-a) to the site. */
  straight_m: number;
  /** Measured walk between site and community; null = Baidu found no route or the route failed. */
  route_m: number | null;
  dur_s: number | null;
  /** Status under the rule before and after the new facility; 待核实 = not verified. */
  before: ShownStatus;
  after: ShownStatus;
}

export interface WhatIfResult {
  analysis_id: string;
  category: HardCategory;
  /** Always the task rule; kept so branch ids and older clients stay the same. */
  rules: 'task';
  rule_m: number;
  site_bd09: LngLat;
  measured: WhatIfRow[];
  /** Communities whose check was not covered (or not verified) before and is covered after. */
  newly_covered: string[];
  /** Communities within reach that were not routed because of the route cap (farthest first to go). */
  skipped: string[];
  /** Routes Baidu billed for this what-if (cache hits are free), and routes answered from the cache. */
  quota: { routes: number; cached: number };
}

export type WhatIfFailure = { kind: 'no_checks' } | { kind: 'baidu'; error: unknown };

const r1 = (v: number) => Math.round(v * 10) / 10;

function checkOf(c: Community, category: HardCategory): FacilityCheck | undefined {
  return c.checks?.[category];
}

/**
 * Runs one what-if against an analysis: the result, or why it cannot be answered (no checks, or a
 * Baidu error when no route at all came back). Rejects with the signal's reason on abort.
 */
export async function runWhatIf(
  id: string,
  result: AnalysisResult,
  input: WhatIfInput,
  router: WhatIfRouter,
  signal: AbortSignal,
): Promise<WhatIfResult | WhatIfFailure> {
  const { category } = input;
  if (!result.communities?.length) return { kind: 'no_checks' };
  const rule_m = ruleDistance(category) ?? 1000;
  const [lng, lat] = result.meta.center_bd09;
  const frame = localFrame(lng, lat);
  const site = frame.toXY(input.site_bd09[0], input.site_bd09[1]);
  const within = result.communities
    .map((c) => ({ c, straight: Math.hypot(c.centroid[0] - site[0], c.centroid[1] - site[1]) }))
    .filter((x) => x.straight <= rule_m * WHATIF_REACH);
  // gaps first (they are what the new facility is for), nearest first within each group
  const gap = (c: Community) => {
    const k = checkOf(c, category);
    return !k || !k.verified || k.status_main !== '覆盖';
  };
  within.sort((a, b) => Number(gap(b.c)) - Number(gap(a.c)) || a.straight - b.straight);
  const routed = within.slice(0, WHATIF_MAX_ROUTES);
  const skipped = within.slice(WHATIF_MAX_ROUTES).map((x) => x.c.name);
  const base = {
    analysis_id: id,
    category,
    rules: 'task' as const,
    rule_m,
    site_bd09: [input.site_bd09[0], input.site_bd09[1]] as LngLat,
  };
  if (!routed.length)
    return { ...base, measured: [], newly_covered: [], skipped, quota: { routes: 0, cached: 0 } };

  let m: RouteMatrix;
  try {
    m = await router.routeMatrixWalking(
      [base.site_bd09],
      routed.map((x) => frame.toLngLat(x.c.centroid[0], x.c.centroid[1])),
      { signal, partial: true },
    );
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    return { kind: 'baidu', error };
  }
  const cells = m.cells[0] ?? [];
  if (m.errors.length && cells.every((cell) => cell.status === 'failed')) {
    return { kind: 'baidu', error: m.errors[0] };
  }
  const newly: string[] = [];
  const measured: WhatIfRow[] = routed.map(({ c, straight }, j) => {
    const cell = cells[j];
    const ok = cell?.status === 'ok';
    const route_m = ok ? cell.distanceM : null;
    const check = checkOf(c, category);
    const after = withNewFacility(check, { straight_m: straight, route_m }, rule_m);
    const was = !!check && check.verified && check.status_main === '覆盖';
    if (!was && after.verified && after.status_main === '覆盖') newly.push(c.name);
    return {
      community: c.name,
      straight_m: r1(straight),
      route_m,
      dur_s: ok ? cell.durationS : null,
      before: check ? shownStatus(check) : '盲区',
      after: shownStatus(after),
    };
  });
  measured.sort((a, b) => (a.route_m ?? Infinity) - (b.route_m ?? Infinity) || a.straight_m - b.straight_m);
  const newly_covered = measured.map((row) => row.community).filter((n) => newly.includes(n));
  return {
    ...base,
    measured,
    newly_covered,
    skipped,
    quota: { routes: m.stats.routesRequested, cached: m.stats.fromCache },
  };
}
