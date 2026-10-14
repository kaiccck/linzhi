/** 图层: what the map draws besides the verdicts, and how long the walk takes at crossings. */
import { Switch, Text, View } from '@tarojs/components';
import { Popup } from './Popup';
import './Layers.css';

export interface LayerFlags {
  circle: boolean;
  heat: boolean;
  gray: boolean;
  crossing: boolean;
}

const ROWS: { key: keyof LayerFlags; label: string; note: string }[] = [
  { key: 'circle', label: '直线 15 分钟圈', note: '画圈法的说法，虚线' },
  { key: 'heat', label: '耗时色阶', note: '越远越淡，按实测步行时间' },
  { key: 'gray', label: '灰色区域', note: '步行 1 公里内缺设施的地方' },
  { key: 'crossing', label: '含过街等待', note: '步行时间加 5%，估算' },
];

export function Layers({
  open,
  onClose,
  flags,
  onFlag,
  hasGray,
}: {
  open: boolean;
  onClose(): void;
  flags: LayerFlags;
  onFlag(key: keyof LayerFlags, on: boolean): void;
  hasGray: boolean;
}) {
  return (
    <Popup open={open} onClose={onClose} title="图层">
      <View className="ly-list">
        {ROWS.filter((r) => r.key !== 'gray' || hasGray).map((r) => (
          <View key={r.key} className="ly-row">
            <View className="ly-main">
              <Text className="ly-label">{r.label}</Text>
              <Text className="ly-note">{r.note}</Text>
            </View>
            <Switch checked={flags[r.key]} color="#2468F2" onChange={(e) => onFlag(r.key, e.detail.value)} />
          </View>
        ))}
      </View>
    </Popup>
  );
}
