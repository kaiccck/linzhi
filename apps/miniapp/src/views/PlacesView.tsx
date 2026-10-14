/**
 * One category of what 15 minutes reach (餐饮, 超市, 公交 …): every facility of it the walk reaches,
 * nearest first in walking minutes, then those the straight circle claims but the walk does not.
 * The map shows the same facilities; a row tapped names its facility there.
 */
import { ScrollView, Text, View } from '@tarojs/components';
import { useEffect, useMemo, useState } from 'react';
import { CAT_COLOR, poiName, type Model } from '@web/model/derive';
import { facilityMarks, type FacilityMark, type FacilityRow } from '@web/model/facilities';
import { BackRow, fmt, SectionHead } from '../components/ui';
import { Icon } from '../platform/Icons';
import './PlacesView.css';

export function placeMarks(model: Model, cat: string, scale: number): FacilityMark[] {
  return facilityMarks(model, scale).filter((m) => m.cat === cat && !m.fresh);
}

export function PlacesView({
  part,
  model,
  row,
  scale,
  selected,
  onSelect,
  onBack,
  rows,
  onCategory,
}: {
  model: Model;
  row: FacilityRow;
  /** the sheet's fixed head, or its scrolling body */
  part: 'head' | 'body';
  scale: number;
  selected: string | null;
  onSelect(key: string): void;
  onBack(): void;
  /** every category of 周边设施, to switch between without going back */
  rows: readonly FacilityRow[];
  onCategory(row: FacilityRow): void;
}) {
  const others = rows;
  // the chips scroll to the category on screen once they are laid out (not on the first frame)
  const [chip, setChip] = useState('');
  const at = others.findIndex((r) => r.cat === row.cat);
  useEffect(() => {
    const t = setTimeout(() => setChip(`fchip-${at}`), 120);
    return () => clearTimeout(t);
  }, [at]);
  const marks = useMemo(() => placeMarks(model, row.cat, scale), [model, row.cat, scale]);
  const reach = marks.filter((m) => m.reach).sort((a, b) => a.t - b.t);
  const claim = marks.filter((m) => !m.reach && m.inCircle).sort((a, b) => a.t - b.t);
  const who = scale === 1 ? '' : '老人';
  if (part === 'head')
    return (
      <View className="sub-head">
        <BackRow label={model.data.meta.name} onBack={onBack} />
        <View className="places-head">
          <View className="places-ico">
            <Icon id={row.icon} color={CAT_COLOR[row.cat]} size={22} />
          </View>
          <View className="places-titles">
            <Text className="places-title">
              {who}15 分钟走得到 {reach.length} {unitOf(row.cat)}
              {row.cat}
            </Text>
            <Text className="places-sub">
              {claim.length
                ? `直线圈里还有 ${claim.length} ${unitOf(row.cat)}，实际 15 分钟走不到`
                : '直线圈里的都走得到'}
            </Text>
          </View>
        </View>
        {others.length > 1 ? (
          <ScrollView
            scrollX
            className="cats places-cats"
            showScrollbar={false}
            enhanced
            scrollWithAnimation
            scrollIntoView={chip}
          >
            <View className="cats-in">
              {others.map((r, i) => (
                <View
                  key={r.cat}
                  id={`fchip-${i}`}
                  className={'cat' + (r.cat === row.cat ? ' on' : '')}
                  onClick={() => onCategory(r)}
                >
                  <Icon id={r.icon} color={CAT_COLOR[r.cat]} size={15} />
                  <Text className="cat-name">{r.cat}</Text>
                  <Text className="cat-c num">{r.walk}</Text>
                </View>
              ))}
            </View>
          </ScrollView>
        ) : null}
      </View>
    );
  return (
    <View className="places">
      {reach.length ? (
        <View className="plist">
          {reach.map((m, i) => (
            <PlaceRow key={m.key} m={m} rank={i + 1} on={selected === m.key} onTap={() => onSelect(m.key)} />
          ))}
        </View>
      ) : (
        <Text className="places-empty">从片区中心步行 15 分钟内没有{row.cat}。</Text>
      )}
      {claim.length ? (
        <>
          <SectionHead title="圈里有、走不到" note="直线距离在 15 分钟圈内，实际步行超过 15 分钟" />
          <View className="plist">
            {claim.map((m) => (
              <PlaceRow key={m.key} m={m} on={selected === m.key} onTap={() => onSelect(m.key)} />
            ))}
          </View>
        </>
      ) : null}
      <Text className="places-foot">
        步行分钟按片区中心出发的实测步行时间场估算到每处入口；设施来自百度地点检索，半径约 1.1 公里。
      </Text>
    </View>
  );
}

function unitOf(cat: string): string {
  if (
    cat === '餐饮' ||
    cat === '便利店' ||
    cat === '超市' ||
    cat === '药店' ||
    cat === '银行' ||
    cat === '生鲜超市'
  )
    return '家';
  if (cat === '幼儿园' || cat === '小学' || cat === '中学') return '所';
  if (cat === '公交' || cat === '地铁') return '个';
  return '处';
}

function PlaceRow({ m, rank, on, onTap }: { m: FacilityMark; rank?: number; on: boolean; onTap(): void }) {
  const min = Number.isFinite(m.t) ? Math.max(1, Math.round(m.t / 60)) : null;
  return (
    <View className={'prow' + (on ? ' on' : '')} onClick={onTap} hoverClass="row-pressed">
      {rank ? <Text className="p-rank num">{rank}</Text> : <View className="p-rank dot" />}
      <View className="p-name">
        <Text className="p-main">{poiName(m.face.name)}</Text>
        <Text className="p-sub">直线 {fmt(m.straight)} m</Text>
      </View>
      <View className="p-time">
        <Text className={'p-min num' + (m.reach ? '' : ' pseudo')}>{min ?? '—'}</Text>
        <Text className="p-unit">分钟</Text>
      </View>
    </View>
  );
}
