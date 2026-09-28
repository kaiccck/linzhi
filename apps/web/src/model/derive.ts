/**
 * Everything the screen shows is computed here from one AnalysisResult — no copy is hard-coded.
 * Ported from design/mockups/a-wayfinding/app.js.
 */
import type {
  AnalysisResult,
  CheckStatus,
  Community,
  FacilityCategory,
  FacilityCheck,
  HardCategory,
  Poi,
  WalkPath,
  XY,
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
  | 'pg-search'
  | 'pg-north'
  | 'pg-info'
  | 'pg-check'
  | 'pg-download';

export const CAT_ICON: Partial<Record<FacilityCategory, IconId>> = {
  小学: 'pg-school',
  菜市场: 'pg-market',
  药店: 'pg-pharmacy',
  幼儿园: 'pg-kinder',
  社区卫生: 'pg-clinic',
  地铁: 'pg-metro',
};

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
}

export interface CategoryHead {
  cat: HardCategory;
  ok: number;
  pending: number;
}

export interface Finding {
  key: 'hatch' | 'east' | 'school';
  anchor: XY;
  /** preferred vertical slot of the card, as a share of the map height */
  slot: number;
  tone: 'ink' | 'red';
}

export interface Model {
  id: string;
  code: string;
  data: AnalysisResult;
  frame: Frame;
  /** adult walking speed (m/s), Baidu routematrix: route metres / duration */
  vAdult: number;
  units: Unit[];
  boardOrder: Unit[];
  heads: CategoryHead[];
  circleGaps: number;
  walkGaps: number;
  ruleM: number;
  r15: number;
  raster: Raster;
  /** bilinear walking time from the centre (s) at local metres; -1 outside the field */
  timeAt: (x: number, y: number) => number;
  eastPath: WalkPath | null;
  eastReach15: number | null;
  /** Named obstacles behind the east callout (meta.barrier_names); empty = generic wording. */
  barrierNames: string[];
  worstSchool: { unit: Unit; check: FacilityCheck } | null;
  findings: Finding[];
  /** POIs that get a tile on the map */
  pois: (Poi & { icon: IconId; minor: boolean })[];
  place: { title: string; line: string };
  /** date of the Baidu measurements, from the attribution */
  measuredOn: string;
  /** true when community outlines or POIs come from OpenStreetMap */
  usesOsm: boolean;
}

const RANK: Record<CheckStatus, number> = { 盲区: 0, 伪覆盖: 1, 临界: 2, 覆盖: 3 };

/** "申城佳苑三期A块" → ["申城佳苑", "三期A块"]; names without a phase suffix stay whole. */
export function splitName(name: string): [string, string] {
  const m = /^(.+?)((?:[一二三四五六七八九十\d]+期)(?:[A-Z\d]+块)?|北区|南区|东区|西区)$/.exec(name);
  // Baidu writes 川杨新苑-四期 as often as 川杨新苑四期; the separator belongs to neither half
  return m && m[1] && m[2] ? [m[1].replace(/[-－—·\s]+$/, ''), m[2]] : [name, ''];
}

export const poiName = (n: string) => n.replace(/^上海市/, '').replace(/^浦东新区/, '');

export function deriveModel(data: AnalysisResult, id: string): Model {
  const frame = frameFromMeta(data.meta);
  const vAdult = data.meta.walk_speed_mps || 1.17;
  const ruleM = data.baseline.rule_radius_m || 1000;
  // sample ids look like zj-a → codes A-01 …; a live check uses A as well
  const prefix = /^[a-z]+-([a-z])$/i.exec(id)?.[1]?.toUpperCase() ?? 'A';

  const units: Unit[] = data.communities.map((c) => {
    const [nameMain, nameSub] = splitName(c.name);
    return { ...c, code: '', blind: false, bad: false, sev: 0, t: -1, nameMain, nameSub };
  });
  [...units]
    .sort((a, b) => b.centroid[1] - a.centroid[1] || a.centroid[0] - b.centroid[0])
    .forEach((u, i) => {
      u.code = `${prefix}-${String(i + 1).padStart(2, '0')}`;
    });
  const timeAt = fieldSampler(data.field);
  for (const u of units) {
    const st = CATS.map((k) => u.checks[k]).filter((s) => s.verified !== false);
    u.blind = st.some((s) => s.status === '盲区');
    u.bad = st.some((s) => s.status_main === '伪覆盖');
    u.sev =
      Math.min(3, ...st.map((s) => RANK[s.status] ?? 3)) * 10 -
      st.filter((s) => s.status_main !== '覆盖').length;
    u.t = timeAt(u.centroid[0], u.centroid[1]);
  }
  const boardOrder = [...units].sort((a, b) => a.sev - b.sev || a.code.localeCompare(b.code));

  const checks = units.flatMap((u) => CATS.map((k) => u.checks[k]));
  const circleGaps = checks.filter((x) => x.straight_m > ruleM).length;
  const walkGaps = checks.filter((x) => x.route_m > ruleM && x.verified !== false).length;
  const heads = CATS.map((cat) => ({
    cat,
    ok: units.filter((u) => u.checks[cat].verified !== false && u.checks[cat].route_m <= ruleM).length,
    pending: units.filter((u) => u.checks[cat].verified === false).length,
  }));

  // the measured Baidu walking path whose bearing is closest to due east
  const eastPath = data.paths.reduce<WalkPath | null>(
    (a, p) => (!a || Math.abs(p.bearing_deg - 90) < Math.abs(a.bearing_deg - 90) ? p : a),
    null,
  );
  // shortest straight-line reach at 15′ in the eastern sector the path crosses
  const eastSector = data.stats.reach_by_bearing.filter((r) => r.b >= 70 && r.b <= 90);
  const eastReach15 = eastSector.length ? Math.min(...eastSector.map((r) => r.r900)) : null;

  const worst = units
    .map((unit) => ({ unit, check: unit.checks['小学'] }))
    .filter((o) => o.check.verified !== false && o.check.status_main === '伪覆盖')
    .sort((a, b) => b.check.route_m - a.check.route_m)[0];

  const r15 = data.baseline.circle_r15_m;
  const findings: Finding[] = [];
  // the hatched ring the circle claims: pinned north-east, just inside the circle
  const hatchR = Math.min(r15 - 90, 960);
  findings.push({
    key: 'hatch',
    anchor: [Math.sin((40 * Math.PI) / 180) * hatchR, Math.cos((40 * Math.PI) / 180) * hatchR],
    slot: 0.13,
    tone: 'ink',
  });
  const end = eastPath?.pts[eastPath.pts.length - 1];
  if (end) findings.push({ key: 'east', anchor: [end[0], end[1]], slot: 0.4, tone: 'ink' });
  if (worst) findings.push({ key: 'school', anchor: worst.unit.centroid, slot: 0.62, tone: 'red' });

  const pois = data.pois.flatMap((p) => {
    const icon = CAT_ICON[p.cat];
    if (p.stall_of || !icon || (p.cat === '地铁' && /出入口/.test(p.name))) return [];
    return [{ ...p, icon, minor: p.cat === '药店' || p.cat === '幼儿园' }];
  });

  const region = data.meta.region;
  const place = {
    title: region?.town ? `${region.town} · ${data.meta.name}` : data.meta.name,
    line: [
      region ? `${region.city ?? ''}${region.district ?? ''}` : null,
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
    code: id === 'live' ? '实时' : id.toUpperCase(),
    data,
    frame,
    vAdult,
    units,
    boardOrder,
    heads,
    circleGaps,
    walkGaps,
    ruleM,
    r15,
    raster: rasterize(data.field, 6),
    timeAt,
    eastPath,
    eastReach15,
    worstSchool: worst ?? null,
    findings,
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

/** Reachable area (km²) within T seconds, counted on the raster. */
export function reachArea(raster: Raster, T: number, scale: number): number {
  let n = 0;
  for (const v of raster.t) if (v >= 0 && v * scale <= T) n++;
  return (n * raster.res * raster.res) / 1e6;
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
