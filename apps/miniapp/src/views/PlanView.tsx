/**
 * 规划补点: for the category chosen, the sites the analysis suggests (each with the communities it
 * would bring within the rule), and the planner's own site — placed by a tap on the map, estimated at
 * once, measured with Baidu on request (实测核验) and kept as a branch of the analysis.
 */
import { Text, View } from '@tarojs/components';
import type { HardCategory } from '@zoudedao/core';
import type { WhatIfBranch } from '@web/data/history';
import { distWords, newNoun, type Model } from '@web/model/derive';
import { siteWords, type SitePin, type WhatIfEstimate } from '@web/model/siting';
import type { PlanState } from '@web/state';
import { BackRow, SectionHead } from '../components/ui';
import { scoreWith, type LifeCircleScore } from '../model/score';
import { CategoryChips } from './AreaView';
import { Icon } from '../platform/Icons';
import './PlanView.css';

export function PlanView({
  part,
  model,
  cat,
  score,
  onCat,
  pins,
  plan,
  estimate,
  measureBlocked,
  branches,
  onBack,
  onPlace,
  onUseSite,
  onClear,
  onMeasure,
  onRestore,
}: {
  model: Model;
  cat: HardCategory;
  score: LifeCircleScore;
  /** the sheet's fixed head, or its scrolling body */
  part: 'head' | 'body';
  onCat(c: HardCategory): void;
  pins: SitePin[];
  plan: PlanState;
  estimate: WhatIfEstimate | null;
  measureBlocked: string | null;
  branches: WhatIfBranch[] | null;
  onBack(): void;
  onPlace(): void;
  onUseSite(pin: SitePin): void;
  onClear(): void;
  onMeasure(): void;
  onRestore(b: WhatIfBranch): void;
}) {
  const head = model.heads.find((h) => h.cat === cat)!;
  const gaps = head.pseudo + head.blind;
  const mine = pins.filter((p) => p.cat === cat).sort((a, b) => a.rank - b.rank);
  const rule = distWords(model.ruleOf[cat]);
  const m = plan.measure;
  const measured = m.status === 'done' && m.cat === cat ? m.result : null;
  const saved = (branches ?? []).filter((b) => b.category === cat);
  const gain = (n: number) => {
    const sh = scoreWith(score, cat, n);
    return sh ? sh.after - sh.before : 0;
  };
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const shift =
    plan.site && estimate
      ? scoreWith(score, cat, measured ? measured.newly_covered.length : estimate.flips.length)
      : null;
  if (part === 'head')
    return (
      <View className="sub-head">
        <BackRow label={model.data.meta.name} onBack={onBack} />
        <Text className="plan-title">规划补点</Text>
        <Text className="plan-sub">
          {gaps
            ? `${gaps} 个小区步行 ${rule}内没有${cat}，新设施放在哪里补得最多`
            : `每个小区步行 ${rule}内都有${cat}`}
        </Text>
        <CategoryChips model={model} cat={cat} onCat={onCat} />
      </View>
    );
  return (
    <View className="plan">
      {plan.site && estimate ? (
        <View className="whatif">
          <View className="wi-head">
            <Text className="wi-title">放在这里的{newNoun(cat)}</Text>
            <View className="wi-x" onClick={onClear} hoverClass="pressed">
              <Text>移除</Text>
            </View>
          </View>
          <Text className="wi-big">
            {measured ? '百度实测：' : '估算：'}多{' '}
            <Text className="num">{measured ? measured.newly_covered.length : estimate.flips.length}</Text>{' '}
            个小区步行 {rule}内走得到{cat}
          </Text>
          {shift ? (
            <View className="wi-shift">
              <View className="wi-s">
                <Text className="wi-k">体检评分</Text>
                <Text className="wi-v num">
                  {shift.before}
                  <Text className="wi-arrow"> → </Text>
                  <Text className={shift.after > shift.before ? 'wi-up' : ''}>{shift.after}</Text>
                </Text>
              </View>
              <View className="wi-s">
                <Text className="wi-k">{cat}覆盖率</Text>
                <Text className="wi-v num">
                  {pct(shift.catBefore)}
                  <Text className="wi-arrow"> → </Text>
                  <Text className={shift.catAfter > shift.catBefore ? 'wi-up' : ''}>
                    {pct(shift.catAfter)}
                  </Text>
                </Text>
              </View>
            </View>
          ) : null}
          <Text className="wi-codes">
            {(measured
              ? measured.newly_covered
              : estimate.flips.map((f) => `${f.unit.code} ${f.unit.nameMain}`)
            ).join('、') || '一个也补不上：离缺口小区太远或被河道、高架隔开'}
          </Text>
          {measured ? (
            <Text className="wi-note">
              百度批量算路 {measured.quota.routes} 条
              {measured.quota.cached ? `（缓存 ${measured.quota.cached} 条）` : ''}，已存为这次体检的分支
            </Text>
          ) : (
            <Text className="wi-note">按绕行系数估算，步行 {rule}内的缺口小区才计入</Text>
          )}
          {measured ? null : (
            <View
              className={'wi-measure' + (measureBlocked || m.status === 'running' ? ' off' : '')}
              onClick={measureBlocked || m.status === 'running' ? undefined : onMeasure}
              hoverClass="act-press"
            >
              <Text>{m.status === 'running' ? '正在用百度实测…' : '用百度步行路线实测核验'}</Text>
            </View>
          )}
          {m.status === 'failed' && m.cat === cat ? <Text className="wi-err">{m.message}</Text> : null}
          {measureBlocked && !measured ? <Text className="wi-note">{measureBlocked}</Text> : null}
        </View>
      ) : (
        <View className={'place-btn' + (plan.placing ? ' on' : '')} onClick={onPlace} hoverClass="act-press">
          <Icon id="ui-target" color={plan.placing ? '#FFFFFF' : '#2468F2'} size={18} />
          <Text>{plan.placing ? '在地图上点一下放置…' : `在地图上放一个${newNoun(cat)}`}</Text>
        </View>
      )}

      {mine.length ? (
        <>
          <SectionHead title="建议位置" note="按能补上的小区数排序" />
          <View className="sites">
            {mine.map((p) => (
              <View
                key={p.key}
                className={'site' + (plan.hotSite === p.key ? ' on' : '')}
                onClick={() => onUseSite(p)}
                hoverClass="row-pressed"
              >
                <Text className="site-rank num">{p.rank}</Text>
                <View className="site-main">
                  <Text className="site-label">{p.label ? siteWords(p.label) : `建议 ${p.rank}`}</Text>
                  <Text className="site-covers">
                    补上 {p.covers.length} 个：{p.covers.map((c) => c.unit?.code ?? c.name).join('、')}
                  </Text>
                  {gain(p.covers.length) > 0 ? (
                    <Text className="site-gain num">评分 +{gain(p.covers.length)}</Text>
                  ) : null}
                </View>
                <Text className={'site-tag' + (p.verified ? ' ok' : '')}>
                  {p.verified ? '已实测' : '估算'}
                </Text>
              </View>
            ))}
          </View>
        </>
      ) : gaps ? (
        <Text className="plan-empty">这一类没有现成的建议位置，可以在地图上自己放一个试试。</Text>
      ) : null}

      {saved.length ? (
        <>
          <SectionHead title="核验过的位置" />
          <View className="sites">
            {saved.map((b) => (
              <View key={b.id} className="site" onClick={() => onRestore(b)} hoverClass="row-pressed">
                <View className="site-rank dot" />
                <View className="site-main">
                  <Text className="site-label">多 {b.newly_covered.length} 个小区走得到</Text>
                  <Text className="site-covers">{b.newly_covered.join('、') || '一个也没有'}</Text>
                </View>
                <Text className="site-tag ok">已实测</Text>
              </View>
            ))}
          </View>
        </>
      ) : null}
    </View>
  );
}
