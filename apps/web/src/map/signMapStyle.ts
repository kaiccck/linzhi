/**
 * Custom Baidu basemap style for the sign map (DESIGN.md "Basemap" tokens).
 *
 * The Baidu layer is composited with CSS `mix-blend-mode: hard-light` over our own paper + time-field
 * canvas, which restores the mockup's print order — paper, graded yellow, then white streets on top:
 *   - 50% grey is neutral: land lets the paper (or the yellow reach) through unchanged;
 *   - white stays white: streets and label halos knock out the yellow, as in the mockup;
 *   - darker colours multiply (×2) and lighter ones screen.
 * Every colour below is therefore *encoded*: `ink(token)` solves for the Baidu colour that prints as the
 * design token over Map Paper, so outside the reach the basemap shows exactly the DESIGN.md colours.
 *
 * Feature types were checked against this area (张江, zoom 16–17) on JSAPI 4.0: manmade = residential
 * and built blocks, education = school grounds, entertainment = commercial, scenicspots/green = parks,
 * highway = S20, cityhighway = 华夏高架, tertiary/fourlevel/provincial/nationalway = the street grid.
 */

type Styler = Record<string, string | number>;
interface StyleRule {
  featureType: string;
  elementType: string;
  stylers: Styler;
}

/** Map Paper, the ground the Baidu layer is blended over. */
export const PAPER = '#eceee9';

const hex = (h: string) =>
  [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];
const toHex = (c: number[]) =>
  '#' +
  c
    .map((v) =>
      Math.round(Math.max(0, Math.min(1, v)) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('') +
  'ff';

/** Baidu colour that prints as `target` when hard-light blended over Map Paper. */
export function ink(target: string): string {
  const b = hex(PAPER);
  const t = hex(target);
  return toHex(
    t.map((tc, i) => {
      const bc = b[i]!;
      // hard-light: S ≤ ½ → 2·B·S (multiply); S > ½ → screen(B, 2S − 1)
      return tc <= bc ? tc / (2 * bc) : 0.5 + (0.5 * (tc - bc)) / (1 - bc);
    }),
  );
}

const NEUTRAL = '#808080ff';
const WHITE = '#ffffffff';

const rule = (featureType: string, elementType: string, stylers: Styler): StyleRule => ({
  featureType,
  elementType,
  stylers,
});

const STREETS = [
  'nationalway',
  'provincialway',
  'arterial',
  'tertiaryway',
  'fourlevelway',
  'local',
  'scenicspotsway',
  'universityway',
  'vacationway',
];
const WALLS = ['highway', 'cityhighway'];
const AREAS: [string, string][] = [
  ['manmade', '#dfe3de'],
  ['estate', '#dfe3de'],
  ['education', '#e7e1cc'],
  ['medical', '#e4ddd6'],
  ['entertainment', '#e4ddd6'],
  ['shopping', '#e4ddd6'],
  ['transportation', '#e2e4df'],
  ['building', '#e2e4df'],
  ['green', '#c7e0ba'],
  ['scenicspots', '#c7e0ba'],
];
const HIDDEN_LABELS = [
  'poilabel',
  'districtlabel',
  'town',
  'village',
  'estatelabel',
  'businesstowerlabel',
  'companylabel',
  'governmentlabel',
  'educationlabel',
  'medicallabel',
  'entertainmentlabel',
  'shoppinglabel',
  'restaurantlabel',
  'hotellabel',
  'lifeservicelabel',
  'carservicelabel',
  'financelabel',
  'otherlabel',
  'transportationlabel',
  'scenicspotslabel',
  'airportlabel',
  'subwaylabel',
  // area names (小区, 公司, 公园 …): the sign's own codes and pictograms name places
  ...AREAS.map(([t]) => t),
];

export const SIGN_MAP_STYLE: StyleRule[] = [
  rule('land', 'geometry', { color: NEUTRAL }),
  ...AREAS.map(([t, token]) => rule(t, 'geometry', { color: ink(token) })),
  rule('water', 'geometry', { color: ink('#a8cbe6') }),
  rule('water', 'labels.text.fill', { color: ink('#2f6fae') }),
  rule('water', 'labels.text.stroke', { color: ink('#eaf3fb') }),
  ...STREETS.flatMap((t) => [
    rule(t, 'geometry.fill', { color: WHITE }),
    rule(t, 'geometry.stroke', { color: ink('#b9c0bb') }),
    rule(t, 'labels.text.fill', { color: ink('#4d555b') }),
    rule(t, 'labels.text.stroke', { color: WHITE }),
    rule(t, 'labels.icon', { visibility: 'off' }),
  ]),
  // elevated expressways are charcoal walls with charcoal label plates
  ...WALLS.flatMap((t) => [
    rule(t, 'geometry.fill', { color: ink('#4a5058') }),
    rule(t, 'geometry.stroke', { color: ink('#1f2429') }),
    rule(t, 'labels.text.fill', { color: WHITE }),
    rule(t, 'labels.text.stroke', { color: ink('#2b3137') }),
  ]),
  rule('railway', 'geometry', { color: ink('#d3d6d1') }),
  rule('subway', 'geometry', { visibility: 'off' }),
  rule('subwaystation', 'geometry', { visibility: 'off' }),
  rule('boundary', 'geometry', { visibility: 'off' }),
  ...HIDDEN_LABELS.map((t) => rule(t, 'labels', { visibility: 'off' })),
  rule('poilabel', 'labels.icon', { visibility: 'off' }),
];
