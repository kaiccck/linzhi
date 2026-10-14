/** Keeps an optional part (a chart) from taking the whole screen down when it fails: it just goes. */
import { Component, type ReactNode } from 'react';

export class Boundary extends Component<{ children: ReactNode; fallback?: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(err: unknown) {
    console.warn('[邻至] 一个部件没有画出来', err);
  }

  override render() {
    return this.state.failed ? (this.props.fallback ?? null) : this.props.children;
  }
}
