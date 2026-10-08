/**
 * Custom Baidu basemap style for the light map (DESIGN.md "Basemap"): a pale grey ground, white
 * streets on a light casing, water and parks as the only colour, the elevated roads and the S20 a quiet
 * grey band, and every name — streets, places, compounds, buildings — in a muted grey on a white halo.
 * Baidu's own POI icons stay off: the map's facility marks are the only icons.
 *
 * The Baidu layer is left untouched (no CSS blending), so its streets and label glyphs stay crisp; the
 * warm walking-time field is our own canvas above it, multiplied in (paint.ts). The colours here are
 * therefore plain design tokens.
 *
 * Feature types were checked against this area (张江, zoom 15–17) on JSAPI 4.0: manmade = residential
 * and built blocks, education = school grounds, entertainment = commercial, scenicspots/green = parks,
 * highway = S20, cityhighway = 华夏高架, tertiary/fourlevel/provincial/nationalway = the street grid.
 */

type Styler = Record<string, string | number>;
export interface StyleRule {
  featureType: string;
  elementType: string;
  stylers: Styler;
}

/** The map's ground (Baidu's land, and the offline map's paper). */
export const GROUND = '#eef0f1';

/**
 * Street, place and POI name inks: muted, a step apart, all readable on the ground with their halo,
 * and a step under the overlay's own names (--ink-2), so the basemap reads as the ground beneath them.
 * The elevated roads keep the darkest: they are the barriers the findings name.
 */
export const LABEL_INK = {
  road: '#6d7886',
  wall: '#566170',
  place: '#6d7886',
  poi: '#77818e',
  water: '#4f7ea6',
  park: '#5c8a57',
} as const;

const WHITE = '#ffffff';

/** Baidu's style editor writes colours as #rrggbbaa: every colour here goes out opaque that way. */
const opaque = (stylers: Styler): Styler =>
  typeof stylers.color === 'string' && /^#[0-9a-f]{6}$/i.test(stylers.color)
    ? { ...stylers, color: `${stylers.color}ff` }
    : stylers;

const rule = (featureType: string, elementType: string, stylers: Styler): StyleRule => ({
  featureType,
  elementType,
  stylers: opaque(stylers),
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
/** Land use, a whisper apart from the ground; parks and water carry the only colour. */
export const AREAS: [string, string][] = [
  ['manmade', '#e6e9ec'],
  ['estate', '#e6e9ec'],
  ['education', '#ebe9e3'],
  ['medical', '#ebe7e8'],
  ['entertainment', '#ebe7e8'],
  ['shopping', '#ebe7e8'],
  ['transportation', '#e8eaeb'],
  ['building', '#e3e6ea'],
  ['green', '#d9e9d4'],
  ['scenicspots', '#d9e9d4'],
];
/** Place names (地名): kept on, in the muted voice. */
export const PLACE_NAMES = ['districtlabel', 'town', 'airportlabel'];
const POI_NAMES = [
  'transportationlabel',
  // area names drawn on the blocks themselves
  ...AREAS.map(([t]) => t),
];
/**
 * Off: everyday clutter — firms, office towers, offices, venues and the hamlets (…家宅) that fill the
 * map's edges and say nothing about walking — and the facility classes the map marks and names itself
 * (schools, clinics and pharmacies, markets and shops): Baidu's copy of 孙桥小学 would print beside the
 * app's own; metro stations are the map's own marks too (lines under construction print orange).
 */
export const QUIET = [
  'companylabel',
  'businesstowerlabel',
  'governmentlabel',
  'entertainmentlabel',
  'village',
  'educationlabel',
  'medicallabel',
  'shoppinglabel',
  'restaurantlabel',
  'hotellabel',
  'lifeservicelabel',
  'carservicelabel',
  'financelabel',
  'otherlabel',
  'subwaylabel',
  'subway',
];

/**
 * Baidu's compound names (estatelabel: 川杨新苑-北区 beside the map's A-02 川杨新苑 三期) and the names
 * it prints on the blocks themselves (manmade area labels: firms, depots, hamlets, compounds again —
 * these ignore the label blockers). Off at every level: the map names the compounds it checks, the
 * streets and the water name the rest. Every label part, or the ink and halo rules above show them again.
 */
export const BLOCK_NAMES = ['estatelabel', 'manmade'];

const LABEL_PARTS = ['labels', 'labels.text', 'labels.text.fill', 'labels.text.stroke'];

export const LIGHT_MAP_STYLE: StyleRule[] = [
  rule('land', 'geometry', { color: GROUND }),
  ...AREAS.map(([t, token]) => rule(t, 'geometry', { color: token })),
  // zoomed in, the buildings stand up: pale roofs, walls a shade darker so the blocks read in 3D
  rule('building', 'geometry.topfill', { color: '#eceef1' }),
  rule('building', 'geometry.sidefill', { color: '#d2d8df' }),
  rule('water', 'geometry', { color: '#c9dcec' }),
  rule('water', 'labels.text.fill', { color: LABEL_INK.water }),
  rule('water', 'labels.text.stroke', { color: WHITE }),
  ...STREETS.flatMap((t) => [
    rule(t, 'geometry.fill', { color: WHITE }),
    rule(t, 'geometry.stroke', { color: '#d3d9e0' }),
    rule(t, 'labels.text.fill', { color: LABEL_INK.road }),
    rule(t, 'labels.text.stroke', { color: WHITE }),
    rule(t, 'labels.icon', { visibility: 'off' }),
  ]),
  // elevated roads and the S20: a quiet grey band (they are the barriers the findings name)
  ...WALLS.flatMap((t) => [
    rule(t, 'geometry.fill', { color: '#dde2e8' }),
    rule(t, 'geometry.stroke', { color: '#b3bcc7' }),
    rule(t, 'labels.text.fill', { color: LABEL_INK.wall }),
    rule(t, 'labels.text.stroke', { color: WHITE }),
    rule(t, 'labels.icon', { visibility: 'off' }),
  ]),
  rule('railway', 'geometry', { color: '#d3d8de' }),
  rule('subwaystation', 'geometry', { visibility: 'off' }),
  rule('boundary', 'geometry', { visibility: 'off' }),
  // no Baidu icons anywhere; any name a rule below does not reach still prints grey (Baidu colours
  // some kinds on its own)
  rule('poilabel', 'labels.icon', { visibility: 'off' }),
  rule('poilabel', 'labels.text.fill', { color: LABEL_INK.poi }),
  rule('poilabel', 'labels.text.stroke', { color: WHITE }),
  rule('scenicspotslabel', 'labels.text.fill', { color: LABEL_INK.park }),
  rule('scenicspotslabel', 'labels.text.stroke', { color: WHITE }),
  rule('scenicspotslabel', 'labels.icon', { visibility: 'off' }),
  ...PLACE_NAMES.flatMap((t) => [
    rule(t, 'labels.text', { fontsize: 22 }),
    rule(t, 'labels.text.fill', { color: LABEL_INK.place }),
    rule(t, 'labels.text.stroke', { color: WHITE }),
    rule(t, 'labels.icon', { visibility: 'off' }),
  ]),
  ...POI_NAMES.flatMap((t) => [
    rule(t, 'labels.text', { fontsize: 22 }),
    rule(t, 'labels.text.fill', { color: LABEL_INK.poi }),
    rule(t, 'labels.text.stroke', { color: WHITE }),
    rule(t, 'labels.icon', { visibility: 'off' }),
  ]),
  ...QUIET.map((t) => rule(t, 'labels', { visibility: 'off' })),
  rule('subway', 'geometry', { visibility: 'off' }),
  ...BLOCK_NAMES.flatMap((t) => LABEL_PARTS.map((element) => rule(t, element, { visibility: 'off' }))),
];
