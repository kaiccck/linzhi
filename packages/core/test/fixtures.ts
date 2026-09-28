/** Test-only access to the frozen sample data and the saved Baidu responses under research/. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { localFrame } from '../src/coords.js';
import type { LocalFrame, LngLat } from '../src/coords.js';
import type { AnalysisResult } from '../src/types.js';

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export function readJson<T>(rel: string): T {
  return JSON.parse(readFileSync(REPO_ROOT + rel, 'utf8')) as T;
}

let zj: AnalysisResult | undefined;

/** data/samples/zj-a.json (申城佳苑片区), parsed once per test file. */
export function zjA(): AnalysisResult {
  return (zj ??= readJson<AnalysisResult>('data/samples/zj-a.json'));
}

/** The local frame of zj-a (origin at meta.center_bd09). */
export function zjFrame(): LocalFrame {
  const [lng, lat] = zjA().meta.center_bd09;
  return localFrame(lng, lat);
}

/** A saved Baidu call: `_meta.request` is the URL with keys masked, `response` the JSON body. */
export interface RawCall<R> {
  _meta: { request: string };
  response: R;
}

export function readRaw<R>(rel: string): RawCall<R> {
  return readJson<RawCall<R>>(rel);
}

/** "lat,lng|lat,lng;uid|…" (routematrix parameters) → [lng, lat][]. */
export function latLngList(s: string | null): LngLat[] {
  return (s ?? '')
    .split('|')
    .filter(Boolean)
    .map((tok) => {
      const [lat, lng] = tok.split(';')[0]!.split(',').map(Number);
      return [lng!, lat!];
    });
}

/** Deterministic PRNG (mulberry32) so synthetic tests never flake. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Synthetic walking-time world: a river along x = riverX that can only be crossed at `bridge`;
 * everywhere else people walk at a constant detour ratio rho0 from the centre (0, 0).
 */
export function riverWorld(
  opts: { riverX?: number; bridge?: [number, number]; rho0?: number; speed?: number } = {},
) {
  const riverX = opts.riverX ?? 300;
  const bridge = opts.bridge ?? [300, -700];
  const rho0 = opts.rho0 ?? 1.2;
  const speed = opts.speed ?? 1.17;
  const toBridge = Math.hypot(bridge[0], bridge[1]);
  const time = (x: number, y: number): number =>
    x < riverX
      ? (rho0 * Math.hypot(x, y)) / speed
      : (rho0 * (toBridge + Math.hypot(x - bridge[0], y - bridge[1]))) / speed;
  return { riverX, bridge, rho0, speed, time };
}

/** Jittered lattice of timed points (TimeSample-like) over a box, skipping the centre. */
export function jitteredSamples(
  time: (x: number, y: number) => number,
  box: { xmin: number; xmax: number; ymin: number; ymax: number },
  spacing: number,
  seed = 7,
): { xy: [number, number]; dur_s: number }[] {
  const rand = rng(seed);
  const out: { xy: [number, number]; dur_s: number }[] = [];
  for (let gx = box.xmin; gx <= box.xmax; gx += spacing) {
    for (let gy = box.ymin; gy <= box.ymax; gy += spacing) {
      const x = gx + (rand() - 0.5) * spacing * 0.5;
      const y = gy + (rand() - 0.5) * spacing * 0.5;
      if (Math.hypot(x, y) < 30) continue;
      out.push({ xy: [x, y], dur_s: time(x, y) });
    }
  }
  return out;
}
