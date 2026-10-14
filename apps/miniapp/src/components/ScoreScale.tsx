/**
 * The score with what a newcomer needs to read it: the number and its band, where it sits on the
 * scale everyone can read (0–100 in four bands — 待改善 / 需关注 / 基本达标 / 良好, cut at 60, 75, 90 —
 * the walk's score a filled mark, the straight line's a hollow one), the standard it is held to, and
 * how it is counted. Shared by 概览 and the report.
 */
import { Text, View } from '@tarojs/components';
import type { HardCategory } from '@zoudedao/core';
import { CAT_COLOR, STAT_ICON } from '@web/model/derive';
import type { LifeCircleScore } from '../model/score';
import { Icon } from '../platform/Icons';
import './ScoreScale.css';

const BANDS = [
  { to: 60, word: '待改善', cls: 'b0' },
  { to: 75, word: '需关注', cls: 'b1' },
  { to: 90, word: '基本达标', cls: 'b2' },
  { to: 100, word: '良好', cls: 'b3' },
] as const;

/** Where the two tags go (in % of the track): over their marks, pushed apart when they would touch. */
function tagSpots(walk: number, circle: number | null): { walk: number; circle: number | null } {
  const GAP = 17;
  const clamp = (v: number) => Math.max(8, Math.min(92, v));
  if (circle === null) return { walk: clamp(walk), circle: null };
  let a = walk;
  let b = circle;
  if (b - a < GAP) {
    const mid = (a + b) / 2;
    a = mid - GAP / 2;
    b = mid + GAP / 2;
  }
  // keep both inside, the pair moving together
  if (a < 8) [a, b] = [8, 8 + Math.max(GAP, b - a)];
  if (b > 92) [a, b] = [92 - Math.max(GAP, b - a), 92];
  return { walk: a, circle: b };
}

export function ScoreScale({ walk, circle }: { walk: number; circle: number }) {
  const claim = circle > walk ? circle : null;
  const spot = tagSpots(walk, claim);
  return (
    <View className="ss">
      <View className="ss-tags">
        <Text className="ss-tag walk num" style={{ left: `${spot.walk}%` }}>
          实测 {walk}
        </Text>
        {spot.circle !== null ? (
          <Text className="ss-tag claim num" style={{ left: `${spot.circle}%` }}>
            直线 {claim}
          </Text>
        ) : null}
      </View>
      <View className="ss-track">
        {BANDS.map((b, i) => (
          <View
            key={b.cls}
            className={`ss-band ${b.cls}`}
            style={{ width: `${b.to - (i ? BANDS[i - 1]!.to : 0)}%` }}
          />
        ))}
        {claim !== null ? <View className="ss-mark claim" style={{ left: `${claim}%` }} /> : null}
        <View className="ss-mark walk" style={{ left: `${walk}%` }} />
      </View>
      <View className="ss-words">
        {BANDS.map((b, i) => (
          <View key={b.cls} className="ss-word" style={{ width: `${b.to - (i ? BANDS[i - 1]!.to : 0)}%` }}>
            <Text className="ss-w">{b.word}</Text>
            <Text className="ss-r num">
              {i ? BANDS[i - 1]!.to : 0}–{b.to}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

export function ScoreBlock({
  score,
  cats,
  rule,
  shown,
}: {
  score: LifeCircleScore;
  cats: readonly HardCategory[];
  /** the rule in words, "1 公里" */
  rule: string;
  /** the numeral as it shows now (it counts down from the straight line's on arrival) */
  shown?: number;
}) {
  const n = shown ?? score.walk;
  const settled = n === score.walk;
  return (
    <View className="sb">
      <View className="sb-line">
        <Text className={`sb-n num g-${settled ? score.grade.tone : 'quiet'}`}>{n}</Text>
        <Text className="sb-u">分</Text>
        <Text className={`grade g-${score.grade.tone}`}>{score.grade.word}</Text>
        {score.circle > score.walk ? (
          <Text className="sb-claim">
            按直线距离算 <Text className="num struck">{score.circle}</Text> 分
          </Text>
        ) : null}
      </View>
      <ScoreScale walk={score.walk} circle={score.circle} />

      <View className="sb-how">
        <View className="sb-row">
          <Text className="sb-k">标准</Text>
          <Text className="sb-v">每个小区步行 {rule}（约 15 分钟）内应走得到：</Text>
        </View>
        <View className="sb-cats">
          {cats.map((c) => (
            <View key={c} className="sb-cat">
              <Icon id={STAT_ICON[c]} color={CAT_COLOR[c]} size={15} />
              <Text>{c}</Text>
            </View>
          ))}
        </View>
        <View className="sb-row">
          <Text className="sb-k">算法</Text>
          <Text className="sb-v">
            每类设施算覆盖率：走得到它的小区 ÷ 全部小区；得分是 {cats.length} 类覆盖率的平均 × 100
            {score.pending ? `，${score.pending} 项待核实的不计入` : ''}。
          </Text>
        </View>
        <View className="sb-row">
          <Text className="sb-k">对比</Text>
          <Text className="sb-v">
            “实测”按百度步行路线的真实距离；“直线”只量直线，隔着河、高架、围墙也算走得到，因此偏高。
          </Text>
        </View>
      </View>
    </View>
  );
}

/** The radar's title with its key: the walk's share, and what the straight line adds on top. */
export function RadarHead() {
  return (
    <View className="rh">
      <Text className="rh-t">各类设施覆盖率</Text>
      <View className="legend">
        <View className="lg-k walk" />
        <Text>实测</Text>
        <View className="lg-k miss" />
        <Text>直线多算的</Text>
      </View>
    </View>
  );
}
