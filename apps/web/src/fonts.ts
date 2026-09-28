/**
 * "Sign Numerals": the numeral face of the sign, composed from two self-hosted OFL fonts.
 *  - Barlow (road-sign lineage, tabular figures) for digits, Latin and punctuation — except the prime;
 *  - the sign face's own prime (Noto Sans SC), because Barlow's ′ is 0.6em wide and opens a gap in
 *    "24′" and "31′。" that the approved DIN-style setting never had.
 * Registered through the FontFace API so each file still loads only when a glyph in its range is used.
 */
import barlow600 from '@fontsource/barlow/files/barlow-latin-600-normal.woff2?url';
import barlow700 from '@fontsource/barlow/files/barlow-latin-700-normal.woff2?url';
import prime600 from '@fontsource/noto-sans-sc/files/noto-sans-sc-91-600-normal.woff2?url';
import prime700 from '@fontsource/noto-sans-sc/files/noto-sans-sc-91-700-normal.woff2?url';

export const NUMERAL_FAMILY = 'Sign Numerals';

// Barlow's latin subset range with U+2032–2033 (prime, double prime) taken out
const BARLOW_RANGE =
  'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, ' +
  'U+2000-2031, U+2034-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD';

export function registerNumeralFace(): void {
  if (typeof FontFace === 'undefined' || !document.fonts) return;
  const faces: [string, string, string][] = [
    ['600', barlow600, BARLOW_RANGE],
    ['700', barlow700, BARLOW_RANGE],
    ['600', prime600, 'U+2032-2033'],
    ['700', prime700, 'U+2032-2033'],
  ];
  for (const [weight, url, unicodeRange] of faces) {
    document.fonts.add(
      new FontFace(NUMERAL_FAMILY, `url(${url}) format('woff2')`, { weight, unicodeRange, display: 'swap' }),
    );
  }
}
