/**
 * The report's map: the same print as the screen's map, drawn from the analysis alone — the Baidu tile
 * canvas cannot be exported, so there is no basemap beyond what the data carries (the OpenStreetMap
 * layers of a sample, when present). Canvases are painted at 3× so the printed page stays sharp
 * (about 290 dpi at this size); codes, marks and tags are HTML over them, placed by the same layout
 * rules as the screen (codes win). Each unit wears its worst verdict of the three categories.
 */
import { HARD_CATEGORIES } from '@zoudedao/core';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Pg } from '../components/Icons.js';
import { staticView } from '../geo/view.js';
import { layoutOverlay, rectQuads } from '../map/layout.js';
import { MapOverlay } from '../map/MapOverlay.js';
import { ScenePainter } from '../map/paint.js';
import { circleR, fmtInt, type Model } from '../model/derive.js';
import { facilityMarks } from '../model/facilities.js';
import { worstLook } from '../model/looks.js';

/** 182 mm × 150 mm at 96 px/in (the printed width of the page between its margins). */
export const MAP_W = 688;
export const MAP_H = 566;
const DPR = 3;
const NICE = [100, 200, 250, 500, 1000];
const noop = () => {};
const HARD: ReadonlySet<string> = new Set(HARD_CATEGORIES);

export function ReportMap({ model, scale, onPainted }: { model: Model; scale: number; onPainted?(): void }) {
  const underRef = useRef<HTMLCanvasElement>(null);
  const overRef = useRef<HTMLCanvasElement>(null);
  // the straight circle and a margin across the shorter side, centred on the analysis centre
  const view = useMemo(() => staticView(MAP_W, MAP_H, { cx: 0, cy: 0, span: model.r15 * 2 * 1.1 }), [model]);
  const painter = useMemo(() => new ScenePainter(model), [model]);
  const L = useMemo(
    () =>
      layoutOverlay({
        model,
        view,
        narrow: false,
        playing: false,
        T: 900,
        scale,
        circle: true,
        // the three hard categories' facilities in the circle or within 15′
        marks: { kind: 'all', list: facilityMarks(model, scale).filter((m) => HARD.has(m.cat)) },
        names: false,
      }),
    [model, view, scale],
  );

  useLayoutEffect(() => {
    const under = underRef.current!;
    const over = overRef.current!;
    for (const c of [under, over]) {
      c.width = MAP_W * DPR;
      c.height = MAP_H * DPR;
    }
    painter.paint(
      under.getContext('2d')!,
      over.getContext('2d')!,
      view,
      {
        T: 900,
        scale,
        circle: true,
        heat: true,
        hot: null,
        playing: false,
        gray: true,
        look: worstLook,
        route: false,
        taken: rectQuads(L.taken),
      },
      DPR,
      true,
    );
    onPainted?.();
  }, [painter, view, scale, onPainted, L]);

  // the printed map keeps its A4 size; a narrower screen (a phone) shows it scaled to the sheet
  const fitRef = useRef<HTMLDivElement>(null);
  const [k, setK] = useState(1);
  useLayoutEffect(() => {
    const el = fitRef.current;
    if (!el) return;
    const measure = () => setK(Math.min(1, el.clientWidth / MAP_W));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const bar = [...NICE].reverse().find((m) => m * view.s <= 120) ?? NICE[0]!;
  // what OpenStreetMap drew here: the streets and water (the `base` layers), and the community
  // outlines only where the units carry them (live results and samples B, C, V are points)
  const outlines = model.units.some((u) => u.outlined && !!u.osm_id);
  const osm = model.data.base
    ? `街道、水系${outlines ? '与小区轮廓' : ''} © OpenStreetMap 贡献者`
    : outlines
      ? '小区轮廓 © OpenStreetMap 贡献者'
      : null;
  return (
    <div className="rp-mapfit" ref={fitRef} style={k < 1 ? { height: MAP_H * k } : undefined}>
      <div
        className="rp-mapbox"
        style={{ width: MAP_W, height: MAP_H, ...(k < 1 ? { transform: `scale(${k})` } : {}) }}
      >
        <canvas className="layer under" ref={underRef} aria-hidden="true" />
        <canvas className="layer over" ref={overRef} aria-hidden="true" />
        <MapOverlay
          model={model}
          view={view}
          L={L}
          look={worstLook}
          narrow={false}
          hot={null}
          onHot={noop}
          interactive={false}
          hereLabel="片区中心"
        />
        <div className="rp-mapmeta" aria-hidden="true">
          <span className="scalebar">
            <span className="sb-bar" style={{ width: Math.round(bar * view.s) }} />
            <span className="num">{bar >= 1000 ? `${bar / 1000} km` : `${bar} m`}</span>
          </span>
          <span className="rp-north">
            <Pg id="pg-play" />
            <span>北</span>
          </span>
        </div>
        <p className="rp-prov">
          {osm ?? '无底图：本图只画体检数据'} · 步行：百度地图实测{' '}
          <span className="num">{model.measuredOn}</span> · 直线圈半径{' '}
          <span className="num">{fmtInt(circleR(model, scale))}</span> m
        </p>
      </div>
    </div>
  );
}
