/**
 * 体检报告: the analysis as one page to read and forward in WeChat — the answer, the reach, the
 * five categories, every community's checks, what 15 minutes reach, the suggested sites, and where
 * every number comes from. A community's code opens it on the map.
 */
import { Button, ScrollView, Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useMemo } from 'react';
import {
  circleKm2,
  circleMissShare,
  distWords,
  reachArea,
  STAT_ICON,
  CAT_COLOR,
  type Model,
} from '@web/model/derive';
import { facilitySummary } from '@web/model/facilities';
import { checkLook, type Look } from '@web/model/looks';
import { sitePins, siteWords } from '@web/model/siting';
import { Boundary } from '../../components/Boundary';
import { Radar } from '../../components/Radar';
import { RadarHead, ScoreBlock } from '../../components/ScoreScale';
import { fmt } from '../../components/ui';
import { lifeCircleScore } from '../../model/score';
import { unitNo } from '../../model/unitNo';
import { Icon } from '../../platform/Icons';
import * as store from '../../state/store';
import { walkText } from '../../views/AreaView';
import './index.css';

const CELL: Record<Look, string> = {
  ok: 'ok',
  edge: 'ok',
  'edge-over': 'pseudo',
  pseudo: 'pseudo',
  blind: 'blind',
  none: 'blind',
  pending: 'pending',
  na: 'na',
  neutral: 'pending',
};

function sentence(model: Model): string {
  const t = model.tally;
  const rule = distWords(model.ruleM);
  if (!t.units) return `${model.units.length} 个小区步行 ${rule}内，${model.cats.length} 类设施都走得到。`;
  const parts = [
    t.pseudo ? `${t.pseudo} 项直线不到 ${rule}、实际步行却超过` : '',
    t.blind ? `${t.blind} 项连直线都超过 ${rule}` : '',
  ]
    .filter(Boolean)
    .join('，');
  return (
    `${model.units.length} 个小区中，${t.units} 个步行 ${rule}内至少缺一类设施，按直线距离只能看出 ${t.circleUnits} 个。` +
    `共 ${model.walkGaps} 项缺口，${parts}。` +
    (t.pending ? `另有 ${t.pending} 项待核实，不计入。` : '')
  );
}

export default function ReportPage() {
  const s = store.useStore();
  const shown = store.shown(s);
  Taro.useShareAppMessage(() => ({
    title: shown ? `${shown.model.data.meta.name} 15 分钟生活圈体检报告` : '邻至体检报告',
    path: '/pages/index/index',
  }));
  const facts = useMemo(() => {
    if (!shown) return null;
    const m = shown.model;
    return {
      area: reachArea(m.raster, 900, 1),
      circle: circleKm2(m, 1),
      miss: circleMissShare(m, 1, 1),
      fac: facilitySummary(m, 1),
      pins: sitePins(m),
      score: lifeCircleScore(m),
      gray: (m.data.gray_areas ?? []).reduce((a, g) => a + (g.kind === 'gap' ? g.area_m2 : 0), 0) / 1e6,
    };
  }, [shown]);
  if (!shown || !facts) return <View className="rp-empty">先回到地图选一个片区</View>;
  const { model } = shown;
  const meta = model.data.meta;
  const region = meta.region
    ? `${meta.region.city ?? ''}${meta.region.district ?? ''}${meta.region.town ?? ''}`
    : '';
  // 小学 of 商办 compounds: no 对口小学 (neither a gap nor pending)
  const naOf = (cat: string) =>
    model.units.filter((u) => u.checks[cat as keyof typeof u.checks]?.school_assignment === 'not_applicable')
      .length;
  const openUnit = (code: string) => {
    store.openUnitOnMap(code);
    Taro.navigateBack().catch(() => {});
  };

  return (
    <View className="rp">
      <View className="rp-cover">
        <Text className="rp-title">{meta.name}</Text>
        <Text className="rp-meta">
          {[
            '15 分钟生活圈体检',
            region,
            meta.center_label ? `中心 ${meta.center_label}` : '',
            `百度地图实测 ${model.measuredOn}`,
          ]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      </View>

      <View className="rp-card">
        <Text className="rp-h">体检评分</Text>
        <ScoreBlock score={facts.score} cats={model.cats} rule={distWords(model.ruleM)} />
        <RadarHead />
        <View className="rp-radar">
          <Boundary>
            <Radar size={240} categories={facts.score.categories} playKey={`${model.id}#${shown.seq}`} />
          </Boundary>
        </View>
        <Text className="rp-p">{sentence(model)}</Text>
      </View>

      {facts.gray > 0 ? (
        <View className="rp-card">
          <Text className="rp-h">灰色区域</Text>
          <Text className="rp-p">
            <Text className="num b">{facts.gray.toFixed(2)}</Text> 平方公里的住区步行 {distWords(model.ruleM)}
            内至少缺一类设施（地图上灰色标出），是补点的优先范围。
          </Text>
        </View>
      ) : null}

      <View className="rp-card">
        <Text className="rp-h">15 分钟能走多远</Text>
        <Text className="rp-p">
          从片区中心出发，按百度实测步行时间，15 分钟走得到{' '}
          <Text className="num b">{facts.area.toFixed(2)}</Text> 平方公里；直线画的 15 分钟圈有{' '}
          <Text className="num b">{facts.circle.toFixed(2)}</Text> 平方公里，其中{' '}
          <Text className="num b pseudo">{Math.round(facts.miss * 100)}%</Text> 的地方实际走不到。
        </Text>
      </View>

      <View className="rp-card">
        <Text className="rp-h">五类设施</Text>
        <View className="rp-heads">
          {model.heads.map((h) => (
            <View key={h.cat} className="rp-head">
              <Icon id={STAT_ICON[h.cat]} color={CAT_COLOR[h.cat]} size={18} />
              <Text className="rp-head-cat">{h.cat}</Text>
              <Text className="rp-head-n">
                走得到 <Text className="num">{h.ok}</Text>
                {h.pseudo ? (
                  <Text className="pseudo">
                    {' '}
                    · 绕路太远 <Text className="num">{h.pseudo}</Text>
                  </Text>
                ) : null}
                {h.blind ? (
                  <Text>
                    {' '}
                    · 直线也远 <Text className="num">{h.blind}</Text>
                  </Text>
                ) : null}
                {h.pending ? (
                  <Text className="quiet">
                    {' '}
                    · 待核 <Text className="num">{h.pending}</Text>
                  </Text>
                ) : null}
                {naOf(h.cat) ? (
                  <Text className="quiet">
                    {' '}
                    · 无对口 <Text className="num">{naOf(h.cat)}</Text>
                  </Text>
                ) : null}
              </Text>
            </View>
          ))}
        </View>
      </View>

      <View className="rp-card wide">
        <Text className="rp-h pad">逐小区</Text>
        <ScrollView scrollX className="rp-table-wrap">
          <View className="rp-table">
            <View className="rp-tr head">
              <Text className="rp-td unit">小区</Text>
              {model.cats.map((k) => (
                <Text key={k} className="rp-td">
                  {k}
                </Text>
              ))}
            </View>
            {model.boardOrder.map((u) => (
              <View key={u.code} className="rp-tr" onClick={() => openUnit(u.code)}>
                <View className="rp-td unit">
                  <Text className="rp-code num">{unitNo(u.code)}</Text>
                  <Text className="rp-uname">
                    {u.nameMain}
                    {u.nameSub ? ` ${u.nameSub}` : ''}
                  </Text>
                </View>
                {model.cats.map((k) => {
                  const st = u.checks[k];
                  const look = checkLook(st);
                  return (
                    <Text key={k} className={`rp-td cell rc-${CELL[look]}`}>
                      {walkText(st)}
                    </Text>
                  );
                })}
              </View>
            ))}
          </View>
        </ScrollView>
        <View className="rp-legend">
          <Text className="lg rc-pseudo">红：绕路太远</Text>
          <Text className="lg rc-blind">深灰：直线也远</Text>
          <Text className="lg rc-ok">绿：走得到</Text>
          {model.tally.pending ? <Text className="lg rc-pending">灰：待核</Text> : null}
          {model.units.some((u) => u.checks.小学?.school_assignment === 'not_applicable') ? (
            <Text className="lg rc-na">无对口：商办产权，没有对口小学</Text>
          ) : null}
        </View>
      </View>

      <View className="rp-card">
        <Text className="rp-h">15 分钟能走到的设施</Text>
        <View className="rp-fac">
          {facts.fac.rows.map((r) => (
            <View key={r.cat} className="rp-fac-row">
              <Icon id={r.icon} color={CAT_COLOR[r.cat]} size={16} />
              <Text className="rp-fac-cat">{r.cat}</Text>
              <Text className="rp-fac-n">
                <Text className="num b">{r.walk}</Text>
                {r.circle > r.walk ? <Text className="quiet"> / 圈里 {r.circle}</Text> : null}
              </Text>
              <Text className="rp-fac-near">{r.nearestMin !== null ? `最近 ${r.nearestMin} 分钟` : '—'}</Text>
            </View>
          ))}
        </View>
      </View>

      {facts.pins.length ? (
        <View className="rp-card">
          <Text className="rp-h">补点建议</Text>
          {facts.pins
            .slice()
            .sort((a, b) => b.covers.length - a.covers.length)
            .slice(0, 6)
            .map((p) => (
              <View key={p.key} className="rp-pin">
                <Text className="rp-pin-cat">{p.cat}</Text>
                <View className="rp-pin-main">
                  <Text className="rp-pin-t">{p.label ? siteWords(p.label) : `建议 ${p.rank}`}</Text>
                  <Text className="rp-pin-n">
                    补上 {p.covers.length} 个小区{p.verified ? '（已用百度实测核验）' : '（估算）'}
                  </Text>
                </View>
              </View>
            ))}
        </View>
      ) : null}

      <View className="rp-card">
        <Text className="rp-h">方法与数据</Text>
        <Text className="rp-small">
          每个小区从出入口出发，用百度地图批量算路实测步行到最近一处设施，超过 {distWords(model.ruleM)}
          即为缺口； 直线距离在规则内而步行超出的为“绕路太远”（伪覆盖），直线就超出的为“直线也远”（盲区）。15
          分钟可达范围由 {fmt(model.data.samples.length)} 个实测采样点的步行时间插值得到，成人步速{' '}
          {(model.vAdult * 3.6).toFixed(1)} km/h，老人按 3.2 km/h 换算。
          设施来自百度地点检索，并与官方名录核对。
        </Text>
        {(meta.attribution ?? []).map((a) => (
          <Text key={a} className="rp-src">
            {a}
          </Text>
        ))}
      </View>

      <Button className="rp-share" openType="share">
        <Icon id="ui-share" color="#FFFFFF" size={18} />
        <Text>转发给同事</Text>
      </Button>
      <View className="rp-end" />
    </View>
  );
}
