/** Numbers of the live pipeline, with the design-doc section they come from. */
import { WALK_SPEED_MPS } from '@zoudedao/core';

export const ENGINE_VERSION = '0.1.0';

/** Baidu routematrix walking speed: every answer has duration = distance / 1.17 (§2.2). */
export const WALK_SPEED = WALK_SPEED_MPS;
/** Elderly profile (§5.7, MUTCD slow pedestrians ≈ 0.91 m/s). Routes stay the same, times × 1.17 / 0.9. */
export const ELDER_SPEED_MPS = 0.9;
/** 15 minutes. */
export const LIMIT_S = 900;
/** Outer seed radius R = v·T: nothing farther can be reached in 15 minutes (§5.1 fact 1). */
export const R15_M = LIMIT_S * WALK_SPEED;

/** Half-size of the analysed square (field lattice, demand points), as in data/samples/zj-a.json. */
export const EXTENT_M = 1600;
/**
 * Demand points (residential gates) are kept within the 15-minute straight-line circle plus 50 m: the
 * check is about the people inside the circle being tested, and codes outside it would land under
 * the map's controls.
 */
export const DEMAND_RADIUS_M = 1100;
/**
 * Facilities are searched 1 km beyond the demand radius (§6.2): a demand point near the edge can be
 * served by a facility farther out, and leaving it out would invent a false gap there.
 */
export const FACILITY_BUFFER_M = 1000;
export const PLACE_PAGE_SIZE = 20;
/**
 * The other 民生设施 (社区卫生, 养老, 地铁, 公园, 超市, 公交) are counted for the circle being tested,
 * not for demand points near the edge: searched within the 15-minute circle plus 50 m, which lets the
 * page limit reach much further into it than the 2.1 km facility radius would.
 */
export const LIVELIHOOD_RADIUS_M = DEMAND_RADIUS_M;
/** Place pages of the 民生设施 union (the rest of the 40 rows it can return is the bus-stop tail). */
export const LIVELIHOOD_PAGES = 2;
/**
 * A 民生设施 row with the name of a facility already in the inventory (another source or query) is
 * that facility when this close; stations get more room (platforms, exits, OSM station outlines).
 */
export const LIVELIHOOD_DEDUPE_M = 150;
export const STATION_DEDUPE_M = 300;

/** Fewer usable seed routes than this and the field is not worth drawing. */
export const MIN_SEED_SAMPLES = 16;
/** Barrier detection needs a triangulation dense enough that edges stay under 400 m. */
export const MIN_BARRIER_SAMPLES = 60;
/** §5.4 stopping rule: the 15-minute region changed by less than 3 % (symmetric difference). */
export const CONVERGED_SHARE = 0.03;
/** Planning and partial fields are coarse; the final field matches the samples' 20 m lattice. */
export const COARSE_CELL_M = 40;
export const FINAL_CELL_M = 20;
/** Samples closer than this to an earlier one are dropped (first source wins, as in zj-a). */
export const SAMPLE_DEDUPE_M = 5;
/** Walked-route vertices become samples every ~20 m of route (Baidu vertices are ~15 m apart). */
export const PATH_SAMPLE_SPACING_M = 20;
/** Siting candidates along walked routes (§7.5). */
export const SITE_SPACING_M = 50;

/** New candidates per demand point, category and round of the coverage check (§7.3 early stop). */
export const COVERAGE_K = 2;
export const COVERAGE_MAX_ROUNDS = 4;
/** Siting suggestions verified with measured routes, per category. */
export const MAX_VERIFY_SITES = 2;
export const MAX_SITES = 3;

/** Gray areas: nearest-demand raster (§7.4). Without outlines a gate stands for ~250 m around it. */
export const GRAY_CELL_M = 50;
export const GRAY_REACH_M = 250;
