/**
 * The two figures of the test report, as self-contained SVG in the product's palette (DESIGN.md):
 *
 *  - accuracy-quota.svg: two small multiples on one x-axis (routematrix routes): IoU of the 15-minute
 *    region and mean absolute time error. Emphasis form: our method in cobalt (a line through the
 *    budgets, other variants as distinct markers), the competitor in signal red, the straight-line
 *    circle as gray context. Legend always present; direct labels only where they fit.
 *  - overlay.svg: the reference 15-minute region (reach yellow) with engine@400 (cobalt), star16 (red)
 *    and the straight-line circle (dashed ink), as on the product map.
 *
 * Cobalt and signal red were validated as a pair on the paper surface (dataviz validate_palette: CVD
 * ΔE 24.0, normal-vision ΔE 38.2, both ≥ 3:1). Text always wears ink, never a series colour.
 */
import type { XY } from '@zoudedao/core';

import { R15_M } from './methods.js';
import type { MethodResult, Results } from './score.js';

const C = {
  cobalt: '#1446B0',
  reach: '#FFC400',
  signal: '#E23A2E',
  ink: '#101316',
  ink2: '#4A5157',
  paper: '#ECEEE9',
  white: '#FFFFFF',
  grid: '#D6DAD3',
  axis: '#B9C0BB',
} as const;

const FONT =
  "'Noto Sans SC', 'Source Han Sans SC', 'Noto Sans CJK SC', 'PingFang SC', 'Microsoft YaHei', sans-serif";

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const f1 = (v: number) => (Math.round(v * 10) / 10).toString();
const fmt = (v: number | null | undefined, digits: number) =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(digits);

/** Rough rendered width of a label (CJK and full-width ≈ 1 em, the rest ≈ 0.55 em). */
export function textWidth(s: string, size: number): number {
  let w = 0;
  for (const ch of s) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? size : size * 0.56;
  return w;
}

function text(
  x: number,
  y: number,
  s: string,
  o: { size?: number; weight?: number; fill?: string; anchor?: string } = {},
) {
  return `<text x="${f1(x)}" y="${f1(y)}" font-size="${o.size ?? 12}"${o.weight ? ` font-weight="${o.weight}"` : ''} fill="${o.fill ?? C.ink}"${o.anchor ? ` text-anchor="${o.anchor}"` : ''}>${esc(s)}</text>`;
}

/** A round number ≥ v from 1, 2, 2.5, 5 × 10^k. */
export function niceCeil(v: number): number {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v - 1e-9) return m * p;
  return 10 * p;
}

/** Ticks at a round step covering [lo, hi]; −0 prints as 0. */
function ticks(lo: number, hi: number, target = 5): number[] {
  const step = niceCeil((hi - lo) / target);
  const out: number[] = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9; v += step) {
    const r = Math.round(v * 1e6) / 1e6;
    out.push(r === 0 ? 0 : r);
  }
  return out;
}

/** The smallest multiple of a round step (≈ v / target) that is ≥ v. */
export function niceMax(v: number, target = 5): number {
  if (!(v > 0)) return 1;
  const step = niceCeil(v / target);
  return Math.ceil(v / step - 1e-9) * step;
}

type Marker = 'dot' | 'ring' | 'diamond' | 'square';

interface Series {
  id: string;
  name: string;
  color: string;
  marker: Marker;
  /** Points drawn as one line (the engine budgets), else single markers. */
  line: boolean;
  points: { x: number; m: MethodResult }[];
}

function markerSvg(kind: Marker, x: number, y: number, color: string, title: string): string {
  const t = `<title>${esc(title)}</title>`;
  const ring = `stroke="${C.paper}" stroke-width="2"`;
  switch (kind) {
    case 'dot':
      return `<circle cx="${f1(x)}" cy="${f1(y)}" r="4.5" fill="${color}" ${ring}>${t}</circle>`;
    case 'ring':
      // hollow and larger than a dot, so a point it coincides with stays visible inside it
      return `<circle cx="${f1(x)}" cy="${f1(y)}" r="7.5" fill="none" stroke="${color}" stroke-width="2">${t}</circle>`;
    case 'diamond':
      return `<path d="M${f1(x)} ${f1(y - 6)}L${f1(x + 6)} ${f1(y)}L${f1(x)} ${f1(y + 6)}L${f1(x - 6)} ${f1(y)}Z" fill="${color}" ${ring}>${t}</path>`;
    case 'square':
      return `<rect x="${f1(x - 7)}" y="${f1(y - 7)}" width="14" height="14" fill="none" stroke="${color}" stroke-width="2">${t}</rect>`;
  }
}

/** Groups the methods into the chart's series (fixed identity per kind of method, never by rank). */
export function chartSeries(results: Results): Series[] {
  const pick = (f: (m: MethodResult) => boolean) =>
    results.methods.filter(f).map((m) => ({ x: m.cost.routes, m }));
  const series: Series[] = [
    {
      id: 'engine',
      name: '本方法（实时引擎，用满预算）',
      color: C.cobalt,
      marker: 'dot',
      line: true,
      points: pick((m) => /^engine@\d+$/.test(m.id)).sort((a, b) => a.x - b.x),
    },
    {
      id: 'default',
      name: '本方法·默认配置',
      color: C.cobalt,
      marker: 'diamond',
      line: false,
      points: pick((m) => m.id === 'engine-default'),
    },
    {
      id: 'seed48',
      name: '本方法·仅 48 点',
      color: C.cobalt,
      marker: 'ring',
      line: false,
      points: pick((m) => m.id === 'seed48'),
    },
    {
      id: 'nobarrier',
      name: '本方法·无断裂检测',
      color: C.cobalt,
      marker: 'square',
      line: false,
      points: pick((m) => /-nobarrier$/.test(m.id)),
    },
    {
      id: 'star16',
      name: '16 方位射线法',
      color: C.signal,
      marker: 'dot',
      line: false,
      points: pick((m) => m.id === 'star16'),
    },
    {
      id: 'circle',
      name: '直线圆',
      color: C.ink2,
      marker: 'dot',
      line: false,
      points: pick((m) => m.id === 'circle'),
    },
  ];
  return series.filter((s) => s.points.length);
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Offsets (dx, dy, anchor) tried around a marker, nearest first; far ones get a leader line. */
const LABEL_SPOTS: [number, number, 'start' | 'end'][] = [
  [11, 4, 'start'],
  [11, -9, 'start'],
  [11, 17, 'start'],
  [-11, 4, 'end'],
  [-11, -9, 'end'],
  [-11, 17, 'end'],
  [18, -24, 'start'],
  [18, 32, 'start'],
  [-18, -24, 'end'],
  [-18, 32, 'end'],
  [26, -40, 'start'],
  [26, 48, 'start'],
];

/**
 * Direct labels, placed in order at the first spot that collides with nothing already drawn (markers,
 * the curve, earlier labels) and stays in the panel; a label that fits nowhere is left to the legend.
 */
function placeLabels(
  reqs: { mx: number; my: number; s: string; bold?: boolean }[],
  taken: Box[],
  bounds: Box,
): string[] {
  const out: string[] = [];
  const size = 12;
  for (const r of reqs) {
    const w = textWidth(r.s, size);
    for (const [dx, dy, anchor] of LABEL_SPOTS) {
      const lx = r.mx + dx;
      const ly = r.my + dy;
      const box: Box = { x: anchor === 'start' ? lx - 2 : lx - w - 2, y: ly - size, w: w + 4, h: size + 4 };
      const inside =
        box.x >= bounds.x &&
        box.y >= bounds.y &&
        box.x + box.w <= bounds.x + bounds.w &&
        box.y + box.h <= bounds.y + bounds.h;
      if (!inside || taken.some((t) => overlaps(t, box))) continue;
      taken.push(box);
      if (Math.abs(dy) > 17) {
        // a leader from the marker's edge to the label's near end
        const ex = r.mx + Math.sign(dx) * 6;
        const ey = r.my + Math.sign(dy) * 6;
        out.push(
          `<line x1="${f1(ex)}" y1="${f1(ey)}" x2="${f1(lx - Math.sign(dx) * 2)}" y2="${f1(ly - 4)}" stroke="${C.ink2}" stroke-width="1"/>`,
        );
      }
      out.push(text(lx, ly, r.s, { size, anchor, ...(r.bold ? { weight: 800 } : {}) }));
      break;
    }
  }
  return out;
}

/** Small boxes along a polyline, so labels keep off the curve. */
function lineBoxes(pts: readonly { x: number; y: number }[]): Box[] {
  const out: Box[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 5));
    for (let k = 0; k <= n; k++) {
      const x = a.x + ((b.x - a.x) * k) / n;
      const y = a.y + ((b.y - a.y) * k) / n;
      out.push({ x: x - 2, y: y - 2, w: 4, h: 4 });
    }
  }
  return out;
}

interface Panel {
  title: string;
  lo: number;
  hi: number;
  value: (m: MethodResult) => number;
  digits: number;
  unit: string;
}

/**
 * The y range of a panel from our method and the competitor; the straight-line circle is context and
 * may lie far outside it, in which case it is drawn at the panel's edge with its value (off-scale).
 */
function panelsFor(results: Results, series: Series[]): Panel[] {
  const focus = series.filter((s) => s.id !== 'circle').flatMap((s) => s.points.map((p) => p.m));
  const pool = focus.length ? focus : results.methods;
  const ious = pool.map((m) => m.region.iou).filter(Number.isFinite);
  const iouLo = Math.max(0, Math.floor((Math.min(...ious) - 0.03) * 20) / 20);
  const maes = pool.flatMap((m) => (m.points.time ? [m.points.time.mae_s] : []));
  const maeHi = niceMax(Math.max(10, ...maes) * 1.2);
  return [
    {
      title: '15 分钟区域 IoU（越高越好）',
      lo: Math.min(iouLo, 0.95),
      hi: 1,
      value: (m) => m.region.iou,
      digits: 3,
      unit: '',
    },
    {
      title: '耗时平均绝对误差 MAE（秒，越低越好）',
      lo: 0,
      hi: maeHi,
      value: (m) => m.points.time?.mae_s ?? NaN,
      digits: 0,
      unit: ' 秒',
    },
  ];
}

/** IoU and MAE against routematrix routes, as two panels sharing the x scale. */
export function accuracyChart(results: Results): string {
  const W = 980;
  const series = chartSeries(results);
  const all = series.flatMap((s) => s.points);
  const xMax = niceMax(Math.max(100, ...all.map((p) => p.x)) * 1.04, 4);
  const panelW = 400;
  const plotH = 250;
  const left = [70, 70 + panelW + 90];

  // legend: every series, wrapped to the width (identity never rests on colour alone)
  const legend: string[] = [];
  let lx = 24;
  let ly = 84;
  for (const s of series) {
    const w = 20 + textWidth(s.name, 12) + 22;
    if (lx + w > W - 24) {
      lx = 24;
      ly += 22;
    }
    const cx = lx + 8;
    if (s.line)
      legend.push(
        `<line x1="${lx}" y1="${ly - 4}" x2="${lx + 16}" y2="${ly - 4}" stroke="${s.color}" stroke-width="2"/>`,
      );
    legend.push(markerSvg(s.marker, cx, ly - 4, s.color, s.name));
    legend.push(text(lx + 22, ly, s.name, { size: 12 }));
    lx += w;
  }
  const top = ly + 44;
  const H = top + plotH + 100;

  const parts: string[] = [];
  parts.push(`<rect width="${W}" height="${H}" fill="${C.paper}"/>`);
  parts.push(text(24, 36, `精度–配额曲线 · ${results.area.name}`, { size: 17, weight: 800 }));
  parts.push(
    text(
      24,
      58,
      `参考真值：${results.reference.spacing_m} 米格点 × ${results.reference.radius_m} 米圆内 ${results.reference.counts.points} 点的百度批量算路实测；横轴为方法请求的批量算路条数（命中缓存也计数）`,
      { size: 12, fill: C.ink2 },
    ),
  );
  parts.push(...legend);

  panelsFor(results, series).forEach((p, k) => {
    const x0 = left[k]!;
    const xs = (v: number) => x0 + (v / xMax) * panelW;
    const yRaw = (v: number) => top + plotH - ((v - p.lo) / (p.hi - p.lo)) * plotH;
    const taken: Box[] = [];
    parts.push(text(x0, top - 16, p.title, { size: 13, weight: 800 }));
    for (const t of ticks(p.lo, p.hi, 5)) {
      const y = yRaw(t);
      parts.push(
        `<line x1="${x0}" y1="${f1(y)}" x2="${x0 + panelW}" y2="${f1(y)}" stroke="${Math.abs(t - p.lo) < 1e-9 ? C.axis : C.grid}" stroke-width="1"/>`,
      );
      parts.push(
        text(x0 - 8, y + 4, p.digits ? t.toFixed(2) : String(t), { size: 11, fill: C.ink2, anchor: 'end' }),
      );
    }
    for (const t of ticks(0, xMax, 4)) {
      const x = xs(t);
      parts.push(
        `<line x1="${f1(x)}" y1="${top + plotH}" x2="${f1(x)}" y2="${top + plotH + 4}" stroke="${C.axis}" stroke-width="1"/>`,
      );
      parts.push(
        text(x, top + plotH + 18, t.toLocaleString('en-US'), { size: 11, fill: C.ink2, anchor: 'middle' }),
      );
    }
    parts.push(
      text(x0 + panelW, top + plotH + 38, '批量算路（条）', { size: 11, fill: C.ink2, anchor: 'end' }),
    );

    const labels: Parameters<typeof placeLabels>[0] = [];
    const marks: string[] = [];
    for (const s of series) {
      const pts = s.points
        .map((q) => {
          const v = p.value(q.m);
          const y = yRaw(v);
          // off-scale context: pinned 8 px inside the edge it lies beyond (its label says so)
          const off = y > top + plotH ? 1 : y < top ? -1 : 0;
          return { x: xs(q.x), y: off > 0 ? top + plotH - 8 : off < 0 ? top + 8 : y, v, off, q };
        })
        .filter((q) => Number.isFinite(q.v));
      if (!pts.length) continue;
      if (s.line && pts.length > 1) {
        marks.push(
          `<polyline points="${pts.map((q) => `${f1(q.x)},${f1(q.y)}`).join(' ')}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`,
        );
        taken.push(...lineBoxes(pts));
      }
      for (const q of pts) {
        const title = `${q.q.m.label}：${q.q.x} 条，${p.digits ? 'IoU' : 'MAE'} ${fmt(q.v, p.digits)}${p.unit}${q.off ? '（超出纵轴范围）' : ''}`;
        marks.push(markerSvg(s.marker, q.x, q.y, s.color, title));
        taken.push({ x: q.x - 9, y: q.y - 9, w: 18, h: 18 });
      }
      const last = pts[pts.length - 1]!;
      const val = `${fmt(last.v, p.digits)}${p.unit}`;
      if (s.id === 'engine') labels.push({ mx: last.x, my: last.y, s: `本方法 ${val}`, bold: true });
      if (s.id === 'star16') labels.push({ mx: last.x, my: last.y, s: `射线法 ${val}` });
      if (s.id === 'circle')
        labels.push({ mx: last.x, my: last.y, s: `直线圆 ${val}${last.off ? '（超出纵轴）' : ''}` });
    }
    parts.push(...marks);
    const right = Math.min(x0 + panelW + 70, W - 10);
    parts.push(...placeLabels(labels, taken, { x: x0 - 4, y: top - 4, w: right - (x0 - 4), h: plotH + 8 }));
    if (k === 1 && series.some((s) => s.id === 'star16')) {
      parts.push(
        text(x0, top + plotH + 58, '16 方位射线法只给出区域、不给出耗时场，没有 MAE。', {
          size: 11,
          fill: C.ink2,
        }),
      );
    }
  });
  parts.push(
    text(
      24,
      H - 14,
      '各点数值见 results.md 的表格；鼠标悬停在点上可看方法与数值。直线圆超出纵轴时画在边缘并标出数值。',
      {
        size: 11,
        fill: C.ink2,
      },
    ),
  );
  return svgDoc(W, H, '精度–配额曲线', parts);
}

function svgDoc(w: number, h: number, title: string, parts: string[]): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" font-family="${esc(FONT)}" role="img" aria-label="${esc(title)}">`,
    `<title>${esc(title)}</title>`,
    ...parts,
    '</svg>',
    '',
  ].join('\n');
}

function ringsPath(rings: readonly XY[][], tx: (p: XY) => XY): string {
  return rings
    .filter((r) => r.length >= 3)
    .map((r) => `M${r.map((p) => tx(p).map(f1).join(' ')).join('L')}Z`)
    .join('');
}

/** The overlay compares the reference with this engine budget (or the closest one below it). */
export function overlayEngineId(ids: readonly string[], target = 400): string | null {
  const budgets = ids
    .map((id) => /^engine@(\d+)$/.exec(id))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]));
  const below = budgets.filter((b) => b <= target).sort((a, b) => b - a);
  if (below.length) return `engine@${below[0]}`;
  if (ids.includes('engine-default')) return 'engine-default';
  const any = budgets.sort((a, b) => a - b)[0];
  return any !== undefined ? `engine@${any}` : null;
}

/** Reference region vs engine@400 vs star16 vs the straight-line circle, north up. */
export function overlayMap(
  results: Results,
  rings: { reference: XY[][]; methods: ReadonlyMap<string, XY[][]> },
): string {
  const size = 720;
  const half = 1250; // metres from the centre to the map edge
  const s = size / (2 * half);
  const top = 70;
  const legendH = 128;
  const W = size;
  const H = top + size + legendH;
  const cx = size / 2;
  const cy = top + size / 2;
  const tx = (p: XY): XY => [cx + p[0] * s, cy - p[1] * s];
  const byId = new Map(results.methods.map((m) => [m.id, m]));
  const engineId = overlayEngineId([...rings.methods.keys()]);
  const engine = engineId ? byId.get(engineId) : undefined;
  const star = byId.get('star16');
  const circle = byId.get('circle');

  const parts: string[] = [];
  parts.push(`<rect width="${W}" height="${H}" fill="${C.paper}"/>`);
  parts.push(text(20, 32, `15 分钟步行可达范围对比 · ${results.area.name}`, { size: 17, weight: 800 }));
  parts.push(
    text(20, 54, `中心 ${results.area.center_bd09.join(', ')}（BD-09）· 北向上 · 黄色为参考真值`, {
      size: 12,
      fill: C.ink2,
    }),
  );
  parts.push(`<clipPath id="map"><rect x="0" y="${top}" width="${size}" height="${size}"/></clipPath>`);
  parts.push(`<g clip-path="url(#map)">`);
  parts.push(
    `<path d="${ringsPath(rings.reference, tx)}" fill="${C.reach}" fill-opacity="0.45" fill-rule="evenodd"><title>参考真值：15 分钟可达（稠密网格插值）</title></path>`,
  );
  // the straight-line claim, as the product draws it: long dash in ink
  parts.push(
    `<circle cx="${f1(cx)}" cy="${f1(cy)}" r="${f1(R15_M * s)}" fill="none" stroke="${C.ink}" stroke-width="1.8" stroke-dasharray="11 7"><title>直线圆：半径 1,053 米</title></circle>`,
  );
  const line = (rs: readonly XY[][] | undefined, color: string, title: string) => {
    if (!rs?.length) return;
    const d = ringsPath(rs, tx);
    parts.push(`<path d="${d}" fill="none" stroke="${C.white}" stroke-width="5" stroke-linejoin="round"/>`);
    parts.push(
      `<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"><title>${esc(title)}</title></path>`,
    );
  };
  line(rings.methods.get('star16'), C.signal, '16 方位射线法：15 分钟多边形');
  if (engineId) line(rings.methods.get(engineId), C.cobalt, `${engine?.label ?? engineId}：15 分钟等时线`);
  // the centre: cobalt, as 你在这里 on the product map
  parts.push(
    `<circle cx="${f1(cx)}" cy="${f1(cy)}" r="5.5" fill="${C.cobalt}" stroke="${C.white}" stroke-width="2.5"><title>分析中心</title></circle>`,
  );
  parts.push('</g>');
  parts.push(
    `<rect x="0.5" y="${top + 0.5}" width="${size - 1}" height="${size - 1}" fill="none" stroke="${C.axis}" stroke-width="1"/>`,
  );

  // north and scale
  const nx = size - 36;
  const ny = top + 34;
  parts.push(
    `<path d="M${nx} ${ny - 16}L${nx + 7} ${ny + 2}L${nx} ${ny - 3}L${nx - 7} ${ny + 2}Z" fill="${C.ink}"/>`,
  );
  parts.push(text(nx, ny + 20, '北', { size: 12, weight: 800, anchor: 'middle' }));
  const bar = 500 * s;
  const bx = 24;
  const by = top + size - 26;
  parts.push(
    `<rect x="${bx - 8}" y="${by - 22}" width="${f1(bar + 16)}" height="36" fill="${C.white}" fill-opacity="0.85"/>`,
  );
  parts.push(
    `<path d="M${bx} ${by - 6}V${by}H${f1(bx + bar)}V${by - 6}" fill="none" stroke="${C.ink}" stroke-width="1.5"/>`,
  );
  parts.push(text(bx + bar / 2, by - 9, '500 米', { size: 11, anchor: 'middle' }));

  // legend with the numbers that matter
  const ly = top + size + 30;
  const rows: { swatch: string; label: string }[] = [
    {
      swatch: `<rect x="0" y="-11" width="22" height="14" fill="${C.reach}" fill-opacity="0.45"/>`,
      label: `参考真值 15 分钟可达：${fmt(results.reference.area_km2, 2)} 平方公里（${results.reference.spacing_m} 米格点实测插值）`,
    },
  ];
  if (engine) {
    rows.push({
      swatch: `<line x1="0" y1="-4" x2="22" y2="-4" stroke="${C.white}" stroke-width="5"/><line x1="0" y1="-4" x2="22" y2="-4" stroke="${C.cobalt}" stroke-width="2"/>`,
      label: `${engine.label}：IoU ${fmt(engine.region.iou, 3)}，面积比 ${fmt(engine.region.area_ratio, 2)}`,
    });
  }
  if (star) {
    rows.push({
      swatch: `<line x1="0" y1="-4" x2="22" y2="-4" stroke="${C.white}" stroke-width="5"/><line x1="0" y1="-4" x2="22" y2="-4" stroke="${C.signal}" stroke-width="2"/>`,
      label: `16 方位射线法（48 条）：IoU ${fmt(star.region.iou, 3)}，面积比 ${fmt(star.region.area_ratio, 2)}`,
    });
  }
  if (circle) {
    rows.push({
      swatch: `<line x1="0" y1="-4" x2="22" y2="-4" stroke="${C.ink}" stroke-width="1.8" stroke-dasharray="11 7"/>`,
      label: `直线圆（半径 1,053 米）：IoU ${fmt(circle.region.iou, 3)}，面积比 ${fmt(circle.region.area_ratio, 2)}`,
    });
  }
  rows.forEach((r, k) => {
    const y = ly + k * 24;
    parts.push(`<g transform="translate(24 ${y})">${r.swatch}</g>`);
    parts.push(text(56, y, r.label, { size: 12 }));
  });
  return svgDoc(W, H, `15 分钟步行可达范围对比：${results.area.name}`, parts);
}
