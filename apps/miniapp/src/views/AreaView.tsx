/**
 * The sheet on an area, in two layers. The head stays put: the area, the answer in one line (live
 * while 走一遍 plays), the actions, and three tabs. The body is the tab's: 概览 (the reach of 15
 * minutes and how much the circle overstates it), 缺口小区 (the communities that cannot walk to a
 * facility, one category at a time), 周边设施 (what 15 minutes reach, grouped as a resident thinks).
 */
import { Button, ScrollView, Slider, Text, View } from '@tarojs/components';
import { useEffect, useMemo, useState } from 'react';
import type { FacilityCheck, HardCategory } from '@zoudedao/core';
import { schoolNotApplicable, schoolPendingReason } from '@zoudedao/core';
import { CAT_COLOR, compass, distWords, poiName, STAT_ICON, type Model, type Unit } from '@web/model/derive';
import { facilitySummary, type FacilityRow } from '@web/model/facilities';
import { freshLine } from '@web/model/fresh';
import { checkLook, type Look } from '@web/model/looks';
import type { Profile } from '@web/state';
import { Boundary } from '../components/Boundary';
import { Radar } from '../components/Radar';
import { RadarHead, ScoreBlock } from '../components/ScoreScale';
import { fmt, Segmented, StatusChip } from '../components/ui';
import type { LifeCircleScore } from '../model/score';
import { Icon } from '../platform/Icons';
import './AreaView.css';

export type AreaTab = 'overview' | 'gaps' | 'nearby';

/**
 * A numeral that arrives as the circle would give it and moves to the walk's — the gap communities
 * count up 9 → 23, the score counts down 91 → 70: the radar's shrink, told by a number. Once per
 * analysis.
 */
export function useTween(from: number, to: number, key: string): number {
  const [v, setV] = useState(to);
  useEffect(() => {
    if (from === to) {
      setV(to);
      return;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    setV(from);
    const t0 = Date.now() + 420;
    const tick = () => {
      if (!live) return;
      const p = Math.max(0, Math.min(1, (Date.now() - t0) / 900));
      setV(Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3))));
      if (p < 1) timer = setTimeout(tick, 40);
    };
    timer = setTimeout(tick, 420);
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [key]);
  return v;
}

/* ================================================================ head */

export function AreaHead({
  model,
  sourceTag,
  walking,
  tab,
  onTab,
  onSwitch,
  onStop,
  onPlan,
  onReport,
  onAsk,
}: {
  model: Model;
  sourceTag: string;
  /** 走一遍 plays: the minute and the reach so far, in the answer's place */
  walking: { T: number; area: number } | null;
  tab: AreaTab;
  onTab(t: AreaTab): void;
  onSwitch(): void;
  onStop(): void;
  onPlan(): void;
  onReport(): void;
  onAsk(): void;
}) {
  const region = model.data.meta.region;
  const where = region
    ? `${region.district ?? ''}${region.town ?? ''}`
    : (model.data.meta.center_label ?? '');
  const { tally } = model;
  const shownUnits = useTween(tally.circleUnits, tally.units, `${model.id}|${model.data.meta.generated}`);
  return (
    <View className="ah">
      <View className="ah-top">
        <View className="ah-titles">
          <Text className="ah-title">{model.data.meta.name}</Text>
          <Text className="ah-sub">
            {[where, `${model.units.length} 个小区`, sourceTag].filter(Boolean).join(' · ')}
          </Text>
        </View>
        <View className="ah-switch" onClick={onSwitch} hoverClass="pressed">
          <Icon id="ui-search" color="#4E5662" size={14} />
          <Text>换个地方</Text>
        </View>
      </View>

      {walking ? (
        <View className="ah-answer walking">
          <Text className="ah-n num walk">{(walking.T / 60).toFixed(1)}′</Text>
          <View className="ah-words">
            <Text className="ah-main">
              走得到 <Text className="num">{walking.area.toFixed(2)}</Text> 平方公里
            </Text>
            <Text className="ah-note">从片区中心出发，按百度实测步行时间</Text>
          </View>
          <View className="ah-stop" onClick={onStop} hoverClass="pressed">
            <Text>停止</Text>
          </View>
        </View>
      ) : (
        <View className="ah-answer">
          {tally.units ? (
            <Text className={`ah-n num g-${shownUnits === tally.units ? 'pseudo' : 'quiet'}`}>
              {shownUnits}
            </Text>
          ) : (
            <View className="ah-done">
              <Icon id="pg-check" color="#1F9A8C" size={20} />
            </View>
          )}
          <View className="ah-words">
            <Text className="ah-main">
              {tally.units
                ? `个小区步行 ${distWords(model.ruleM)}内缺设施`
                : `每个小区步行 ${distWords(model.ruleM)}内都走得到`}
            </Text>
            <Text className="ah-note">
              {tally.units ? (
                <>
                  共 {model.units.length} 个小区，按直线距离只看得出{' '}
                  <Text className="num b">{tally.circleUnits}</Text> 个
                </>
              ) : (
                `${model.cats.join('、')}`
              )}
            </Text>
          </View>
        </View>
      )}

      <View className="acts">
        <View className="act" onClick={onPlan} hoverClass="act-press">
          <Icon id="ui-pin" color="#2468F2" size={17} />
          <Text>规划补点</Text>
        </View>
        <View className="act" onClick={onAsk} hoverClass="act-press">
          <Icon id="ui-chat" color="#2468F2" size={17} />
          <Text>问 AI</Text>
        </View>
        <View className="act" onClick={onReport} hoverClass="act-press">
          <Icon id="ui-doc" color="#2468F2" size={17} />
          <Text>报告</Text>
        </View>
        <Button className="act act-btn" openType="share" hoverClass="act-press">
          <Icon id="ui-share" color="#2468F2" size={17} />
          <Text>转发</Text>
        </Button>
      </View>

      <View className="tabs">
        {(
          [
            ['overview', '概览'],
            ['gaps', '缺口小区'],
            ['nearby', '周边设施'],
          ] as const
        ).map(([id, label]) => (
          <View key={id} className={'tab' + (tab === id ? ' on' : '')} onClick={() => onTab(id)}>
            <Text>{label}</Text>
            {id === 'gaps' && tally.units ? <Text className="tab-n num">{tally.units}</Text> : null}
          </View>
        ))}
      </View>
    </View>
  );
}

/* ================================================================ 概览 */

export function Overview({
  model,
  T,
  playing,
  walked,
  onPlay,
  onScrub,
  area,
  circleKm2,
  missShare,
  profile,
  onProfile,
  kmh,
  detourOn,
  onDetour,
  score,
  playKey,
  gray,
  onGray,
  method,
  onMethod,
}: {
  model: Model;
  score: LifeCircleScore;
  /** replays the radar's shrink (a new analysis, another walker) */
  playKey: string;
  gray: boolean;
  onGray(): void;
  method: boolean;
  onMethod(): void;
  T: number;
  playing: boolean;
  walked: boolean;
  onPlay(): void;
  onScrub(T: number): void;
  area: number;
  circleKm2: number;
  missShare: number;
  profile: Profile;
  onProfile(p: Profile): void;
  kmh: { adult: string; elder: string };
  detourOn: boolean;
  onDetour(): void;
}) {
  const m = T / 60;
  const minutes = !playing && Number.isInteger(m) ? String(m) : m.toFixed(1);
  const d = model.detour;
  const grayArea =
    (model.data.gray_areas ?? []).reduce((s, g) => s + (g.kind === 'gap' ? g.area_m2 : 0), 0) / 1e6;
  const st = model.data.stats;
  const matrix = model.data.samples.filter((x) => x.src === 'routematrix').length;
  const along = model.data.samples.length - matrix;
  const shownScore = useTween(score.circle, score.walk, playKey);
  return (
    <View className="ov">
      <View className="ov-sec">
        <Text className="ov-title">体检评分</Text>
        <ScoreBlock score={score} cats={model.cats} rule={distWords(model.ruleM)} shown={shownScore} />
        <RadarHead />
        <View className="score-radar">
          <Boundary>
            <Radar size={232} categories={score.categories} playKey={playKey} />
          </Boundary>
        </View>
      </View>

      <View className="ov-sec">
        <View className="ov-head">
          <Text className="ov-title">{minutes} 分钟走得到</Text>
          <Segmented
            value={profile}
            onChange={onProfile}
            options={[
              { id: 'adult', label: <Text>成人</Text> },
              { id: 'elder', label: <Text>老人</Text> },
            ]}
          />
        </View>
        <View className="reach-line">
          <Text className="rl-v num">{area.toFixed(2)}</Text>
          <Text className="rl-u">平方公里</Text>
        </View>
        <Text className="reach-sub">
          直线 15 分钟圈 <Text className="num">{circleKm2.toFixed(2)}</Text> 平方公里，其中{' '}
          <Text className="num pseudo">{Math.round(missShare * 100)}%</Text> 实际走不到 ·{' '}
          {profile === 'elder' ? kmh.elder : kmh.adult} km/h
        </Text>
        <View className="player">
          <View className={'play' + (playing ? ' on' : '')} onClick={onPlay} hoverClass="act-press">
            <Icon id={playing ? 'ui-close' : 'pg-play'} color="#FFFFFF" size={playing ? 16 : 15} />
          </View>
          <View className="scrub">
            <Slider
              className="scrub-slider"
              min={0}
              max={1200}
              step={30}
              value={T}
              activeColor="#EAC47C"
              backgroundColor="#E9EBEF"
              blockColor="#2468F2"
              blockSize={20}
              onChanging={(e) => onScrub(e.detail.value)}
              onChange={(e) => onScrub(e.detail.value)}
            />
            <View className="ticks">
              {[0, 5, 10, 15, 20].map((t) => (
                <Text
                  key={t}
                  className={'tick num' + (t === 15 ? ' k15' : '')}
                  style={{ left: `${(t / 20) * 100}%` }}
                >
                  {t}′
                </Text>
              ))}
            </View>
          </View>
        </View>
        <Text className="player-note">
          {playing
            ? '正在从 0 分钟走到 15 分钟…'
            : walked
              ? '再点一次，重走一遍'
              : '点播放，看 15 分钟一步步走出去'}
        </Text>
      </View>

      {grayArea > 0 ? (
        <View className={'ov-sec toggle' + (gray ? ' on' : '')} onClick={onGray} hoverClass="row-pressed">
          <View className="tg-text">
            <Text className="ov-title">灰色区域</Text>
            <Text className="ov-p">
              <Text className="num b">{grayArea.toFixed(2)}</Text> 平方公里的住区步行 {distWords(model.ruleM)}
              内至少缺一类设施，地图上以灰色标出
            </Text>
          </View>
          <Text className="tg-go">{gray ? '隐藏' : '显示'}</Text>
        </View>
      ) : null}

      {d ? (
        <View
          className={'ov-sec detour' + (detourOn ? ' on' : '')}
          onClick={onDetour}
          hoverClass="row-pressed"
        >
          <View className="dt-text">
            <Text className="ov-title">绕路最远的方向</Text>
            <Text className="ov-p">
              {compass(d.bearing)} <Text className="num b">{fmt(d.straight)}</Text> m 的地方，要走{' '}
              <Text className="num b pseudo">{fmt(d.route)}</Text> m，约 {Math.round(d.dur / 60)} 分钟
              {model.barrierNames.length ? `；挡在中间的是${model.barrierNames.join('和')}` : ''}
            </Text>
          </View>
          <Text className="dt-go">{detourOn ? '收起' : '看路线'}</Text>
        </View>
      ) : null}

      <View className={'ov-sec toggle' + (method ? ' on' : '')} onClick={onMethod} hoverClass="row-pressed">
        <View className="tg-text">
          <Text className="ov-title">怎么测出来的</Text>
          <Text className="ov-p">
            不用路网数据，只用百度地图实测：批量算路测了 <Text className="num b">{matrix}</Text> 个点、 沿{' '}
            <Text className="num b">{model.data.paths.length}</Text> 条步行路线取了{' '}
            <Text className="num b">{along}</Text> 个点，再空间插值成连续的步行时间；留一法检验平均误差{' '}
            <Text className="num b">{typeof st.loo_mae_s === 'number' ? Math.round(st.loo_mae_s) : '—'}</Text>{' '}
            秒
            {model.data.barriers?.length
              ? `，并从时间突变里找出 ${model.data.barriers.length} 段河道、高架等阻隔`
              : ''}
            。
          </Text>
        </View>
        <Text className="tg-go">{method ? '收起' : '看采样点'}</Text>
      </View>

      <Provenance model={model} />
    </View>
  );
}

/* ================================================================ 缺口小区 */

const FINE: ReadonlySet<Look> = new Set(['ok', 'edge']);
const RANK: Partial<Record<Look, number>> = { none: 0, pseudo: 1, blind: 1, 'edge-over': 1, pending: 2 };
const walkOf = (s: FacilityCheck) => (s.route_m > 0 ? s.route_m : Infinity);

/** The measured walk, set by where it came from: ≥ a lower bound, ≈ an estimate, ≤ an upper bound. */
export function walkText(s: FacilityCheck): string {
  // the chip beside it says 待核, or 无对口 (a 商办 compound has no 对口小学)
  if (schoolPendingReason(s)) return '—';
  if (schoolNotApplicable(s)) return '无对口';
  const look = checkLook(s);
  if (look === 'none') return '没有';
  const bound =
    look === 'pending' || s.route_upper_bound
      ? '≤'
      : s.route_basis === 'lower_bound'
        ? '≥'
        : s.route_basis === 'estimated'
          ? '≈'
          : '';
  return `${bound}${fmt(s.route_m)} m`;
}

export function Gaps({
  model,
  cat,
  onCat,
  walking,
  onUnit,
}: {
  model: Model;
  cat: HardCategory;
  onCat(c: HardCategory): void;
  walking: boolean;
  onUnit(code: string): void;
}) {
  const [open, setOpen] = useState(false);
  const rule = model.ruleOf[cat];
  const { main, rest } = useMemo(() => {
    const all = model.units.map((u) => ({ u, s: u.checks[cat], look: checkLook(u.checks[cat]) }));
    const main = all
      .filter((r) => !FINE.has(r.look))
      .sort((a, b) => (RANK[a.look] ?? 3) - (RANK[b.look] ?? 3) || walkOf(b.s) - walkOf(a.s));
    const rest = all.filter((r) => FINE.has(r.look)).sort((a, b) => walkOf(b.s) - walkOf(a.s));
    return { main, rest };
  }, [model, cat]);
  const fresh = cat === '菜市场' ? freshLine(model) : null;
  return (
    <View className="gaps">
      <CategoryChips model={model} cat={cat} onCat={onCat} walking={walking} />
      <Text className="gaps-note">
        每个小区实测步行到最近一处{cat}，超过 {distWords(rule)}即为缺口
      </Text>
      {main.length === 0 ? (
        <View className="all-ok">
          <Icon id="pg-check" color="#1F9A8C" size={16} />
          <Text>
            {model.units.length} 个小区步行 {distWords(rule)}内都走得到{cat}
          </Text>
        </View>
      ) : null}
      <View className="rows">
        {[...main, ...(open || !main.length ? rest : [])].map(({ u, s, look }) => (
          <UnitRow key={u.code} u={u} s={s} look={walking ? 'neutral' : look} onTap={() => onUnit(u.code)} />
        ))}
      </View>
      {rest.length && main.length ? (
        <View className="fold" onClick={() => setOpen(!open)} hoverClass="pressed">
          <Text>{open ? '收起走得到的小区' : `其余 ${rest.length} 个小区走得到`}</Text>
          <Icon id={open ? 'ui-down' : 'ui-right'} color="#7A828E" size={13} />
        </View>
      ) : null}
      {fresh ? (
        <View className="fresh">
          <View className="fresh-k" />
          <Text>{fresh}</Text>
        </View>
      ) : null}
    </View>
  );
}

export function CategoryChips({
  model,
  cat,
  onCat,
  walking = false,
}: {
  model: Model;
  cat: HardCategory;
  onCat(c: HardCategory): void;
  walking?: boolean;
}) {
  // scroll to the chosen chip once the row is laid out (not on the first frame)
  const at = model.cats.indexOf(cat);
  const [chip, setChip] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setChip(`chip-${at}`), 120);
    return () => clearTimeout(t);
  }, [at]);
  return (
    <ScrollView
      scrollX
      className="cats"
      showScrollbar={false}
      enhanced
      scrollWithAnimation
      scrollIntoView={chip}
    >
      <View className="cats-in">
        {model.heads.map((h, i) => {
          const gaps = h.pseudo + h.blind;
          return (
            <View
              key={h.cat}
              id={`chip-${i}`}
              className={'cat' + (h.cat === cat ? ' on' : '')}
              onClick={() => onCat(h.cat)}
            >
              <Icon id={STAT_ICON[h.cat]} color={CAT_COLOR[h.cat]} size={16} />
              <Text className="cat-name">{h.cat}</Text>
              {walking ? null : gaps ? (
                <Text className="cat-n num">{gaps}</Text>
              ) : (
                <Icon id="pg-check" color="#1F9A8C" size={13} />
              )}
            </View>
          );
        })}
      </View>
    </ScrollView>
  );
}

const CODE_CLS: Partial<Record<Look, string>> = {
  pseudo: 'c-pseudo',
  'edge-over': 'c-pseudo',
  blind: 'c-blind',
  none: 'c-blind',
  pending: 'c-pending',
  ok: 'c-ok',
  edge: 'c-ok',
};

export function UnitRow({ u, s, look, onTap }: { u: Unit; s: FacilityCheck; look: Look; onTap(): void }) {
  return (
    <View className="urow" onClick={onTap} hoverClass="row-pressed">
      <Text className={`code num ${CODE_CLS[look] ?? 'c-quiet'}`}>{u.code}</Text>
      <View className="u-name">
        <Text className="u-main">{u.nameMain}</Text>
        {u.nameSub ? <Text className="u-sub">{u.nameSub}</Text> : null}
      </View>
      <View className="u-right">
        <Text className={'u-walk num' + (look === 'pseudo' || look === 'edge-over' ? ' pseudo' : '')}>
          {/* 无对口 is said by the chip */}
          {look === 'neutral' || look === 'na' ? '—' : walkText(s)}
        </Text>
        {look === 'neutral' ? null : <StatusChip look={look} small />}
      </View>
      <Icon id="ui-right" color="#C2C7CF" size={14} />
    </View>
  );
}

/* ================================================================ 周边设施 */

/** What 15 minutes reach, in the groups of the task (医疗、教育、购物、养老) and of a day. */
export const NEARBY_GROUPS: readonly { title: string; cats: readonly string[] }[] = [
  // the task's four (医疗、教育、购物、养老) first, then what a day also needs
  { title: '医疗', cats: ['社区卫生', '药店'] },
  { title: '教育', cats: ['幼儿园', '小学', '中学'] },
  { title: '购物', cats: ['菜市场', '生鲜超市', '超市', '便利店', '餐饮'] },
  { title: '养老', cats: ['养老'] },
  { title: '出行', cats: ['公交', '地铁'] },
  { title: '生活服务', cats: ['快递', '银行'] },
  { title: '文体', cats: ['公园', '健身', '文化'] },
];

const MEASURE: Record<string, string> = {
  餐饮: '家',
  超市: '家',
  便利店: '家',
  生鲜超市: '家',
  药店: '家',
  银行: '家',
  幼儿园: '所',
  小学: '所',
  中学: '所',
  公交: '个站',
  地铁: '个站',
  菜市场: '个',
};
export const measure = (cat: string) => MEASURE[cat] ?? '处';

export function Nearby({
  model,
  scale,
  elder,
  onCategory,
}: {
  model: Model;
  scale: number;
  elder: boolean;
  onCategory(row: FacilityRow): void;
}) {
  const rows = useMemo(
    () => new Map(facilitySummary(model, scale).rows.map((r) => [r.cat as string, r])),
    [model, scale],
  );
  return (
    <View className="nb">
      <Text className="nb-note">从片区中心出发，{elder ? '按老人步速' : ''}步行 15 分钟走得到的设施</Text>
      {NEARBY_GROUPS.map((g) => {
        const here = g.cats.flatMap((c) => (rows.get(c) ? [rows.get(c)!] : []));
        if (!here.length) return null;
        return (
          <View key={g.title} className="nb-group">
            <Text className="nb-h">{g.title}</Text>
            {here.map((r) => (
              <View key={r.cat} className="nb-row" onClick={() => onCategory(r)} hoverClass="row-pressed">
                <View className="nb-ico">
                  <Icon id={r.icon} color={r.walk ? CAT_COLOR[r.cat] : '#A9AFB8'} size={17} />
                </View>
                <Text className="nb-cat">{r.cat}</Text>
                <View className="nb-right">
                  <Text className={'nb-n num' + (r.walk ? '' : ' none')}>
                    {r.walk}
                    <Text className="nb-unit"> {measure(r.cat)}</Text>
                  </Text>
                  <Text className="nb-sub">
                    {r.walk
                      ? r.nearestMin !== null
                        ? `最近 ${Math.max(1, r.nearestMin)} 分钟`
                        : ''
                      : r.circle
                        ? `圈里有 ${r.circle} ${measure(r.cat)}，走不到`
                        : '附近没有'}
                  </Text>
                </View>
                <Icon id="ui-right" color="#C2C7CF" size={14} />
              </View>
            ))}
          </View>
        );
      })}
    </View>
  );
}

export function Provenance({ model }: { model: Model }) {
  const meta = model.data.meta;
  return (
    <Text className="prov">
      步行时间：百度地图批量算路实测 {model.measuredOn}，成人 {(model.vAdult * 3.6).toFixed(1)}{' '}
      km/h；设施：百度地点检索
      {model.usesOsm ? '；小区轮廓 © OpenStreetMap' : ''}。中心 {meta.center_label ?? poiName(meta.name)}。
    </Text>
  );
}
