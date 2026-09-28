/**
 * 走得到 · 精度–配额评测 CLI, run with tsx through the package scripts `eval` and `eval:live` (only `run`
 * needs Baidu keys; eval:live loads them from the repository's .env.local)
 *
 *   plan  <区域> [--json]                       expected calls per step; reads local files only
 *   run   <区域> [--steps reference,star16,engine] [--max-routes N] [--max-walks N] [--redo]
 *   score <区域>                                metrics and figures from the artefacts; no network
 *
 * Common: --dir <产物根目录>（默认 research/eval）、--budgets 48,100,200,400,700、--spacing 100、--radius 1600
 * Exit codes: 0 done, 1 usage or error, 2 no usable key, 3 stopped at a ceiling or quota (rerun to continue).
 */
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  BaiduClient,
  loadBaiduConfig,
  openStore,
  SERVICE_LABEL,
  type BaiduClientOptions,
  type Env,
} from '@zoudedao/baidu';

import { AREAS, areaById, type EvalArea } from './areas.js';
import { CeilingLedger } from './ceiling.js';
import { ENGINE_BUDGETS, type StepId } from './methods.js';
import { ALL_STEPS, formatPlan, planArea } from './plan.js';
import { runArea } from './run.js';
import { scoreArea } from './score.js';

export const USAGE = `用法（在仓库根目录执行；eval:live 会读取仓库根目录的 .env.local 里的百度 Key，只有 run 需要）：
  pnpm --filter @zoudedao/eval eval plan <区域> [--json]
  pnpm --filter @zoudedao/eval eval:live run <区域> [--steps reference,star16,engine] [--max-routes N] [--max-walks N] [--redo]
  pnpm --filter @zoudedao/eval eval score <区域>

区域：A（申城佳苑片区）、V（海科路 1650 号）、B（玉兰香苑片区）、C（万科翡翠公园片区）
通用参数：--dir <产物根目录，默认 research/eval>  --budgets 48,100,200,400,700  --spacing 100  --radius 1600
run 不给 --max-routes / --max-walks 时，上限取 plan 算出的预计计费量；超过上限的下一个请求不会发出，运行干净地停止（退出码 3），重跑时从停下的地方继续。`;

/** The repository root: the nearest ancestor of this file with pnpm-workspace.yaml. */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const up = dirname(dir);
    if (up === dir) return process.cwd();
    dir = up;
  }
}

function ints(s: string | undefined, what: string): number[] | undefined {
  if (s === undefined) return undefined;
  const out = s.split(',').map((x) => Number(x.trim()));
  if (!out.length || out.some((v) => !Number.isInteger(v) || v < 0))
    throw new Error(`${what} 须为非负整数，收到 ${s}`);
  return out;
}

function int(s: string | undefined, what: string): number | undefined {
  const v = ints(s, what);
  if (v && v.length !== 1) throw new Error(`${what} 只能是一个整数`);
  return v?.[0];
}

function stepsOf(s: string | undefined): StepId[] {
  if (s === undefined) return [...ALL_STEPS];
  const out = s.split(',').map((x) => x.trim()) as StepId[];
  const bad = out.filter((x) => !ALL_STEPS.includes(x));
  if (bad.length) throw new Error(`未知步骤 ${bad.join(', ')}：可选 ${ALL_STEPS.join(', ')}`);
  return out;
}

/** Everything the CLI touches outside its arguments; tests replace the network and the clock. */
export interface CliIO {
  /** Default process.env (keys, BAIDU_CACHE_PATH, INIT_CWD). */
  env?: Env;
  /** Where relative paths start; default INIT_CWD (pnpm keeps the caller's directory there) or cwd. */
  cwd?: string;
  /** Repository root (default research/eval lives there); default: found from this file. */
  repo?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
  areas?: Readonly<Record<string, EvalArea>>;
  /** Transport and scheduler of the Baidu client (tests: the synthetic city, no waiting). */
  client?: Pick<BaiduClientOptions, 'transport' | 'scheduler'>;
  now?: () => Date;
  /** Listen for Ctrl-C (default true). */
  sigint?: boolean;
}

export async function main(argv: readonly string[], io: CliIO = {}): Promise<number> {
  const env = io.env ?? process.env;
  const out = io.out ?? ((line: string) => console.log(line));
  const err = io.err ?? ((line: string) => console.error(line));
  const now = io.now ?? (() => new Date());
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      json: { type: 'boolean' },
      dir: { type: 'string' },
      steps: { type: 'string' },
      budgets: { type: 'string' },
      spacing: { type: 'string' },
      radius: { type: 'string' },
      'max-routes': { type: 'string' },
      'max-walks': { type: 'string' },
      redo: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [cmd, areaArg] = positionals;
  if (values.help || !cmd || !areaArg || !['plan', 'run', 'score'].includes(cmd)) {
    out(USAGE);
    return values.help ? 0 : 1;
  }
  const area = areaById(areaArg, io.areas ?? AREAS);
  const repo = io.repo ?? repoRoot();
  // pnpm runs package scripts in the package directory: paths typed by the user are relative to INIT_CWD
  const cwd = io.cwd ?? env.INIT_CWD ?? process.cwd();
  const root = values.dir ? resolve(cwd, values.dir) : join(repo, 'research', 'eval');
  const rel = (p: string) => relative(cwd, p) || '.';
  const budgets = ints(values.budgets, '--budgets') ?? [...ENGINE_BUDGETS];
  const spacing = int(values.spacing, '--spacing');
  const radius = int(values.radius, '--radius');
  const reference = {
    ...(spacing !== undefined ? { spacing_m: spacing } : {}),
    ...(radius !== undefined ? { radius_m: radius } : {}),
  };
  const steps = stepsOf(values.steps);
  const redo = values.redo ?? false;

  if (cmd === 'plan') {
    const plan = planArea({ root, area, steps, budgets, reference, redo });
    out(values.json ? JSON.stringify(plan, null, 2) : formatPlan(plan, rel(plan.dir)));
    return 0;
  }

  if (cmd === 'score') {
    const scored = scoreArea({ root, area, now });
    for (const m of scored.results.methods) {
      const mae = m.points.time ? `${m.points.time.mae_s.toFixed(1)} 秒` : '—';
      out(
        `${m.id.padEnd(22)} 路线 ${String(m.cost.routes).padStart(4)}  IoU ${m.region.iou.toFixed(3)}  面积比 ${m.region.area_ratio.toFixed(2)}  准确率 ${(m.points.accuracy * 100).toFixed(1)}%  MAE ${mae}`,
      );
    }
    out(`已写入：${scored.files.map(rel).join('、')}`);
    return 0;
  }

  // run: keys first, before the cache or the network is touched
  const config = loadBaiduConfig(env, { cwd: repo });
  const needs: ('routematrix_walking' | 'directionlite_walking')[] = ['routematrix_walking'];
  if (steps.includes('engine')) needs.push('directionlite_walking');
  const missing = needs.filter((s) => !config.auth[s]);
  if (missing.length) {
    for (const i of config.issues) err(`[${i.level}] ${i.key}：${i.message}`);
    err(
      `${missing.map((s) => SERVICE_LABEL[s]).join('、')}没有可用的 Key：用 pnpm --filter @zoudedao/eval eval:live run …（读取仓库根目录的 .env.local），或用 node --env-file 提供 BAIDU_MATRIX_AK / BAIDU_SERVER_AK`,
    );
    return 2;
  }
  const plan = planArea({ root, area, steps, budgets, reference, redo });
  const maxRoutes = int(values['max-routes'], '--max-routes') ?? plan.totals.billed;
  const maxWalks =
    int(values['max-walks'], '--max-walks') ??
    Math.max(plan.totals.walks_billed_max, plan.totals.walks_billed);
  out(formatPlan(plan, rel(plan.dir)));
  out(
    `\n本次上限：批量算路 ${maxRoutes} 条、轻量步行路线 ${maxWalks} 次；地点检索、逆地理编码、地理编码、坐标转换 0 次。缓存与账本：${rel(config.cachePath)}\n`,
  );
  const store = openStore(config.cachePath, { onWarning: (m) => err(m) });
  const ledger = new CeilingLedger({
    tier: config.tier,
    store,
    caps: {
      routematrix_walking: maxRoutes,
      directionlite_walking: maxWalks,
      place: 0,
      reverse_geocoding: 0,
      geocoding: 0,
      geoconv: 0,
    },
  });
  const client = new BaiduClient({
    config,
    store,
    ledger,
    ...io.client,
    onEvent: (e) => {
      if (e.type === 'retry')
        out(`  重试 ${SERVICE_LABEL[e.service]}（第 ${e.retry} 次，${e.reason}，等待 ${e.delayMs} ms）`);
    },
  });
  const controller = new AbortController();
  const onSigint = () => {
    out('\n收到中断：停止发送新请求，已测结果已保存');
    controller.abort(new Error('用户中断'));
  };
  const listen = io.sigint ?? true;
  if (listen) process.once('SIGINT', onSigint);
  try {
    const t0 = Date.now();
    const report = await runArea({
      client,
      ledger,
      root,
      area,
      steps,
      budgets,
      reference,
      redo,
      now,
      log: out,
      signal: controller.signal,
    });
    const q = ledger.usage('routematrix_walking');
    out(
      `\n本次计费：批量算路 ${report.billed.routes} 条（上限 ${maxRoutes}），轻量步行路线 ${report.billed.walks} 次（上限 ${maxWalks}）；` +
        `今日批量算路累计 ${q.used}/${q.limit}。用时 ${((Date.now() - t0) / 1000).toFixed(0)} 秒。`,
    );
    if (report.stopped) {
      out(`未完成：${report.stopped}\n提高上限后重跑同一命令即可继续（已完成的部分不再计费）。`);
      return 3;
    }
    out(report.scored ? `完成：结果见 ${rel(join(root, area.id, 'results.md'))}` : '完成（未评分）');
    return 0;
  } finally {
    if (listen) process.off('SIGINT', onSigint);
    client.close();
  }
}

// run as a program (tsx src/cli.ts, node dist/cli.js), not when imported
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    },
  );
}
