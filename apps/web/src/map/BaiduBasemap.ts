/**
 * Owns one Baidu JSAPI 4.0 map: north-up, no tilt or rotation, the sign-map style, framed like the
 * mockup, and a projection read-out (local metres → CSS px) for the overlays drawn on top.
 */
import type { Frame } from '../geo/frame.js';
import { affineView, type Composition, type View } from '../geo/view.js';
import type { BMapNS } from './loadBaidu.js';
import { SIGN_MAP_STYLE } from './signMapStyle.js';

export interface BasemapEvents {
  /** the map moved, zoomed or resized: re-read the projection */
  onChange(): void;
  /** the first full set of tiles is on screen */
  onTilesLoaded(): void;
  /** the user dragged, wheeled or pinched (programmatic moves do not count) */
  onUserMove(): void;
  onClick(lng: number, lat: number): void;
}

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

export class BaiduBasemap {
  readonly map: BMap.Map;
  private destroyed = false;
  private tilesSeen = false;
  private readonly cleanup: (() => void)[] = [];

  constructor(
    private readonly B: BMapNS,
    readonly container: HTMLElement,
    private readonly frame: Frame,
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
      displayOptions: { poiIcon: false, building: false, indoor: false },
    });
    this.map = map;
    // pointToPixel only works once the view is initialised; fit() then sets the real zoom
    map.centerAndZoom(this.point(0, 0), 16, { noAnimation: true });
    map.disableTilt();
    map.disableRotate();
    map.disableRotateGestures();
    // 4.0's setMapStyle is the typed name of GL's setMapStyleV2 (it delegates to it)
    map.setMapStyle({ styleJson: SIGN_MAP_STYLE });

    const change = () => {
      if (!this.destroyed) events.onChange();
    };
    for (const name of CHANGE_EVENTS) map.addEventListener(name, change);
    map.addEventListener('dragstart', () => events.onUserMove());
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
    for (const type of ['wheel', 'dblclick', 'touchstart'] as const) {
      container.addEventListener(type, user, { passive: true });
      this.cleanup.push(() => container.removeEventListener(type, user));
    }
  }

  get tilesLoaded() {
    return this.tilesSeen;
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

  /** Frame the map like the mockup: (cx, cy) at the centre, `span` metres across the shorter side. */
  fit(c: Composition, width: number, height: number) {
    if (this.destroyed || width < 10 || height < 10) return;
    this.map.checkResize();
    const target = Math.min(width, height) / c.span;
    const center = this.point(c.cx, c.cy);
    this.map.centerAndZoom(center, this.map.getZoom() || 16, { noAnimation: true });
    const s0 = this.scaleNow();
    if (!(s0 > 0)) return;
    const zoom = this.map.getZoom() + Math.log2(target / s0);
    this.map.setMinZoom(Math.max(3, Math.floor((zoom - 1.5) * 4) / 4));
    this.map.setMaxZoom(Math.min(21, zoom + 3));
    this.map.centerAndZoom(center, zoom, { noAnimation: true });
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
   * The map approval number (审图号) from Baidu's own copyright control. With a custom style the JSAPI
   * keeps that control hidden, so the provenance line repeats the number (read, never typed in).
   */
  approvalNumber(): string | null {
    const text = this.container.querySelector('.BMap_cpyCtrl')?.textContent ?? '';
    return /GS[（(]\d{4}[)）]\d+号/.exec(text)?.[0] ?? null;
  }

  /** Keep Baidu's logo and copyright visible above our bottom-left walk plate. */
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
