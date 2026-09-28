/** Wire rounding as in data/samples/*.json; −0 becomes 0, so a stored result equals the one in memory. */
export function round(v: number, digits: number): number {
  const k = 10 ** digits;
  const r = Math.round(v * k) / k;
  return r === 0 ? 0 : r;
}

export const r1 = (v: number) => round(v, 1);
export const r3 = (v: number) => round(v, 3);
