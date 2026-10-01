/**
 * "Barlow Num": the numeral face, composed from two self-hosted OFL fonts.
 *  - Barlow (500/600, latin) for digits, Latin and punctuation — except the prime;
 *  - Noto Sans SC's own prime, because Barlow's ′ is 0.6 em wide and opens a gap in "24′" and "31′。".
 * Registered through the FontFace API so each file still loads only when a glyph in its range is used.
 * The words are Noto Sans SC 400/500/700 from @fontsource (main.tsx), sliced by unicode-range: the
 * app shows community, facility and street names and AI answers it cannot know in advance, so the
 * browser fetches only the slices a page really uses instead of a fixed subset.
 */
import barlow500 from '@fontsource/barlow/files/barlow-latin-500-normal.woff2?url';
import barlow600 from '@fontsource/barlow/files/barlow-latin-600-normal.woff2?url';
import prime500 from '@fontsource/noto-sans-sc/files/noto-sans-sc-91-500-normal.woff2?url';
import prime700 from '@fontsource/noto-sans-sc/files/noto-sans-sc-91-700-normal.woff2?url';

export const NUMERAL_FAMILY = 'Barlow Num';

// Barlow's latin subset range with U+2032–2033 (prime, double prime) taken out
const BARLOW_RANGE =
  'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, ' +
  'U+2000-2031, U+2034-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD';

export function registerNumeralFace(): void {
  if (typeof FontFace === 'undefined' || !document.fonts) return;
  const faces: [string, string, string][] = [
    ['500', barlow500, BARLOW_RANGE],
    ['600', barlow600, BARLOW_RANGE],
    ['500', prime500, 'U+2032-2033'],
    // the prime next to 600 numerals: the sans has no 600, its 700 matches Barlow 600's colour
    ['600', prime700, 'U+2032-2033'],
  ];
  for (const [weight, url, unicodeRange] of faces) {
    document.fonts.add(
      new FontFace(NUMERAL_FAMILY, `url(${url}) format('woff2')`, { weight, unicodeRange, display: 'swap' }),
    );
  }
}

/** Canvas text (the offline basemap's street and place names) waits for these faces. */
export function loadMapFaces(sample: string): Promise<unknown> {
  if (typeof document === 'undefined' || !document.fonts) return Promise.resolve();
  return Promise.all([
    document.fonts.load('400 12px "Noto Sans SC"', sample),
    document.fonts.load('500 13px "Noto Sans SC"', sample),
    document.fonts.load(`600 12px "${NUMERAL_FAMILY}"`, 'A-0123456789′'),
  ]).catch(() => undefined);
}
