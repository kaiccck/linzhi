/**
 * `plan`: what `run` will ask Baidu for, per step, without calling anything (it reads only the local
 * artefacts, to skip what is already done).
 *
 * Exact: the routes each step asks for (the reference's pending points; star16's 48; engine@B's
 * 48-route seed plus refinement rounds of ≤ 48 up to B — the engine's budget counts cache hits too).
 * Expected billed routes follow from what earlier steps already asked for, which the cache answers:
 * star16's points are the engine's seed; engine@B repeats every round of the smaller budgets before it
 * (same samples → same plan → same points) and only pays for the rest; the default engine's rounds are
 * a prefix of engine@400's; the ablation without barrier detection picks different points and is
 * counted in full. These are upper bounds: real cache hits (earlier runs, refinement points that land on
 * the reference lattice) only lower them.
 */
import type { EvalArea } from './areas.js';
import { areaPaths, readMethods, readReference, type AreaPaths, type MethodArtefact } from './artefacts.js';
import { referenceLattice } from './lattice.js';
import { MATRIX_CHUNK } from './measure.js';
import {
  engineCalls,
  ENGINE_WALKS_MAX,
  measuredMethods,
  STAR16,
  type MethodSpec,
  type StepId,
} from './methods.js';
import { pendingPoints, REF_RADIUS_M, REF_SPACING_M, type ReferenceOptions } from './reference.js';

export const ALL_STEPS: readonly StepId[] = ['reference', 'star16', 'engine'];

export interface PlanStep {
  step: StepId;
  id: string;
  label: string;
  /** Already done (its artefact exists): `run` skips it and calls nothing. */
  done: boolean;
  /** Routes per routematrix call, in order, cached or not. */
  calls: number[];
  /** Routes asked for (Σ calls). */
  routes: number;
  /** Expected HTTP requests: calls with at least one route no earlier step asked for. */
  requests: number;
  /** Expected billed routes (upper bound). */
  billed: number;
  /** Walked routes asked for (directionlite). */
  walks: number;
  /** Expected billed walks, and the most it can be (spare probes when one has no route). */
  walks_billed: number;
  walks_billed_max: number;
  /** The engine's convergence may end it before `routes`. */
  mayStopEarly: boolean;
  note: string;
}

export interface AreaPlan {
  area: EvalArea;
  dir: string;
  reference: { spacing_m: number; radius_m: number; points: number; pending: number };
  steps: PlanStep[];
  totals: {
    routes: number;
    billed: number;
    requests: number;
    walks_billed: number;
    walks_billed_max: number;
  };
}

/** Chunks of ≤ 50 routes (the reference is asked 1 × 50 per call). */
export function chunks(n: number, size = MATRIX_CHUNK): number[] {
  const out: number[] = [];
  for (let left = n; left > 0; left -= size) out.push(Math.min(size, left));
  return out;
}

/** Routematrix calls a method makes: star16 one of 48, engine@B its seed and rounds. */
export function methodCalls(spec: MethodSpec): number[] {
  if (spec.kind === 'star16') return [STAR16.routes];
  if (spec.kind !== 'engine' || !spec.engine) return [];
  const b = spec.engine.budget;
  const refine = b.refine ?? 0;
  const rounds = b.refineRounds ?? Math.ceil(refine / 48);
  return engineCalls(48 + Math.min(refine, rounds * 48));
}

/** What the cache is expected to hold: the seed points, the rounds of each refinement family, the walks. */
class CacheModel {
  seed = false;
  walks = false;
  private readonly rounds = new Map<string, number[]>();

  private family(spec: MethodSpec): string {
    return spec.engine?.barriers === false ? 'no-barrier' : 'barrier';
  }

  /** Billed routes and requests of `calls` for `spec`, then records them as cached. */
  take(spec: MethodSpec, calls: readonly number[]): { billed: number; requests: number } {
    let billed = 0;
    let requests = 0;
    calls.forEach((n, i) => {
      if (i === 0) {
        if (!this.seed) {
          billed += n;
          requests++;
        }
        this.seed = true;
        return;
      }
      const fam = this.family(spec);
      const done = this.rounds.get(fam) ?? [];
      const have = done[i - 1] ?? 0;
      if (n > have) {
        billed += n - have;
        requests++;
        done[i - 1] = n;
      }
      this.rounds.set(fam, done);
    });
    return { billed, requests };
  }

  takeWalks(walks: number): { billed: number; max: number } {
    if (!walks || this.walks) return { billed: 0, max: 0 };
    this.walks = true;
    return { billed: walks, max: ENGINE_WALKS_MAX };
  }
}

/** Calls an existing artefact actually made (its rounds may be fewer than the spec's cap). */
function doneCalls(spec: MethodSpec, art: MethodArtefact): number[] {
  const planned = methodCalls(spec);
  if (spec.kind !== 'engine' || !art.engine) return planned;
  return planned.slice(0, 1 + art.engine.refine_rounds);
}

export function planArea(args: {
  root: string;
  area: EvalArea;
  steps?: readonly StepId[];
  budgets?: readonly number[];
  reference?: ReferenceOptions;
  redo?: boolean;
}): AreaPlan {
  const steps = new Set(args.steps ?? ALL_STEPS);
  const paths: AreaPaths = areaPaths(args.root, args.area.id);
  const ref = readReference(paths);
  const spacing = args.reference?.spacing_m ?? ref?.lattice.spacing_m ?? REF_SPACING_M;
  const radius = args.reference?.radius_m ?? ref?.lattice.radius_m ?? REF_RADIUS_M;
  if (ref && (ref.lattice.spacing_m !== spacing || ref.lattice.radius_m !== radius)) {
    throw new Error(
      `已有的参考网格间距 ${ref.lattice.spacing_m} m、半径 ${ref.lattice.radius_m} m，与本次参数不同；请换一个 --dir`,
    );
  }
  const points = ref ? ref.points.length : referenceLattice(spacing, radius).length;
  const pending = ref ? pendingPoints(ref).length : points;
  const out: PlanStep[] = [];

  if (steps.has('reference')) {
    const calls = chunks(pending);
    out.push({
      step: 'reference',
      id: 'reference',
      label: '参考网格',
      done: pending === 0,
      calls,
      routes: pending,
      requests: calls.length,
      billed: pending,
      walks: 0,
      walks_billed: 0,
      walks_billed_max: 0,
      mayStopEarly: false,
      note: `${spacing} 米格点、${radius} 米圆内共 ${points} 点，待测 ${pending} 点`,
    });
  }

  // artefacts that stay (not redone) were measured before: the cache holds their routes
  const specs = measuredMethods(args.budgets);
  const existing = readMethods(paths);
  const cache = new CacheModel();
  const kept = (spec: MethodSpec) => !args.redo && existing.has(spec.id);
  for (const spec of specs) {
    const art = existing.get(spec.id);
    if (!art || !kept(spec)) continue;
    cache.take(spec, doneCalls(spec, art));
    cache.takeWalks(spec.walks);
  }

  for (const spec of specs) {
    const step = spec.kind === 'star16' ? 'star16' : 'engine';
    if (!steps.has(step)) continue;
    if (kept(spec)) {
      out.push({
        step,
        id: spec.id,
        label: spec.label,
        done: true,
        calls: [],
        routes: 0,
        requests: 0,
        billed: 0,
        walks: 0,
        walks_billed: 0,
        walks_billed_max: 0,
        mayStopEarly: false,
        note: '已完成（产物已存在），跳过',
      });
      continue;
    }
    const calls = methodCalls(spec);
    const { billed, requests } = cache.take(spec, calls);
    const walks = cache.takeWalks(spec.walks);
    const routes = calls.reduce((a, b) => a + b, 0);
    let note: string;
    if (spec.kind === 'star16')
      note = billed ? '16 方位 × 3 半径，一次 1 × 48' : '与引擎粗采样同一批点，命中缓存';
    else if (spec.engine?.barriers === false) note = '关闭断裂检测后加密点不同，按全部新增估计上限';
    else if (spec.mayStopEarly)
      note = `最多 ${calls.length - 1} 轮加密，收敛即停；与前面预算的轮次相同，命中缓存`;
    else if (calls.length === 1) note = spec.walks ? '只做粗采样 + 4 条步行路线' : '只用粗采样的 48 点';
    else note = `粗采样 + ${calls.length - 1} 轮加密（用满预算）；较小预算已测的轮次命中缓存`;
    out.push({
      step,
      id: spec.id,
      label: spec.label,
      done: false,
      calls,
      routes,
      requests,
      billed,
      walks: spec.walks,
      walks_billed: walks.billed,
      walks_billed_max: walks.max,
      mayStopEarly: spec.mayStopEarly,
      note,
    });
  }

  const sum = (k: 'routes' | 'billed' | 'requests' | 'walks_billed' | 'walks_billed_max') =>
    out.reduce((a, s) => a + s[k], 0);
  return {
    area: args.area,
    dir: paths.dir,
    reference: { spacing_m: spacing, radius_m: radius, points, pending },
    steps: out,
    totals: {
      routes: sum('routes'),
      billed: sum('billed'),
      requests: sum('requests'),
      walks_billed: sum('walks_billed'),
      walks_billed_max: sum('walks_billed_max'),
    },
  };
}

// ------------------------------------------------------------------------------------ printing

const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;

/** Display width in a terminal: CJK and full-width characters take two columns. */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += WIDE.test(ch) ? 2 : 1;
  return w;
}

const padEnd = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - displayWidth(s)));
const padStart = (s: string, w: number) => ' '.repeat(Math.max(0, w - displayWidth(s))) + s;
const n = (v: number) => v.toLocaleString('en-US');

export function formatPlan(plan: AreaPlan, relDir = plan.dir): string {
  const a = plan.area;
  const head = [
    '步骤',
    '方法',
    '调用',
    '路线（含缓存）',
    '预计计费路线',
    '预计请求',
    '步行路线（计费）',
    '说明',
  ];
  const rows = plan.steps.map((s) => [
    s.step,
    s.id,
    s.done ? '—' : String(s.calls.length),
    s.done ? '—' : `${s.mayStopEarly ? '≤ ' : ''}${n(s.routes)}`,
    s.done ? '0' : n(s.billed),
    s.done ? '0' : n(s.requests),
    s.done
      ? '—'
      : `${s.walks} (${s.walks_billed}${s.walks_billed_max > s.walks_billed ? `–${s.walks_billed_max}` : ''})`,
    s.note,
  ]);
  const t = plan.totals;
  rows.push([
    '合计',
    '',
    '',
    n(t.routes),
    n(t.billed),
    n(t.requests),
    `(${t.walks_billed}${t.walks_billed_max > t.walks_billed ? `–${t.walks_billed_max}` : ''})`,
    '',
  ]);
  const numeric = new Set([2, 3, 4, 5]);
  const widths = head.map((h, k) => Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[k]!))));
  const fmtRow = (r: string[]) =>
    r
      .map((c, k) =>
        k === r.length - 1 ? c : numeric.has(k) ? padStart(c, widths[k]!) : padEnd(c, widths[k]!),
      )
      .join('  ')
      .trimEnd();
  const lines = [
    `走得到 · 精度–配额评测计划（只读本地产物文件，不调用任何接口）`,
    `区域 ${a.id}：${a.name}（${a.label}），中心 BD-09 ${a.center_bd09.join(', ')}`,
    `产物目录：${relDir}`,
    `参考网格：${plan.reference.spacing_m} 米格点、${plan.reference.radius_m} 米圆内共 ${n(plan.reference.points)} 点，待测 ${n(plan.reference.pending)} 点`,
    '',
    fmtRow(head),
    ...rows.slice(0, -1).map(fmtRow),
    widths.map((w) => '-'.repeat(w)).join('  '),
    fmtRow(rows[rows.length - 1]!),
    '',
    `批量算路：请求 ${n(t.routes)} 条（含缓存命中），预计计费 ≤ ${n(t.billed)} 条（个人档每日 5,000 条），约 ${n(t.requests)} 次 HTTP 请求。`,
    `轻量步行路线：预计计费 ${t.walks_billed} 次（没有路线的方向由备用方向顶上时最多 ${t.walks_billed_max} 次）。地点检索、逆地理编码：0。`,
    `建议：run ${a.id} --max-routes ${t.billed} --max-walks ${Math.max(t.walks_billed_max, t.walks_billed)}（这也是 run 不加参数时的默认上限）。`,
  ];
  return lines.join('\n');
}
