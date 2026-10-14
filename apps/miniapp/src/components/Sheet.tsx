/**
 * The bottom sheet over the map: three heights (peek, half, full), dragged by its handle or tapped
 * to the next. Its height is reported up so the map frames what stays visible above it.
 */
import { ScrollView, View, type CommonEvent } from '@tarojs/components';
import { useRef, useState, type ReactNode } from 'react';
import './Sheet.css';

export type Snap = 'peek' | 'half' | 'full';

export function Sheet({
  heights,
  snap,
  onSnap,
  head,
  children,
  scrollTop,
}: {
  /** px per snap */
  heights: Record<Snap, number>;
  snap: Snap;
  onSnap(s: Snap): void;
  /** always visible under the handle, outside the scrolling body */
  head?: ReactNode;
  children: ReactNode;
  /** set to scroll the body back to its top (a new analysis, a new mode) */
  scrollTop?: number;
}) {
  const [drag, setDrag] = useState<number | null>(null);
  const start = useRef<{ y: number; h: number; t: number } | null>(null);
  const h = drag ?? heights[snap];
  const order: Snap[] = ['peek', 'half', 'full'];

  // View types its touch handlers as plain events; the touches are there at run time
  const touchY = (e: CommonEvent) => (e as unknown as { touches: { clientY: number }[] }).touches[0]!.clientY;
  const onStart = (e: CommonEvent) => {
    start.current = { y: touchY(e), h: heights[snap], t: Date.now() };
  };
  const onMove = (e: CommonEvent) => {
    const s = start.current;
    if (!s) return;
    const next = s.h + (s.y - touchY(e));
    setDrag(Math.max(heights.peek - 40, Math.min(heights.full, next)));
  };
  const onEnd = () => {
    const s = start.current;
    start.current = null;
    if (!s) return;
    const now = drag ?? s.h;
    setDrag(null);
    // a flick goes one step its way; a drag settles on the nearest height
    const moved = now - s.h;
    const fast = Math.abs(moved) / Math.max(1, Date.now() - s.t) > 0.5;
    const i = order.indexOf(snap);
    if (Math.abs(moved) < 6) {
      onSnap(order[(i + 1) % order.length]!);
      return;
    }
    if (fast) {
      onSnap(order[Math.max(0, Math.min(2, i + (moved > 0 ? 1 : -1)))]!);
      return;
    }
    let best: Snap = snap;
    for (const k of order) if (Math.abs(heights[k] - now) < Math.abs(heights[best] - now)) best = k;
    onSnap(best);
  };

  return (
    <View className={'sheet' + (drag === null ? ' settle' : '')} style={{ height: `${h}px` }}>
      <View
        className="sheet-grip"
        onTouchStart={onStart}
        onTouchMove={onMove}
        onTouchEnd={onEnd}
        onTouchCancel={onEnd}
      >
        <View className="sheet-handle" />
      </View>
      {head ? <View className="sheet-head">{head}</View> : null}
      <ScrollView className="sheet-body" scrollY enhanced showScrollbar={false} scrollTop={scrollTop}>
        {children}
        <View className="sheet-end" />
      </ScrollView>
    </View>
  );
}
