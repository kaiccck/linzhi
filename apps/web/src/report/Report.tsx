/**
 * 体检报告 — the whole check as a printable A4 document (the top bar's 报告, or ?report).
 *
 * The workbench on paper: a white masthead with the mark, the place and its letter, the verdict set as
 * on the panel, the map drawn from the data, then the lists in the panel's language (facility glyphs
 * in their hues, unit codes, numerals in the numeral face, the verdict's flat tints and edges: red for
 * 伪覆盖, slate for 盲区, amber dots for 临界, a dashed grey edge for anything unverified). The cover is
 * exactly one A4 page; everything after it flows with page margins, running heads and page numbers.
 * Every number is computed from the analysis on screen, none is typed in.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { FRESH_RULE_TEXT, type FacilityCheck, type HardCategory } from '@zoudedao/core';
import { Le } from '../components/Le.js';
import { Tally } from '../components/Facilities.js';
import { BRAND, BrandMark } from '../components/Brand.js';
import { Pg, Ui } from '../components/Icons.js';
import { NumText } from '../components/NumText.js';
import { verdictLines, verdictSentence } from '../components/Verdict.js';
import {
  CAT_COLOR,
  circleKm2,
  circleR,
  distWords,
  fmtInt,
  isWalkGap,
  poiName,
  reachArea,
  ruleWords,
  STAT_ICON,
  V_ELDER,
  type Model,
  type Unit,
} from '../model/derive.js';
import { facilitySummary, rowLabel } from '../model/facilities.js';
import { freshAlt, freshLine, freshText } from '../model/fresh.js';
import { analysisGeoJSON, geojsonName } from '../model/geojson.js';
import { grayLevels, grayRuleText, type GrayLevel } from '../model/gray.js';
import { checkLook, lookClass, worstLook } from '../model/looks.js';
import type { SitePin } from '../model/siting.js';
import type { Profile } from '../state.js';
import { ReportMap } from './ReportMap.js';
import './report.css';

const today = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** CSS string literal for the page's running head (margin boxes cannot read the DOM). */
const cssString = (s: string) => `"${s.replace(/["\\]/g, '\\$&').replace(/\n/g, ' ')}"`;

const N = ({ children }: { children: ReactNode }) => <span className="num">{children}</span>;

function Code({ u }: { u: Unit }) {
  return <span className={'code ' + lookClass(worstLook(u))}>{u.code}</span>;
}

function Sec({
  n,
  title,
  aside,
  children,
  id,
}: {
  n: string;
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  id: string;
}) {
  return (
    <section className="rp-sec" aria-labelledby={id}>
      <header className="rp-sec-head">
        <span className="rp-no num" aria-hidden="true">
          {n}
        </span>
        <h2 id={id}>{title}</h2>
        {aside ? <span className="rp-aside">{aside}</span> : null}
      </header>
      {children}
    </section>
  );
}

/* ------------------------------------------------------------------ cover */

function Verdict({ model }: { model: Model }) {
  const { claim, walk } = verdictLines(model);
  const line = (parts: (string | { n: number; pseudo?: boolean })[], cls: string) => (
    <p className={cls} aria-hidden="true">
      {parts.map((p, i) =>
        typeof p === 'string' ? (
          p
        ) : (
          <b key={i} className={'v-n' + (p.pseudo ? ' pseudo' : '')}>
            {p.n}
          </b>
        ),
      )}
    </p>
  );
  return (
    <>
      <p className="sr-only">{verdictSentence(model)}</p>
      {line(claim, 'v-line v-claim')}
      {line(walk, 'v-line')}
    </>
  );
}

/** The four numbers of the cover as one sentence: what walking reaches against what the circle draws. */
function Figures({ model, scale }: { model: Model; scale: number }) {
  const { stats } = model.data;
  const reach = scale === 1 ? stats.area_iso15_km2 : reachArea(model.raster, 900, scale);
  const circle = scale === 1 ? stats.area_circle15_km2 : circleKm2(model, scale);
  const radius = Math.sqrt((reach * 1e6) / Math.PI);
  return (
    <p className="rp-figline">
      <N>15′</N> 真正走得到 <b className="num">{reach.toFixed(2)}</b> km²，
      <span className="muted">
        直线圈画的是 <b className="num">{circle.toFixed(2)}</b> km²
      </span>
      ，高估 <b className="num">{(circle / reach).toFixed(2)}</b> 倍；按面积折算，等效步行半径{' '}
      <b className="num">{fmtInt(radius)}</b> m（直线圈 <N>{fmtInt(circleR(model, scale))}</N> m）。
    </p>
  );
}

function MapKey({ model }: { model: Model }) {
  const gray = grayLevels(model).some((g) => g.kind === 'gap');
  return (
    <ul className="rp-key">
      <li>
        <span className="k-here" aria-hidden="true">
          <Pg id="pg-walk" />
        </span>
        <span>片区中心</span>
      </li>
      <li>
        <span className="k-ramp" aria-hidden="true" />
        <span>步行可达，越近越浓</span>
      </li>
      <li>
        <span className="k-iso" aria-hidden="true" />
        <span>
          <N>15′</N> 边与 <N>5′ 10′</N> 等时线
        </span>
      </li>
      <li>
        <span className="k-circle" aria-hidden="true" />
        <span>
          直线画的 <N>15′</N> 圈
        </span>
      </li>
      {gray ? (
        <li>
          <span className="sw s-gray" aria-hidden="true" />
          <span>灰色区域：{grayRuleText(model)}</span>
        </li>
      ) : null}
      <li>
        <span>小区（最重的一项）</span>
        <span className="code s-pseudo">伪覆盖</span>
        <span className="code s-blind">盲区</span>
        <span className="code s-ok">都走得到</span>
      </li>
    </ul>
  );
}

/* ------------------------------------------------------------------ 01 圈内设施 */

function FacilitySection({ model, scale, kmh }: { model: Model; scale: number; kmh: string }) {
  const s = useMemo(() => facilitySummary(model, scale), [model, scale]);
  return (
    <Sec
      n="01"
      id="rp-fac"
      title="圈内设施"
      aside={
        <>
          从片区中心出发 · 步速 <N>{kmh}</N> km/h · 直线圈半径 <N>{fmtInt(s.radiusM)}</N> m
        </>
      }
    >
      <p className="rp-lead">
        {s.circle > s.walk ? (
          <>
            <span className="muted">
              直线圈里有 <N>{s.circle}</N> 处设施，
            </span>
            <N>15′</N> 只走得到 <N>{s.walk}</N> 处。
          </>
        ) : s.circle > 0 ? (
          <>
            直线圈里 <N>{s.circle}</N> 处设施，<N>15′</N> 都走得到。
          </>
        ) : (
          <>直线圈里没有这些设施。</>
        )}
      </p>
      <div className="rp-scroll">
        <table className="rp-table rp-fac">
          <thead>
            <tr>
              <th scope="col" colSpan={2}>
                设施
              </th>
              <th scope="col" className="c-tally">
                直线圈里的每一处 <i className="mk mk-walk" aria-hidden="true" /> 走得到{' '}
                <i className="mk mk-claim" aria-hidden="true" /> 走不到
              </th>
              <th scope="col" className="c-n">
                <N>15′</N> 走得到
              </th>
              <th scope="col" className="c-n">
                圈里
              </th>
              <th scope="col" className="c-near">
                最近一处（步行）
              </th>
            </tr>
          </thead>
          <tbody>
            {s.rows.map((r) => (
              <tr
                key={r.cat}
                aria-label={rowLabel(r, s.radiusM)}
                style={{ ['--c' as string]: CAT_COLOR[r.cat] }}
              >
                <td className="c-ico">
                  <span className="ico" aria-hidden="true">
                    <Pg id={r.icon} />
                  </span>
                </td>
                <th scope="row">
                  {r.cat}
                  <small>
                    共 <N>{r.found}</N>
                  </small>
                </th>
                <td className="c-tally">
                  <Tally marks={r.tally} max={24} />
                </td>
                <td className="c-n n-walk">
                  <N>{r.walk}</N>
                </td>
                <td className="c-n n-claim">
                  <N>{r.circle}</N>
                </td>
                <td className="c-near">
                  {r.nearestMin === null ? (
                    <span className="none">步行范围内没有</span>
                  ) : (
                    <>
                      <N>{r.nearestMin}′</N>
                      {r.nearest ? <small>{r.nearest}</small> : null}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Sec>
  );
}

/* ------------------------------------------------------------------ 02 小区 × 设施 */

/** A check in metres, the rule's own unit: the walker changes minutes, never the verdict. */
function DirCell({ cat, s }: { cat: HardCategory; s: FacilityCheck }) {
  const look = checkLook(s);
  if (look === 'none') {
    return (
      <td className="c-cell">
        <div className="rp-cell s-blind">
          <span className="top">清单里没有</span>
          <span className="bot">{cat}</span>
        </div>
      </td>
    );
  }
  const bound = s.route_upper_bound ? <Le /> : s.route_basis === 'estimated' ? '≈' : null;
  if (look === 'pending') {
    return (
      <td className="c-cell">
        <div
          className="rp-cell s-pending"
          aria-label={`${cat} 待核：已测路线 ${fmtInt(s.route_m)} 米只是上限`}
        >
          <span className="top">
            <b className="word">待核</b>
            <N>
              {bound ?? <Le />}
              {fmtInt(s.route_m)} m
            </N>
          </span>
          <span className="bot">
            <em>未单独实测</em>
          </span>
        </div>
      </td>
    );
  }
  const word =
    s.status === '覆盖'
      ? ''
      : s.status === '临界'
        ? `临界${s.status_main === '覆盖' ? '' : `·${s.status_main}`}`
        : s.status;
  return (
    <td className="c-cell">
      <div className={'rp-cell ' + lookClass(look)}>
        <span className="top">
          <N>
            {bound}
            {fmtInt(s.route_m)} m
          </N>
        </span>
        <span className="bot">
          <span>
            直线 <N>{fmtInt(s.straight_m)}</N> m
          </span>
          {word ? <em>{word}</em> : null}
        </span>
        {s.alt ? (
          <span className="fresh" title={freshText(s.alt)}>
            <i className="k-a" aria-hidden="true" />
            可买菜 <N>{fmtInt(s.alt.route_m)}</N> m
          </span>
        ) : null}
      </div>
    </td>
  );
}

function DirectorySection({ model }: { model: Model }) {
  const pending = model.heads.reduce((n, h) => n + h.pending, 0);
  const within = (
    <>
      {' '}
      <N>{distWords(model.ruleM)}</N>内
    </>
  );
  return (
    <Sec
      n="02"
      id="rp-dir"
      title={`小区 × ${model.cats.join('、')}`}
      aside={<>{ruleWords(model)} · 由重到轻</>}
    >
      <p className="rp-lead">
        <span className="muted">
          画圈只找到 <N>{model.circleGaps}</N> 项缺口；
        </span>
        实测步行找到 <N>{model.walkGaps}</N> 项，在 <N>{model.tally.units}</N> 个小区
        {pending ? (
          <>
            ，另有 <N>{pending}</N> 项待核，不计入
          </>
        ) : null}
        。
      </p>
      <div className="rp-scroll">
        <table className="rp-table rp-dir" style={{ ['--n' as string]: model.cats.length }}>
          <thead>
            <tr>
              <th scope="col" colSpan={2}>
                小区
              </th>
              {model.heads.map((h) => (
                // no pictogram here: this head repeats on every page, where Chrome drops <use> glyphs
                <th scope="col" key={h.cat} className="c-cat">
                  {h.cat}
                  <small>
                    走得到 <N>{h.ok}</N>/<N>{model.units.length}</N>
                    {h.pending ? (
                      <>
                        {' '}
                        · <N>{h.pending}</N> 待核
                      </>
                    ) : null}
                  </small>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {model.boardOrder.map((u) => (
              <tr key={u.code}>
                <td className="c-code">
                  <Code u={u} />
                </td>
                <th scope="row" className="c-name">
                  {u.nameMain}
                  {u.nameSub ? <small>{u.nameSub}</small> : null}
                </th>
                {model.cats.map((k) => (
                  <DirCell key={k} cat={k} s={u.checks[k]} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="rp-states">
        <li>
          <span className="sw s-pseudo" aria-hidden="true" />
          <span>伪覆盖：直线{within}有，步行超过</span>
        </li>
        <li>
          <span className="sw s-blind" aria-hidden="true" />
          <span>盲区：直线{within}也没有</span>
        </li>
        <li>
          <span className="sw s-edge" aria-hidden="true" />
          <span>
            临界：步行距离与<N>{distWords(model.ruleM)}</N>相差不到 <N>50</N> m
          </span>
        </li>
        <li>
          <span className="sw s-pending" aria-hidden="true" />
          <span>待核：尚未对该小区单独算路</span>
        </li>
      </ul>
      <p className="rp-note">
        上行为步行距离（
        <Le /> 为上限，≈ 为估算），下行为直线距离。
      </p>
      <FreshNote model={model} />
    </Sec>
  );
}

/**
 * 缺菜市场的小区里哪些还能就近买菜: the count, then each unit with its shop. Beside the verdict, never in
 * it — the 菜市场 gaps above stay gaps.
 */
function FreshNote({ model }: { model: Model }) {
  const line = freshLine(model);
  if (!line) return null;
  const rows = model.boardOrder.flatMap((u) => {
    const alt = freshAlt(model, u);
    return alt ? [{ u, alt }] : [];
  });
  return (
    <div className="rp-fresh">
      <p>
        <i className="k-a" aria-hidden="true" />
        <span>
          <NumText text={line} />
        </span>
      </p>
      {rows.length ? (
        <ul>
          {rows.map(({ u, alt }) => (
            <li key={u.code}>
              <span className="num">{u.code}</span> {u.name}：{poiName(alt.name)}（{alt.kind}），步行{' '}
              <N>{fmtInt(alt.route_m)}</N> m
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ 03 灰色区域 */

function levelWord(g: GrayLevel, n: number): string {
  if (g.kind === 'pseudo') return '其中由伪覆盖造成';
  if (g.min >= n) return `${n} 类都缺`;
  return `缺 ${g.min} 类及以上`;
}

function GraySection({ model }: { model: Model }) {
  const levels = useMemo(() => grayLevels(model), [model]);
  const outer = levels.find((g) => g.kind === 'gap');
  return (
    <Sec n="03" id="rp-gray" title="灰色区域" aside={grayRuleText(model)}>
      {outer ? (
        <>
          <p className="rp-lead">
            设施匮乏的地方共 <N>{outer.areaKm2.toFixed(2)}</N> km²，分成 <N>{outer.patches}</N> 片，涉及{' '}
            <N>{outer.units.length}</N> 个小区。
          </p>
          <div className="rp-scroll">
            <table className="rp-table rp-gray">
              <thead>
                <tr>
                  <th scope="col" colSpan={2}>
                    分级
                  </th>
                  <th scope="col" className="c-n">
                    面积
                  </th>
                  <th scope="col" className="c-n">
                    片数
                  </th>
                  <th scope="col">落在其中的小区</th>
                </tr>
              </thead>
              <tbody>
                {levels.map((g) => (
                  <tr key={`${g.kind}${g.min}`}>
                    <td className="c-sw">
                      <span
                        className={`sw g-${g.kind === 'pseudo' ? 'pseudo' : Math.min(g.min, 3)}`}
                        aria-hidden="true"
                      />
                    </td>
                    <th scope="row">{levelWord(g, model.cats.length)}</th>
                    <td className="c-n">
                      <N>{g.areaKm2.toFixed(2)}</N> <small>km²</small>
                    </td>
                    <td className="c-n">
                      <N>{g.patches}</N>
                    </td>
                    <td className="c-units">
                      {g.units.length ? (
                        g.units.map((u) => <Code key={u.code} u={u} />)
                      ) : (
                        <span className="none">没有小区出入口落在其中</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="rp-note">颜色越深，缺的类别越多。</p>
        </>
      ) : (
        <p className="rp-lead muted">没有灰色区域。</p>
      )}
    </Sec>
  );
}

/* ------------------------------------------------------------------ 04 规划建议 */

/** The planner's own site on the 规划 page when the report was opened: estimated, or measured. */
export interface ReportWhatIf {
  cat: HardCategory;
  covers: Unit[];
  verified: boolean;
}

function Badge({ verified }: { verified: boolean }) {
  return <span className={'badge' + (verified ? ' ok' : ' est')}>{verified ? '已核验' : '估算'}</span>;
}

function SiteSection({
  model,
  pins,
  whatif,
}: {
  model: Model;
  pins: SitePin[];
  whatif: ReportWhatIf | null;
}) {
  const groups = model.cats.flatMap((cat) => {
    const list = pins.filter((p) => p.cat === cat);
    return list.length ? [{ cat, list }] : [];
  });
  const rule = distWords(model.ruleM);
  const gaps = model.units.some((u) => model.cats.some((c) => isWalkGap(u.checks[c], model.ruleOf[c])));
  return (
    <Sec n="04" id="rp-site" title="规划建议" aside="贪心最大覆盖（MCLP）选址">
      {whatif ? (
        <div className="rp-sites rp-whatif" style={{ ['--c' as string]: CAT_COLOR[whatif.cat] }}>
          <h3>
            <span className="ico" aria-hidden="true">
              <Pg id={STAT_ICON[whatif.cat]} />
            </span>
            当前模拟：新增{whatif.cat}
          </h3>
          <ol>
            <li>
              <span className="rank num">+</span>
              <div className="what">
                <b>规划页上选的位置</b>
                <span>
                  可使 <N>{whatif.covers.length}</N> 个小区进入步行 <N>{rule}</N>
                  {whatif.covers.length ? '：' : '。'}
                  {whatif.covers.map((u) => (
                    <Code key={u.code} u={u} />
                  ))}
                </span>
              </div>
              <Badge verified={whatif.verified} />
            </li>
          </ol>
        </div>
      ) : null}
      {groups.length ? (
        <>
          <p className="rp-lead">
            在这些位置补设施，可让更多小区进入步行 <N>{rule}</N>。
          </p>
          {groups.map(({ cat, list }) => (
            <div className="rp-sites" key={cat} style={{ ['--c' as string]: CAT_COLOR[cat] }}>
              <h3>
                <span className="ico" aria-hidden="true">
                  <Pg id={STAT_ICON[cat]} />
                </span>
                新增{cat}
              </h3>
              <ol>
                {list.map((p) => (
                  <li key={p.key}>
                    <span className="rank num">{p.rank}</span>
                    <div className="what">
                      <b>{p.label ?? `选址点 ${p.rank}`}</b>
                      <span>
                        可使 <N>{p.covers.length}</N> 个小区进入步行 <N>{rule}</N>：
                        {p.covers.map(({ name, unit }) =>
                          unit ? (
                            <Code key={name} u={unit} />
                          ) : (
                            <span key={name} className="nm">
                              {name}
                            </span>
                          ),
                        )}
                      </span>
                    </div>
                    <Badge verified={p.verified} />
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </>
      ) : whatif ? null : (
        <p className="rp-lead muted">{gaps ? '没有找到合适的选址。' : `各小区步行 ${rule}内都走得到。`}</p>
      )}
    </Sec>
  );
}

/**
 * The data's attribution lines for a reader: the Baidu services as one line in Chinese, OpenStreetMap's
 * licence line in Chinese, the official lists as they are (they already name their publisher and date).
 */
export function sourceLines(attribution: readonly string[], measuredOn: string): string[] {
  const out: string[] = [];
  let baidu = false;
  for (const a of attribution) {
    if (/Baidu Maps/i.test(a)) baidu = true;
    else if (/OpenStreetMap/i.test(a)) out.push('小区轮廓：© OpenStreetMap 贡献者（ODbL）');
    else out.push(a);
  }
  if (baidu) out.unshift(`步行路线与设施：百度地图 Web 服务，${measuredOn} 起实测`);
  return [...new Set(out)];
}

/* ------------------------------------------------------------------ 05 方法与局限 */

function MethodSection({ model, profile }: { model: Model; profile: Profile }) {
  const { meta, stats } = model.data;
  const notes = (meta as { notes?: unknown }).notes;
  const warnings = (meta as { warnings?: unknown }).warnings;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const kmh = (model.vAdult * 3.6).toFixed(1);
  return (
    <Sec n="05" id="rp-method" title="方法与局限">
      <ul className="rp-method">
        <li>
          步行时间来自百度地图批量算路与轻量步行路线，共 <N>{fmtInt(stats.n_samples)}</N> 个实测样本，
          按绕行系数去趋势插值成耗时场
          {typeof stats.loo_mae_s === 'number' ? (
            <>
              （留一交叉验证平均误差 <N>{Math.round(stats.loo_mae_s)}</N> 秒）
            </>
          ) : null}
          。
        </li>
        <li>
          步速按百度批量算路的 <N>{model.vAdult.toFixed(2)}</N> m/s（<N>{kmh}</N> km/h）
          {profile === 'elder' ? (
            <>
              ，本报告按老人 <N>{V_ELDER}</N> m/s（<N>{(V_ELDER * 3.6).toFixed(1)}</N>{' '}
              km/h）换算，直线圈随之缩为 <N>{fmtInt(900 * V_ELDER)}</N> m
            </>
          ) : null}
          ；直线画的 <N>15′</N> 圈半径 = <N>900</N> 秒 × 步速 = <N>{fmtInt(model.r15)}</N> m（成人）。
        </li>
        <li>
          判定规则（赛题）：{ruleWords(model)}；步行距离与规则距离相差不到 <N>50</N> m
          的标为临界，需实地核实。
        </li>
        <li>步行时间按路线距离 ÷ 步速计，不含红绿灯等候。</li>
        {freshLine(model) ? <li>{FRESH_RULE_TEXT}</li> : null}
      </ul>
      {list(warnings).length ? (
        <>
          <h3 className="rp-sub">注意</h3>
          <ul className="rp-notes">
            {list(warnings).map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </>
      ) : null}
      <h3 className="rp-sub">数据来源</h3>
      <ul className="rp-notes">
        {sourceLines(meta.attribution ?? [], model.measuredOn).map((a) => (
          <li key={a}>{a}</li>
        ))}
        <li>
          报告由{BRAND}（开源，Apache-2.0）根据体检结果生成，生成于 <N>{meta.generated.slice(0, 10)}</N>。
        </li>
      </ul>
      {list(notes).length ? (
        // how the data was made, field by field: folded on screen, printed in full at the end
        <details className="rp-appx">
          <summary>
            附录 · 数据处理说明 <span className="num">{list(notes).length}</span> 条
          </summary>
          <ul className="rp-notes">
            {list(notes).map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </Sec>
  );
}

/* ------------------------------------------------------------------ page */

/** User-initiated only: the file is made here from the analysis on screen and handed over as a Blob. */
function downloadGeoJSON(model: Model, scale: number, analysisId: string | null) {
  const text = JSON.stringify(analysisGeoJSON(model, { scale }));
  const url = URL.createObjectURL(new Blob([text], { type: 'application/geo+json;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = geojsonName(model, analysisId);
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function Report({
  model,
  profile,
  scale,
  sourceNote,
  sourceTag,
  analysisId = null,
  pins,
  whatif = null,
}: {
  model: Model;
  profile: Profile;
  scale: number;
  sourceNote: string;
  sourceTag: string | null;
  /** names the downloaded file (a live check by its server id) */
  analysisId?: string | null;
  /** the 规划 page's suggestions (the analysis' own, or estimated in the browser) */
  pins: SitePin[];
  /** the planner's own site on the 规划 page, if any */
  whatif?: ReportWhatIf | null;
}) {
  const [painted, setPainted] = useState(false);
  const onPainted = useCallback(() => setPainted(true), []);
  const date = useMemo(today, []);
  const elder = profile === 'elder';
  const kmh = ((elder ? V_ELDER : model.vAdult) * 3.6).toFixed(1);
  const title = `${model.place.title} · 15 分钟生活圈体检报告`;
  const pending = model.heads.reduce((n, h) => n + h.pending, 0);

  // the page scrolls and prints as a document while the report is up
  useEffect(() => {
    const root = document.documentElement;
    const before = document.title;
    root.dataset.view = 'report';
    delete root.dataset.zddReady;
    document.title = `${BRAND} · ${title}`;
    return () => {
      delete root.dataset.view;
      delete root.dataset.zddReady;
      document.title = before;
    };
  }, [title]);
  // the appendix is folded on screen and printed in full
  useEffect(() => {
    const open = () =>
      document.querySelectorAll<HTMLDetailsElement>('details.rp-appx').forEach((d) => {
        d.dataset.was = d.open ? '1' : '';
        d.open = true;
      });
    const restore = () =>
      document.querySelectorAll<HTMLDetailsElement>('details.rp-appx').forEach((d) => {
        d.open = d.dataset.was === '1';
      });
    addEventListener('beforeprint', open);
    addEventListener('afterprint', restore);
    return () => {
      removeEventListener('beforeprint', open);
      removeEventListener('afterprint', restore);
    };
  }, []);
  // capture hook: <html data-zdd-ready="report"> once the map is painted and the fonts are in
  useEffect(() => {
    if (!painted) return;
    let cancelled = false;
    void document.fonts.ready.then(() =>
      requestAnimationFrame(() => {
        if (!cancelled) document.documentElement.dataset.zddReady = 'report';
      }),
    );
    return () => {
      cancelled = true;
    };
  }, [painted]);

  return (
    <div className="rp-stand">
      <style>{`@page { @top-center { content: ${cssString(`${BRAND} · ${title}`)}; } }`}</style>
      <nav className="rp-bar" aria-label="报告操作">
        <span className="rp-bar-title">
          体检报告 · <span className="num">A4</span> · {model.place.title}
        </span>
        <button
          type="button"
          className="btn"
          title="等时圈、直线圈、小区与判定、设施、灰色区域；WGS-84 坐标，可直接放进 GIS"
          onClick={() => downloadGeoJSON(model, scale, analysisId)}
        >
          <Ui id="ui-map-dl" />
          下载 GeoJSON
        </button>
        <button type="button" className="btn" onClick={() => window.print()}>
          <Ui id="ui-print" />
          打印 / 存为 PDF
        </button>
      </nav>

      <article className="rp" aria-label={title}>
        <section className="rp-sheet rp-cover" aria-label="概要">
          <header className="rp-mast">
            <div className="rp-brand">
              <BrandMark size={28} />
              <span className="wordmark">
                <b>{BRAND}</b>
                <span>15 分钟生活圈体检报告</span>
              </span>
              <span className="area-code num" title={sourceNote}>
                {model.code}
              </span>
            </div>
            <h1>{model.place.title}</h1>
            <p className="rp-where">{[model.place.line, sourceTag].filter(Boolean).join(' · ')}</p>
            <p className="rp-dates">
              <span>
                百度实测 <N>{model.measuredOn}</N>
              </span>
              <span>
                报告生成 <N>{date}</N>
              </span>
              <span>
                {elder ? '老人' : '成人'}步速 <N>{kmh}</N> km/h
              </span>
              <span>
                规则 步行 <N>{distWords(model.ruleM)}</N>
              </span>
            </p>
          </header>

          <div className="rp-verdict">
            <Verdict model={model} />
            <p className="sub">
              <N>{model.units.length}</N> 个小区 × {model.cats.join('、')}，逐一实测步行路线
              {pending ? (
                <>
                  ；另有 <N>{pending}</N> 项待核，不计入
                </>
              ) : null}
              。
            </p>
          </div>

          <Figures model={model} scale={scale} />

          <figure className="rp-map">
            <ReportMap model={model} scale={scale} onPainted={onPainted} />
            <figcaption>
              <MapKey model={model} />
            </figcaption>
          </figure>
        </section>

        <div className="rp-flow">
          <FacilitySection model={model} scale={scale} kmh={kmh} />
          <DirectorySection model={model} />
          <GraySection model={model} />
          <SiteSection model={model} pins={pins} whatif={whatif} />
          <MethodSection model={model} profile={profile} />
          <footer className="rp-end">
            <BrandMark size={18} />
            {BRAND} · 按真实路网体检 15 分钟生活圈 · {sourceNote}
          </footer>
        </div>
      </article>
    </div>
  );
}
