/**
 * `run`: executes the steps in order — reference → star16 → engine variants — writing every artefact as
 * soon as it exists, and stops cleanly at the first request the ceiling (or Baidu's quota, or a key
 * problem) refuses. Rerunning continues where it stopped: measured reference points are skipped,
 * finished methods are skipped, and anything asked before is answered by the cache for free.
 */
import type { BaiduClient } from '@zoudedao/baidu';
import { EngineError } from '@zoudedao/engine';

import type { EvalArea } from './areas.js';
import { areaPaths, methodFile, readMethods, writeJson } from './artefacts.js';
import { EvalCeilingError, type CeilingLedger } from './ceiling.js';
import { runEngineMethod } from './engineRun.js';
import { measuredMethods, type StepId } from './methods.js';
import { ALL_STEPS } from './plan.js';
import { runReference, type ReferenceOptions } from './reference.js';
import { scoreArea, ScoreNotReady } from './score.js';
import { runStar16 } from './star16.js';

export type StepStatus = 'done' | 'skipped' | 'stopped';

export interface StepReport {
  step: StepId;
  id: string;
  status: StepStatus;
  /** Routes asked for (cached or not), routes and walks billed in this run, HTTP requests. */
  routes: number;
  routes_billed: number;
  requests: number;
  walks: number;
  walks_billed: number;
  wall_ms: number;
  message?: string;
}

export interface RunReport {
  area: EvalArea;
  steps: StepReport[];
  /** What this process billed, against the ceilings. */
  billed: { routes: number; walks: number };
  ceilings: { routes: number | null; walks: number | null };
  /** The error that ended the run early, or null. */
  stopped: string | null;
  /** results.json and figures were written. */
  scored: boolean;
  files: string[];
}

export async function runArea(args: {
  client: BaiduClient;
  ledger: CeilingLedger;
  root: string;
  area: EvalArea;
  steps?: readonly StepId[];
  budgets?: readonly number[];
  reference?: ReferenceOptions;
  redo?: boolean;
  now?: () => Date;
  log?: (line: string) => void;
  signal?: AbortSignal;
}): Promise<RunReport> {
  const { client, ledger, root, area } = args;
  const now = args.now ?? (() => new Date());
  const log = args.log ?? (() => {});
  const steps = new Set(args.steps ?? ALL_STEPS);
  const paths = areaPaths(root, area.id);
  const report: RunReport = {
    area,
    steps: [],
    billed: { routes: 0, walks: 0 },
    ceilings: {
      routes: ledger.cap('routematrix_walking') ?? null,
      walks: ledger.cap('directionlite_walking') ?? null,
    },
    stopped: null,
    scored: false,
    files: [],
  };
  const finish = () => {
    report.billed = {
      routes: ledger.billed('routematrix_walking'),
      walks: ledger.billed('directionlite_walking'),
    };
    return report;
  };
  const stop = (r: StepReport, err: Error) => {
    r.status = 'stopped';
    r.message = err.message;
    report.stopped = `${r.id}：${err.message}`;
    log(`停止：${report.stopped}`);
  };
  const sig = args.signal ? { signal: args.signal } : {};

  if (steps.has('reference')) {
    const t0 = performance.now();
    const res = await runReference({
      client,
      root,
      area,
      now,
      log,
      ...(args.reference ? { opts: args.reference } : {}),
      ...sig,
    });
    const s = res.session;
    const r: StepReport = {
      step: 'reference',
      id: 'reference',
      status: s.calls ? 'done' : 'skipped',
      routes: s.routes,
      routes_billed: s.routes_billed,
      requests: s.requests,
      walks: 0,
      walks_billed: 0,
      wall_ms: Math.round(performance.now() - t0),
    };
    report.steps.push(r);
    report.files.push(paths.reference);
    const c = res.artefact.counts;
    log(
      `参考网格：本次 ${s.calls} 次调用、计费 ${s.routes_billed} 条（缓存 ${s.routes_cached} 条）；共 ${c.points} 点，有路线 ${c.ok}，无路线 ${c.no_route}，失败 ${c.failed}，未测 ${c.pending}`,
    );
    if (res.stopped) {
      stop(r, res.stopped);
      return finish();
    }
  }

  const existing = readMethods(paths);
  for (const spec of measuredMethods(args.budgets)) {
    const step = spec.kind === 'star16' ? 'star16' : 'engine';
    if (!steps.has(step)) continue;
    const r: StepReport = {
      step,
      id: spec.id,
      status: 'skipped',
      routes: 0,
      routes_billed: 0,
      requests: 0,
      walks: 0,
      walks_billed: 0,
      wall_ms: 0,
    };
    report.steps.push(r);
    if (!args.redo && existing.has(spec.id)) {
      log(`${spec.id}：产物已存在，跳过`);
      continue;
    }
    const routesBefore = ledger.billed('routematrix_walking');
    const walksBefore = ledger.billed('directionlite_walking');
    const t0 = performance.now();
    const res =
      spec.kind === 'star16'
        ? await runStar16({ client, area, now, ...sig })
        : await runEngineMethod({ spec, client, ledger, area, now, ...sig });
    r.wall_ms = Math.round(performance.now() - t0);
    r.routes_billed = ledger.billed('routematrix_walking') - routesBefore;
    r.walks_billed = ledger.billed('directionlite_walking') - walksBefore;
    if (res.stopped || !res.artefact) {
      stop(r, res.stopped ?? new Error('没有产物'));
      return finish();
    }
    const a = res.artefact;
    Object.assign(r, {
      status: 'done',
      routes: a.cost.routes,
      requests: a.cost.requests,
      walks: a.cost.walks,
    });
    writeJson(methodFile(paths, spec.id), a);
    report.files.push(methodFile(paths, spec.id));
    log(
      `${spec.id}：请求 ${a.cost.routes} 条（计费 ${r.routes_billed}）、步行路线 ${a.cost.walks} 次（计费 ${r.walks_billed}），${(r.wall_ms / 1000).toFixed(1)} 秒` +
        (a.engine ? `；加密 ${a.engine.refine_rounds} 轮，样本 ${a.engine.n_samples}` : ''),
    );
  }

  try {
    const scored = scoreArea({ root, area, now });
    report.scored = true;
    report.files.push(...scored.files);
    log(`评分：${scored.files.length} 个文件已写入 ${paths.dir}`);
  } catch (err) {
    // only "nothing to score yet" is expected here; anything else is a bug and must surface
    if (!(err instanceof ScoreNotReady)) throw err;
    log(`未评分：${err.message}`);
  }
  return finish();
}

/** An EngineError from the evaluation's own ceiling (not Baidu's quota). */
export function isCeilingStop(err: unknown): boolean {
  const cause = err instanceof EngineError ? err.cause : err;
  return cause instanceof EvalCeilingError;
}
