/**
 * 对口小学 of the live mode: where an official catchment table (对口地段) covers the centre's district and
 * town, every compound is matched to its assigned school (core matchCatchment: 弄号, 小区名, 期/块) and
 * the walk from its gate to the school's gate is measured — reusing the coverage check's routes, and
 * one routematrix batch within the `catchment` budget line for the rest. A school the table names
 * without a campus (上海市浦东新区孙桥小学) is routed to each campus found; the nearer one is reported.
 */
import {
  catchmentCovers,
  isCatchmentHit,
  matchCatchment,
  planMatrixBatches,
  schoolCampuses,
  schoolKey,
  type CatchmentCheck,
  type CatchmentHit,
  type CatchmentList,
  type CatchmentMethod,
  type DemandPoint,
  type LocalFrame,
  type OdDestination,
  type Poi,
  type RoutedPair,
  type SchoolSite,
  type XY,
} from '@zoudedao/core';

import { describeError, isDegradable } from './errors.js';
import type { LiveCommunity, MatrixFn } from './coverage.js';
import type { Meter } from './meter.js';
import type { OfficialList } from './official.js';
import type { DemandSite } from './residential.js';
import { r1 } from './round.js';

export interface CatchmentStats {
  list: string;
  communities: number;
  matched: number;
  by_method: Record<CatchmentMethod, number>;
  unmatched: string[];
  /** Compounds whose name rows assign different schools: left unmatched. */
  ambiguous: string[];
  /** Matched compounds with a measured walk to their school. */
  routed: number;
  /** Routes this step asked Baidu for (the rest came from the coverage check). */
  new_routes: number;
  /** Matched compounds whose school is not in the facility list nor geocoded. */
  school_not_found: number;
}

export interface CatchmentOutcome {
  stats: CatchmentStats | null;
  notes: string[];
}

const METHOD_TEXT: Record<CatchmentMethod, string> = {
  lane: '弄号',
  name: '小区名',
  phase: '名称缺期或块',
  base: '名称去掉期或块',
};

/**
 * The school as officially named: a list's name when one confirmed the POI, the table's name when it
 * names the campus, else the table's school with the Baidu POI's campus (孙桥小学(张江校区) →
 * 上海市浦东新区孙桥小学（张江校区）).
 */
function campusName(school: string, site: SchoolSite): string {
  if (site.official) return site.name;
  if (schoolKey(school).campus) return school;
  const campus = schoolKey(site.name).campus;
  if (!campus) return school;
  return `${school}（${/[区部校点]$/.test(campus) ? campus : `${campus}校区`}）`;
}

export async function runCatchment(args: {
  meter: Meter;
  frame: LocalFrame;
  matrix: MatrixFn;
  lists: readonly CatchmentList[];
  region: { city?: string; district?: string; town?: string } | undefined;
  demand: readonly DemandSite[];
  /** Communities of the coverage check, given their `catchment` in place. */
  communities: LiveCommunity[];
  pois: readonly Poi[];
  /** Official facility lists: geocoded schools stand in for schools the inventory lacks. */
  official: readonly OfficialList[];
  /** Routes the coverage check measured (gate → facility uid). */
  routes: readonly RoutedPair[];
  warn?: (message: string) => void;
}): Promise<CatchmentOutcome> {
  if (!args.lists.length) return { stats: null, notes: [] };
  const list = args.lists.find((l) => catchmentCovers(l, args.region));
  if (!list) {
    const towns = [...new Set(args.lists.flatMap((l) => l.coverage?.towns ?? []))];
    const where = args.region
      ? `${args.region.district ?? ''}${args.region.town ?? ''}`
      : '（没有逆地理编码结果，无法判断街镇）';
    return {
      stats: null,
      notes: [
        `对口小学：官方对口地段表目前只转录了${towns.join('、') || '部分街镇'}，本次中心在${where}，不做对口匹配。`,
      ],
    };
  }
  const { frame } = args;
  // geocoded list schools, under the uid fusion gives an added entry (gov:<list>:<entry index>)
  const extra = args.official
    .filter((l) => l.category === '小学')
    .flatMap((l) =>
      l.entries.flatMap((e, i) =>
        e.bd09 && e.status === 'active'
          ? [{ name: e.name, xy: frame.toXY(e.bd09[0], e.bd09[1]), uid: `gov:${l.id}:${i}` }]
          : [],
      ),
    );
  const stats: CatchmentStats = {
    list: list.id,
    communities: args.demand.length,
    matched: 0,
    by_method: { lane: 0, name: 0, phase: 0, base: 0 },
    unmatched: [],
    ambiguous: [],
    routed: 0,
    new_routes: 0,
    school_not_found: 0,
  };

  // match every compound, find its school's campuses
  const plans: { d: DemandSite; hit: CatchmentHit; sites: SchoolSite[] }[] = [];
  for (const d of args.demand) {
    const m = matchCatchment(list, d.name, d.address);
    if (!isCatchmentHit(m)) {
      (m.reason === 'ambiguous' ? stats.ambiguous : stats.unmatched).push(d.name);
      continue;
    }
    stats.matched++;
    stats.by_method[m.method]++;
    const sites = schoolCampuses(m.school, args.pois, extra);
    if (!sites.length) stats.school_not_found++;
    plans.push({ d, hit: m, sites });
  }

  // routes: reuse the coverage check's, ask for the rest within the budget line
  const known = new Map<string, RoutedPair>();
  for (const r of args.routes) {
    const key = `${r.origin_id}\n${r.dest_id}`;
    if (!known.has(key) || (known.get(key)!.route_m === null && r.route_m !== null)) known.set(key, r);
  }
  const siteId = (s: SchoolSite) => s.uid ?? `school:${s.route_xy.join(',')}`;
  const want = new Map<string, OdDestination[]>();
  for (const p of plans) {
    const dests = p.sites
      .filter((s) => !known.has(`${p.d.id}\n${siteId(s)}`))
      .map((s): OdDestination => ({
        id: siteId(s),
        xy: s.route_xy,
        poi: { uid: siteId(s), name: s.name, cat: '小学', xy: s.xy, navi_xy: s.route_xy, source: 'gov' },
      }));
    if (dests.length) want.set(p.d.id, dests);
  }
  const points: DemandPoint[] = plans.map((p) => ({ id: p.d.id, xy: p.d.xy }));
  const bd09 = new Map(args.demand.map((d) => [d.id, d.bd09]));
  let limited = false;
  for (const b of planMatrixBatches(points, want)) {
    const room = args.meter.room('catchment');
    if (b.routes > room) {
      limited = true;
      continue;
    }
    try {
      const m = await args.matrix(
        'catchment',
        b.origins.map((o) => bd09.get(o.id)!),
        b.destinations.map((d) => frame.toLngLat(d.xy[0], d.xy[1])),
      );
      stats.new_routes += b.routes;
      b.origins.forEach((o, i) =>
        b.destinations.forEach((d, j) => {
          const cell = m.cells[i]?.[j];
          if (!cell || cell.status === 'failed') return;
          const ok = cell.status === 'ok';
          known.set(`${o.id}\n${d.id}`, {
            origin_id: o.id,
            dest_id: d.id,
            route_m: ok ? cell.distanceM : null,
            dur_s: ok ? cell.durationS : null,
          });
        }),
      );
    } catch (err) {
      if (!isDegradable(err)) throw err;
      args.warn?.(`对口小学有一批路线失败，涉及的小区只给直线距离：${describeError(err)}`);
    }
  }

  const byName = new Map(args.communities.map((c) => [c.name, c]));
  for (const p of plans) {
    const community = byName.get(p.d.name);
    if (!community) continue;
    const dist = (xy: XY) => r1(Math.hypot(xy[0] - p.d.xy[0], xy[1] - p.d.xy[1]));
    if (!p.sites.length) {
      community.catchment = {
        school: p.hit.school,
        route_m: null,
        dur_s: null,
        straight_m: -1,
        source: list.id,
        matched_by: p.hit.matched_by,
        note: '对口学校不在本次设施清单中，官方名录也没有它的坐标，没有算路',
      };
      continue;
    }
    const walks = p.sites.map((s) => {
      const r = known.get(`${p.d.id}\n${siteId(s)}`);
      return { s, route_m: r?.route_m ?? null, dur_s: r?.dur_s ?? null, straight_m: dist(s.xy) };
    });
    const routed = walks.filter((w) => w.route_m !== null);
    const best = routed.length
      ? routed.reduce((a, b) => (b.route_m! < a.route_m! ? b : a))
      : walks.reduce((a, b) => (b.straight_m < a.straight_m ? b : a));
    const check: CatchmentCheck = {
      school: campusName(p.hit.school, best.s),
      ...(best.s.uid && !best.s.uid.startsWith('school:') ? { school_uid: best.s.uid } : {}),
      route_m: best.route_m,
      dur_s: best.dur_s,
      straight_m: best.straight_m,
      source: list.id,
      matched_by: p.hit.matched_by,
    };
    const others = walks.filter((w) => w !== best);
    const notes: string[] = [];
    if (others.length) {
      const all = walks.every((w) => w.route_m !== null);
      const text = others
        .map((w) =>
          w.route_m === null
            ? `${campusName(p.hit.school, w.s)} 直线 ${Math.round(w.straight_m)} 米，未算路`
            : `${campusName(p.hit.school, w.s)} 步行 ${w.route_m} 米`,
        )
        .join('；');
      notes.push(
        `对口表未写校区，找到 ${walks.length} 个校区，取${all ? '步行较近的一个' : '已算路的校区中步行最近的一个'}（另：${text}）`,
      );
    }
    if (best.route_m === null)
      notes.push(limited ? '对口小学的算路预算已用完，只给直线距离' : '没有测到步行路线，只给直线距离');
    else {
      stats.routed++;
      if (limited && walks.some((w) => w.route_m === null)) {
        notes.push('对口小学的算路预算已用完，未算路的校区只给直线距离');
      }
    }
    if (notes.length) check.note = notes.join('；');
    community.catchment = check;
  }

  const methods = (Object.keys(METHOD_TEXT) as CatchmentMethod[])
    .filter((k) => stats.by_method[k])
    .map((k) => `${METHOD_TEXT[k]} ${stats.by_method[k]}`)
    .join('、');
  const amb = stats.ambiguous.length
    ? `（其中 ${stats.ambiguous.length} 个的同名条目对口不同学校，未判定）`
    : '';
  const unmatched = stats.unmatched.length + stats.ambiguous.length;
  const note =
    `对口小学（${list.publisher}《${list.title}》，${list.published}，${list.url}）：${stats.communities} 个小区中 ` +
    `${stats.matched} 个按官方地段表匹配到对口学校${methods ? `（${methods}）` : ''}，${unmatched} 个未匹配${amb}；` +
    `${stats.routed} 个按百度步行路线算到对口学校的校门（communities[].catchment）。对口学校不一定是最近的学校；` +
    `未匹配的小区多为地段表以弄号或旧名登记、百度用新名或物业名，不代表没有对口学校。`;
  return { stats, notes: [note] };
}
