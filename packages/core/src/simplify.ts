/**
 * Douglas-Peucker line simplification (iterative, no recursion limit) for polylines and closed rings.
 */
import type { XY } from './coords.js';
import { closeRing, openRing, segDist2 } from './geom.js';

/** Keeps the end points and every vertex needed to stay within `tol` metres of the original line. */
export function simplifyLine(pts: XY[], tol: number): XY[] {
  const n = pts.length;
  if (n <= 2) return pts.slice();
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const tol2 = tol * tol;
  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let maxD2 = -1;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d2 = segDist2(pts[i]!, pts[a]!, pts[b]!);
      if (d2 > maxD2) {
        maxD2 = d2;
        idx = i;
      }
    }
    if (idx > 0 && maxD2 > tol2) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i] === 1);
}

/**
 * Simplifies a closed ring. The ring is cut at its first vertex and at the vertex farthest from it,
 * so the two halves are simplified independently and the shape cannot collapse onto a chord.
 * Returns a closed ring, or [] if fewer than three distinct vertices survive.
 */
export function simplifyRing(ring: XY[], tol: number): XY[] {
  const pts = openRing(ring);
  if (pts.length < 3) return [];
  const first = pts[0]!;
  let far = 0;
  let farD = -1;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i]!;
    const d = (p[0] - first[0]) ** 2 + (p[1] - first[1]) ** 2;
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  const a = simplifyLine(pts.slice(0, far + 1), tol);
  const b = simplifyLine([...pts.slice(far), first], tol);
  const merged = [...a, ...b.slice(1, -1)];
  return merged.length >= 3 ? closeRing(merged) : [];
}
