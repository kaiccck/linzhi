/** Meta block of a live result: names, frame, provenance and the honest list of what live mode lacks. */
import type { ReverseGeocodeResult } from '@zoudedao/baidu';
import {
  FRESH_ALT_K,
  FRESH_RULE_TEXT,
  HARD_CATEGORIES,
  TASK_CATEGORIES,
  TASK_RULE_M,
  type AnalysisMeta,
  type ExcludedPoi,
  type HardCategory,
  type LngLat,
} from '@zoudedao/core';

import {
  DEMAND_RADIUS_M,
  ELDER_SPEED_MPS,
  ENGINE_VERSION,
  EXTENT_M,
  LIVELIHOOD_PAGES,
  LIVELIHOOD_RADIUS_M,
  WALK_SPEED,
} from './constants.js';
import type { BrowserPoiStats } from './browser.js';
import { LIVELIHOOD_CATEGORIES } from './facilities.js';
import type { FreshOutcome } from './fresh.js';
import { ALIAS_RADIUS_M, type ResidentialDedupe } from './residential.js';
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

/** How far out each group of the 民生设施 union is known, for the note (engine facilities.ts). */
export interface LivelihoodNote {
  /** 民生设施 added to the inventory. */
  found: number;
  inventory: Partial<Record<string, { complete: boolean; radius_m: number }>>;
}

function livelihoodNote(l: LivelihoodNote | null | undefined): string {
  const others = LIVELIHOOD_CATEGORIES.join('、');
  if (!l) {
    return `本次没有检索${others}（地点检索预算不足或检索失败），圈内设施统计（stats.facility_stats）只含逐小区检查的${HARD_CATEGORIES.join('、')}与生鲜超市。`;
  }
  const cut = Object.entries(l.inventory)
    .filter(([, inv]) => inv && !inv.complete)
    .map(([cat, inv]) => `${cat}只统计到离中心 ${Math.round(inv!.radius_m)} 米`);
  return (
    `民生设施：${others}用一次地点检索（$ 并集，半径 ${LIVELIHOOD_RADIUS_M} 米，最多 ${LIVELIHOOD_PAGES} 页）补充 ${l.found} 处，` +
    '与已有设施重复的不重复计入，地铁站的各出入口算一个站。stats.facility_stats 按成人步速统计各类设施：清单数、15 分钟步行可达数、直线 15 分钟圆内数与最近一处的步行时间，老年人视图由前端按 0.9 米/秒换算。' +
    (cut.length ? `检索页数用完：${cut.join('，')}。` : '')
  );
}

/** Which categories every community was checked for, and by what rule. */
function checkedNote(): string {
  const rules = [...new Set(HARD_CATEGORIES.map((c) => TASK_RULE_M[c]))];
  const rule =
    rules.length === 1
      ? `一律按步行 ${rules[0]! / 1000} 公里内可达判定`
      : HARD_CATEGORIES.map((c) => `${c}步行 ${TASK_RULE_M[c]} 米`).join('、');
  return (
    `逐小区检查 ${HARD_CATEGORIES.length} 类设施：${HARD_CATEGORIES.join('、')}（社区卫生含社区卫生服务中心与服务站），${rule}，` +
    `各类判定方法相同（communities[].checks）；其中${TASK_CATEGORIES.join('、')}是赛题点名的三类。`
  );
}

/** What a reader of a live result must know (Chinese, shown next to the report). */
export function liveNotes(args: {
  profile: Profile;
  facility_radius_m: number;
  demand: number;
  demand_found: number;
  communities_max: number;
  /** The 民生设施 search; null when it did not run. */
  livelihood?: LivelihoodNote | null;
}): string[] {
  const notes = [
    checkedNote(),
    '小区没有轮廓：百度的小区边界（AOI）属于付费服务，实时模式下 communities[].pts 为空，centroid 是小区出入口（优先取 navi_location）。',
    `需求点是地点检索“住宅区$小区”得到的小区出入口：同名子点（××-1号门、××东门、××-3号楼）已合并，限于中心 ${DEMAND_RADIUS_M} 米内（15 分钟直线圈），取最近的 ${args.communities_max} 个；本次 ${args.demand} 个（检出 ${args.demand_found} 个）。`,
    `设施检索半径 ${args.facility_radius_m} 米，即需求点范围 ${DEMAND_RADIUS_M} 米外加 1 公里缓冲，避免边缘小区出现假盲区；菜场摊位并入所属菜市场，不单独计数。`,
    livelihoodNote(args.livelihood),
    FIELD_NOTE,
    'verified = false 的判定与 site_suggestions 中 verified = false 的建议只是估算：前者还有候选设施没算路，或设施清单在该距离外可能不全；后者没有用实测路线核验。',
  ];
  if (args.profile === 'elder') notes.push(elderNote());
  return notes;
}

/**
 * One line on the curated exclusions that removed facilities here (none: no line). POIs removed for
 * the same reason (one name pattern, e.g. several stations of a delivery brand) share one item.
 */
export function exclusionNote(excluded: readonly ExcludedPoi[]): string[] {
  if (!excluded.length) return [];
  const groups = new Map<string, { names: string[]; e: ExcludedPoi }>();
  for (const e of excluded) {
    const key = `${e.category}\n${e.reason}\n${e.date}`;
    const g = groups.get(key);
    if (g) g.names.push(e.name);
    else groups.set(key, { names: [e.name], e });
  }
  const items = [...groups.values()]
    .map(
      ({ names, e }) =>
        `${names.join('、')}（${e.category}：${e.reason.replace(/[。.]+$/, '')}，${e.date} 核实）`,
    )
    .join('；');
  return [`排除清单（data/official/exclusions.json）：去掉 ${excluded.length} 处百度 POI——${items}。`];
}

/**
 * One line on the 买菜替代 of the 菜市场 gaps (none without a gap): the rule, where the candidates came
 * from and what was found.
 */
export function freshNote(
  f: Pick<FreshOutcome, 'counts' | 'query' | 'known_m'>,
  opts: { radius_m: number },
): string[] {
  const c = f.counts;
  if (!c.gaps) return [];
  const more = [
    ...(c.none ? [`${c.none} 个判定距离内步行没有`] : []),
    ...(c.not_looked ? [`${c.not_looked} 个未下结论`] : []),
  ];
  const counts = `${c.gaps} 个菜市场缺口中 ${c.with_alt} 个有替代${more.length ? `、${more.join('、')}` : ''}`;
  const where = f.query
    ? `候选来自已检索到的设施和一次“${f.query.keywords}”地点检索（半径 ${opts.radius_m} 米` +
      (f.query.complete
        ? '，结果取全）'
        : `，检索页数用完，离中心 ${Math.round(f.known_m)} 米外的店可能不全）`)
    : '本次没有做买菜替代检索（地点检索预算不足或检索失败），只用已检索到的超市与生鲜超市';
  return [
    `买菜替代（checks.菜市场.alt）：${FRESH_RULE_TEXT}${where}，每个缺口小区用百度批量算路实测到判定距离内最近 ${FRESH_ALT_K} 家候选的步行距离；` +
      `${counts}。未下结论（没有 alt 字段）表示算路预算用完、算路失败，或候选可能不全。`,
  ];
}

/**
 * One line on the compounds the residential dedupe merged or dropped (none: no line), naming them; the
 * full list is stats.residential_dedupe.items.
 */
export function residentialNote(d: ResidentialDedupe | null | undefined): string[] {
  if (!d?.items.length) return [];
  const of = (rule: string) => d.items.filter((i) => i.rule === rule);
  const merged = (rule: string) =>
    of(rule)
      .map((i) => `${i.name}并入${i.into}`)
      .join('、');
  const parts = [
    ...(d.parents_dropped
      ? [
          `${of('parent_of_phases')
            .map((i) => i.name)
            .join('、')}下设的各期都在清单里，母小区不再单列，由各期分别判定`,
        ]
      : []),
    ...(d.children_merged ? [`百度只列出一个子点的小区合并子点（${merged('parent_child')}）`] : []),
    ...(d.numeral_merged ? [`期号写法不同（I期、1期、一期）的同一期合并（${merged('phase_numeral')}）`] : []),
    ...(d.misplaced_dropped
      ? [
          `去掉地址与位置都指向同一小区另一期的错位点位（${of('misplaced_phase')
            .map((i) => `${i.name}（地址与位置都指向 ${i.points_to}）`)
            .join('、')}）`,
        ]
      : []),
    ...(d.alias_merged
      ? [`地址写明另一小区且相距不到 ${ALIAS_RADIUS_M} 米的点位合并（${merged('alias')}）`]
      : []),
  ];
  return [
    `小区去重：百度把大型小区的母点与各期（parent_id）、同一期的不同写法和同一小区的别名分别列出，本次${parts.join('；')}。只凭地址相同不合并，相邻而名称不同的小区各自判定；明细见 stats.residential_dedupe。`,
  ];
}

/** One line on the facilities only the browser's map found (none kept: no line). */
export function browserNote(b: BrowserPoiStats | null | undefined, radius_m: number): string[] {
  if (!b?.offered) return [];
  const limited = b.budget_limited ? '，详情查询预算用完，其余未补充' : '';
  return [
    `地图前端补充：浏览器地图检索（JSAPI）列出 ${b.offered} 处设施，其中 ${b.new} 处在设施检索半径 ${radius_m} 米内而百度服务端检索没有返回，` +
      `按 uid 查询地点详情 ${b.detailed} 处${limited}；按百度标签与服务端检索结果一起清洗（餐饮、只卖水果的店、茶饮和线上买菜的前置仓照常剔除），` +
      `计入 ${b.kept} 处（pois[].found_by = "jsapi"）。`,
  ];
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
