/**
 * A live check on its way, in the sheet's place: where it is, what is being measured now, how far
 * along, what has come in so far, and the way out.
 */
import { Text, View } from '@tarojs/components';
import { STAGES, stageIndex, type StreamState } from '@web/data/stream';
import { Icon } from '../platform/Icons';
import './RunView.css';

export function RunView({
  label,
  stream,
  note,
  onCancel,
}: {
  label: string;
  stream: StreamState;
  note: string | null;
  onCancel(): void;
}) {
  const at = stageIndex(stream.stage?.stage);
  const p = Math.max(0.03, Math.min(1, stream.stage?.progress ?? 0.03));
  const pois = stream.partial.pois?.length ?? 0;
  const samples = stream.partial.samples?.length ?? 0;
  return (
    <View className="run">
      <View className="run-head">
        <View className="run-dot">
          <Icon id="pg-walk" color="#FFFFFF" size={20} />
        </View>
        <View className="run-titles">
          <Text className="run-title">正在体检 {label}</Text>
          <Text className="run-msg">{stream.stage?.message ?? '连接服务端…'}</Text>
        </View>
        <View className="run-x" onClick={onCancel} hoverClass="pressed">
          <Text>取消</Text>
        </View>
      </View>
      <View className="run-bar">
        <View className="run-bar-in" style={{ width: `${p * 100}%` }} />
      </View>
      <View className="run-steps">
        {STAGES.map((s, i) => (
          <View key={s.id} className={'run-step' + (i < at ? ' done' : i === at ? ' now' : '')}>
            <View className="rs-dot" />
            <Text>{s.word}</Text>
          </View>
        ))}
      </View>
      <Text className="run-facts">
        {[pois ? `已找到设施 ${pois} 处` : '', samples ? `已实测步行时间 ${samples} 个点` : '']
          .filter(Boolean)
          .join(' · ') || '百度地图实测，通常需要 30–60 秒'}
      </Text>
      {note ? <Text className="run-note">{note}</Text> : null}
    </View>
  );
}
