/**
 * The one <map> of the mini program: the layers (layers.ts) as its polygons, lines and markers,
 * framed on the analysis whenever a new one comes on screen (and on what is picked), clear of what
 * covers the map (the search above, the sheet below).
 */
import { Map } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { memo, useEffect, useMemo, useRef } from 'react';
import type { XY } from '@zoudedao/core';
import { buildLayers, framePoints, toLatLng, type LayerInput, type MarkerHit } from './layers';

const MAP_ID = 'zdd-map';

export interface MapViewProps extends LayerInput {
  /** a new analysis on screen (frames the map once per key) */
  resultKey: string;
  /** px the top bar and the sheet cover: [top, right, bottom, left] */
  inset: [number, number, number, number];
  /** points to frame now (a community and its route, a facility picked); a new key moves the map */
  focus: { key: string; points: XY[] } | null;
  /** bumped to frame the whole area again (回到中心) */
  recenter: number;
  /**
   * bumped when the sheet comes back down from full: frame again what is framed now (the focus, else
   * the area) — the map was out of sight, nobody panned it, and the frame it kept is not to be trusted
   */
  reframe: number;
  onMarker(hit: MarkerHit): void;
  /** a tap on the map's ground, in GCJ-02 */
  onTapMap(at: { latitude: number; longitude: number }): void;
}

export const MapView = memo(function MapView(p: MapViewProps) {
  const { model, resultKey, inset } = p;
  const ctx = useRef<Taro.MapContext | null>(null);
  const layers = useMemo(
    () => buildLayers(p),
    [
      p.model,
      p.cat,
      p.T,
      p.scale,
      p.playing,
      p.circle,
      p.heat,
      p.gray,
      p.hot,
      p.selected,
      p.route,
      p.plan,
      p.places,
      p.lit,
      p.detour,
      p.method,
      p.pickAt,
    ],
  );
  const hitsRef = useRef(layers.hits);
  hitsRef.current = layers.hits;
  const center = useMemo(() => toLatLng(model, [0, 0]), [model]);

  useEffect(() => {
    ctx.current = Taro.createMapContext(MAP_ID);
  }, []);

  // a new analysis (or 回到中心): frame its 15′ circle in the part of the map that shows
  const insetKey = inset.join(',');
  useEffect(() => {
    const t = setTimeout(() => {
      ctx.current?.includePoints({ points: framePoints(model), padding: inset });
    }, 120);
    return () => clearTimeout(t);
    // framed per analysis, per sheet height and on request, not on every layer change
  }, [resultKey, insetKey, p.recenter]);

  // something picked: frame it (with some room around a single point, and a margin so the points
  // never sit on the edge of what shows)
  const frameFocus = (f: { points: XY[] }) => {
    const pts =
      f.points.length === 1
        ? [
            [f.points[0]![0] - 220, f.points[0]![1] - 220],
            [f.points[0]![0] + 220, f.points[0]![1] + 220],
          ]
        : f.points;
    const M = 36;
    ctx.current?.includePoints({
      points: pts.map((q) => toLatLng(model, q as XY)),
      padding: [inset[0] + M, inset[1] + M, inset[2] + M, inset[3] + M],
    });
  };
  const focusKey = p.focus?.key ?? '';
  useEffect(() => {
    const f = p.focus;
    if (!f || !f.points.length) return;
    const t = setTimeout(() => frameFocus(f), 80);
    return () => clearTimeout(t);
  }, [focusKey]);

  useEffect(() => {
    if (!p.reframe) return;
    const t = setTimeout(() => {
      if (p.focus?.points.length) frameFocus(p.focus);
      else ctx.current?.includePoints({ points: framePoints(model), padding: inset });
    }, 160);
    return () => clearTimeout(t);
  }, [p.reframe]);

  return (
    <Map
      id={MAP_ID}
      className="map"
      longitude={center.longitude}
      latitude={center.latitude}
      scale={15}
      minScale={12}
      maxScale={19}
      markers={layers.markers as never}
      polygons={layers.polygons as never}
      polyline={layers.polylines as never}
      circles={layers.circles as never}
      enablePoi
      enableBuilding={false}
      enableRotate={false}
      enableOverlooking={false}
      showCompass={false}
      showScale
      onMarkerTap={(e) => {
        const hit = hitsRef.current.get(Number(e.detail.markerId));
        if (hit) p.onMarker(hit);
      }}
      onLabelTap={(e) => {
        const hit = hitsRef.current.get(Number((e.detail as { markerId?: number }).markerId));
        if (hit) p.onMarker(hit);
      }}
      onTap={(e) => {
        const d = e.detail as { latitude?: number; longitude?: number };
        if (typeof d.latitude === 'number' && typeof d.longitude === 'number')
          p.onTapMap({ latitude: d.latitude, longitude: d.longitude });
      }}
      onError={() => {}}
    />
  );
});
