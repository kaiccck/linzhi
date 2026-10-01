/**
 * Owns one Baidu JSAPI 4.0 map: north-up, no tilt or rotation, the light map style, framed like the
 * mockup, and a projection read-out (local metres → CSS px) for the overlays drawn on top.
 */
import type { Frame } from '../geo/frame.js';
import { affineView, type Composition, type View } from '../geo/view.js';
import type { BMapNS } from './loadBaidu.js';
import { LIGHT_MAP_STYLE } from './signMapStyle.js';

export interface BasemapEvents {
  /** the map moved, zoomed or resized: re-read the projection */
  onChange(): void;
  /** the first full set of tiles is on screen */
  onTilesLoaded(): void;
  /** the user dragged, wheeled or pinched (programmatic moves do not count) */
  onUserMove(): void;
  onClick(lng: number, lat: number): void;
}

/** Floating controls over the map that keep the wheel to themselves. */
const WHEEL_OWN = '.float, .map-meta, .dock, .ask-dock';

const CHANGE_EVENTS = [
  'movestart',
  'moving',
  'moveend',
  'zoomstart',
  'zooming',
  'zoomend',
  'dragstart',
  'dragging',
  'dragend',
  'resize',
  'load',
] as const;

/** One of Baidu's own labels, transparent: it only holds a place in Baidu's label collision. */
export interface LabelBlocker {
  lng: number;
  lat: number;
  /** CSS px of the box: a row of square glyphs this wide and tall */
  w: number;
  h: number;
}

/**
 * The map approval number (审图号) from Baidu's own copyright control, wherever the map is on the page.
 * With a custom style the JSAPI keeps that control hidden; 说明 repeats the number (read, never typed in).
 */
export function readApprovalNumber(root: ParentNode = document): string | null {
  const text = root.querySelector('.BMap_cpyCtrl')?.textContent ?? '';
  return /GS[（(]\d{4}[)）]\d+号/.exec(text)?.[0] ?? null;
}

export class BaiduBasemap {
  readonly map: BMap.Map;
  private destroyed = false;
  private tilesSeen = false;
  private readonly cleanup: (() => void)[] = [];
  private blockerUids: string[] = [];
  private blockerKey = '';
  /** the wheel is easing the zoom (its frames are fractional on purpose) */
  private gliding = false;

  constructor(
    private readonly B: BMapNS,
    readonly container: HTMLElement,
    private frame: Frame,
    private readonly events: BasemapEvents,
  ) {
    const map = new B.Map(container, {
      enableTilt: false,
      enableRotate: false,
      enableRotateGestures: false,
      enableTiltGestures: false,
      heading: 0,
      tilt: 0,
      enableMapClick: false,
      enableIconHighlight: false,
      enableAutoResize: true,
      enableAdaptiveMinZoom: false,
      // buildings on: zoomed in (17+) Baidu stands them up in 3D, even on a flat north-up map
      displayOptions: { poiIcon: false, building: true, indoor: false },
    });
    this.map = map;
    // pointToPixel only works once the view is initialised; fit() then sets the real zoom
    map.centerAndZoom(this.point(0, 0), 16, { noAnimation: true });
    map.disableTilt();
    map.disableRotate();
    map.disableRotateGestures();
    // pinch and double-click zoom are Baidu's own; the wheel is ours (below)
    map.disableScrollWheelZoom();
    map.enableDoubleClickZoom();
    map.enablePinchToZoom();
    // 4.0's setMapStyle is the typed name of GL's setMapStyleV2 (it delegates to it)
    map.setMapStyle({ styleJson: LIGHT_MAP_STYLE });

    const change = () => {
      if (!this.destroyed) events.onChange();
    };
    for (const name of CHANGE_EVENTS) map.addEventListener(name, change);
    map.addEventListener('dragstart', () => events.onUserMove());
    // a pinch stops between levels, where Baidu scales its label glyphs and they blur: carry on to the
    // next whole level in the direction of travel (the wheel below settles on whole levels itself)
    let from = 16;
    map.addEventListener('zoomstart', () => {
      if (!this.gliding) from = map.getZoom();
    });
    map.addEventListener('zoomend', () => {
      if (this.destroyed || this.gliding) return;
      const z = map.getZoom();
      if (Math.abs(z - Math.round(z)) <= 0.01) return;
      map.setZoom(z > from ? Math.ceil(z) : Math.floor(z));
    });
    map.addEventListener('tilesloaded', () => {
      if (this.destroyed) return;
      events.onChange();
      if (!this.tilesSeen) {
        this.tilesSeen = true;
        events.onTilesLoaded();
      }
    });
    map.addEventListener('click', (e) => {
      if (!this.destroyed && e.point) events.onClick(e.point.lng, e.point.lat);
    });
    // wheel / pinch / double-click zoom are user moves too (dragstart covers panning)
    const user = (e: Event) => {
      if (e.type !== 'touchstart' || (e as TouchEvent).touches.length > 1) events.onUserMove();
    };
    for (const type of ['dblclick', 'touchstart'] as const) {
      container.addEventListener(type, user, { passive: true });
      this.cleanup.push(() => container.removeEventListener(type, user));
    }
    // The wheel glides: every event moves a target zoom (a mouse notch one whole level, a trackpad
    // swipe by its travel) and each frame eases the map towards it around the pointer, so the zoom
    // follows the fingers. Once the wheel rests the target rounds to a whole level, where Baidu draws
    // its labels crisply, and the glide lands there.
    let target = 0;
    let start = 0;
    let cur: BMap.Pixel | null = null;
    let lastWheel = 0;
    let raf = 0;
    const glide = () => {
      raf = 0;
      if (this.destroyed) return;
      const resting = performance.now() - lastWheel > 140;
      // a quarter level past a whole one carries on to the next; less falls back
      if (resting) target = target > start ? Math.ceil(target - 0.25) : Math.floor(target + 0.25);
      const z = map.getZoom();
      const gap = target - z;
      const done = resting && Math.abs(gap) < 0.004;
      if (done || Math.abs(gap) >= 0.004) {
        // around the pointer: the centre closes in on it by the scale step (a still setZoom ignores
        // its zoomCenter and scales around the middle)
        const next = done ? target : z + gap * 0.3;
        const k = 2 ** (z - next);
        const c = map.pointToPixel(map.getCenter());
        const p = cur ?? c;
        const centre = map.pixelToPoint(new B.Pixel(p.x + (c.x - p.x) * k, p.y + (c.y - p.y) * k));
        map.centerAndZoom(centre, next, { noAnimation: true });
      }
      if (done) {
        this.gliding = false;
        cur = null;
        return;
      }
      raf = requestAnimationFrame(glide);
    };
    const wheel = (e: WheelEvent) => {
      if (this.destroyed) return;
      // the floating controls keep their own wheel (a scrolling dock, a card being read)
      if ((e.target as Element | null)?.closest?.(WHEEL_OWN)) {
        // …but a pinch over one never zooms the whole page
        if (e.ctrlKey) e.preventDefault();
        return;
      }
      events.onUserMove();
      // a trackpad pinch arrives as ctrl + wheel with small deltas: zoom the map with it rather than
      // letting the browser zoom the whole page (which reflows every code and label)
      e.preventDefault();
      const px = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * 800 : e.deltaY;
      // a mouse notch is a large, whole delta; a trackpad sends many small ones
      const notch = e.deltaMode !== 0 || (Math.abs(px) >= 50 && Number.isInteger(px) && !e.ctrlKey);
      const levels = notch ? -Math.sign(px) : -px / (e.ctrlKey ? 60 : 220);
      if (!this.gliding) {
        this.gliding = true;
        start = target = map.getZoom();
      }
      target = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), target + levels));
      const r = container.getBoundingClientRect();
      cur = new B.Pixel(e.clientX - r.left, e.clientY - r.top);
      lastWheel = performance.now();
      if (!raf) raf = requestAnimationFrame(glide);
    };
    this.cleanup.push(() => cancelAnimationFrame(raf));
    // on the whole map, not only the basemap: codes, names, marks and cards lie over it, and a wheel
    // over one of them must zoom the map too
    const host = container.closest('main') ?? container.parentElement ?? container;
    host.addEventListener('wheel', wheel, { passive: false });
    this.cleanup.push(() => host.removeEventListener('wheel', wheel));
  }

  get tilesLoaded() {
    return this.tilesSeen;
  }

  /**
   * Another analysis on screen: its local metres are read from here on. The map itself stays (no
   * reload, no blank tiles); the caller fits the new composition.
   */
  setFrame(frame: Frame) {
    this.frame = frame;
  }

  private point(x: number, y: number): BMap.Point {
    const [lng, lat] = this.frame.toLngLat(x, y);
    return new this.B.Point(lng, lat);
  }

  /** px per metre along x at the current zoom */
  private scaleNow(): number {
    const a = this.map.pointToPixel(this.point(0, 0));
    const b = this.map.pointToPixel(this.point(1000, 0));
    return (b.x - a.x) / 1000;
  }

  /**
   * Frame the map like the mockup: (cx, cy) at the centre, at least `span` metres across the shorter
   * side — at a whole zoom level. Baidu GL draws its label glyphs crisply only at integer zooms (a
   * fractional zoom scales them, and they blur), so the zoom snaps down to the level that still fits
   * the span; the composition keeps its centre offset in metres, so the reach sits where it did.
   * `shiftY` puts that centre so many px below the panel's middle (negative: above), into the band
   * the floating controls leave free; `shiftX` so many px right of it (the 路演 card covers the left).
   */
  fit(c: Composition, width: number, height: number, shiftY = 0, shiftX = 0) {
    if (this.destroyed || width < 10 || height < 10) return;
    this.map.checkResize();
    const target = Math.min(width, height) / c.span;
    const center = this.point(c.cx, c.cy);
    this.map.centerAndZoom(center, Math.round(this.map.getZoom()) || 16, { noAnimation: true });
    const s0 = this.scaleNow();
    if (!(s0 > 0)) return;
    const exact = this.map.getZoom() + Math.log2(target / s0);
    // a hair of tolerance, so 15.98 stays 16 rather than dropping a whole level
    const zoom = Math.max(3, Math.min(19, Math.floor(exact + 0.03)));
    this.map.setMinZoom(Math.max(3, zoom - 3));
    // deep enough to see the buildings stand up (Baidu extrudes them from about 19)
    this.map.setMaxZoom(21);
    this.map.centerAndZoom(center, zoom, { noAnimation: true });
    if (!shiftY && !shiftX) return;
    // the panel's middle shows the point |shiftY| px south of the centre when that goes up (and north
    // when it goes down), and |shiftX| px west of it when the centre moves right
    const s = this.scaleNow();
    if (s > 0)
      this.map.centerAndZoom(this.point(c.cx - shiftX / s, c.cy + shiftY / s), zoom, { noAnimation: true });
  }

  /** Current projection as an axis-aligned affine (the map is north-up and flat). */
  readView(width: number, height: number): View | null {
    if (this.destroyed) return null;
    const o = this.map.pointToPixel(this.point(0, 0));
    const ex = this.map.pointToPixel(this.point(1000, 0));
    const ny = this.map.pointToPixel(this.point(0, 1000));
    const sx = (ex.x - o.x) / 1000;
    const sy = (o.y - ny.y) / 1000;
    if (![o.x, o.y, sx, sy].every(Number.isFinite) || sx <= 0 || sy <= 0) return null;
    return affineView(width, height, o.x, o.y, sx, sy);
  }

  toLngLat(x: number, y: number) {
    return this.frame.toLngLat(x, y);
  }

  /**
   * Move the map by a screen offset (px): brings a typed centre, a walking route or a citation's
   * places into the clear part of the map (animated unless `still`).
   */
  panBy(dx: number, dy: number, still = false) {
    if (this.destroyed) return;
    this.map.panBy(Math.round(dx), Math.round(dy), still ? { noAnimation: true } : undefined);
  }

  /**
   * Baidu's names give way where the map's own text stands. The light style cannot hide Baidu's
   * compound names only inside the study area (its rules are not spatial), so every code pill, name,
   * tag and card is mirrored as an invisible Baidu label of the same box with the highest rank: Baidu
   * then drops its own labels that would collide — the duplicated compound names (玉兰香苑3期 twice) and
   * the text half-covered by a pill — and keeps every other street and place name.
   */
  setLabelBlockers(list: readonly LabelBlocker[]) {
    const map = this.map as BMap.Map & Partial<Pick<BMap.Map, 'addMapLabels' | 'removeMapLabels'>>;
    if (this.destroyed || typeof map.addMapLabels !== 'function' || typeof map.removeMapLabels !== 'function')
      return;
    const key = list
      .map((b) => `${b.lng.toFixed(6)},${b.lat.toFixed(6)},${Math.round(b.w)},${Math.round(b.h)}`)
      .join(';');
    if (key === this.blockerKey) return;
    this.blockerKey = key;
    const clear = { color: 'rgba(0,0,0,0)', haloSize: 0, strokeColor: 'rgba(0,0,0,0)' };
    try {
      if (this.blockerUids.length) map.removeMapLabels(this.blockerUids);
      const labels: BMap.MapLabel[] = [];
      list.forEach((b, i) => {
        // Baidu's label size is in device units (2 per CSS px); a row of square glyphs spans the box
        const f = Math.max(8, Math.min(16, b.h));
        const n = Math.max(1, Math.round(b.w / f));
        labels.push({
          position: new this.B.Point(b.lng, b.lat),
          text: '口'.repeat(n),
          uid: `zdd-block-${i}`,
          rank: 1e6,
          direction: 4,
          style: { fontSize: f * 2, ...clear },
        });
      });
      this.blockerUids = labels.length ? map.addMapLabels(labels) : [];
    } catch {
      // an older JSAPI without map labels: Baidu keeps all of its names
      this.blockerUids = [];
    }
  }

  /** Keep Baidu's logo and copyright visible above the bottom-left 走一遍 card. */
  placeCopyright(left: number, bottom: number) {
    if (this.destroyed) return;
    this.map.setCopyrightOffset(new this.B.Size(left, bottom), new this.B.Size(left + 66, bottom + 4));
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const f of this.cleanup) f();
    try {
      this.map.destroy();
    } catch {
      // the WebGL context may already be gone (page teardown)
    }
    this.container.replaceChildren();
  }
}
