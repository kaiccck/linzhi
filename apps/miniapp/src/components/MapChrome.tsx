/**
 * What floats over the map: the search capsule under the status bar (beside WeChat's own capsule),
 * and the round buttons on the right — 图层 and 回到中心.
 */
import { Text, View } from '@tarojs/components';
import type { LegendItem } from '../map/layers';
import { Icon } from '../platform/Icons';
import './MapChrome.css';

/** The point picked on the map, before it becomes the centre of a new check. */
export function PickCard({
  bottom,
  label,
  busy,
  onGo,
  onCancel,
}: {
  bottom: number;
  label: string;
  busy: boolean;
  onGo(): void;
  onCancel(): void;
}) {
  return (
    <View className="pick-card" style={{ bottom: `${bottom}px` }}>
      <View className="pick-text">
        <Text className="pick-t">以这里为中心体检</Text>
        <Text className="pick-n num">{label}</Text>
      </View>
      <View className="pick-x" onClick={onCancel} hoverClass="pressed">
        <Text>取消</Text>
      </View>
      <View
        className={'pick-go' + (busy ? ' busy' : '')}
        onClick={busy ? undefined : onGo}
        hoverClass="act-press"
      >
        <Text>{busy ? '定位中…' : '开始体检'}</Text>
      </View>
    </View>
  );
}

export function SearchCapsule({
  top,
  height,
  right,
  onTap,
}: {
  top: number;
  height: number;
  /** room WeChat's capsule takes at the right */
  right: number;
  onTap(): void;
}) {
  return (
    <View
      className="search-cap"
      style={{ top: `${top}px`, height: `${height}px`, right: `${right}px` }}
      onClick={onTap}
      hoverClass="pressed"
    >
      <Icon id="ui-search" color="#4E5662" size={17} />
      <Text className="search-ph">搜地址或小区，体检它的 15 分钟</Text>
    </View>
  );
}

export function MapButtons({
  top,
  onLayers,
  onRecenter,
  picking,
  onPick,
}: {
  top: number;
  onLayers(): void;
  onRecenter(): void;
  /** 选点体检 is on: the next tap on the map is a new centre */
  picking: boolean;
  onPick(): void;
}) {
  return (
    <View className="map-btns" style={{ top: `${top}px` }}>
      <View
        className={'map-btn' + (picking ? ' on' : '')}
        onClick={onPick}
        hoverClass="pressed"
        aria-label="在地图上选一个中心体检"
      >
        <Icon id="ui-target" color={picking ? '#FFFFFF' : '#16191F'} size={20} />
      </View>
      <View className="map-btn" onClick={onLayers} hoverClass="pressed" aria-label="图层">
        <Icon id="ui-layers" color="#16191F" size={20} />
      </View>
      <View className="map-btn" onClick={onRecenter} hoverClass="pressed" aria-label="回到片区中心">
        <Icon id="ui-locate" color="#2468F2" size={19} />
      </View>
    </View>
  );
}

/** 图例: what the plates' colours and the drawn areas mean, at the foot of the map. */
export function MapLegend({ bottom, items }: { bottom: number; items: readonly LegendItem[] }) {
  if (!items.length) return null;
  return (
    <View className="legend-card" style={{ bottom: `${bottom}px` }}>
      {items.map((it) => (
        <View key={it.key} className="lg-item">
          <View
            className={`lg-sw lg-${it.kind}`}
            style={
              it.kind === 'line'
                ? { borderTopColor: it.border }
                : {
                    background: it.bg,
                    borderColor: it.border,
                    borderStyle: it.dashed ? 'dashed' : 'solid',
                  }
            }
          />
          <Text className="lg-w">{it.word}</Text>
        </View>
      ))}
    </View>
  );
}
