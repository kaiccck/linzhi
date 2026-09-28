/**
 * The synthetic city behind Baidu's wire format, as a Transport for the real BaiduClient: request URLs
 * in, JSON bodies out (HTTP 200 + status), so the client's signing, batching, cache and ledger all run.
 */
import type { Transport, TransportResponse } from '@zoudedao/baidu';
import type { LngLat, XY } from '@zoudedao/core';

import { City, routeSteps, SPEED } from './city.js';

/** "lat,lng" (Baidu order, optional ";uid") → [lng, lat]. */
function latLng(s: string): LngLat {
  const [lat, lng] = (s.split(';')[0] ?? '').split(',').map(Number);
  return [lng!, lat!];
}

const ll = (p: LngLat) => ({ lng: p[0], lat: p[1] });

export interface CityTransport extends Transport {
  /** Request paths in order. */
  paths: string[];
}

export function cityTransport(city: City): CityTransport {
  const paths: string[] = [];
  const ok = (json: Record<string, unknown>): TransportResponse => ({
    httpStatus: 200,
    json: { status: 0, message: 'ok', ...json },
  });
  const toLngLat = (xy: XY) => city.toLngLat(xy);
  const t = (async ({ url }) => {
    const u = new URL(url);
    const q = (k: string) => u.searchParams.get(k) ?? '';
    paths.push(u.pathname);
    switch (u.pathname) {
      case '/reverse_geocoding/v3/': {
        const at = latLng(q('location'));
        return ok({
          result: {
            location: ll(at),
            formatted_address: '测试省测试市临河区滨河街道河西路88号',
            business: '临河',
            sematic_description: '中心花园内',
            addressComponent: {
              province: '测试省',
              city: '测试市',
              district: '临河区',
              town: '滨河街道',
              street: '河西路',
              street_number: '88号',
            },
            pois: [],
            poiRegions: [{ name: '中心花园', tag: '房地产;住宅区', uid: 'rp1', direction_desc: '内' }],
          },
        });
      }
      case '/place/v3/around': {
        const center = city.toXY(latLng(q('location')));
        const list = city.place(q('query').split('$'), center, Number(q('radius')));
        const size = Number(q('page_size') || 10);
        const page = Number(q('page_num') || 0);
        const rows = list.slice(page * size, Math.min((page + 1) * size, 150));
        return ok({
          result_type: 'poi_type',
          total: Math.min(list.length, 150),
          results: rows.map((p) => ({
            name: p.name,
            uid: p.uid,
            location: ll(toLngLat(p.xy)),
            province: '测试省',
            city: '测试市',
            area: '临河区',
            detail_info: {
              tag: p.tag,
              classified_poi_tag: p.tag,
              distance: Math.round(Math.hypot(p.xy[0] - center[0], p.xy[1] - center[1])),
              ...(p.navi ? { navi_location: ll(toLngLat(p.navi)) } : {}),
              ...(p.parent ? { parent_id: p.parent } : {}),
            },
          })),
        });
      }
      case '/routematrix/v2/walking': {
        const origins = q('origins').split('|').map(latLng);
        const dests = q('destinations').split('|').map(latLng);
        const result = origins.flatMap((o) =>
          dests.map((d) => {
            const m = Math.round(city.walk(city.toXY(o), city.toXY(d)));
            const s = Math.round(m / SPEED);
            return { distance: { text: `${m}米`, value: m }, duration: { text: `${s}秒`, value: s } };
          }),
        );
        return ok({ result });
      }
      case '/directionlite/v1/walking': {
        const o = latLng(q('origin'));
        const d = latLng(q('destination'));
        const r = city.route(city.toXY(o), city.toXY(d));
        const steps = routeSteps(r.points).map((st) => ({
          distance: Math.round(st.distance),
          duration: Math.round((st.distance / SPEED) * 1.05),
          instruction: `步行${Math.round(st.distance)}米`,
          path: st.points.map((p) => toLngLat(p).join(',')).join(';'),
          start_location: ll(toLngLat(st.points[0]!)),
          end_location: ll(toLngLat(st.points[st.points.length - 1]!)),
        }));
        return ok({
          result: {
            origin: ll(o),
            destination: ll(d),
            routes: [
              {
                distance: steps.reduce((a, s) => a + s.distance, 0),
                duration: steps.reduce((a, s) => a + s.duration, 0),
                steps,
              },
            ],
          },
        });
      }
      default:
        return { httpStatus: 200, json: { status: 2, message: `unexpected path ${u.pathname}` } };
    }
  }) as CityTransport;
  t.paths = paths;
  return t;
}
