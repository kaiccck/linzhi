/**
 * Everything the screen shows is computed here from one AnalysisResult — no copy is hard-coded.
 *
 * The geometry (frame, time field, POIs, the measured detour route) and the verdicts (every unit's
 * checks, the gap counts, the heads) under the task rule: 小学、菜市场、药店 within 步行 1 公里. GB 50180
 * checks an older result may carry (`checks_gb`) are not read.
 */
import {
  type AnalysisResult,
  type CheckStatus,
  type Community,
  type FacilityCategory,
  type FacilityCheck,
  type HardCategory,
  type Poi,
  type WalkPath,
  type XY,
} from '@zoudedao/core';
import { fieldSampler, rasterize, type Raster } from '../geo/field.js';
import { frameFromMeta, type Frame } from '../geo/frame.js';

export const CATS: readonly HardCategory[] = ['小学', '菜市场', '药店'];
/** Elderly walking speed used by the profile switch (m/s); the adult speed comes from the data. */
export const V_ELDER = 0.9;

export type IconId =
  | 'pg-walk'
  | 'pg-school'
  | 'pg-market'
  | 'pg-pharmacy'
  | 'pg-metro'
  | 'pg-kinder'
  | 'pg-clinic'
  | 'pg-play'
  | 'pg-info'
  | 'pg-check'
  | 'pg-download'
  | 'pg-print'
  | 'pg-super'
  | 'pg-fresh'
  | 'pg-elder'
  | 'pg-bus'
  | 'pg-park'
  | 'pg-pin'
  | 'pg-plus';

/** Categories that get a mark on the 体检 map (the rest stay off it, so the map keeps its density). */
export const CAT_ICON: Partial<Record<FacilityCategory, IconId>> = {
  小学: 'pg-school',
  菜市场: 'pg-market',
  药店: 'pg-pharmacy',
  幼儿园: 'pg-kinder',
  社区卫生: 'pg-clinic',
  地铁: 'pg-metro',
};

/** Pictograms of every 民生设施 category, for the 圈内设施 lists (panel, map and report). */
export const STAT_ICON: Record<Exclude<FacilityCategory, '其他'>, IconId> = {
  小学: 'pg-school',
  幼儿园: 'pg-kinder',
  菜市场: 'pg-market',
  生鲜超市: 'pg-fresh',
  超市: 'pg-super',
  药店: 'pg-pharmacy',
  社区卫生: 'pg-clinic',
  养老: 'pg-elder',
  公交: 'pg-bus',
  地铁: 'pg-metro',
  公园: 'pg-park',
};

/**
 * Facility glyph colours (DESIGN.md): the three hard categories and their kin carry a hue each —
 * schools violet, markets orange, pharmacies teal (checked apart for the common colour-vision
 * deficiencies, and never the only carrier: the pictogram differs too); everything else is grey.
 */
export const CAT_COLOR: Record<Exclude<FacilityCategory, '其他'>, string> = {
  小学: '#6d5bd0',
  幼儿园: '#6d5bd0',
  菜市场: '#d4782f',
  生鲜超市: '#d4782f',
  超市: '#6b7585',
  药店: '#1b9aaa',
  社区卫生: '#1b9aaa',
  养老: '#6b7585',
  公交: '#6b7585',
  地铁: '#6b7585',
  公园: '#6b7585',
};
export const catColor = (cat: FacilityCategory) => (cat === '其他' ? '#6b7585' : CAT_COLOR[cat]);

export interface Unit extends Community {
  /** stable map code, e.g. A-01 (north to south, then west to east) */
  code: string;
  blind: boolean;
  bad: boolean;
  /** severity sort key: lower = worse */
  sev: number;
  /** walking time from the centre at the centroid (s), -1 outside the field */
  t: number;
  /** display name split: main + suffix (e.g. 申城佳苑 / 三期A块) */
  nameMain: string;
  nameSub: string;
  /** the unit has its own outline to tint (OSM); live results are points */
  outlined: boolean;
}

/** One hard category over all units, as the category cards and the report heads show it. */
export interface CategoryHead {
  cat: HardCategory;
  /** units whose measured walk is within the rule */
  ok: number;
  /** units not routed on their own yet (no verdict) */
  pending: number;
  /** within the rule by straight line, beyond it on foot */
  pseudo: number;
  /** beyond the rule even by straight line */
  blind: number;
  /** of the measured ones, within 50 m of the rule either way */
  edge: number;
}

/**
 * The verdict's tally: the circle's gaps are the blind ones (nothing within the rule even by straight
 * line); the walk finds those plus every pseudo-covered one. Pending checks count in neither.
 */
export interface VerdictTally {
  blind: number;
  pseudo: number;
  pending: number;
  /** communities with at least one gap on foot (the gaps are unit × category pairs) */
  units: number;
  /** of those, the ones the circle finds too (at least one gap beyond the rule by straight line) */
  circleUnits: number;
}

/**
 * The measured Baidu walking route the map quotes: the one the data names its barriers for (east of
 * 申城佳苑: 河道 and the S20), otherwise the most roundabout of the measured routes.
 */
export interface Detour {
  path: WalkPath;
  /** straight line from the centre to the route's end, metres */
  straight: number;
  /** measured walking distance, metres */
  route: number;
  /** measured walking time, seconds (adult) */
  dur: number;
  /** compass bearing of the route's end from the centre */
  bearing: number;
}

export interface Model {
  id: string;
  /** the letter the area button shows: A, B … (实时 for a live check) */
  code: string;
  data: AnalysisResult;
  frame: Frame;
  /** rule distance per hard category, metres (the task rule: the same for all three) */
  ruleOf: Record<HardCategory, number>;
  /** adult walking speed (m/s), Baidu routematrix: route metres / duration */
  vAdult: number;
  units: Unit[];
  boardOrder: Unit[];
  heads: CategoryHead[];
  circleGaps: number;
  walkGaps: number;
  tally: VerdictTally;
  /** the task rule's distance (the gray areas and siting suggestions are computed at it) */
  ruleM: number;
  /** radius of the adult's straight 15′ circle (900 s × adult speed); see `circleR` for a profile */
  r15: number;
  raster: Raster;
  /** bilinear walking time from the centre (s) at local metres; -1 outside the field */
  timeAt: (x: number, y: number) => number;
  detour: Detour | null;
  /** Named obstacles behind the detour (meta.barrier_names); empty = generic wording. */
  barrierNames: string[];
  /** POIs that get a mark on the 体检 map */
  pois: (Poi & { icon: IconId; minor: boolean })[];
  place: { title: string; line: string };
  /** date of the Baidu measurements, from the attribution */
  measuredOn: string;
  /** true when community outlines or POIs come from OpenStreetMap */
  usesOsm: boolean;
}

const RANK: Record<CheckStatus, number> = { 盲区: 0, 伪覆盖: 1, 临界: 2, 覆盖: 3 };

/**
 * Where a unit sits on the map: the compound's own point when the data carries it (live results:
 * Baidu's POI, where its name is on the basemap), else the centroid. `centroid` stays the gate the
 * residents walk from — several phases of one estate can share a gate, and their codes would pile up there.
 */
export const spotOf = (u: { centroid: XY; label_xy?: XY }): XY => u.label_xy ?? u.centroid;

/** "申城佳苑三期A块" → ["申城佳苑", "三期A块"]; names without a phase suffix stay whole. */
export function splitName(name: string): [string, string] {
  const m = /^(.+?)((?:[一二三四五六七八九十\d]+期)(?:[A-Z\d]+块)?|北区|南区|东区|西区)$/.exec(name);
  // Baidu writes 川杨新苑-四期 as often as 川杨新苑四期; the separator belongs to neither half
  return m && m[1] && m[2] ? [m[1].replace(/[-－—·\s]+$/, ''), m[2]] : [name, ''];
}

export const poiName = (n: string) => n.replace(/^上海市/, '').replace(/^浦东新区/, '');

/** The rule distance per category: the analysis' own (步行 1 公里) for all three. */
export const rulesOf = (taskM: number): Record<HardCategory, number> => ({
  小学: taskM,
  菜市场: taskM,
  药店: taskM,
});

/** "1 公里" / "500 米": a rule distance in words. */
export const distWords = (m: number) => (m % 1000 === 0 ? `${m / 1000} 公里` : `${fmtInt(m)} 米`);

/**
 * A check's measured walk is beyond the rule (and counts as a gap) — pending checks never do. An
 * inventory with no facility of the category at all (distances -1) is a gap by line and on foot.
 */
export const isWalkGap = (s: FacilityCheck, rule: number) =>
  s.verified !== false && (s.route_m > rule || s.route_m < 0);
export const isCircleGap = (s: FacilityCheck, rule: number) => s.straight_m > rule || s.straight_m < 0;

type Verdicts = Pick<
  Model,
  'ruleOf' | 'units' | 'boardOrder' | 'heads' | 'circleGaps' | 'walkGaps' | 'tally'
>;

/**
 * The verdicts: each unit's severity, the panel's order (worst first), the heads, and the circle's and
 * the walk's gap counts.
 */
function verdicts(base: Pick<Model, 'ruleM'>, units: Unit[]): Verdicts {
  const ruleOf = rulesOf(base.ruleM);
  for (const u of units) {
    const st = CATS.map((k) => u.checks[k]).filter((s) => s.verified !== false);
    u.blind = st.some((s) => s.status === '盲区');
    u.bad = st.some((s) => s.status_main === '伪覆盖');
    u.sev =
      Math.min(3, ...st.map((s) => RANK[s.status] ?? 3)) * 10 -
      st.filter((s) => s.status_main !== '覆盖').length;
  }
  const boardOrder = [...units].sort((a, b) => a.sev - b.sev || a.code.localeCompare(b.code));

  const pairs = units.flatMap((u) => CATS.map((k) => ({ u, k, s: u.checks[k] })));
  const circleGaps = pairs.filter(({ k, s }) => isCircleGap(s, ruleOf[k])).length;
  const walk = pairs.filter(({ k, s }) => isWalkGap(s, ruleOf[k]));
  const tally: VerdictTally = {
    blind: walk.filter(({ k, s }) => isCircleGap(s, ruleOf[k])).length,
    pseudo: walk.filter(({ k, s }) => !isCircleGap(s, ruleOf[k])).length,
    pending: pairs.filter(({ s }) => s.verified === false).length,
    units: new Set(walk.map(({ u }) => u.code)).size,
    circleUnits: new Set(walk.filter(({ k, s }) => isCircleGap(s, ruleOf[k])).map(({ u }) => u.code)).size,
  };
  const heads: CategoryHead[] = CATS.map((cat) => {
    const rule = ruleOf[cat];
    const measured = units.map((u) => u.checks[cat]).filter((s) => s.verified !== false);
    const gaps = measured.filter((s) => isWalkGap(s, rule));
    return {
      cat,
      ok: measured.length - gaps.length,
      pending: units.length - measured.length,
      pseudo: gaps.filter((s) => !isCircleGap(s, rule)).length,
      blind: gaps.filter((s) => isCircleGap(s, rule)).length,
      edge: measured.filter((s) => s.route_m >= 0 && Math.abs(s.route_m - rule) <= 50).length,
    };
  });
  return { ruleOf, units, boardOrder, heads, circleGaps, walkGaps: walk.length, tally };
}

/** The route the map quotes (see `Detour`). */
function pickDetour(data: AnalysisResult): Detour | null {
  const routes = data.paths.flatMap((path): Detour[] => {
    const end = path.pts[path.pts.length - 1];
    if (!end) return [];
    const straight = Math.hypot(end[0], end[1]);
    const [, , dur, route] = end;
    if (!(straight > 0) || !(route > 0)) return [];
    const bearing = ((Math.atan2(end[0], end[1]) * 180) / Math.PI + 360) % 360;
    return [{ path, straight, route, dur, bearing }];
  });
  if (!routes.length) return null;
  // the data names what stands in the way of its eastward route (meta.barrier_names)
  if (data.meta.barrier_names?.length) {
    return routes.reduce((a, r) =>
      Math.abs(r.path.bearing_deg - 90) < Math.abs(a.path.bearing_deg - 90) ? r : a,
    );
  }
  return routes.reduce((a, r) => (r.route / r.straight > a.route / a.straight ? r : a));
}

export function deriveModel(data: AnalysisResult, id: string): Model {
  const frame = frameFromMeta(data.meta);
  const vAdult = data.meta.walk_speed_mps || 1.17;
  const ruleM = data.baseline.rule_radius_m || 1000;
  // sample ids look like zj-a → codes A-01 …; a live check uses A as well
  const letter = /^[a-z]+-([a-z])$/i.exec(id)?.[1]?.toUpperCase();
  const prefix = letter ?? 'A';

  const units: Unit[] = data.communities.map((c) => {
    const [nameMain, nameSub] = splitName(c.name);
    return {
      ...c,
      code: '',
      blind: false,
      bad: false,
      sev: 0,
      t: -1,
      nameMain,
      nameSub,
      outlined: c.pts.length >= 3,
    };
  });
  [...units]
    .sort((a, b) => b.centroid[1] - a.centroid[1] || a.centroid[0] - b.centroid[0])
    .forEach((u, i) => {
      u.code = `${prefix}-${String(i + 1).padStart(2, '0')}`;
    });
  const timeAt = fieldSampler(data.field);
  for (const u of units) u.t = timeAt(u.centroid[0], u.centroid[1]);

  const r15 = data.baseline.circle_r15_m;

  // minor marks (smaller, dropped on narrow maps) are the numerous everyday ones: pharmacies,
  // kindergartens and 社区卫生服务站 — live inventories list several of each around one centre
  const pois = data.pois.flatMap((p) => {
    const icon = CAT_ICON[p.cat];
    if (p.stall_of || !icon || (p.cat === '地铁' && /出入口/.test(p.name))) return [];
    return [{ ...p, icon, minor: p.cat === '药店' || p.cat === '幼儿园' || p.cat === '社区卫生' }];
  });

  const region = data.meta.region;
  const place = {
    title: data.meta.name,
    line: [
      region ? `${region.city ?? ''}${region.district ?? ''}${region.town ?? ''}` : null,
      data.meta.center_label ? `中心 ${data.meta.center_label}` : null,
    ]
      .filter(Boolean)
      .join(' · '),
  };
  const dated = [...(data.meta.attribution ?? [])].reverse().find((a) => /baidu/i.test(a)) ?? '';
  const measuredOn = /(\d{4}-\d{2}-\d{2})/.exec(dated)?.[1] ?? data.meta.generated.slice(0, 10);
  const usesOsm = data.communities.some((c) => !!c.osm_id) || data.pois.some((p) => p.source === 'osm');

  return {
    id,
    code: id === 'live' ? '实时' : (letter ?? id.toUpperCase()),
    data,
    frame,
    vAdult,
    ...verdicts({ ruleM }, units),
    ruleM,
    r15,
    raster: rasterize(data.field, 6),
    timeAt,
    detour: pickDetour(data),
    barrierNames: data.meta.barrier_names ?? [],
    pois,
    place,
    measuredOn,
    usesOsm,
  };
}

/** Walking-time multiplier of a profile relative to the measured adult speed. */
export const profileScale = (profile: 'adult' | 'elder', vAdult: number) =>
  profile === 'elder' ? vAdult / V_ELDER : 1;

/**
 * Radius of the straight 15′ circle for a profile: 900 s at the profile's speed (1,053 m for the
 * measured adult, 810 m at 0.9 m/s). The map's circle, its tag, the walk card's readout and the
 * 圈内设施 counts all read it from here, so they never disagree.
 */
export const circleR = (model: Pick<Model, 'r15'>, scale: number) => model.r15 / scale;
export const circleKm2 = (model: Pick<Model, 'r15'>, scale: number) =>
  (Math.PI * circleR(model, scale) ** 2) / 1e6;

/** Reachable area (km²) within T seconds, counted on the raster. */
export function reachArea(raster: Raster, T: number, scale: number): number {
  let n = 0;
  for (const v of raster.t) if (v >= 0 && v * scale <= T) n++;
  return (n * raster.res * raster.res) / 1e6;
}

/**
 * Share of the profile's straight 15′ circle that the walk does not reach in 15′, counted on the
 * raster. `timeScale` stretches the walking times only (含过街等待), never the circle.
 */
export function circleMissShare(
  model: Pick<Model, 'raster' | 'r15'>,
  scale: number,
  timeScale = scale,
): number {
  const { raster } = model;
  const R = circleR(model, scale);
  let inC = 0;
  let miss = 0;
  for (let r = 0; r < raster.h; r++) {
    const y = raster.y1 - (r + 0.5) * raster.res;
    for (let q = 0; q < raster.w; q++) {
      const x = raster.x0 + (q + 0.5) * raster.res;
      if (x * x + y * y > R * R) continue;
      inC++;
      const t = raster.t[r * raster.w + q]!;
      if (t < 0 || t * timeScale > 900) miss++;
    }
  }
  return inC ? miss / inC : 0;
}

export const fmtInt = (n: number) => Math.round(n).toLocaleString('en-US');

/**
 * Shortest straight-line reach within T seconds over a set of bearings, marched along the field
 * (used when the profile is not the measured adult one; the adult value comes from the data).
 */
export function reachAlong(model: Model, bearings: number[], T: number, scale: number): number | null {
  let best: number | null = null;
  for (const b of bearings) {
    const a = (b * Math.PI) / 180;
    for (let r = 5; r <= 1600; r += 5) {
      const t = model.timeAt(Math.sin(a) * r, Math.cos(a) * r);
      if (t < 0) break;
      if (t * scale > T) {
        best = best === null ? r : Math.min(best, r);
        break;
      }
    }
  }
  return best;
}

/**
 * How far 15′ reaches in the detour's direction (±15°): the shortest reach there, metres. The adult
 * value is the engine's own (stats.reach_by_bearing); another profile re-reads the field.
 */
export function detourReach(model: Model, scale: number): number | null {
  const d = model.detour;
  if (!d) return null;
  const near = (b: number) => Math.abs(((b - d.bearing + 540) % 360) - 180) <= 15;
  if (scale === 1) {
    const sector = model.data.stats.reach_by_bearing.filter((r) => near(r.b));
    if (sector.length) return Math.min(...sector.map((r) => r.r900));
  }
  const bearings: number[] = [];
  for (let b = -15; b <= 15; b += 5) bearings.push((d.bearing + b + 360) % 360);
  return reachAlong(model, bearings, 900, scale);
}

/** 16-point compass words, cardinal points with 正 (正东 996 m). */
export function compass(bearing: number): string {
  const words = [
    '正北',
    '北偏东',
    '东北',
    '东偏北',
    '正东',
    '东偏南',
    '东南',
    '南偏东',
    '正南',
    '南偏西',
    '西南',
    '西偏南',
    '正西',
    '西偏北',
    '西北',
    '北偏西',
  ];
  return words[Math.round((((bearing % 360) + 360) % 360) / 22.5) % 16]!;
}

/** "向东" / "向东南": the direction a reach is measured in (8 points). */
export function towards(bearing: number): string {
  const words = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
  return `向${words[Math.round((((bearing % 360) + 360) % 360) / 45) % 8]!}`;
}

/**
 * The unit a category's finding is about: the longest measured 伪覆盖 walk (what the circle misses),
 * else the longest 盲区 one. Pending checks never qualify.
 */
export function worstUnit(
  model: Model,
  cat: HardCategory,
): { unit: Unit; check: FacilityCheck; kind: 'pseudo' | 'blind' } | null {
  const measured = model.units
    .map((unit) => ({ unit, check: unit.checks[cat] }))
    .filter((o) => o.check.verified !== false && o.check.route_m >= 0);
  const pick = (status: '伪覆盖' | '盲区') =>
    measured
      .filter((o) => o.check.status_main === status)
      .sort((a, b) => b.check.route_m - a.check.route_m)[0];
  const pseudo = pick('伪覆盖');
  if (pseudo) return { ...pseudo, kind: 'pseudo' };
  const blind = pick('盲区');
  return blind ? { ...blind, kind: 'blind' } : null;
}

/** The rule in words: "步行 1 公里内应有小学、菜市场、药店". */
export function ruleWords(model: Pick<Model, 'ruleM'>): string {
  return `步行 ${distWords(model.ruleM)}内应有${CATS.join('、')}`;
}
