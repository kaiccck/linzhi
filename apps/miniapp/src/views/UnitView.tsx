/**
 * One community, as a map app's place card: its code and name, then each checked category in a row
 * with its verdict and measured walk. A row opened shows the evidence — the straight line against the
 * real walking route Baidu measured, against the rule — while the map draws that route.
 */
import { Text, View } from '@tarojs/components';
import type { HardCategory } from '@zoudedao/core';
import type { EvidenceView } from '@web/map/evidenceCard';
import { CAT_COLOR, distWords, fmtInt, poiName, STAT_ICON, type Model } from '@web/model/derive';
import { catchmentText } from '@web/model/evidence';
import { freshText } from '@web/model/fresh';
import { checkLook } from '@web/model/looks';
import { BackRow, fmt, StatusChip } from '../components/ui';
import { Icon } from '../platform/Icons';
import { walkText } from './AreaView';
import './UnitView.css';

export function UnitView({
  part,
  model,
  code,
  cat,
  evidence,
  scale,
  onBack,
  onCat,
}: {
  model: Model;
  code: string;
  /** the sheet's fixed head, or its scrolling body */
  part: 'head' | 'body';
  /** the category whose route is open */
  cat: HardCategory | null;
  evidence: EvidenceView | null;
  scale: number;
  onBack(): void;
  onCat(cat: HardCategory): void;
}) {
  const u = model.units.find((x) => x.code === code);
  if (!u) return null;
  const gaps = model.cats.filter((k) => {
    const l = checkLook(u.checks[k]);
    return l === 'pseudo' || l === 'blind' || l === 'none' || l === 'edge-over';
  });
  if (part === 'head')
    return (
      <View className="sub-head">
        <BackRow label={model.data.meta.name} onBack={onBack} />
        <View className="unit-head">
          <Text className="unit-code num">{u.code}</Text>
          <View className="unit-titles">
            <Text className="unit-title">{u.nameMain}</Text>
            <Text className="unit-sub">
              {[
                u.nameSub,
                gaps.length ? `步行 ${distWords(model.ruleM)}内缺 ${gaps.join('、')}` : '五类设施都走得到',
              ]
                .filter(Boolean)
                .join(' · ')}
            </Text>
          </View>
        </View>
      </View>
    );
  return (
    <View className="unit">
      <View className="checks">
        {model.cats.map((k) => {
          const s = u.checks[k];
          const look = checkLook(s);
          const open = cat === k;
          return (
            <View key={k} className={'check' + (open ? ' open' : '')}>
              <View className="check-row" onClick={() => onCat(k)} hoverClass="row-pressed">
                <View className="check-ico">
                  <Icon id={STAT_ICON[k]} color={CAT_COLOR[k]} size={18} />
                </View>
                <View className="check-name">
                  <Text className="check-cat">{k}</Text>
                  <Text className="check-via">{poiName(s.via ?? s.nearest_straight ?? '') || '—'}</Text>
                </View>
                <View className="check-right">
                  <Text
                    className={
                      'check-walk num' + (look === 'pseudo' || look === 'edge-over' ? ' pseudo' : '')
                    }
                  >
                    {walkText(s)}
                  </Text>
                  <StatusChip look={look} small />
                </View>
              </View>
              {open ? <Evidence model={model} ev={evidence} scale={scale} /> : null}
            </View>
          );
        })}
      </View>
      {u.catchment ? <Text className="unit-note">{catchmentText(u.catchment)}</Text> : null}
    </View>
  );
}

/** Straight line, real walk and the rule on one scale; minutes; where the numbers come from. */
function Evidence({ model, ev, scale }: { model: Model; ev: EvidenceView | null; scale: number }) {
  if (!ev) return null;
  const { base, facts } = ev;
  const rule = model.ruleOf[base.cat];
  if (ev.status === 'failed') return <Text className="ev-msg">{ev.message}</Text>;
  const straight = facts?.straightM ?? base.straightM;
  const walk = facts?.routeM ?? null;
  const top = Math.max(rule * 1.25, straight, walk ?? 0);
  const pct = (m: number) => `${Math.min(100, (100 * m) / top)}%`;
  const over = walk !== null && walk > rule ? walk - rule : 0;
  return (
    <View className="ev">
      <View className="ev-bars">
        <Text className="evk">直线</Text>
        <View className="ev-track">
          <View className="ev-straight" style={{ width: pct(straight) }} />
          <View className="ev-rule" style={{ left: pct(rule) }} />
        </View>
        <Text className="evv num">{fmt(straight)} m</Text>
        <Text className="evk">实际步行</Text>
        <View className="ev-track">
          {walk === null ? (
            <View className="ev-loading" />
          ) : (
            <View className={'ev-walk' + (over ? ' over' : '')} style={{ width: pct(walk) }} />
          )}
          <View className="ev-rule" style={{ left: pct(rule) }} />
        </View>
        <Text className={'evv num' + (over ? ' pseudo' : '')}>{walk === null ? '…' : `${fmt(walk)} m`}</Text>
      </View>
      <Text className="ev-line">
        {walk === null
          ? '正在取百度步行路线…'
          : `${scale !== 1 ? '老人' : ''}约 ${facts!.minutes} 分钟${over ? `，比 ${distWords(rule)}多走 ${fmtInt(over)} m` : ''}；虚线是 ${distWords(rule)}`}
      </Text>
      {base.cat === '菜市场' && base.check.alt ? (
        <Text className="ev-foot">{freshText(base.check.alt)}</Text>
      ) : null}
      {facts?.checkRouteM ? (
        <Text className="ev-foot">判定用的批量算路距离 {fmtInt(facts.checkRouteM)} m</Text>
      ) : null}
      <Text className="ev-foot">
        {facts?.source === 'baidu' ? '刚从百度取回的步行路线' : '百度步行路线（存档）'}
      </Text>
    </View>
  );
}
