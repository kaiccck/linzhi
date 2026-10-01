/**
 * 坐标输入: a centre typed as coordinates skips text geocoding. BD-09 is used as is; GCJ-02 and WGS84
 * go through Baidu's coordinate conversion (geoconv/v2, cached like every Baidu call) and are
 * cross-checked against core's public formulas, which agree with geoconv to better than 1 m in
 * Shanghai (research/api-probe/raw/02*_geoconv_*). Without a client (sample mode) or when geoconv
 * fails, the formulas answer on their own and the response says so.
 */
import { BaiduError, GEOCONV_MODEL, type BaiduClient } from '@zoudedao/baidu';
import { gcj02ToBd09, haversine, wgs84ToBd09, type LngLat } from '@zoudedao/core';
import { untilAborted } from './abort.js';
import { forClient } from './redact.js';

export type Crs = 'bd09' | 'gcj02' | 'wgs84';
export const CRS_VALUES: readonly Crs[] = ['bd09', 'gcj02', 'wgs84'];

/** How center_bd09 was obtained from the typed point. */
export type ConvertedVia = 'baidu_geoconv' | 'local' | 'none';

/** geoconv and the local formula disagreeing by more than this means the input CRS is doubtful. */
export const CONVERSION_TOLERANCE_M = 10;

export const CRS_ZH: Readonly<Record<Crs, string>> = {
  bd09: 'BD-09（百度地图）',
  gcj02: 'GCJ-02（高德、腾讯地图）',
  wgs84: 'WGS84（GPS、OpenStreetMap）',
};

export type GeoconvClient = Pick<BaiduClient, 'geoconv'>;

export interface Conversion {
  /** Rounded to 6 decimals (≈ 0.1 m). */
  center_bd09: LngLat;
  converted_via: ConvertedVia;
  /** Why this point, in Chinese (shown next to the candidate). */
  reason: string;
  warnings: string[];
}

const round6 = (v: number) => Number(v.toFixed(6));
const fmtM = (m: number) => (m < 10 ? m.toFixed(1) : String(Math.round(m)));

function local(point: LngLat, crs: Exclude<Crs, 'bd09'>): LngLat {
  return crs === 'gcj02' ? gcj02ToBd09(point[0], point[1]) : wgs84ToBd09(point[0], point[1]);
}

/**
 * The typed point in BD-09. `client` absent: local formulas only (sample mode). geoconv failing for
 * any Baidu reason (quota, key, network, deadline) falls back to the formula with a warning; anything
 * else is a bug and propagates.
 */
export async function toBd09(
  point: LngLat,
  crs: Crs,
  client: GeoconvClient | undefined,
  signal?: AbortSignal,
): Promise<Conversion> {
  if (crs === 'bd09') {
    return {
      center_bd09: [round6(point[0]), round6(point[1])],
      converted_via: 'none',
      reason: '输入的是 BD-09 坐标（百度地图坐标系），直接作为中心点，不需要转换',
      warnings: [],
    };
  }
  const formula = local(point, crs);
  const byFormula = (reason: string, warnings: string[]): Conversion => ({
    center_bd09: [round6(formula[0]), round6(formula[1])],
    converted_via: 'local',
    reason,
    warnings,
  });
  if (!client) {
    return byFormula(
      `输入的是 ${CRS_ZH[crs]}坐标，按公开的坐标转换公式换算为 BD-09（样例模式不调用百度接口）`,
      [],
    );
  }
  const model = crs === 'gcj02' ? GEOCONV_MODEL.GCJ02_TO_BD09 : GEOCONV_MODEL.WGS84_TO_BD09;
  let converted: LngLat;
  try {
    const call = client.geoconv([point], { model, ...(signal ? { signal } : {}) });
    const [answer] = signal ? await untilAborted(call, signal) : await call;
    if (!answer) throw new Error('geoconv returned no point');
    converted = answer;
  } catch (err) {
    if (!(err instanceof BaiduError) && !signal?.aborted) throw err;
    const why = signal?.aborted ? '超时' : forClient(err instanceof BaiduError ? err.message : String(err));
    return byFormula(`输入的是 ${CRS_ZH[crs]}坐标，按公开的坐标转换公式换算为 BD-09`, [
      `百度坐标转换暂不可用（${why}），已改用本地公式换算；两者在上海实测相差不到 1 米`,
    ]);
  }
  const delta = haversine(converted[0], converted[1], formula[0], formula[1]);
  const warnings =
    delta > CONVERSION_TOLERANCE_M
      ? [
          `百度坐标转换结果与本地公式相差 ${fmtM(delta)} 米（超过 ${CONVERSION_TOLERANCE_M} 米），已采用百度的结果；请确认输入的确实是 ${CRS_ZH[crs]}坐标`,
        ]
      : [];
  return {
    center_bd09: [round6(converted[0]), round6(converted[1])],
    converted_via: 'baidu_geoconv',
    reason: `输入的是 ${CRS_ZH[crs]}坐标，经百度坐标转换服务转为 BD-09，与本地公式相差 ${fmtM(delta)} 米`,
    warnings,
  };
}
