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

export const compositionFor = (narrow: boolean): Composition =>
  narrow ? { cx: 0, cy: 30, span: 2150 } : { cx: 300, cy: -20, span: 2500 };

export function staticView(width: number, height: number, c: Composition): View {
  const s = Math.min(width, height) / c.span;
  return affineView(width, height, width / 2 - c.cx * s, height / 2 + c.cy * s, s, s);
}

/** Map-panel widths below this use the compact overlay rules (flag above the dot, no callouts). */
export const NARROW_PX = 700;
