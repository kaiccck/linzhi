/** Small shared pieces of the sheets: status chips, section heads, segmented controls. */
import { Text, View } from '@tarojs/components';
import type { ReactNode } from 'react';
import type { Look } from '@web/model/looks';
import { Icon } from '../platform/Icons';
import './ui.css';

/** A verdict as a chip: its word always beside its colour (never colour alone). */
const CHIP: Record<Look, { cls: string; word: string }> = {
  ok: { cls: 'ok', word: '走得到' },
  edge: { cls: 'edge', word: '临界' },
  'edge-over': { cls: 'edge', word: '临界·超出' },
  pseudo: { cls: 'pseudo', word: '绕路太远' },
  blind: { cls: 'blind', word: '直线也远' },
  none: { cls: 'blind', word: '没有' },
  pending: { cls: 'pending', word: '待核' },
  na: { cls: 'na', word: '无对口' },
  neutral: { cls: 'pending', word: '—' },
};

export function StatusChip({ look, small = false }: { look: Look; small?: boolean }) {
  const c = CHIP[look];
  return <Text className={`chip chip-${c.cls}${small ? ' chip-s' : ''}`}>{c.word}</Text>;
}

export function SectionHead({
  title,
  note,
  action,
  onAction,
}: {
  title: string;
  note?: ReactNode;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <View className="sec-head">
      <View className="sec-titles">
        <Text className="sec-title">{title}</Text>
        {note ? <Text className="sec-note">{note}</Text> : null}
      </View>
      {action && onAction ? (
        <View className="sec-action" onClick={onAction} hoverClass="pressed">
          <Text>{action}</Text>
          <Icon id="ui-right" color="#2468F2" size={14} />
        </View>
      ) : null}
    </View>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly { id: T; label: ReactNode }[];
  value: T;
  onChange(v: T): void;
}) {
  return (
    <View className="seg">
      {options.map((o) => (
        <View key={o.id} className={'seg-b' + (o.id === value ? ' on' : '')} onClick={() => onChange(o.id)}>
          {o.label}
        </View>
      ))}
    </View>
  );
}

/** A back row at the top of a sheet's sub-view: ‹ and where it goes back to. */
export function BackRow({ label, onBack, right }: { label: string; onBack(): void; right?: ReactNode }) {
  return (
    <View className="back-row">
      <View className="back" onClick={onBack} hoverClass="pressed">
        <Icon id="ui-back" color="#2468F2" size={18} />
        <Text>{label}</Text>
      </View>
      {right}
    </View>
  );
}

export const fmt = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
