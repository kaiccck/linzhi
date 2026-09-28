/**
 * Request encoding and SN signing, byte-compatible with Baidu's official Python sample:
 *
 *   encoded = urllib.parse.quote("/path?" + query, safe="/:=&?#+!$,;'@()*[]")
 *   sn      = md5(urllib.parse.quote_plus(encoded + SK))
 *
 * The signature covers the query exactly as sent (same order, same escaping), so the string that is
 * signed is the string that goes on the wire, with `&sn=` appended last.
 */
import { createHash } from 'node:crypto';
import type { ServiceAuth } from './config.js';
import type { BaiduService } from './types.js';

/** Characters the official sample leaves unescaped in "path?query". */
export const BAIDU_SAFE = "/:=&?#+!$,;'@()*[]";
/**
 * Safe set for a single query value: BAIDU_SAFE minus the query delimiters (& = # + ?), so user text such
 * as "3#楼" cannot break the query. Keeps `$` (place keywords) and `,` `;` (coordinates) readable, as in
 * the recorded requests.
 */
export const VALUE_SAFE = "/:!$,;'@()*[]";

const UNRESERVED = new Set('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-~');
const utf8 = new TextEncoder();

/** Python's urllib.parse.quote: percent-encode UTF-8 bytes except unreserved and `safe` characters. */
export function pyQuote(input: string, safe = '/'): string {
  let out = '';
  for (const byte of utf8.encode(input)) {
    const ch = String.fromCharCode(byte);
    if (byte < 0x80 && (UNRESERVED.has(ch) || safe.includes(ch))) out += ch;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** Python's urllib.parse.quote_plus: like pyQuote with spaces as '+'. */
export function pyQuotePlus(input: string, safe = ''): string {
  if (!input.includes(' ')) return pyQuote(input, safe);
  return pyQuote(input, `${safe} `).replaceAll(' ', '+');
}

/** sn for an already encoded "/path?query" (everything before `&sn=`). */
export function snSign(encodedPathAndQuery: string, sk: string): string {
  return createHash('md5')
    .update(pyQuotePlus(encodedPathAndQuery + sk), 'utf8')
    .digest('hex');
}

/** The official sample verbatim: raw "/path?query" in, sn out. Used for the doc test vector. */
export function snForRawPath(rawPathAndQuery: string, sk: string): string {
  return snSign(pyQuote(rawPathAndQuery, BAIDU_SAFE), sk);
}

export type QueryValue = string | number | boolean;
export type QueryParams = ReadonlyArray<readonly [string, QueryValue]>;

/** Encodes params in the given order. `escape` lists extra characters to escape inside values. */
export function encodeQuery(params: QueryParams, escape = ''): string {
  const safe = escape ? [...VALUE_SAFE].filter((c) => !escape.includes(c)).join('') : VALUE_SAFE;
  return params.map(([k, v]) => `${pyQuote(k, '')}=${pyQuote(String(v), safe)}`).join('&');
}

/** Services whose signed requests must carry a `timestamp` param (directionlite, per §2 measurements). */
export const SN_TIMESTAMP_SERVICES: ReadonlySet<BaiduService> = new Set(['directionlite_walking']);

export interface BuildRequestInput {
  host: string;
  path: string;
  params: QueryParams;
  auth: ServiceAuth;
  service: BaiduService;
  /** Unix ms; only used for the `timestamp` param. */
  now: number;
  /** Extra characters to escape inside values, e.g. ';' for routematrix `lat,lng;uid`. */
  escape?: string;
}

export interface BuiltRequest {
  url: string;
  /** "/path?query[&sn=…]" exactly as sent. */
  pathAndQuery: string;
}

/** Appends timestamp (SN + directionlite), ak and finally sn, then encodes and signs. */
export function buildRequest(input: BuildRequestInput): BuiltRequest {
  const { auth } = input;
  const params: [string, QueryValue][] = input.params.map(([k, v]) => [k, v]);
  if (auth.mode === 'sn' && SN_TIMESTAMP_SERVICES.has(input.service)) {
    params.push(['timestamp', Math.floor(input.now / 1000)]);
  }
  params.push(['ak', auth.ak]);
  let pathAndQuery = `${pyQuote(input.path, BAIDU_SAFE)}?${encodeQuery(params, input.escape)}`;
  if (auth.mode === 'sn') pathAndQuery += `&sn=${snSign(pathAndQuery, auth.sk)}`;
  return { url: input.host + pathAndQuery, pathAndQuery };
}

/** Masks ak and sn so a URL can be logged or stored. */
export function maskUrl(url: string): string {
  return url.replace(/([?&](?:ak|sn)=)[^&#]*/g, '$1***');
}
