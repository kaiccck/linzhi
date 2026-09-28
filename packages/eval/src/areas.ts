/**
 * Evaluation areas: the sample communities of 技术设计文档 §11.1. The centre is the analysis centre
 * of the live engine (BD-09), so the evaluation measures exactly what the product shows.
 */
import type { LngLat } from '@zoudedao/core';

export interface EvalArea {
  /** Directory name under research/eval/ and the CLI argument (case-insensitive). */
  id: string;
  name: string;
  /** The label the engine gets as input, e.g. a crossing. */
  label: string;
  center_bd09: LngLat;
}

export const AREAS: Readonly<Record<string, EvalArea>> = {
  A: { id: 'A', name: '申城佳苑片区', label: '孙环路 × 高木桥路', center_bd09: [121.644195, 31.19007] },
  V: { id: 'V', name: 'AI 小镇服务中心', label: '海科路1650号', center_bd09: [121.624269, 31.19307] },
  B: { id: 'B', name: '玉兰香苑片区', label: '玉兰香苑', center_bd09: [121.638346, 31.205134] },
  C: { id: 'C', name: '万科翡翠公园片区', label: '万科翡翠公园', center_bd09: [121.618088, 31.185923] },
};

/** The registered area for a CLI argument such as `a` or `V`; throws with the list of known ids. */
export function areaById(id: string, registry: Readonly<Record<string, EvalArea>> = AREAS): EvalArea {
  const area = registry[id.trim().toUpperCase()];
  if (!area) {
    const known = Object.values(registry)
      .map((a) => `${a.id}（${a.name}）`)
      .join('、');
    throw new Error(`未知区域 ${id}：可选 ${known}`);
  }
  return area;
}
