/**
 * A fake BaiduClient over the synthetic city: the four methods the engine calls with the result shapes
 * of @zoudedao/baidu, and a real QuotaLedger billed per request the way the client bills (routematrix
 * per ≤ 50-route tile). Every call is logged with its options; `onCall` can fail any of them.
 */
import {
  BaiduError,
  QuotaLedger,
  type BaiduService,
  type CallOptions,
  type PlacePoi,
  type RouteCell,
  type RouteMatrix,
  type WalkingStep,
} from '@zoudedao/baidu';
import type { LngLat, XY } from '@zoudedao/core';

import type { EngineClient } from '../src/index.js';
import { City, routeSteps, SPEED, type CityPoi } from './city.js';

export interface CallLog {
  service: BaiduService;
  /** Routes for routematrix, 1 per request otherwise. */
  units: number;
  /** n-th call of this service, from 1. */
  n: number;
  opts: CallOptions;
}

export interface FakeOptions {
  city?: City;
  /** Default: a fresh in-memory personal-tier ledger; null = a client without ledger. */
  ledger?: QuotaLedger | null;
  /** Runs before a call is answered; a returned error fails the call. */
  onCall?: (call: CallLog) => Error | void;
}

const REVERSE_POIS = [
  {
    uid: 'rp1',
    name: '中心花园',
    tag: '房地产;住宅区',
    location: null,
    distanceM: 0,
    direction: '内',
    address: null,
  },
];

export class FakeClient implements EngineClient {
  readonly city: City;
  readonly ledger: QuotaLedger | undefined;
  readonly calls: CallLog[] = [];
  /** What the client billed: pages for place, routes for routematrix, requests otherwise. */
  readonly billed: Partial<Record<BaiduService, number>> = {};
  private readonly onCall: FakeOptions['onCall'];

  constructor(opts: FakeOptions = {}) {
    this.city = opts.city ?? new City();
    this.ledger = opts.ledger === null ? undefined : (opts.ledger ?? new QuotaLedger({ tier: 'personal' }));
    this.onCall = opts.onCall;
  }

  count(service: BaiduService): number {
    return this.calls.filter((c) => c.service === service).length;
  }

  private begin(service: BaiduService, units: number, opts: CallOptions): Error | undefined {
    opts.signal?.throwIfAborted();
    const call: CallLog = { service, units, n: this.count(service) + 1, opts };
    this.calls.push(call);
    return this.onCall?.(call) ?? undefined;
  }

  /** Acquire and commit like BaiduClient.fetchJson: throws BaiduQuotaError past the budget or the limit. */
  private bill(service: BaiduService, units: number, opts: CallOptions) {
    this.ledger?.acquire(service, units, opts.budget).commit();
    this.billed[service] = (this.billed[service] ?? 0) + units;
  }

  private ll = (xy: XY): LngLat => this.city.toLngLat(xy);

  reverseGeocode: EngineClient['reverseGeocode'] = async (location, opts = {}) => {
    const err = this.begin('reverse_geocoding', 1, opts);
    if (err) throw err;
    this.bill('reverse_geocoding', 1, opts);
    return {
      location,
      formattedAddress: '测试省测试市临河区滨河街道河西路88号',
      semanticDescription: '中心花园内',
      business: '临河',
      province: '测试省',
      city: '测试市',
      district: '临河区',
      town: '滨河街道',
      townCode: null,
      adcode: null,
      street: '河西路',
      streetNumber: '88号',
      pois: opts.pois ? REVERSE_POIS : [],
      regions: [{ name: '中心花园', tag: '房地产;住宅区', uid: 'rp1', relation: '内' }],
      via: 'api',
    };
  };

  placeAround: EngineClient['placeAround'] = async (keywords, center, opts = {}) => {
    const words = [
      ...new Set(
        (typeof keywords === 'string' ? [keywords] : [...keywords])
          .flatMap((k) => k.split('$'))
          .map((k) => k.trim())
          .filter(Boolean),
      ),
    ];
    const pageSize = opts.pageSize ?? 20;
    const maxPages = opts.maxPages ?? 3;
    const list = this.city.place(words, this.city.toXY(center), opts.radius ?? 1000);
    const total = Math.min(list.length, 150);
    const pois: PlacePoi[] = [];
    let pages = 0;
    let exhausted = false;
    for (let page = 0; page < maxPages; page++) {
      const err = this.begin('place', 1, opts);
      if (err) throw err;
      this.bill('place', 1, opts);
      pages++;
      const rows = list.slice(page * pageSize, Math.min((page + 1) * pageSize, 150));
      pois.push(...rows.map((p) => this.placePoi(p, center)));
      if (rows.length < pageSize || (page + 1) * pageSize >= total) {
        exhausted = true;
        break;
      }
    }
    const capped = total >= 150;
    return {
      keywords: words,
      total,
      capped,
      complete: exhausted && !capped,
      pages,
      apiCalls: pages,
      resultType: 'poi_type',
      queryType: null,
      pois,
      via: 'api',
    };
  };

  private placePoi(p: CityPoi, center: LngLat): PlacePoi {
    const c = this.city.toXY(center);
    return {
      uid: p.uid,
      name: p.name,
      location: this.ll(p.xy),
      naviLocation: p.navi ? this.ll(p.navi) : null,
      address: null,
      province: '测试省',
      city: '测试市',
      area: '临河区',
      town: null,
      townCode: null,
      telephone: null,
      tag: p.tag,
      classifiedTag: p.tag,
      type: null,
      label: null,
      brand: null,
      distanceM: Math.round(Math.hypot(p.xy[0] - c[0], p.xy[1] - c[1])),
      parentId: p.parent ?? null,
      children: [],
      extra: {},
    };
  }

  routeMatrixWalking: EngineClient['routeMatrixWalking'] = async (origins, destinations, opts = {}) => {
    const units = origins.length * destinations.length;
    const failed = (err: BaiduError): RouteMatrix => ({
      cells: origins.map(() =>
        destinations.map((): RouteCell => ({
          status: 'failed',
          distanceM: null,
          durationS: null,
          via: 'api',
          error: err,
        })),
      ),
      errors: [err],
      stats: { ...stats(units), fromApi: 0, failed: units, requests: 0, routesRequested: 0 },
    });
    const err = this.begin('routematrix_walking', units, opts);
    // like the real client: with `partial` a failed request comes back as failed cells plus its error
    if (err) {
      if (!opts.partial || !(err instanceof BaiduError)) throw err;
      return failed(err);
    }
    try {
      for (let left = units; left > 0; left -= 50) this.bill('routematrix_walking', Math.min(50, left), opts);
    } catch (e) {
      if (!opts.partial || !(e instanceof BaiduError)) throw e;
      return failed(e);
    }
    const cells = origins.map((o) =>
      destinations.map((d): RouteCell => {
        const m = Math.round(this.city.walk(this.city.toXY(o), this.city.toXY(d)));
        return m > 0 && Number.isFinite(m)
          ? { status: 'ok', distanceM: m, durationS: Math.round(m / SPEED), via: 'api' }
          : { status: 'no_route', distanceM: null, durationS: null, via: 'api' };
      }),
    );
    return { cells, errors: [], stats: stats(units) };
  };

  walkingRoute: EngineClient['walkingRoute'] = async (origin, destination, opts = {}) => {
    const err = this.begin('directionlite_walking', 1, opts);
    if (err) throw err;
    this.bill('directionlite_walking', 1, opts);
    const r = this.city.route(this.city.toXY(origin), this.city.toXY(destination));
    if (r.points.length < 2) return null;
    const steps = routeSteps(r.points).map((st): WalkingStep => {
      const distanceM = Math.round(st.distance);
      return {
        distanceM,
        // directionlite runs 3.5–6.6 % slower than distance / 1.17 (measured)
        durationS: Math.round((st.distance / SPEED) * 1.05),
        instruction: `步行${distanceM}米`,
        instructionHtml: `步行<b>${distanceM}</b>米`,
        turnType: null,
        turnTypeId: null,
        direction: null,
        start: this.ll(st.points[0]!),
        end: this.ll(st.points[st.points.length - 1]!),
        path: st.points.map(this.ll),
      };
    });
    const path: LngLat[] = [];
    for (const p of steps.flatMap((s) => s.path)) {
      const last = path[path.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) path.push(p);
    }
    return {
      distanceM: steps.reduce((a, s) => a + s.distanceM, 0),
      durationS: steps.reduce((a, s) => a + s.durationS, 0),
      origin,
      destination,
      steps,
      path,
      via: 'api',
    };
  };
}

function stats(units: number) {
  return {
    pairs: units,
    unique: units,
    identity: 0,
    fromCache: 0,
    joined: 0,
    fromApi: units,
    failed: 0,
    requests: Math.ceil(units / 50),
    routesRequested: units,
  };
}
