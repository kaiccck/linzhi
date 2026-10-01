import { setTimeout as delay } from 'node:timers/promises';
import type { AnalysisResult, Poi } from '@zoudedao/core';
import type { AnalyzeInput, Analyzer, Emit, Stage } from './analyzer.js';
import { MemoryQuotaLedger } from './quota.js';

/** The recorded analysis replayed in live mode until the Baidu-backed analyzer is wired in. */
export const REPLAY_SAMPLE_ID = 'zj-a';

export interface SampleReplayOptions {
  /** Loads the recorded result to replay. */
  load: () => Promise<AnalysisResult>;
  /** Delay multiplier: 1 ≈ 11 s end to end, 0 = no delays. */
  pace?: number;
  ledger?: MemoryQuotaLedger;
}

/** Facilities as first found by place search: walking routes from the centre come later (reach). */
function unrouted({ center_route_m: _m, center_dur_s: _s, ...poi }: Poi): Poi {
  return poi;
}

/**
 * Stand-in for the live engine: streams a recorded analysis stage by stage (docs/技术设计文档.md §3.3)
 * so the web app can build its streaming UI without keys. The input centre is ignored and Baidu is
 * never called; quota events follow the per-analysis budget of §4.4 and are counted in `ledger`.
 */
export class SampleReplayAnalyzer implements Analyzer {
  readonly name = 'replay';
  readonly ledger: MemoryQuotaLedger;
  readonly #load: () => Promise<AnalysisResult>;
  readonly #pace: number;

  constructor(options: SampleReplayOptions) {
    this.#load = options.load;
    this.#pace = options.pace ?? 1;
    this.ledger = options.ledger ?? new MemoryQuotaLedger();
  }

  async analyze(input: AnalyzeInput, emit: Emit, signal: AbortSignal): Promise<AnalysisResult> {
    const wait = async (ms: number) => {
      if (this.#pace > 0) await delay(ms * this.#pace, undefined, { signal });
      signal.throwIfAborted();
    };
    const stage = (stage: Stage, progress: number, message: string) =>
      emit('stage', { stage, progress, message });
    const charge = (service: string, count: number) => emit('quota', this.ledger.charge(service, count));

    signal.throwIfAborted();
    const r = await this.#load();
    const routed = r.samples.filter((s) => s.src === 'routematrix');
    const traced = r.samples.filter((s) => s.src === 'directionlite_path');
    const seed = routed.slice(0, 48);
    const firstRound = routed.slice(48, 96);
    const routedPois = r.pois.filter((p) => p.center_route_m !== undefined).length;
    const elder = input.profile === 'elder' ? '；老年人画像暂按成人步速回放' : '';

    stage(
      'locate',
      0.03,
      `样例回放：定位「${r.meta.center_label ?? r.meta.name}」（不使用输入坐标，不调用百度接口${elder}）`,
    );
    await wait(300);
    charge('reverse_geocoding', 1);
    emit('partial', { meta: r.meta, baseline: r.baseline, venue: r.venue, base: r.base });
    await wait(400);

    stage('facilities', 0.1, '检索周边设施：小学、菜市场、药店等');
    await wait(700);
    charge('place', 3);
    emit('partial', { pois: r.pois.map(unrouted) });
    await wait(300);

    stage('seed', 0.2, `粗采样：16 个方位 × 3 个半径，共 ${seed.length} 条步行路线`);
    await wait(1200);
    charge('routematrix_walking', 48);
    emit('partial', { samples: seed });
    await wait(300);

    stage('paths', 0.35, `沿 ${r.paths.length} 个方向采集步行路径`);
    await wait(900);
    charge('directionlite_walking', r.paths.length);
    emit('partial', { paths: r.paths, samples: [...seed, ...traced] });
    await wait(300);

    stage('refine', 0.5, '边界带加密采样：第 1/2 轮');
    await wait(1000);
    charge('routematrix_walking', 48);
    emit('partial', { samples: [...seed, ...traced, ...firstRound] });
    stage('refine', 0.65, '边界带加密采样：第 2/2 轮');
    await wait(1000);
    charge('routematrix_walking', 48);
    emit('partial', {
      samples: r.samples,
      field: r.field,
      contours: r.contours,
      contours_meta: r.contours_meta,
    });
    await wait(300);

    stage('reach', 0.78, `计算中心到 ${routedPois} 处设施的步行距离`);
    await wait(800);
    charge('routematrix_walking', routedPois);
    emit('partial', { pois: r.pois });
    await wait(200);

    stage('coverage', 0.88, `判定 ${r.communities.length} 个小区 × 3 类设施的步行覆盖`);
    await wait(1500);
    charge('routematrix_walking', r.communities.length * 3 * 2);
    // like the engine: the 灰色区域 come with the checks they are drawn from
    emit('partial', { communities: r.communities, ...(r.gray_areas ? { gray_areas: r.gray_areas } : {}) });
    await wait(300);

    stage('report', 0.96, '汇总体检报告');
    await wait(400);
    emit('partial', { stats: r.stats });
    await wait(200);
    return r;
  }
}
