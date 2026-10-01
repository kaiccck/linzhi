/**
 * Dev-only stand-in for POST /api/analyze (?fakeStream=<sample>): streams a recorded sample the way
 * the engine streams a live check — stage events, then partials with the samples measured so far and
 * the coarse field built from them (core's buildIsochrone at the engine's partial resolution), round
 * by round — so the progressive map can be built and captured without spending any Baidu quota. It
 * never touches /api/analyze. `hold` stops the stream after that stage (for screenshots mid-stream).
 */
import { buildIsochrone, type AnalysisResult, type Poi, type TimeSample } from '@zoudedao/core';
import type { AnalyzeFn, StageEvent } from './api.js';
import { sampleStage, type StageId } from './stream.js';

/** The engine's partial fields: 40 m cells over ±1,600 m, no validation pass. */
const COARSE = { extent_m: 1600, cell_m: 40, loo: false } as const;

const unrouted = ({ center_route_m: _m, center_dur_s: _s, ...poi }: Poi): Poi => poi;

export function fakeAnalyzer(
  load: () => Promise<AnalysisResult>,
  opts: { pace?: number; hold?: string } = {},
) {
  const pace = opts.pace ?? 700;
  const analyzeFake: AnalyzeFn = async (_body, handlers, signal) => {
    const r = await load();
    const wait = (ms: number) =>
      new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            reject(new DOMException('aborted', 'AbortError'));
          },
          { once: true },
        );
      });
    let partial: Partial<AnalysisResult> = {};
    const send = (p: Partial<AnalysisResult>) => {
      partial = { ...partial, ...p };
      handlers.onPartial?.(partial);
    };
    const stage = async (id: StageId, progress: number, message: string) => {
      handlers.onStage?.({ stage: id, progress, message } satisfies StageEvent);
      await wait(pace);
    };
    // held: wait until the check is cancelled (the longest timer a browser keeps)
    const hold = async (id: string) => {
      if (opts.hold === id) await wait(2 ** 31 - 1);
    };
    const coarse = (samples: TimeSample[]) => {
      const iso = buildIsochrone(samples, COARSE);
      return {
        field: iso.field,
        contours: iso.contours,
        contours_meta: iso.contours_meta,
        baseline: iso.baseline,
      };
    };

    const seed = r.samples.filter((s) => sampleStage(s) === 'seed');
    const traced = r.samples.filter((s) => sampleStage(s) === 'path');
    const rounds = [
      ...new Set(r.samples.filter((s) => sampleStage(s) === 'refine').map((s) => s.set ?? '')),
    ].sort();

    await stage(
      'locate',
      0.03,
      `定位：${r.meta.center_label ?? r.meta.name}（开发演示：回放样例，不调用百度）`,
    );
    send({ meta: r.meta });
    await hold('locate');
    await stage('facilities', 0.08, '设施检索：小学、菜市场、药店');
    send({ pois: r.pois.map(unrouted) });
    await hold('facilities');
    await stage('seed', 0.12, `粗采样：16 个方位 × 3 个半径，共 ${seed.length} 条步行路线`);
    send({ samples: seed, ...coarse(seed) });
    await hold('seed');
    await stage('paths', 0.18, `路径采集：沿绕行最明显的 ${r.paths.length} 个方向请求步行路线`);
    let done = [...seed, ...traced];
    send({ paths: r.paths, samples: done, ...coarse(done) });
    await hold('paths');
    for (const [i, set] of rounds.entries()) {
      const batch = r.samples.filter((s) => s.set === set);
      await stage('refine', 0.24 + 0.08 * i, `边界加密第 ${i + 1} 轮：${batch.length} 个点`);
      done = [...done, ...batch];
      send({ samples: done, ...coarse(done) });
      await hold(`refine${i + 1}`);
    }
    await stage('reach', 0.6, '等时圈：按百度实测步速 1.17 米/秒生成 5、10、15 分钟范围');
    send({
      samples: r.samples,
      field: r.field,
      contours: r.contours,
      ...(r.contours_meta ? { contours_meta: r.contours_meta } : {}),
      baseline: r.baseline,
      stats: r.stats,
    });
    await hold('reach');
    await stage('coverage', 0.88, `判定 ${r.communities.length} 个小区 × 3 类设施的步行覆盖`);
    send({ communities: r.communities, ...(r.gray_areas ? { gray_areas: r.gray_areas } : {}) });
    await hold('coverage');
    await stage('report', 0.96, '汇总体检报告');
    return r;
  };
  return analyzeFake;
}
