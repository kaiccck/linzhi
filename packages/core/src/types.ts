/**
 * Wire model of one community health check (体检). The server produces it, the web app renders it,
 * and data/samples/*.json store it. Field names stay snake_case to match the JSON on disk.
 *
 * Frames:
 *  - LngLat: BD-09 longitude/latitude unless a field says otherwise (Baidu's native frame).
 *  - XY: local metres around the analysis centre, x east, y north (see AnalysisMeta.frame_formula).
 */
import type { LngLat, XY } from './coords.js';
import type { FacilityStat } from './facility-stats.js';

export type { LngLat, XY };

/** Walking-time thresholds with pre-computed isochrone rings, in seconds. */
export type IsoLevel = '300' | '600' | '900';

/** Four-state rule for "can this community walk to a facility of this category within 1 km?" */
export type CheckStatus = '覆盖' | '伪覆盖' | '盲区' | '临界';
/** Three-state main verdict (临界 is an extra flag on top of one of these). */
export type MainStatus = '覆盖' | '伪覆盖' | '盲区';

/** Hard indicators named by the competition task. */
export type HardCategory = '小学' | '菜市场' | '药店';
export type FacilityCategory =
  HardCategory | '生鲜超市' | '幼儿园' | '社区卫生' | '养老' | '超市' | '公交' | '地铁' | '公园' | '其他';

export interface AnalysisMeta {
  /** Display name of the analysed area, e.g. 申城佳苑片区. */
  name: string;
  /** Human label of the centre point, e.g. 孙环路 × 高木桥路. */
  center_label?: string;
  center_bd09: LngLat;
  frame: string;
  frame_formula: string;
  /** Half-size of the analysed square, metres. */
  extent_m: number;
  /** Baidu routematrix walking speed (distance / duration), m/s. Measured 1.17. */
  walk_speed_mps: number;
  generated: string;
  generator?: string;
  attribution: string[];
  /** Administrative context of the centre from reverse geocoding, e.g. 上海市 / 浦东新区 / 张江镇. */
  region?: { city?: string; district?: string; town?: string };
  /**
   * Named obstacles behind the worst-detour direction, e.g. ['河道', 'S20 外环']. Only set when a
   * source names them; clients fall back to generic wording otherwise.
   */
  barrier_names?: string[];
}

/**
 * Where FacilityCheck.route_m comes from; absent means 'routed' (as in all sample data).
 *  - routed: shortest measured Baidu walking route among the routed candidates.
 *  - lower_bound: no facility's routing point lies within the rule distance, so nothing was routed;
 *    route_m is the straight distance to the nearest routing point, a proven lower bound (L ≥ r).
 *  - estimated: candidates exist but none has been routed yet; route_m = ρ̂ × straight. Always comes
 *    with verified = false.
 *  - none: the facility inventory has no facility of the category at all; distances are -1.
 */
export type RouteBasis = 'routed' | 'lower_bound' | 'estimated' | 'none';

/** Why a shop counts as a 买菜替代 (core freshKind). */
export type FreshKind = '生鲜超市' | '果蔬店' | '超市';

/** 买菜替代: a shop within the rule on foot where vegetables can be bought, for a 菜市场 check that is a gap. Informational: the verdict stays. */
export interface FreshAlternative {
  name: string;
  uid: string;
  /** why it counts */
  kind: FreshKind;
  /** Local metres, the analysis frame: the shop's routing point (entrance when Baidu knows it). */
  xy: XY;
  /** Straight line from the community to `xy`, metres (the walk ends there too). */
  straight_m: number;
  /** Measured routematrix walking distance, metres. */
  route_m: number;
  dur_s: number;
}

export interface FacilityCheck {
  /** Straight-line distance to the nearest facility of the category, metres. */
  straight_m: number;
  nearest_straight?: string;
  /** Shortest measured walking route among routed candidates, metres (see route_basis when not routed). */
  route_m: number;
  dur_s: number;
  /** Facility reached by the shortest route. */
  via?: string;
  via_uid?: string;
  via_straight_m?: number;
  via_stall_of?: string;
  status: CheckStatus;
  status_main: MainStatus;
  /** |route_m − 1000| ≤ 50. */
  borderline: boolean;
  /** Only some candidates were routed; a nearer unrouted one may be shorter. */
  route_upper_bound: boolean;
  /** false = not routed for this community on its own yet; never paint a verdict colour for it. */
  verified: boolean;
  unrouted_nearer?: { name: string; uid: string; straight_m: number }[];
  route_basis?: RouteBasis;
  /** 菜市场 gaps only: the nearest 买菜替代 within the rule on foot; null = looked, none; absent = not looked */
  alt?: FreshAlternative | null;
}

export interface Community {
  name: string;
  osm_id?: string;
  /** Outline in local metres (closed ring not required). */
  pts: XY[];
  centroid: XY;
  /**
   * Where the compound sits on the map (the compound POI's own point); `centroid` stays the gate
   * residents walk from, which several phases of one estate may share. Set on live results; absent on
   * curated samples with outlines.
   */
  label_xy?: XY;
  area_m2?: number;
  checks: Record<HardCategory, FacilityCheck>;
  worst_status?: CheckStatus;
  /**
   * @deprecated Checks under GB 50180-2018 radii, written by older engine versions only. Kept so stored
   * results still parse; nothing computes or reads it any more.
   */
  readonly checks_gb?: Readonly<Record<HardCategory, FacilityCheck>>;
  /** The assigned primary school (对口小学) from an official catchment list, when one matches. */
  catchment?: CatchmentCheck;
}

/** Walk to the assigned primary school (对口地段), which is not necessarily the nearest one. */
export interface CatchmentCheck {
  school: string;
  school_uid?: string;
  /** Measured walking route to the school's entrance; null when not routed. */
  route_m: number | null;
  dur_s: number | null;
  straight_m: number;
  /** Official list id, e.g. pudong-catchment-2025. */
  source: string;
  /**
   * How the community was matched to the list, `method:detail` (core matchCatchment): lane:顺和路60弄,
   * name:申城佳苑一期A块, phase:玉兰香苑二期A块/玉兰香苑二期B块 (the name lacks the block), base:川杨新苑一期/…
   * (the name matched without its 期/区, every such row assigns the same school).
   */
  matched_by: string;
  /** Chinese caveat, e.g. the table names no campus and the nearer of two was taken, or why route_m is null. */
  note?: string;
}

export interface Poi {
  uid: string;
  name: string;
  cat: FacilityCategory;
  tag?: string;
  xy: XY;
  /** Entrance / navigation point; route to this for area facilities. */
  navi_xy: XY | null;
  source: 'baidu' | 'osm' | 'gov' | 'manual';
  /** Stall inside a market: merge into the market entity, never count on its own. */
  stall_of?: string;
  /** uid of the market POI the stall belongs to, when that POI was found. */
  stall_of_uid?: string;
  /** On a market POI: the market name its stalls use, e.g. 孙桥菜市场 for 浦商邻里荟(孙桥店). */
  market_name?: string;
  /** Baidu parent_id (the building, mall or campus the POI sits in). */
  parent_uid?: string;
  /** uids of duplicates merged into this one (same-category child by parent_id, or same name within 30 m). */
  merged_uids?: string[];
  center_route_m?: number;
  center_dur_s?: number;
  straight_m?: number;
  /**
   * Set when an official list (data/official/*.json) names this facility: `list` is the list id,
   * `name` the official name. With source 'baidu' the list confirmed or re-classified a Baidu POI
   * (e.g. a standardized market Baidu tags 生鲜超市 or plain 购物); with source 'gov' Baidu search did
   * not return it and the point is the geocoded official address.
   */
  official?: { list: string; name: string; address?: string; reclassified_from?: string };
  /**
   * How a Baidu POI was found when place search did not return it: `jsapi` = the browser's JSAPI
   * LocalSearch listed it (POST /api/analyze `browser_pois`) and the server read its tags with
   * place/v3/detail. Absent for place-search results.
   */
  found_by?: 'jsapi';
}

export type SampleSource = 'routematrix' | 'directionlite_path';

export interface TimeSample {
  xy: XY;
  straight_m: number;
  route_m: number;
  dur_s: number;
  /** Detour ratio: dur_s × speed / straight_m. */
  rho: number;
  bearing_deg: number;
  src: SampleSource;
  set?: string;
  /** directionlite_path only: index into AnalysisResult.paths. */
  path?: number;
  /** directionlite_path only: Baidu's own step time, 3–7 % slower than route_m / 1.17. */
  dur_dl_s?: number;
}

export interface WalkPath {
  bearing_deg: number;
  /** [x, y, cumulative seconds, cumulative metres] per vertex. */
  pts: [number, number, number, number][];
}

/** Walking time from the centre on a regular lattice; -1 = outside the domain. */
export interface TimeField {
  cell_m: number;
  nx: number;
  ny: number;
  x0: number;
  y0: number;
  /** Row-major from (x0, y0), +x then +y; values sit on lattice nodes. */
  t_s: number[];
  note?: string;
}

export interface ContourMeta {
  hole: boolean;
  parent: number | null;
  area_m2: number;
}

export interface ReachByBearing {
  b: number;
  r300: number;
  r600: number;
  r900: number;
}

export interface GapSummary {
  basis: string;
  n: number;
  rho_median: number;
  rho_p75: number;
  rho_p90: number;
  rho_max: number;
  n_inside_circle15: number;
  n_inside_circle15_over_900s: number;
  share_inside_circle15_over_900s: number;
  median_extra_s_inside_circle15: number;
  worst: {
    bearing_deg: number;
    straight_m: number;
    route_m: number;
    dur_s: number;
    rho: number;
    set?: string;
  }[];
}

export interface AnalysisStats {
  n_samples: number;
  loo_mae_s?: number;
  loo_p90_abs_err_s?: number;
  area_iso15_km2: number;
  area_circle15_km2: number;
  /** circle / real reach. */
  overstate_x: number;
  /** real reach / circle. */
  reach_share: number;
  areas_km2: Record<IsoLevel, { iso: number; circle: number }>;
  community_status_counts?: Record<string, unknown>;
  straight_vs_walk_gap_summary: GapSummary;
  reach_by_bearing: ReachByBearing[];
  /**
   * 圈内设施统计: facilityStats(result) at the stored (adult, 1.17 m/s) speed — per category in
   * STAT_ORDER, the facilities found, those reachable on foot within 15 minutes (field time at the
   * entrance ≤ 900 s), those inside the straight 15-minute circle, and the walk to the nearest one.
   * Stations count once however many entrances the inventory lists. Clients derive the elder view with
   * facilityStats(result, { scale: walk_speed_mps / 0.9 }); absent in results made before it existed.
   */
  facility_stats?: FacilityStat[];
  [key: string]: unknown;
}

/** A barrier piece found from walking times alone (design doc §5.3): κ = |Δt|·v / |Δx| > κ*. */
export interface BarrierPiece {
  a: XY;
  b: XY;
  kappa: number;
}

/** 灰色区域 (design doc §7.4): where the nearest demand point misses facilities. */
export interface GrayArea {
  /** 'gap': at least min_missing hard categories are not walkable within the rule; 'pseudo': 伪覆盖. */
  kind: 'gap' | 'pseudo';
  min_missing: number;
  /** Closed rings; outer counter-clockwise, holes clockwise (fill with the even-odd rule). */
  rings: XY[][];
  meta: ContourMeta[];
  area_m2: number;
}

/** One ranked facility-siting suggestion (design doc §7.5). */
export interface SiteSuggestion {
  rank: number;
  category: FacilityCategory;
  site_id: string;
  label?: string;
  xy: XY;
  /** Demand ids newly brought within the rule distance by this site. */
  covers: string[];
  /** Sum of the demand weights in covers. */
  gain: number;
  /** ρ̂ at the site; L̂ takes the larger ρ̂ of site and demand point plus a time bound (siting.ts). */
  rho_local: number;
  /** true once covers were confirmed with measured routes; false = estimate only. */
  verified: boolean;
  routes: { demand_id: string; straight_m: number; est_m: number; route_m?: number }[];
}

export interface Venue {
  name: string;
  bd09: LngLat;
  xy: XY;
  in_extent: boolean;
  bearing_deg: number;
  distance_m: number;
  source?: string;
}

/** Optional preview geometry (OpenStreetMap, ODbL) used by the sample/offline mode only. */
export interface BaseLayers {
  roads: { cls: string; elevated: boolean; bridge: boolean; name: string | null; pts: XY[] }[];
  water_areas: { pts: XY[] }[];
  waterways: { name: string | null; kind: string; pts: XY[] }[];
  rail: { pts: XY[] }[];
  landuse: { kind: string; name: string | null; pts: XY[] }[];
  places?: { name: string; kind: string; xy: XY }[];
}

export interface AnalysisResult {
  meta: AnalysisMeta;
  communities: Community[];
  pois: Poi[];
  samples: TimeSample[];
  paths: WalkPath[];
  field: TimeField;
  contours: Record<IsoLevel, XY[][]>;
  contours_meta?: Record<IsoLevel, ContourMeta[]>;
  baseline: { circle_r15_m: number; rule_radius_m: number; note?: string };
  stats: AnalysisStats;
  venue?: Venue;
  base?: BaseLayers;
  /** Barriers detected from the samples' times (§5.3). */
  barriers?: BarrierPiece[];
  /** 灰色区域 polygons (§7.4). */
  gray_areas?: GrayArea[];
  /** Ranked siting suggestions per hard category (§7.5). */
  site_suggestions?: Partial<Record<HardCategory, SiteSuggestion[]>>;
}
