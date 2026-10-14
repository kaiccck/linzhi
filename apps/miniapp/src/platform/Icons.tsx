/**
 * Icons for the mini program, which has no inline SVG: the web's pictograms and UI glyphs (its SVG
 * sprite, generated into icons.gen.ts) and a few of the mini program's own, painted as SVG data-URI
 * backgrounds in the colour asked for.
 */
import { View } from '@tarojs/components';
import { SYMBOLS } from './icons.gen';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** UTF-8 → base64 (no btoa in the mini program). */
export function base64(text: string): string {
  const bytes: number[] = [];
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b = 0, c = 0] = [bytes[i]!, bytes[i + 1], bytes[i + 2]];
    const n = (a << 16) | (b << 8) | c;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63]! : '=';
    out += i + 2 < bytes.length ? B64[n & 63]! : '=';
  }
  return out;
}

/** The mini program's own stroke glyphs (24 grid, 1.8 stroke), beside the web's sprite. */
const OWN: Record<string, string> = {
  'ui-back':
    '<path d="M14.5 5.5 8 12l6.5 6.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  'ui-right':
    '<path d="M9.5 5.5 16 12l-6.5 6.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  'ui-down':
    '<path d="M6 9.5 12 15.5 18 9.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  'ui-target':
    '<circle cx="12" cy="12" r="6.5" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="2.2" fill="currentColor"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  'ui-route':
    '<circle cx="6" cy="18" r="2.2" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="18" cy="6" r="2.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8.2 18H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  'ui-chat':
    '<path d="M4.5 5.5h15a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 3.5V17.5h-1A1.5 1.5 0 0 1 3 16V7a1.5 1.5 0 0 1 1.5-1.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8 11.5h8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  'ui-doc':
    '<path d="M6.5 3h8l4 4v13.5a.5.5 0 0 1-.5.5H6.5a.5.5 0 0 1-.5-.5v-17a.5.5 0 0 1 .5-.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M9 12h7M9 16h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  'ui-pin':
    '<path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="12" cy="10" r="2.3" fill="currentColor"/>',
  'ui-share':
    '<path d="M12 3.5v11M7.5 8 12 3.5 16.5 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 11.5v8h12v-8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  'ui-send': '<path d="M4 11.5 20 4l-6.5 16-2.6-6.9z" fill="currentColor"/>',
  'ui-locate':
    '<path d="M20 4 4 11l6.5 2.5L13 20z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
};

const cache = new Map<string, string>();

/** The glyph as an SVG data URI in `color`. */
export function iconUri(id: string, color = '#16191F'): string {
  const key = `${id}|${color}`;
  let uri = cache.get(key);
  if (!uri) {
    const own = OWN[id];
    const s = own ? { viewBox: '0 0 24 24', body: own } : SYMBOLS[id];
    if (!s) return '';
    const body = s.body.replace(/currentColor/g, color);
    const fill = own ? 'none' : color;
    uri = `data:image/svg+xml;base64,${base64(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${s.viewBox}" fill="${fill}">${body}</svg>`,
    )}`;
    cache.set(key, uri);
  }
  return uri;
}

export function Icon({
  id,
  color,
  size = 20,
  className,
}: {
  id: string;
  color?: string;
  size?: number;
  className?: string;
}) {
  return (
    <View
      className={'icon' + (className ? ` ${className}` : '')}
      style={{ width: `${size}px`, height: `${size}px`, backgroundImage: `url("${iconUri(id, color)}")` }}
    />
  );
}
