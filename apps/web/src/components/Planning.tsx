/**
 * 规划 — what fixing it would take. First the planner's own question, 假如在这里开一家…: put a site on
 * the map and see at once which units the new facility would bring within the rule on foot (估算, from
 * the analysis' detour field, no API call); 实测核验 then measures those walks, only where the server
 * can (live mode with the Baidu engine). Below, the analysis' own siting suggestions, numbered like
 * their pins on the map.
 */
import type { HardCategory } from '@zoudedao/core';
import { shortTime, type WhatIfBranch } from '../data/history.js';
import {
  CAT_COLOR,
  CAT_ICON,
  distWords,
  fmtInt,
  measureOf,
  newNoun,
  type Model,
  type Unit,
} from '../model/derive.js';
import { checkLook, lookClass } from '../model/looks.js';
import { lacks, type SitePin, type WhatIfEstimate } from '../model/siting.js';
import type { PlanState } from '../state.js';
import { Pg } from './Icons.js';
import { NumText } from './NumText.js';

function Chips({
  units,
  cat,
  onHot,
}: {
  units: { name: string; unit: Unit | null }[];
  cat: HardCategory;
  onHot(code: string | null): void;
}) {
  return (
    <span className="chips">
      {units.map(({ name, unit }) =>
        unit ? (
          <button
            type="button"
            key={name}
            className={'code ' + lookClass(checkLook(unit.checks[cat]))}
            title={unit.name}
            aria-label={`${unit.code} ${unit.name}`}
            onMouseEnter={() => onHot(unit.code)}
            onMouseLeave={() => onHot(null)}
            onFocus={() => onHot(unit.code)}
            onBlur={() => onHot(null)}
          >
            {unit.code}
          </button>
        ) : (
          <span key={name} className="chip-name">
            {name}
          </span>
        ),
      )}
    </span>
  );
}

export function Badge({ verified }: { verified: boolean }) {
  return (
    <span
      className={'badge' + (verified ? ' ok' : ' est')}
      title={verified ? '已用百度步行路线实测' : '按这次体检的绕行系数估算，未经实测'}
    >
      {verified ? '已核验' : '估算'}
    </span>
  );
}

function WhatIf({
  model,
  cat,
  plan,
  estimate,
  measureBlocked,
  onPlace,
  onClear,
  onMeasure,
  onHot,
}: {
  model: Model;
  cat: HardCategory;
  plan: PlanState;
  estimate: WhatIfEstimate | null;
  measureBlocked: string | null;
  onPlace(): void;
  onClear(): void;
  onMeasure(): void;
  onHot(code: string | null): void;
}) {
  const rule = model.ruleOf[cat];
  const { measure } = plan;
  const measured = measure.status === 'done' ? measure.result : null;
  const byName = new Map(model.units.map((u) => [u.name, u]));
  const why = !estimate
    ? ''
    : measure.status === 'failed'
      ? measure.message
      : measure.status === 'done' && measure.saved
        ? `${shortTime(measure.saved.created_at)} 的实测结果。`
        : measured
          ? `已实测，用了 ${measured.quota.routes} 条配额。`
          : estimate.routable === 0
            ? `直线 ${distWords(rule)}内没有缺${cat}的小区。`
            : (measureBlocked ?? '');
  return (
    <div className={'whatif' + (plan.placing ? ' placing' : '')}>
      <div className="wi-head">
        <Pg id={CAT_ICON[cat]!} color={CAT_COLOR[cat]} />
        <h2>
          假如在这里新增一{measureOf(cat)}
          {newNoun(cat)}
        </h2>
        {plan.site ? (
          <button type="button" className="link" onClick={onClear}>
            清除
          </button>
        ) : null}
      </div>
      {plan.placing ? (
        <p className="wi-hint" role="status">
          在地图上点一个位置；<kbd>Esc</kbd> 取消。
        </p>
      ) : !estimate ? (
        <>
          <button type="button" className="btn" onClick={onPlace}>
            <Pg id="pg-pin" />
            在地图上选位置
          </button>
        </>
      ) : (
        <div className="wi-result" aria-live="polite">
          <p className="wi-big">
            <b className="v-n">{measured ? measured.newly_covered.length : estimate.flips.length}</b>
            <span>
              个小区因此步行 <NumText text={distWords(rule)} />
              内走得到
            </span>
            <Badge verified={!!measured} />
          </p>
          <p className="wi-of">
            缺{cat}的小区共 <span className="num">{estimate.demand.length}</span> 个
            {measured ? (
              <>
                ，实测 <span className="num">{measured.measured.length}</span> 条步行路线
              </>
            ) : null}
            。
          </p>
          {measured ? (
            <ul className="wi-measured">
              {measured.measured.map((m) => {
                const u = byName.get(m.community);
                return (
                  <li
                    key={m.community}
                    className={measured.newly_covered.includes(m.community) ? 'flip' : ''}
                  >
                    <span className={'code ' + (u ? lookClass(checkLook(u.checks[cat])) : 's-quiet')}>
                      {u?.code ?? '—'}
                    </span>
                    <span className="nm">{m.community}</span>
                    <span className="num">{m.route_m === null ? '无路线' : `${fmtInt(m.route_m)} m`}</span>
                    <span className="st">
                      {m.before} → {m.after}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : estimate.flips.length ? (
            <Chips
              units={estimate.flips.map((f) => ({ name: f.unit.name, unit: f.unit }))}
              cat={cat}
              onHot={onHot}
            />
          ) : null}
          <div className="wi-acts">
            {!measured ? (
              <button
                type="button"
                className="btn"
                disabled={measureBlocked !== null || measure.status === 'running' || estimate.routable === 0}
                aria-describedby={why ? 'wi-why' : undefined}
                onClick={onMeasure}
              >
                {measure.status === 'running' ? (
                  '正在实测…'
                ) : (
                  <>
                    实测核验
                    <small>
                      <span className="num">{estimate.routable}</span> 条步行路线
                    </small>
                  </>
                )}
              </button>
            ) : null}
            <button type="button" className="link" onClick={onPlace}>
              换个位置
            </button>
          </div>
          {why ? (
            <p className="wi-why" id="wi-why">
              {why ? <NumText text={why} /> : null}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * 规划's answer before its list: how many new sites the suggestions take, and how many of the
 * communities that lack the category they bring within the rule on foot (估算 until measured).
 */
function PlanVerdict({ model, cat, list }: { model: Model; cat: HardCategory; list: SitePin[] }) {
  const demand = model.units.filter((u) => lacks(u, cat)).length;
  if (!demand || !list.length) return null;
  const covered = new Set(list.flatMap((p) => p.covers.map((c) => c.name))).size;
  const all = covered >= demand;
  const rule = distWords(model.ruleOf[cat]);
  return (
    <section className="verdict plan-verdict" aria-labelledby="plan-say">
      <p className="sr-only" id="plan-say">
        {`新增 ${list.length} ${measureOf(cat)}${newNoun(cat)}，缺${cat}的 ${demand} 个小区中 ${covered} 个因此步行 ${rule}内走得到（${list.every((p) => p.verified) ? '已核验' : '估算'}）。`}
      </p>
      <div className="v-top" aria-hidden="true">
        <b className="v-n">{list.length}</b>
        <p className="v-lines">
          <span className="v-t1">
            {measureOf(cat)}新{newNoun(cat)}
            {all ? '就够' : ''}
          </span>
          <span className="v-t2">
            缺{cat}的 <span className="num">{demand}</span> 个小区
            {all ? (
              '都'
            ) : (
              <>
                里 <span className="num">{covered}</span> 个
              </>
            )}
            能步行 <NumText text={rule} />
            内走到
          </span>
        </p>
        <Badge verified={list.every((p) => p.verified)} />
      </div>
    </section>
  );
}

/**
 * The what-if measurements saved on this analysis (POST /api/whatif keeps each one as a branch):
 * choosing one puts its site, category and measured answer back on the map without a new Baidu call.
 */
function Branches({
  branches,
  current,
  onRestore,
}: {
  branches: WhatIfBranch[];
  current: string | null;
  onRestore(b: WhatIfBranch): void;
}) {
  return (
    <section className="branches" aria-label="已保存的实测模拟">
      <h2 className="plan-h">
        已保存的实测模拟 <span className="num">{branches.length}</span>
      </h2>
      <ol className="br-list">
        {branches.map((b) => {
          return (
            <li key={b.id}>
              <button
                type="button"
                className={'br' + (current === b.id ? ' on' : '')}
                aria-current={current === b.id ? 'true' : undefined}
                onClick={() => onRestore(b)}
              >
                <Pg id={CAT_ICON[b.category]!} color={CAT_COLOR[b.category]} />
                <span className="br-what">
                  <b>
                    新增{newNoun(b.category)} · <span className="num">{b.newly_covered.length}</span>{' '}
                    个小区因此走得到
                  </b>
                  <small>
                    <span className="num">{shortTime(b.created_at)}</span> · 实测{' '}
                    <span className="num">{b.measured.length}</span> 条路线
                  </small>
                </span>
                <Badge verified />
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function Planning({
  model,
  cat,
  pins,
  plan,
  estimate,
  measureBlocked,
  onPlace,
  onClear,
  onMeasure,
  onHot,
  onHotSite,
  branches,
  onRestoreBranch,
}: {
  model: Model;
  cat: HardCategory;
  pins: SitePin[];
  plan: PlanState;
  estimate: WhatIfEstimate | null;
  measureBlocked: string | null;
  onPlace(): void;
  onClear(): void;
  onMeasure(): void;
  onHot(code: string | null): void;
  onHotSite(key: string | null): void;
  branches?: WhatIfBranch[] | null;
  onRestoreBranch?(b: WhatIfBranch): void;
}) {
  const list = pins.filter((p) => p.cat === cat);
  const m = plan.measure;
  const current = m.status === 'done' ? (m.saved?.id ?? m.result.branch_id ?? null) : null;
  return (
    <section className="plan" aria-label="规划">
      <PlanVerdict model={model} cat={cat} list={list} />
      <h2 className="plan-h">建议选址 · {cat}</h2>
      {list.length ? (
        <ol className="sites">
          {list.map((p) => (
            <li
              key={p.key}
              className={plan.hotSite === p.key ? 'hot' : ''}
              style={{ ['--c' as string]: CAT_COLOR[cat] }}
              onMouseEnter={() => onHotSite(p.key)}
              onMouseLeave={() => onHotSite(null)}
            >
              <span className="rank num" aria-hidden="true">
                {p.rank}
              </span>
              <span className="what">
                <b>
                  新增后 <span className="num">{p.covers.length}</span> 个小区走得到
                  <Badge verified={p.verified} />
                </b>
                <small>{p.label ?? `选址点 ${p.rank}`}</small>
                <Chips units={p.covers} cat={cat} onHot={onHot} />
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="plan-none">
          {model.data.site_suggestions || !model.units.some((u) => lacks(u, cat))
            ? `这次体检没有需要新增${cat}的小区。`
            : '没有找到合适的选址。'}
        </p>
      )}
      <WhatIf
        model={model}
        cat={cat}
        plan={plan}
        estimate={estimate}
        measureBlocked={measureBlocked}
        onPlace={onPlace}
        onClear={onClear}
        onMeasure={onMeasure}
        onHot={onHot}
      />
      {branches?.length && onRestoreBranch ? (
        <Branches branches={branches} current={current} onRestore={onRestoreBranch} />
      ) : null}
    </section>
  );
}
