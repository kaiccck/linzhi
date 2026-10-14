/** A sheet that rises over everything (the area list, the layers), dimming what is behind it. */
import { Text, View } from '@tarojs/components';
import type { ReactNode } from 'react';
import { Icon } from '../platform/Icons';
import './Popup.css';

export function Popup({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose(): void;
  title: string;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <View className="popup-root" catchMove>
      <View className="popup-dim" onClick={onClose} />
      <View className="popup">
        <View className="popup-head">
          <Text className="popup-title">{title}</Text>
          <View className="popup-x" onClick={onClose} hoverClass="pressed">
            <Icon id="ui-close" color="#7A828E" size={20} />
          </View>
        </View>
        {children}
      </View>
    </View>
  );
}
