/**
 * 路演模式: the check told in six steps for a projector — 画圈 → 走一遍 → 伪覆盖一例 → 圈内设施 →
 * 灰色区域 → 规划建议. Each step is a sentence in large type and what the map shows for it. Every
 * number is computed here from the analysis on screen (any sample, any live check); a step with
 * nothing to show says so rather than disappearing.
 */
import type { HardCategory } from '@zoudedao/core';
import { viaName } from '@zoudedao/core';
import { facilitySummary } from './facilities.js';
import {
  circleKm2,
  circleR,
  distWords,
  fmtInt,
  listWords,
  measureOf,
  newNoun,
  reachArea,
  worstUnit,
  type Model,
} from './derive.js';
import { grayLevels } from './gray.js';
import type { SitePin } from './siting.js';

/** A run of text: words, a number in the numeral face, or a unit code in its pill. */
export type Part = string | { n: string } | { code: string };

export type TourId = 'circle' | 'walk' | 'example' | 'facilities' | 'gray' | 'plan';

export interface TourMap {
  mode: 'check' | 'plan';
  sub: 'sheet' | 'fac';
  cat: HardCategory;
  /** 0: no reach yet (the circle alone); play: 走一遍 from 0′; 900: the reach at 15′ */
  T: 0 | 'play' | 900;
  /** hold every verdict colour back (the circle has not been walked yet) */
  hold: boolean;
  gray: boolean;
  /** the unit whose real walking route the step draws */
  evidence: { code: string; cat: HardCategory } | null;
  /** the suggestion pin to light */
  site: string | null;
}

export interface TourStep {
  id: TourId;
  /** the step's name, e.g. 画圈 */
  kicker: string;
  head: Part[];
  body: Part[];
  map: TourMap;
}

const n = (v: number | string): Part => ({ n: typeof v === 'number' ? fmtInt(v) : v });

/** Plain text of a run (tests, titles, spoken labels). */
export const partsText = (parts: readonly Part[]) =>
  parts.map((p) => (typeof p === 'string' ? p : 'n' in p ? p.n : p.code)).join('');

/** The category with the most gaps on foot (the one the panel opens on). */
function worstCat(model: Model): HardCategory {
  let best = model.heads[0]!;
  for (const h of model.heads) if (h.pseudo + h.blind > best.pseudo + best.blind) best = h;
  return best.cat;
}

/** The example of step 3: the longest 伪覆盖 walk in the worst category that has one, else a 盲区. */
function example(model: Model, first: HardCategory) {
  const order = [first, ...model.cats.filter((c) => c !== first)];
  for (const cat of order) {
    const w = worstUnit(model, cat);
    if (w?.kind === 'pseudo') return { ...w, cat };
  }
  for (const cat of order) {
    const w = worstUnit(model, cat);
    if (w) return { ...w, cat };
  }
  return null;
}

export function tourSteps(model: Model, opts: { scale: number; pins: readonly SitePin[] }): TourStep[] {
  const { scale } = opts;
  const cat = worstCat(model);
  const base: TourMap = {
    mode: 'check',
    sub: 'sheet',
    cat,
    T: 900,
    hold: false,
    gray: false,
    evidence: null,
    site: null,
  };
  const units = model.units.length;
  const R = circleR(model, scale);
  const circle = circleKm2(model, scale);
  const reach = reachArea(model.raster, 900, scale);
  const share = circle > 0 ? Math.round((reach / circle) * 100) : 0;
  const rule = distWords(model.ruleM);
  const steps: TourStep[] = [];

  const kinds = `${model.cats.length} 类设施`;
  // 1 · 画圈: the straight circle alone, no verdict yet
  steps.push({
    id: 'circle',
    kicker: '画圈',
    head: ['直线画一个 ', n('15′'), ' 圈：半径 ', n(R), ' m，', n(circle.toFixed(2)), ' km²'],
    body:
      model.circleGaps > 0
        ? ['圈里 ', n(units), ` 个小区 × ${kinds}。按直线距离找缺口，只找到 `, n(model.circleGaps), ' 项。']
        : ['圈里 ', n(units), ` 个小区 × ${kinds}。按直线距离找缺口，一个也找不到。`],
    map: { ...base, T: 0, hold: true },
  });

  // 2 · 走一遍: the reach replays to 15′ and the verdicts land
  const { walkGaps, tally } = model;
  steps.push({
    id: 'walk',
    kicker: '走一遍',
    head: ['沿真实路网走 ', n('15′'), '：只走得到 ', n(reach.toFixed(2)), ' km²，是圈的 ', n(`${share}%`)],
    body:
      walkGaps === 0
        ? [`逐一实测步行路线：每个小区都走得到这 ${model.cats.length} 类设施。`]
        : tally.pseudo > 0
          ? [
              '逐一实测步行路线，找到 ',
              n(walkGaps),
              ' 项缺口，在 ',
              n(tally.units),
              ' 个小区；画圈漏掉 ',
              n(tally.pseudo),
              ' 项。',
            ]
          : ['逐一实测步行路线，找到 ', n(walkGaps), ' 项缺口，都是直线也够不到的盲区。'],
    map: { ...base, T: 'play' },
  });

  // 3 · 伪覆盖一例, with its real walking route
  const ex = example(model, cat);
  if (ex) {
    const { unit, check } = ex;
    const minutes = Math.round((check.dur_s * scale) / 60);
    const exRule = distWords(model.ruleOf[ex.cat]);
    const via = viaName(check) ?? ex.cat;
    const times = check.straight_m > 0 ? (check.route_m / check.straight_m).toFixed(1) : null;
    steps.push({
      id: 'example',
      kicker: ex.kind === 'pseudo' ? '伪覆盖一例' : '盲区一例',
      head:
        ex.kind === 'pseudo'
          ? ['直线 ', n(check.straight_m), ' m，实际要走 ', n(check.route_m), ' m']
          : ['直线 ', n(check.straight_m), ' m，已超出 ', exRule],
      body:
        ex.kind === 'pseudo'
          ? [
              { code: unit.code },
              ` ${unit.name} → ${via}：步行约 `,
              n(`${minutes}′`),
              ...(times ? ['，是直线的 ', n(times), ' 倍'] : []),
              '。',
            ]
          : [
              { code: unit.code },
              ` ${unit.name}：最近的${ex.cat}步行 `,
              n(check.route_m),
              ' m，约 ',
              n(`${minutes}′`),
              '。直线也够不到，是盲区。',
            ],
      map: { ...base, cat: ex.cat, evidence: { code: unit.code, cat: ex.cat } },
    });
  } else {
    steps.push({
      id: 'example',
      kicker: '伪覆盖一例',
      head: ['没有伪覆盖'],
      body: [`每个小区的 ${kinds}，步行也都在规则距离内。`],
      map: base,
    });
  }

  // 4 · 圈内设施: what the circle claims and what 15′ reaches
  const fac = facilitySummary(model, scale);
  const hard = fac.rows.find((r) => (model.cats as readonly string[]).includes(r.cat) && r.circle > r.walk);
  steps.push({
    id: 'facilities',
    kicker: '圈内设施',
    head: ['圈里有 ', n(fac.circle), ' 处民生设施，', n('15′'), ' 走得到 ', n(fac.walk), ' 处'],
    body: hard
      ? [
          `其中${hard.cat}：圈里 `,
          n(hard.circle),
          ` ${measureOf(hard.cat)}，`,
          n('15′'),
          ' 走得到 ',
          n(hard.walk),
          ` ${measureOf(hard.cat)}。`,
        ]
      : [`${model.cats.join('、')}：圈里有的，15′ 都走得到。`],
    map: { ...base, sub: 'fac' },
  });

  // 5 · 灰色区域
  const gaps = grayLevels(model).filter((g) => g.kind === 'gap');
  const outer = gaps[0];
  const deeper = gaps.find((g) => g.min >= 2 && g.areaKm2 > 0);
  steps.push({
    id: 'gray',
    kicker: '灰色区域',
    head: outer ? ['缺至少一类必需设施的地方：', n(outer.areaKm2.toFixed(2)), ' km²'] : ['没有灰色区域'],
    body: outer
      ? [
          '涉及 ',
          n(outer.units.length),
          ' 个小区',
          ...(deeper ? ['；其中 ', n(deeper.areaKm2.toFixed(2)), ' km² 缺两类以上'] : []),
          '。',
        ]
      : [`每个小区步行 ${rule}内都有${listWords(model.cats, '和')}。`],
    map: { ...base, gray: !!outer },
  });

  // 6 · 规划建议: the suggestion that brings the most units within the rule
  const pin = [...opts.pins].sort((a, b) => b.covers.length - a.covers.length || a.rank - b.rank)[0];
  steps.push({
    id: 'plan',
    kicker: '规划建议',
    head: pin
      ? [
          `新增一${measureOf(pin.cat)}${newNoun(pin.cat)}：可让 `,
          n(pin.covers.length),
          ` 个小区步行 ${rule}内走得到`,
        ]
      : ['没有需要新增设施的建议'],
    body: pin
      ? [
          `地图上的 ${pin.rank} 号${pin.label ? `，${pin.label}` : ''}。`,
          pin.verified ? '已实测核验。' : '估算，落地前需实测核验。',
        ]
      : model.walkGaps === 0
        ? [`每个小区步行都走得到这 ${model.cats.length} 类设施。`]
        : ['这份结果没有给出建议，也没有可用来估算的步行路线。'],
    map: pin ? { ...base, mode: 'plan', cat: pin.cat, site: pin.key } : { ...base, mode: 'plan' },
  });

  return steps;
}
