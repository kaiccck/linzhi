/** Meta block of a live result: names, frame, provenance and the honest list of what live mode lacks. */
import type { ReverseGeocodeResult } from '@zoudedao/baidu';
import type { AnalysisMeta, HardCategory, LngLat, RuleSet } from '@zoudedao/core';

import { DEMAND_RADIUS_M, ELDER_SPEED_MPS, ENGINE_VERSION, EXTENT_M, WALK_SPEED } from './constants.js';
import type { Profile } from './types.js';

/** AnalysisMeta plus the live-mode fields (the web ignores what it does not know). */
export interface LiveMeta extends AnalysisMeta {
  mode: 'live';
  profile: Profile;
  /**
   * The profile's walking speed, for clients to convert with; field, contours and stats stay in routematrix
   * (1.17 m/s) seconds for every profile, like walk_speed_mps.
   */
  profile_speed_mps: number;
  rules: RuleSet;
  rule_m: Record<HardCategory, number>;
  facility_radius_m: number;
  /** Reverse-geocoded address of the centre, e.g. 上海市浦东新区张江镇孙环路174号. */
  address?: string;
  notes: string[];
  /** Steps that degraded (a failed optional lookup, an exhausted budget line), in Chinese. */
  warnings: string[];
}

export const profileSpeed = (profile: Profile) => (profile === 'elder' ? ELDER_SPEED_MPS : WALK_SPEED);

/** Beijing date of `now`, as Baidu's quota day. */
export function beijingDate(now: Date): string {
  return new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

function frameFormula([lng, lat]: LngLat): string {
  // the web parses this sentence (apps/web/src/geo/frame.ts): plain decimals only
  return `x = (lng - ${lng}) * 111320 * cos(${lat} deg), y = (lat - ${lat}) * 110574, lng/lat in BD-09`;
}

/** Display name of the analysed area (meta.name): estate, else searched place, else street. */
export function areaName(
  center: LngLat,
  label: string | undefined,
  rev: ReverseGeocodeResult | null,
): string {
  const residential = (tag: string | null | undefined) => !!tag?.includes('住宅区');
  const inside = rev?.regions.filter((r) => r.name && (r.relation === '内' || r.relation === null)) ?? [];
  // a housing estate the centre lies in names the area best: 申城佳苑 → 申城佳苑片区
  const home = inside.find((r) => residential(r.tag));
  if (home) return `${home.name}片区`;
  // a searched place name, unless it is a crossing (孙环路 × 高木桥路); an estate's name gets 片区,
  // anything else (an office, a service centre) is only the landmark the area sits around
  const name = label?.replace(/[（(][^）)]*[）)]/g, '').trim();
  if (name && !/[×x✕]/.test(name)) {
    const estate = rev?.pois.some((p) => residential(p.tag) && p.name.startsWith(name));
    return estate ? `${name}片区` : `${name}周边`;
  }
  if (inside[0]) return `${inside[0].name}周边`;
  const near = rev?.pois.find((p) => residential(p.tag) && p.name);
  if (near) return `${near.name}周边`;
  if (rev?.street) return `${rev.town ?? ''}${rev.street}周边`;
  if (label) return label;
  return `${center[0].toFixed(5)}, ${center[1].toFixed(5)} 周边`;
}

export function centerLabel(label: string | undefined, rev: ReverseGeocodeResult | null): string | undefined {
  if (label) return label;
  if (rev?.street) return `${rev.street}${rev.streetNumber ?? ''}`;
  return rev?.semanticDescription || rev?.formattedAddress || undefined;
}

export function buildMeta(args: {
  center: LngLat;
  label: string | undefined;
  reverse: ReverseGeocodeResult | null;
  profile: Profile;
  rules: RuleSet;
  rule_m: Record<HardCategory, number>;
  facility_radius_m: number;
  now: Date;
  notes?: string[];
  warnings?: string[];
  /** More sources for the attribution, e.g. official lists. */
  sources?: string[];
}): LiveMeta {
  const { center, reverse: rev } = args;
  const day = beijingDate(args.now);
  const meta: LiveMeta = {
    name: areaName(center, args.label, rev),
    center_bd09: [center[0], center[1]],
    frame: 'local meters, x east, y north, origin at center',
    frame_formula: frameFormula(center),
    extent_m: EXTENT_M,
    walk_speed_mps: WALK_SPEED,
    generated: args.now.toISOString(),
    generator: `@zoudedao/engine ${ENGINE_VERSION}（实时分析）`,
    attribution: [
      `Routes, POIs and addresses: Baidu Maps Web Service (百度地图开放平台：批量算路、轻量步行路线、地点检索 v3、逆地理编码 v3), called ${day}`,
      '实时模式不使用 OpenStreetMap 数据：没有底图路网、水系与小区轮廓，河道与高架只从百度步行耗时推断',
      ...(args.sources ?? []),
    ],
    mode: 'live',
    profile: args.profile,
    profile_speed_mps: profileSpeed(args.profile),
    rules: args.rules,
    rule_m: args.rule_m,
    facility_radius_m: args.facility_radius_m,
    notes: args.notes ?? [],
    warnings: args.warnings ?? [],
  };
  const cl = centerLabel(args.label, rev);
  if (cl) meta.center_label = cl;
  if (rev) {
    const region: NonNullable<AnalysisMeta['region']> = {};
    if (rev.city) region.city = rev.city;
    if (rev.district) region.district = rev.district;
    if (rev.town) region.town = rev.town;
    if (Object.keys(region).length) meta.region = region;
    if (rev.formattedAddress) meta.address = rev.formattedAddress;
  }
  // barrier_names stays unset: walking-route instructions name the roads walked, never the river or
  // expressway that forced the detour, and the client has no reverse-geocoding `roads`; names are
  // never guessed, so the web falls back to generic wording
  return meta;
}

const FIELD_NOTE =
  '耗时场由百度批量算路与步行路线样本插值（绕行系数 ρ 的去趋势插值）得到；河道、高架等阻隔由样本之间的耗时矛盾（Lipschitz 断裂）推断，barriers 列出检出的断裂段。';

const elderNote = () =>
  `老年人画像：field、contours 与 stats 仍按百度路线的 ${WALK_SPEED} 米/秒保存，老年人视图由前端按 ${ELDER_SPEED_MPS} 米/秒换算（耗时 × ${(WALK_SPEED / ELDER_SPEED_MPS).toFixed(2)}）；采样加密围绕老年人的 15 分钟边界进行。`;

/** What a reader of a live result must know (Chinese, shown next to the report). */
export function liveNotes(args: {
  profile: Profile;
  rules: RuleSet;
  facility_radius_m: number;
  demand: number;
  demand_found: number;
  communities_max: number;
}): string[] {
  const notes = [
    '小区没有轮廓：百度的小区边界（AOI）属于付费服务，实时模式下 communities[].pts 为空，centroid 是小区出入口（优先取 navi_location）。',
    `需求点是地点检索“住宅区$小区”得到的小区出入口：同名子点（××-1号门、××东门、××-3号楼）已合并，限于中心 ${DEMAND_RADIUS_M} 米内（15 分钟直线圈），取最近的 ${args.communities_max} 个；本次 ${args.demand} 个（检出 ${args.demand_found} 个）。`,
    `设施检索半径 ${args.facility_radius_m} 米，即需求点范围 ${DEMAND_RADIUS_M} 米外加 1 公里缓冲，避免边缘小区出现假盲区；菜场摊位并入所属菜市场，不单独计数。`,
    FIELD_NOTE,
    'verified = false 的判定与 site_suggestions 中 verified = false 的建议只是估算：前者还有候选设施没算路，或设施清单在该距离外可能不全；后者没有用实测路线核验。',
  ];
  if (args.profile === 'elder') notes.push(elderNote());
  if (args.rules === 'gb50180') {
    notes.push(
      '国标口径（GB 50180-2018）：小学、菜市场或生鲜超市 500 米，药店 300 米；生鲜超市可替代菜市场。',
    );
  }
  return notes;
}

/** Notes of an isochrone-only result (scope `isochrone`). */
export function isochroneNotes(profile: Profile): string[] {
  const notes = [
    '本次只生成等时圈（scope = isochrone）：没有检索设施，也没有做盲区判定与选址，pois 与 communities 为空。',
    FIELD_NOTE,
  ];
  if (profile === 'elder') notes.push(elderNote());
  return notes;
}
