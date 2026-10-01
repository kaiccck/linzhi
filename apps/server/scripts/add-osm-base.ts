/**
 * Adds OpenStreetMap base layers (`base`: roads, water_areas, waterways, rail, landuse, places) to the
 * live samples data/samples/zj-b, zj-c and zj-v. The live engine writes none (live mode uses no OSM
 * data), so the web's offline fallback basemap and the printable report map had no streets for them
 * (无底图). The curated sample zj-a carries these layers from design/mockups/data-build/build-zj-a.ts;
 * this script builds them the same way, for each sample's own centre and frame:
 *
 *   - input: the Overpass snapshots under research/zhangjiang/raw (osm_highways, osm_water, osm_rail,
 *     osm_areas); offline, no network, no key;
 *   - WGS-84 -> GCJ-02 -> BD-09 (core wgs84ToBd09) -> the sample's local frame (core localFrame at
 *     meta.center_bd09, the frame meta.frame_formula states);
 *   - roads joined end to end per render class, clipped and simplified (Douglas-Peucker 1.5 m, like
 *     waterways and rail), water and land-use rings clipped and simplified at 1 m, 0.1 m rounding,
 *     zj-a's draw order;
 *   - clip box: the extent square (±meta.extent_m) plus MARGIN_M.
 *
 * A sample is skipped, never guessed, when its clip box is not inside the query bbox of every snapshot
 * (only there is an Overpass extract complete) or its frame formula is not core localFrame's. Besides
 * `base` (placed after meta, as in zj-a), meta.attribution gets the OpenStreetMap line (first, as in
 * zj-a), the engine's "实时模式不使用 OpenStreetMap 数据…" line is reworded in place (the analysis uses
 * Baidu data only, the OSM basemap is for display only) so the printed report does not contradict
 * itself, and meta.notes gets a Chinese note. Nothing else changes (checked before writing).
 * Idempotent: a rerun computes byte-identical files and leaves them untouched.
 * refresh-live-samples.ts rewrites these samples without `base`: run this again after it.
 *
 *   cd apps/server
 *   node --conditions=source --import tsx scripts/add-osm-base.ts [zj-b …] [--dry-run] [--verify]
 *
 * --dry-run writes nothing. --verify first rebuilds zj-a's base with zj-a's own box (no margin) and
 * stops unless it is byte-identical to the stored one (this port checked against build-zj-a.ts).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assembleRings,
  bd09ToWgs84,
  buildSegmentIndex,
  clipPolyline,
  clipRing,
  coordsSelfTest,
  inBox,
  localFrame,
  polylineLength,
  quantile,
  ringSignedArea,
  simplifyLine,
  simplifyRing,
  squareBox,
  wgs84ToBd09,
  type AnalysisResult,
  type BaseLayers,
  type Box,
  type LngLat,
  type LocalFrame,
  type XY,
} from '@zoudedao/core';

/** The repository root (fileURLToPath: the path has non-ASCII characters). */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const OSM_DIR = join(REPO_ROOT, 'research/zhangjiang/raw');
const SAMPLES_DIR = join(REPO_ROOT, 'data/samples');
const DEFAULT_SAMPLES = ['zj-b', 'zj-c', 'zj-v'];

// zj-a's parameters (build-zj-a.ts)
const LINE_TOL_M = 1.5; // Douglas-Peucker tolerance of roads, waterways and rail
const RING_TOL_M = 1.0; // ... of water and land-use rings
const MIN_PIECE_M = 6; // clipped road/rail/waterway pieces shorter than this are dropped
const MIN_WATER_M2 = 30;
const MIN_LANDUSE_M2 = 50;
/**
 * Clip margin beyond the extent square: the offline map's desktop composition (apps/web geo/view.ts,
 * 2500 m across the shorter side, centred on x = +300 m) reaches x ≈ +1850 m on a 1440-wide screen.
 */
const MARGIN_M = 250;

// ------------------------------------------------------------------------------------ OSM input

interface OsmPoint {
  lat: number;
  lon: number;
}
interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  nodes?: number[];
  geometry?: OsmPoint[];
  members?: { type: string; role: string; geometry?: OsmPoint[] }[];
}
interface OsmFile {
  elements: OsmElement[];
  osm3s?: { timestamp_osm_base?: string };
  _meta?: { query?: string; osm_base?: string };
}
/** WGS-84 bbox in Overpass order. */
interface WgsBox {
  s: number;
  w: number;
  n: number;
  e: number;
}

const OSM_LAYERS = ['highways', 'water', 'rail', 'areas'] as const;
type Osm = Record<(typeof OSM_LAYERS)[number], OsmElement[]>;

const BBOX_RE = /\((-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\)/g;

/** The four snapshots, the bbox inside which all of them are complete, and their date. */
function loadOsm(): { osm: Osm; covered: WgsBox; snapshot: string } {
  const osm = {} as Osm;
  const boxes: WgsBox[] = [];
  const dates = new Set<string>();
  for (const layer of OSM_LAYERS) {
    const name = `osm_${layer}.json`;
    const file = JSON.parse(readFileSync(join(OSM_DIR, name), 'utf8')) as OsmFile;
    const found = [...(file._meta?.query ?? '').matchAll(BBOX_RE)].map((m) => ({
      s: Number(m[1]),
      w: Number(m[2]),
      n: Number(m[3]),
      e: Number(m[4]),
    }));
    if (!found.length)
      throw new Error(`${name}: no (south,west,north,east) bbox in _meta.query, coverage unknown`);
    boxes.push(...found);
    const base = file._meta?.osm_base ?? file.osm3s?.timestamp_osm_base;
    if (base) dates.add(base.slice(0, 10));
    osm[layer] = file.elements;
  }
  const covered = boxes.reduce((a, b) => ({
    s: Math.max(a.s, b.s),
    w: Math.max(a.w, b.w),
    n: Math.min(a.n, b.n),
    e: Math.min(a.e, b.e),
  }));
  return { osm, covered, snapshot: [...dates].sort().join('/') };
}

/**
 * Metres by which the clip box (±half around the frame origin) stays inside the snapshot bbox; negative
 * when part of it lies outside. Walks the box edges every 20 m back to WGS-84 (local -> BD-09 -> WGS-84).
 */
function clearance(frame: LocalFrame, half: number, bb: WgsBox): number {
  let worst = Infinity;
  const n = Math.ceil(half / 10);
  for (let i = 0; i <= n; i++) {
    const t = -half + (2 * half * i) / n;
    const edge: XY[] = [
      [t, -half],
      [t, half],
      [-half, t],
      [half, t],
    ];
    for (const [x, y] of edge) {
      const [lng, lat] = bd09ToWgs84(...frame.toLngLat(x, y));
      const kx = 111320 * Math.cos((lat * Math.PI) / 180);
      worst = Math.min(
        worst,
        (lng - bb.w) * kx,
        (bb.e - lng) * kx,
        (lat - bb.s) * 110574,
        (bb.n - lat) * 110574,
      );
    }
  }
  return worst;
}

// --------------------------------------------------------------- base layers (as build-zj-a.ts)

const ROAD_CLASS: Record<string, string> = {
  motorway: 'motorway',
  motorway_link: 'motorway',
  trunk: 'trunk',
  trunk_link: 'trunk',
  primary: 'primary',
  primary_link: 'primary',
  secondary: 'secondary',
  secondary_link: 'secondary',
  tertiary: 'tertiary',
  tertiary_link: 'tertiary',
  residential: 'residential',
  living_street: 'residential',
  unclassified: 'residential',
  service: 'service',
  footway: 'footway',
  pedestrian: 'footway',
  path: 'footway',
  steps: 'footway',
  cycleway: 'footway',
  track: 'footway',
  bridleway: 'footway',
  corridor: 'footway',
};
// draw order: minor first, elevated last
const CLASS_ORDER = [
  'other',
  'footway',
  'service',
  'residential',
  'tertiary',
  'secondary',
  'primary',
  'trunk',
  'motorway',
];
const LANDUSE_ORDER = ['green', 'park', 'other', 'industrial', 'commercial', 'residential', 'school'];
const WATERWAY_KIND: Record<string, string> = {
  river: 'river',
  canal: 'canal',
  stream: 'stream',
  ditch: 'ditch',
  drain: 'ditch',
};

interface RoadProps {
  cls: string;
  elevated: boolean;
  bridge: boolean;
  tunnel: boolean;
  name: string | null;
  ref: string | null;
  layer: number;
}
interface WayChain {
  nodes: number[];
  props: RoadProps;
}

// the wire shapes of zj-a (BaseLayers plus the optional fields it carries)
type Road = BaseLayers['roads'][number] & { ref?: string; layer?: number; tunnel?: boolean };
type WaterArea = BaseLayers['water_areas'][number] & { name: string | null; holes?: XY[][] };
type Rail = BaseLayers['rail'][number] & {
  name: string | null;
  kind: string;
  tunnel: boolean;
  bridge: boolean;
};
type Landuse = BaseLayers['landuse'][number] & { holes?: XY[][] };
interface Base extends BaseLayers {
  roads: Road[];
  water_areas: WaterArea[];
  rail: Rail[];
  landuse: Landuse[];
  places: NonNullable<BaseLayers['places']>;
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const rXY = (p: XY): XY => [r1(p[0]), r1(p[1])];
const rPts = (pts: XY[]) => pts.map(rXY);

/**
 * Joins ways with identical render properties end-to-end wherever exactly two of them meet, so the map
 * gets long continuous polylines instead of hundreds of OSM way fragments.
 */
function mergeWays(ways: WayChain[]): WayChain[] {
  const groups = new Map<string, WayChain[]>();
  for (const w of ways) {
    const k = JSON.stringify(w.props);
    const g = groups.get(k);
    if (g) g.push(w);
    else groups.set(k, [w]);
  }
  const out: WayChain[] = [];
  for (const g of groups.values()) {
    const ends = new Map<number, number[]>();
    g.forEach((w, i) => {
      const a = w.nodes[0]!;
      const b = w.nodes[w.nodes.length - 1]!;
      if (a === b) return;
      for (const n of [a, b]) {
        const list = ends.get(n);
        if (list) list.push(i);
        else ends.set(n, [i]);
      }
    });
    const used = new Uint8Array(g.length);
    const extend = (chain: number[], atTail: boolean): number[] => {
      for (;;) {
        const endNode = atTail ? chain[chain.length - 1]! : chain[0]!;
        const inc = ends.get(endNode) ?? [];
        if (inc.length !== 2) return chain;
        const j = inc.find((k) => !used[k]);
        if (j === undefined) return chain;
        used[j] = 1;
        let nn = g[j]!.nodes;
        if (atTail) {
          if (nn[0] !== endNode) nn = nn.slice().reverse();
          chain = chain.concat(nn.slice(1));
        } else {
          if (nn[nn.length - 1] !== endNode) nn = nn.slice().reverse();
          chain = nn.slice(0, -1).concat(chain);
        }
        if (chain[0] === chain[chain.length - 1]) return chain;
      }
    };
    for (let i = 0; i < g.length; i++) {
      if (used[i]) continue;
      used[i] = 1;
      let chain = g[i]!.nodes.slice();
      if (chain[0] !== chain[chain.length - 1]) {
        chain = extend(chain, true);
        if (chain[0] !== chain[chain.length - 1]) chain = extend(chain, false);
      }
      out.push({ nodes: chain, props: g[i]!.props });
    }
  }
  return out;
}

/** Outer rings with their holes, in WGS-84: closed ways and multipolygon relations. */
function polygonsOf(e: OsmElement): { outer: LngLat[]; inners: LngLat[][] }[] {
  const toLL = (g: OsmPoint[]): LngLat[] => g.map((p) => [p.lon, p.lat]);
  const closed = (r: LngLat[]) =>
    r.length >= 4 && r[0]![0] === r[r.length - 1]![0] && r[0]![1] === r[r.length - 1]![1];
  if (e.type === 'way' && e.geometry) {
    const ring = toLL(e.geometry);
    return closed(ring) ? [{ outer: ring, inners: [] }] : [];
  }
  if (e.type === 'relation') {
    const members = (e.members ?? []).filter((m) => m.type === 'way' && m.geometry);
    const rings = (inner: boolean) =>
      assembleRings(
        members.filter((m) => (m.role === 'inner') === inner).map((m) => toLL(m.geometry!)),
      ).filter(closed);
    const inners = rings(true);
    return rings(false).map((outer) => ({ outer, inners }));
  }
  return [];
}

function landuseKind(t: Record<string, string>): string | null {
  const lu = t.landuse ?? '';
  const am = t.amenity ?? '';
  if (lu === 'residential') return 'residential';
  if (lu === 'commercial' || lu === 'retail' || am === 'marketplace') return 'commercial';
  if (lu === 'industrial') return 'industrial';
  if (lu === 'education' || ['school', 'kindergarten', 'university', 'college'].includes(am)) return 'school';
  if (t.leisure === 'park') return 'park';
  if (
    t.leisure === 'golf_course' ||
    ['grass', 'greenfield', 'farmland', 'meadow', 'village_green', 'recreation_ground', 'forest'].includes(lu)
  )
    return 'green';
  if (
    ['construction', 'brownfield', 'military'].includes(lu) ||
    ['hospital', 'research_institute'].includes(am)
  )
    return 'other';
  return null;
}

/** The base layers of one frame, clipped to `box`: build-zj-a.ts section 2, step for step. */
function buildBase(osm: Osm, frame: LocalFrame, box: Box): Base {
  const wgsXY = (lng: number, lat: number): XY => frame.toXY(...wgs84ToBd09(lng, lat));
  const lines = (pts: XY[]) =>
    clipPolyline(pts, box)
      .filter((piece) => polylineLength(piece) >= MIN_PIECE_M)
      .map((piece) => rPts(simplifyLine(piece, LINE_TOL_M)));
  /** Projected, clipped and simplified rings, or null if too little of the outer ring is left. */
  const polygon = (f: { outer: LngLat[]; inners: LngLat[][] }, minArea: number) => {
    const ring = (r: LngLat[]) =>
      simplifyRing(
        clipRing(
          r.map(([lng, lat]) => wgsXY(lng, lat)),
          box,
        ),
        RING_TOL_M,
      );
    const outer = ring(f.outer);
    if (!outer.length || Math.abs(ringSignedArea(outer)) < minArea) return null;
    const holes = f.inners.map(ring).filter((h) => h.length && Math.abs(ringSignedArea(h)) >= minArea);
    return { pts: rPts(outer), ...(holes.length ? { holes: holes.map(rPts) } : {}) };
  };

  // ---- roads
  const nodeXY = new Map<number, XY>();
  for (const e of osm.highways) if (e.type === 'node') nodeXY.set(e.id, wgsXY(e.lon!, e.lat!));
  const roadWays: WayChain[] = [];
  for (const w of osm.highways) {
    const t = w.tags;
    if (w.type !== 'way' || !t?.highway) continue;
    if (t.highway === 'proposed' || t.highway === 'platform' || t.area === 'yes') continue;
    const nodes = (w.nodes ?? []).filter((n) => nodeXY.has(n));
    if (nodes.length < 2) continue;
    const cls = ROAD_CLASS[t.highway] ?? 'other';
    const lengthM = polylineLength(nodes.map((n) => nodeXY.get(n)!));
    const bridgeTag = !!t.bridge && t.bridge !== 'no';
    // elevated = viaducts and long expressway bridges; short bridges over creeks stay "bridge"
    const elevated =
      bridgeTag &&
      (t.bridge === 'viaduct' ||
        (t.name ?? '').includes('高架') ||
        t.motorroad === 'yes' ||
        ((cls === 'motorway' || cls === 'trunk') && lengthM > 100));
    roadWays.push({
      nodes,
      props: {
        cls,
        elevated,
        bridge: bridgeTag && !elevated,
        tunnel: !!t.tunnel && t.tunnel !== 'no',
        name: t.name ?? null,
        ref: t.ref ?? null,
        layer: Number.parseInt(t.layer ?? '0', 10) || 0,
      },
    });
  }
  const roads: Road[] = [];
  for (const w of mergeWays(roadWays)) {
    const p = w.props;
    for (const pts of lines(w.nodes.map((n) => nodeXY.get(n)!))) {
      roads.push({
        cls: p.cls,
        elevated: p.elevated,
        bridge: p.bridge,
        name: p.name,
        ...(p.ref ? { ref: p.ref } : {}),
        ...(p.layer ? { layer: p.layer } : {}),
        ...(p.tunnel ? { tunnel: true } : {}),
        pts,
      });
    }
  }
  roads.sort(
    (a, b) =>
      Number(a.elevated) - Number(b.elevated) || CLASS_ORDER.indexOf(a.cls) - CLASS_ORDER.indexOf(b.cls),
  );

  // ---- water
  const water_areas: WaterArea[] = [];
  const waterways: Base['waterways'] = [];
  for (const e of osm.water) {
    const t = e.tags ?? {};
    const isArea =
      t.natural === 'water' ||
      t.landuse === 'reservoir' ||
      t.landuse === 'basin' ||
      t.waterway === 'riverbank';
    if (isArea) {
      for (const f of polygonsOf(e)) {
        const poly = polygon(f, MIN_WATER_M2);
        if (poly) water_areas.push({ name: t.name ?? null, ...poly });
      }
      continue;
    }
    const kind = WATERWAY_KIND[t.waterway ?? ''];
    if (e.type !== 'way' || !kind || !e.geometry || (t.tunnel && t.tunnel !== 'no')) continue;
    for (const pts of lines(e.geometry.map((p) => wgsXY(p.lon, p.lat)))) {
      waterways.push({ name: t.name ?? null, kind, pts });
    }
  }

  // ---- rail
  const rail: Rail[] = [];
  for (const e of osm.rail) {
    const t = e.tags ?? {};
    if (e.type !== 'way' || !e.geometry || !t.railway || t.railway === 'proposed') continue;
    for (const pts of lines(e.geometry.map((p) => wgsXY(p.lon, p.lat)))) {
      rail.push({
        name: t.name ?? null,
        kind: t.railway,
        tunnel: !!t.tunnel && t.tunnel !== 'no',
        bridge: !!t.bridge && t.bridge !== 'no',
        pts,
      });
    }
  }

  // ---- landuse + places
  const landuse: Landuse[] = [];
  const places: Base['places'] = [];
  for (const e of osm.areas) {
    const t = e.tags ?? {};
    if (e.type === 'node') {
      if (t.place && t.name) {
        const xy = wgsXY(e.lon!, e.lat!);
        if (inBox(xy, box)) places.push({ name: t.name, kind: t.place, xy: rXY(xy) });
      }
      continue;
    }
    const kind = landuseKind(t);
    if (!kind) continue;
    for (const f of polygonsOf(e)) {
      const poly = polygon(f, MIN_LANDUSE_M2);
      if (poly) landuse.push({ kind, name: t.name ?? null, ...poly });
    }
  }
  landuse.sort((a, b) => LANDUSE_ORDER.indexOf(a.kind) - LANDUSE_ORDER.indexOf(b.kind));

  return { roads, water_areas, waterways, rail, landuse, places };
}

/** How well Baidu's own geometry of the sample sits on the OSM streets (a frame sanity check). */
function alignment(base: Base, sample: Sample, box: Box): string {
  const walkable = base.roads.filter((r) => !r.elevated && r.cls !== 'motorway').map((r) => r.pts);
  const index = buildSegmentIndex(walkable, 50);
  const stat = (pts: XY[]) => {
    const d = pts
      .filter((p) => inBox(p, box))
      .map(([x, y]) => index.nearest(x, y, 200).d)
      .filter(Number.isFinite);
    if (!d.length) return 'none';
    return `median ${quantile(d, 0.5).toFixed(1)} m, p90 ${quantile(d, 0.9).toFixed(1)} m (n ${d.length})`;
  };
  const vertices = sample.paths.flatMap((p) => p.pts.map(([x, y]): XY => [x, y]));
  const entrances = sample.pois.flatMap((p) => (p.source === 'baidu' && p.navi_xy ? [p.navi_xy] : []));
  return `walk-route vertices ${stat(vertices)}; POI entrances ${stat(entrances)}`;
}

// ---------------------------------------------------------------------------------------- samples

type Sample = Omit<AnalysisResult, 'meta'> & { meta: AnalysisResult['meta'] & { notes?: string[] } };

function readSample(id: string): { file: string; text: string; nl: string; data: Sample } {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)) throw new Error(`not a sample id: ${id}`);
  const file = join(SAMPLES_DIR, `${id}.json`);
  const text = readFileSync(file, 'utf8');
  return { file, text, nl: text.endsWith('\n') ? '\n' : '', data: JSON.parse(text) as Sample };
}

/** `list` with `line` replacing the entry `mine` recognises, else added at the start or the end. */
function withLine(
  list: string[],
  mine: (s: string) => boolean,
  line: string,
  at: 'first' | 'last',
): string[] {
  if (list.some(mine)) return list.map((s) => (mine(s) ? line : s));
  return at === 'first' ? [line, ...list] : [...list, line];
}

const args = process.argv.slice(2);
const options = args.filter((a) => a.startsWith('--'));
const unknown = options.filter((a) => a !== '--dry-run' && a !== '--verify');
if (unknown.length) throw new Error(`unknown option ${unknown.join(' ')} (use --dry-run, --verify)`);
const dryRun = options.includes('--dry-run');
const ids = args.filter((a) => !a.startsWith('--'));
const samples = ids.length ? ids : DEFAULT_SAMPLES;

coordsSelfTest();
const { osm, covered, snapshot } = loadOsm();
const ATTRIBUTION = `Map data © OpenStreetMap contributors (ODbL), Overpass snapshot ${snapshot}`;
const isOsmAttribution = (a: string) => a.startsWith('Map data © OpenStreetMap contributors');
// The engine's attribution says live mode has no OSM basemap (packages/engine/src/report.ts); with a
// base that would contradict the map. Either wording is recognised, so reruns write the same line.
const NO_OSM_HEADS = ['实时模式不使用 OpenStreetMap 数据', '分析只用百度地图实测数据'];
const isNoOsmLine = (a: string) => NO_OSM_HEADS.some((h) => a.startsWith(h));
const NO_OSM_LINE =
  '分析只用百度地图实测数据：小区没有轮廓，河道与高架只从百度步行耗时推断；' +
  '底图的街道、水系与用地 © OpenStreetMap 贡献者，仅用于显示（离线底图与报告地图）。';
const NOTE_HEAD = '底图（base：';
const isBaseNote = (n: string) => n.startsWith(NOTE_HEAD);
const baseNote = (half: number) =>
  `${NOTE_HEAD}道路、水系、铁路、用地与地名）取自 OpenStreetMap 的 Overpass 快照（${snapshot}，` +
  'research/zhangjiang/raw/osm_*.json），由 apps/server/scripts/add-osm-base.ts 离线补入，做法与 zj-a 相同：' +
  `WGS84 按公开公式转 GCJ-02 再转 BD-09，投影到本样例的局部坐标，裁剪到中心 ±${half} 米的方框` +
  `（分析范围外扩 ${MARGIN_M} 米），道路、水道与铁路按 ${LINE_TOL_M} 米、水面与用地按 ${RING_TOL_M} 米容差简化。` +
  '底图只用于离线底图与打印报告的地图，不参与分析：耗时场、小区判定与阻隔推断仍然只用百度数据，小区仍然没有轮廓；' +
  'OSM 的道路与百度的步行路网不一定一致。';
console.log(
  `OSM snapshot ${snapshot}: complete inside S ${covered.s} W ${covered.w} N ${covered.n} E ${covered.e} (WGS-84)`,
);

if (options.includes('--verify')) {
  const a = readSample('zj-a').data;
  const [lng, lat] = a.meta.center_bd09;
  const got = JSON.stringify(buildBase(osm, localFrame(lng, lat), squareBox(a.meta.extent_m)));
  const want = JSON.stringify(a.base ?? null);
  if (got !== want) {
    throw new Error(
      `verify: rebuilt zj-a base has ${Buffer.byteLength(got)} bytes, the stored one ${Buffer.byteLength(want)}: ` +
        'this script no longer matches build-zj-a.ts',
    );
  }
  console.log(
    `verify: zj-a base rebuilt byte-identical (${Buffer.byteLength(got)} bytes) at its own centre and box`,
  );
}

const skipped: string[] = [];
for (const id of samples) {
  const { file, text, nl, data } = readSample(id);
  const meta = data.meta;
  const skip = (reason: string) => {
    skipped.push(id);
    console.log(`\n${id}: SKIPPED, ${reason}`);
  };
  const [lng, lat] = meta.center_bd09;
  if (JSON.stringify(data) + nl !== text) {
    skip('the file is not plain JSON.stringify output; rewriting it would reformat the other fields');
    continue;
  }
  if (
    meta.frame_formula !==
    `x = (lng - ${lng}) * 111320 * cos(${lat} deg), y = (lat - ${lat}) * 110574, lng/lat in BD-09`
  ) {
    skip(`meta.frame_formula is not core localFrame at meta.center_bd09: ${meta.frame_formula}`);
    continue;
  }
  if (data.base && !(meta.notes ?? []).some(isBaseNote)) {
    skip('it already has a base this script did not write (zj-a: build-zj-a.ts); leaving it alone');
    continue;
  }
  const frame = localFrame(lng, lat);
  const half = meta.extent_m + MARGIN_M;
  const clear = clearance(frame, half, covered);
  if (clear < 0) {
    skip(
      `not covered: the ±${half} m box around ${lng},${lat} (BD-09) reaches ${(-clear).toFixed(0)} m beyond the ` +
        'OSM snapshot bbox; no base is invented for it',
    );
    continue;
  }
  const box = squareBox(half);
  const base = buildBase(osm, frame, box);
  const { meta: _meta, base: _old, ...rest } = data;
  const next: Sample = {
    meta: {
      ...meta,
      attribution: withLine(meta.attribution ?? [], isOsmAttribution, ATTRIBUTION, 'first').map((a) =>
        isNoOsmLine(a) ? NO_OSM_LINE : a,
      ),
      notes: withLine(meta.notes ?? [], isBaseNote, baseNote(half), 'last'),
    },
    base,
    ...rest,
  };
  // nothing but base, the OSM attribution line, the reworded no-OSM line (in place) and the note may differ
  const others = (r: Sample) => {
    const { base: _b, ...o } = r;
    return JSON.stringify({
      ...o,
      meta: {
        ...o.meta,
        attribution: (o.meta.attribution ?? [])
          .filter((a) => !isOsmAttribution(a))
          .map((a) => (isNoOsmLine(a) ? '(no-OSM line)' : a)),
        notes: (o.meta.notes ?? []).filter((n) => !isBaseNote(n)),
      },
    });
  };
  if (others(next) !== others(data))
    throw new Error(`${id}: fields other than base, attribution and notes changed`);

  const out = JSON.stringify(next) + nl;
  const before = Buffer.byteLength(text);
  const after = Buffer.byteLength(out);
  const counts = Object.entries(base)
    .map(([k, v]) => `${k} ${(v as unknown[]).length}`)
    .join(', ');
  console.log(
    `\n${id} ${meta.name}: box ±${half} m, ${(clear / 1000).toFixed(1)} km inside the snapshot bbox`,
  );
  console.log(`  base: ${counts}; ${(Buffer.byteLength(JSON.stringify(base)) / 1024).toFixed(1)} KiB`);
  console.log(`  alignment to walkable OSM roads: ${alignment(base, data, squareBox(meta.extent_m))}`);
  const kib = (b: number) => `${b} B (${(b / 1024).toFixed(1)} KiB)`;
  if (out === text) {
    console.log(`  unchanged: ${kib(after)}, not rewritten`);
  } else if (dryRun) {
    console.log(`  dry run: would write ${kib(before)} -> ${kib(after)}`);
  } else {
    writeFileSync(file, out);
    console.log(`  wrote ${kib(before)} -> ${kib(after)}`);
  }
}
if (skipped.length) console.log(`\nskipped: ${skipped.join(', ')}`);
