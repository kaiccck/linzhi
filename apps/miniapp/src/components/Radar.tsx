/**
 * 体检雷达: one axis per checked category, the share of communities covered — the circle's claim as a
 * dashed outline, the walk's measure as the filled shape inside it. On arrival the filled shape starts
 * on the claim's outline and shrinks to the walk (the overstatement, played once).
 *
 * Drawn as SVG painted as a background image (like the icons): it shows wherever the page shows,
 * screenshots and recordings included, which a native 2d canvas does not.
 */
import { View } from '@tarojs/components';
import { useEffect, useMemo, useState } from 'react';
import { base64 } from '../platform/Icons';
import type { CategoryScore } from '../model/score';

const DUR = 760;
const HOLD = 380;
const ease = (p: number) => 1 - Math.pow(1 - p, 3);

function svgOf(
  size: number,
  axes: { label: string; walk: number | null; circle: number | null }[],
  p: number,
): string {
  // labels sit outside the rings: the drawing is wider than the radar by 46 px a side
  const W = size + 92;
  const cx = W / 2;
  const cy = size / 2 + 4;
  const R = size / 2 - 34;
  const n = axes.length;
  const at = (i: number, r: number): [number, number] => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
  };
  const poly = (vals: number[]) =>
    vals
      .map((v, i) => at(i, R * v))
      .map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`)
      .join(' ');
  const e = ease(p);
  const claim = axes.map((a) => a.circle ?? 0);
  const walk = axes.map((a) => (a.circle ?? 0) + ((a.walk ?? 0) - (a.circle ?? 0)) * e);
  const parts: string[] = [];
  for (const k of [0.5, 1]) {
    parts.push(
      `<polygon points="${poly(axes.map(() => k))}" fill="none" stroke="${k === 1 ? '#DFE2E7' : '#ECEEF2'}" stroke-width="1"/>`,
    );
  }
  axes.forEach((_, i) => {
    const [x, y] = at(i, R);
    parts.push(
      `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#ECEEF2" stroke-width="1"/>`,
    );
  });
  parts.push(
    `<polygon points="${poly(claim)}" fill="rgba(224,72,62,0.10)" stroke="#7A828E" stroke-width="1.5" stroke-dasharray="4 4"/>`,
  );
  parts.push(
    `<polygon points="${poly(walk)}" fill="rgba(31,154,140,0.22)" stroke="#1F9A8C" stroke-width="2" stroke-linejoin="round"/>`,
  );
  walk.forEach((v, i) => {
    const a = axes[i]!;
    const short = a.walk !== null && a.circle !== null && a.walk < a.circle - 1e-6;
    const [x, y] = at(i, R * v);
    parts.push(
      `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${short ? 3.5 : 2.5}" fill="${short ? '#E0483E' : '#1F9A8C'}"/>`,
    );
  });
  axes.forEach((a, i) => {
    const [x, y] = at(i, R + 18);
    const anchor = Math.abs(x - cx) < 4 ? 'middle' : x > cx ? 'start' : 'end';
    const short = a.walk !== null && a.circle !== null && a.walk < a.circle;
    const pct = a.walk === null ? '待核' : `${Math.round(a.walk * 100)}%`;
    parts.push(
      `<text x="${x.toFixed(1)}" y="${(y - 3).toFixed(1)}" text-anchor="${anchor}" font-size="12" fill="#4E5662" font-family="-apple-system,PingFang SC,sans-serif">${a.label}</text>`,
      `<text x="${x.toFixed(1)}" y="${(y + 12).toFixed(1)}" text-anchor="${anchor}" font-size="11" font-weight="700" fill="${short ? '#C4382F' : a.walk === null ? '#A9AFB8' : '#17776C'}" font-family="DIN Alternate,Roboto,-apple-system,sans-serif">${pct}</text>`,
    );
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${size}" width="${W}" height="${size}">${parts.join('')}</svg>`;
}

export function Radar({
  size,
  categories,
  playKey,
}: {
  /** px, square */
  size: number;
  categories: readonly CategoryScore[];
  /** a new key replays the shrink */
  playKey: string;
}) {
  const axes = useMemo(
    () => categories.map((c) => ({ label: c.cat as string, walk: c.walk, circle: c.circle })),
    [categories],
  );
  const [p, setP] = useState(0);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    setP(0);
    const t0 = Date.now() + HOLD;
    const tick = () => {
      if (!live) return;
      const q = Math.max(0, Math.min(1, (Date.now() - t0) / DUR));
      setP(q);
      if (q < 1) timer = setTimeout(tick, 33);
    };
    timer = setTimeout(tick, HOLD);
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [playKey]);

  const uri = useMemo(() => `data:image/svg+xml;base64,${base64(svgOf(size, axes, p))}`, [size, axes, p]);
  return (
    <View
      className="radar"
      style={{ width: `${size + 92}px`, height: `${size}px`, backgroundImage: `url("${uri}")` }}
    />
  );
}
