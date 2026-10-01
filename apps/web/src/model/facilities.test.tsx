/**
 * 圈内设施: the panel, the map and the report show @zoudedao/core's facilityStats as it is,
 * recomputed for the elder profile (the circle shrinks to 810 m with it), and the view makes the
 * walk-against-circle contrast legible and speakable.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { facilityStats, type AnalysisResult } from '@zoudedao/core';
import raw from '../../../../data/samples/zj-a.json?raw';
import rawV from '../../../../data/samples/zj-v.json?raw';
import { FacilityView, Tally } from '../components/Facilities.js';
import { deriveModel, profileScale, STAT_ICON } from './derive.js';
import { facilityMarks, facilitySummary, rowLabel } from './facilities.js';

const data = JSON.parse(raw) as AnalysisResult;
const model = deriveModel(data, 'zj-a');
const elder = profileScale('elder', model.vAdult);

describe('facilitySummary', () => {
  const s = facilitySummary(model, 1);

  it('carries facilityStats’ numbers unchanged, one row per category present', () => {
    const core = facilityStats(data);
    expect(s.rows.map((r) => [r.cat, r.found, r.walk, r.circle])).toEqual(
      core.map((c) => [c.category, c.found, c.walk, c.circle]),
    );
    for (const r of s.rows) expect(r.icon).toBe(STAT_ICON[r.cat]);
    expect(s.walk).toBe(core.reduce((n, c) => n + c.walk, 0));
    expect(s.circle).toBe(core.reduce((n, c) => n + c.circle, 0));
  });

  it('draws one square per facility the circle claims, the walkable ones first', () => {
    for (const r of s.rows) {
      expect(r.tally).toHaveLength(Math.max(r.walk, r.circle));
      expect(r.tally.filter((m) => m === 'walk')).toHaveLength(r.walk);
      expect(r.tally.indexOf('claim')).toBe(r.tally.includes('claim') ? r.walk : -1);
    }
    const metro = s.rows.find((r) => r.cat === '地铁')!;
    expect(metro.walk).toBeLessThan(metro.circle);
    expect(metro.tally.every((m) => m === 'claim')).toBe(true);
  });

  it('is recomputed for the elder profile: fewer reached, the 810 m circle, slower minutes', () => {
    const e = facilitySummary(model, elder);
    expect(e.walk).toBeLessThan(s.walk);
    expect(e.radiusM).toBeCloseTo(900 * 0.9, 6);
    expect(e.rows.map((r) => [r.cat, r.walk, r.circle])).toEqual(
      facilityStats(data, { scale: elder }).map((c) => [c.category, c.walk, c.circle]),
    );
    const market = (x: typeof s) => x.rows.find((r) => r.cat === '菜市场')!.nearestMin!;
    expect(market(e)).toBeGreaterThan(market(s));
  });

  it('speaks every number of a row', () => {
    const metro = s.rows.find((r) => r.cat === '地铁')!;
    expect(rowLabel(metro, s.radiusM)).toBe(
      `地铁：直线 ${Math.round(s.radiusM)} 米的圈里 ${metro.circle} 个，15 分钟走得到 ${metro.walk} 个，共找到 ${metro.found} 个；最近的 ${metro.nearest} 步行约 ${metro.nearestMin} 分钟`,
    );
  });
});

describe('the facilities on the map', () => {
  for (const [id, text] of [
    ['zj-a', raw],
    ['zj-v', rawV],
  ] as const) {
    const m = deriveModel(JSON.parse(text) as AnalysisResult, id);
    for (const scale of [1, profileScale('elder', m.vAdult)]) {
      it(`${id} @×${scale.toFixed(2)}: one mark per counted facility, judged as the counts are`, () => {
        const marks = facilityMarks(m, scale);
        const core = facilityStats(m.data, { scale });
        for (const c of core) {
          if (c.category === '其他') continue;
          const mine = marks.filter((x) => x.cat === c.category);
          expect(mine).toHaveLength(c.found);
          expect(mine.filter((x) => x.reach)).toHaveLength(c.walk);
          expect(mine.filter((x) => x.inCircle)).toHaveLength(c.circle);
        }
      });
    }
  }

  it('marks a station at the station, not at one of its entrances', () => {
    const metro = facilityMarks(model, 1).filter((x) => x.cat === '地铁');
    expect(metro.length).toBeGreaterThan(0);
    for (const x of metro) expect(x.face.name).not.toMatch(/出入口/);
  });
});

describe('FacilityView rendering', () => {
  const noop = () => {};
  const shown = ['小学', '菜市场', '药店'];
  const html = renderToStaticMarkup(
    <FacilityView
      model={model}
      scale={1}
      kmh="4.2"
      profileWord="成人"
      hidden={false}
      shown={shown}
      onShow={noop}
    />,
  );
  const s = facilitySummary(model, 1);

  it('is a page of its own with the walk and the circle side by side for every category', () => {
    expect(html).toContain('id="panel-fac" aria-label="中心周边设施"');
    expect(html.match(/class="fac-row( on)?"/g)).toHaveLength(s.rows.length);
    for (const r of s.rows) expect(html).toContain(`aria-label="${rowLabel(r, s.radiusM)}。在地图上显示"`);
  });

  it('ticks the categories the map shows, and only those', () => {
    const ticked = html.match(/class="fac-pick" aria-pressed="true"/g) ?? [];
    expect(ticked).toHaveLength(s.rows.filter((r) => shown.includes(r.cat)).length);
    expect(html).toContain('class="fac-row on"');
  });

  it('sets the numbers in the numeral face — reached over claimed, and the minute prime', () => {
    const metro = s.rows.find((r) => r.cat === '地铁')!;
    expect(html).toContain(
      `<span class="n num" aria-hidden="true"><b>${metro.walk}</b><span>/${metro.circle}</span></span>`,
    );
    expect(html).toContain(`${metro.nearestMin}′</span>`);
    expect(html).not.toMatch(/\d\s*(分钟|min)</);
  });

  it('leads with the walk’s count, the circle’s claim against it, and says them in words', () => {
    expect(html).toContain(`<b class="v-n">${s.walk}</b>`);
    expect(html).toContain('处设施 <span class="num">15′</span> 走得到');
    // two bars on the circle's scale: the walk's share, and what only the circle claims
    expect(html).toContain(`<span class="vc-n num">${s.circle}</span>`);
    expect(html).toContain(`<span class="vc-n num">${s.walk}</span>`);
    expect(html).toContain(
      `从片区中心出发，直线画的 15 分钟圈里有 ${s.circle} 处设施，15 分钟步行只走得到 ${s.walk} 处。`,
    );
    expect(html).toContain('直线圈半径 <span class="num">1,053</span> m');
  });

  it('names the elder circle’s radius when the elder is chosen', () => {
    const e = renderToStaticMarkup(
      <FacilityView
        model={model}
        scale={elder}
        kmh="3.2"
        profileWord="老人"
        hidden={false}
        shown={shown}
        onShow={noop}
      />,
    );
    expect(e).toContain('圈半径 <span class="num">810</span> m');
    expect(e).toContain('老人 <span class="num">3.2</span> km/h');
  });

  it('draws the tally squares, folding long ones into +n', () => {
    const t = (marks: ('walk' | 'claim')[], max?: number) =>
      renderToStaticMarkup(<Tally marks={marks} max={max} />);
    expect(t(['walk', 'claim', 'claim'])).toBe(
      '<span class="tally" aria-hidden="true"><i class="mk mk-walk"></i><i class="mk mk-claim"></i><i class="mk mk-claim"></i></span>',
    );
    expect(t(Array(20).fill('walk'), 8)).toContain('+13');
    expect(t([])).toContain('圈里没有');
  });
});
