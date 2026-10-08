import type { XY } from '@zoudedao/core';

/**
 * A view maps local metres (x east, y north) to CSS pixels of the map panel.
 *
 * - Offline (self-drawn basemap): the mockup's fixed view — `span` metres across the shorter side,
 *   with (cx, cy) at the panel centre.
 * - Baidu basemap: an affine fitted to the live map projection every frame (three pointToPixel
 *   samples). The map is north-up with tilt and rotation disabled, so an axis-aligned affine is exact
 *   to well under a pixel over the 3 km window.
 */
export interface View {
  width: number;
  height: number;
  /** px per metre along x and y (equal on this basemap; kept apart so nothing assumes it) */
  sx: number;
  sy: number;
  /** mean scale, for sizes that are not axis-bound (dot spacing, radii) */
  s: number;
  x(mx: number): number;
  y(my: number): number;
  mx(px: number): number;
  my(py: number): number;
  /** stable key so effects can skip identical frames */
  key: string;
}

export function affineView(
  width: number,
  height: number,
  ox: number,
  oy: number,
  sx: number,
  sy: number,
): View {
  return {
    width,
    height,
    sx,
    sy,
    s: (sx + sy) / 2,
    x: (mx) => ox + mx * sx,
    y: (my) => oy - my * sy,
    mx: (px) => (px - ox) / sx,
    my: (py) => (oy - py) / sy,
    key: `${width}x${height}|${ox.toFixed(2)},${oy.toFixed(2)}|${sx.toFixed(6)},${sy.toFixed(6)}`,
  };
}

/** The mockup's composition: which local point sits at the panel centre and how many metres fit. */
export interface Composition {
  cx: number;
  cy: number;
  span: number;
}

// 2,200 m keeps zoom 16 on a 1280×720 or 1366×768 laptop (2,500 m dropped them to 15, half the size)
export const compositionFor = (narrow: boolean): Composition =>
  narrow ? { cx: 0, cy: 30, span: 2150 } : { cx: 300, cy: -20, span: 2200 };

/**
 * Phones: the map box is short and the 走一遍 card covers its foot, so the fixed composition would
 * push an area whose homes lie off to one side (sample V's lie south-west) under the card. There the
 * composition centres the bounding box of the unit codes and 你在这里 (the origin); the span stays.
 */
export function focusedComposition(base: Composition, points: readonly XY[]): Composition {
  let [x0, x1, y0, y1] = [0, 0, 0, 0];
  for (const [x, y] of points) {
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  return { ...base, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

/**
 * The scale Baidu's map settles on for `s` px per local metre: BaiduBasemap.fit snaps down to a whole
 * zoom (crisp labels), where BD-09 Mercator draws 2^(z - 18) px per unit and a unit is cos(lat) m
 * along x. The static view uses it while the Baidu map loads, so its arrival does not rescale the map.
 */
export function wholeZoomScale(s: number, lat0: number): number {
  const c = Math.cos((lat0 * Math.PI) / 180);
  const zoom = Math.max(3, Math.min(19, Math.floor(18 + Math.log2(s * c) + 0.03)));
  return 2 ** (zoom - 18) / c;
}

/** `shiftY` moves the composition's centre off the panel's middle (px, + down), e.g. into the band
 * the floating controls leave free; `shiftX` moves it right (the 路演 card covers the left side).
 * With `lat0` the scale snaps to the whole zoom Baidu's map will use (wholeZoomScale). */
export function staticView(
  width: number,
  height: number,
  c: Composition,
  shiftY = 0,
  shiftX = 0,
  lat0?: number,
): View {
  const fit = Math.min(width, height) / c.span;
  const s = lat0 === undefined ? fit : wholeZoomScale(fit, lat0);
  return affineView(width, height, width / 2 + shiftX - c.cx * s, height / 2 + shiftY + c.cy * s, s, s);
}

/** Map-panel widths below this use the compact overlay rules (flag above the dot, no callouts). */
export const NARROW_PX = 700;
