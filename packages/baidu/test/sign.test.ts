import { describe, expect, it } from 'vitest';
import {
  BAIDU_SAFE,
  buildRequest,
  encodeQuery,
  maskUrl,
  pyQuote,
  pyQuotePlus,
  snForRawPath,
  snSign,
  type ServiceAuth,
} from '../src/index.js';
import { FAKE_ENV } from './helpers.js';

const SN_AUTH: ServiceAuth = {
  mode: 'sn',
  ak: FAKE_ENV.BAIDU_SERVER_AK,
  sk: FAKE_ENV.BAIDU_SERVER_SK,
  akVar: 'BAIDU_SERVER_AK',
};
const IP_AUTH: ServiceAuth = { mode: 'ip', ak: FAKE_ENV.BAIDU_MATRIX_AK, akVar: 'BAIDU_MATRIX_AK' };

describe('SN signing', () => {
  it('matches the official test vector', () => {
    expect(snForRawPath('/geocoder/v2/?address=百度大厦&output=json&ak=yourak', 'yoursk')).toBe(
      '7de5a22212ffaa9e326444c75a58f9a0',
    );
  });

  it('reproduces the official request through buildRequest, sn last', () => {
    const { pathAndQuery } = buildRequest({
      host: '',
      path: '/geocoder/v2/',
      params: [
        ['address', '百度大厦'],
        ['output', 'json'],
      ],
      auth: { mode: 'sn', ak: 'yourak', sk: 'yoursk', akVar: 'BAIDU_SERVER_AK' },
      service: 'geocoding',
      now: 0,
    });
    expect(pathAndQuery).toBe(
      '/geocoder/v2/?address=%E7%99%BE%E5%BA%A6%E5%A4%A7%E5%8E%A6&output=json&ak=yourak&sn=7de5a22212ffaa9e326444c75a58f9a0',
    );
  });

  it('encodes exactly like urllib.parse.quote / quote_plus (Python reference values)', () => {
    expect(pyQuote("a b~!*'()é中", BAIDU_SAFE)).toBe("a%20b~!*'()%C3%A9%E4%B8%AD");
    expect(pyQuotePlus("a b~!*'()é中/?=&%")).toBe('a+b~%21%2A%27%28%29%C3%A9%E4%B8%AD%2F%3F%3D%26%25');
    expect(pyQuotePlus('/x?a=1&ak=yourakyoursk')).toBe('%2Fx%3Fa%3D1%26ak%3Dyourakyoursk');
  });

  it('signs directionlite with a timestamp before ak (Python reference sn)', () => {
    const { pathAndQuery } = buildRequest({
      host: 'https://api.map.baidu.com',
      path: '/directionlite/v1/walking',
      params: [
        ['origin', '31.190070,121.644195'],
        ['destination', '31.190270,121.654676'],
        ['steps_info', 1],
      ],
      auth: SN_AUTH,
      service: 'directionlite_walking',
      now: 1_790_414_372_000,
    });
    expect(pathAndQuery).toBe(
      `/directionlite/v1/walking?origin=31.190070,121.644195&destination=31.190270,121.654676&steps_info=1` +
        `&timestamp=1790414372&ak=${FAKE_ENV.BAIDU_SERVER_AK}&sn=5bd350fcf6fd31cd223fa3c1e43b0e74`,
    );
  });

  it('keeps "$" raw in place queries and signs them like the Python sample', () => {
    const { pathAndQuery } = buildRequest({
      host: '',
      path: '/place/v3/around',
      params: [
        ['query', '药店$药房'],
        ['location', '31.190070,121.644195'],
        ['radius', 1500],
        ['radius_limit', 'true'],
        ['scope', 2],
        ['page_size', 20],
        ['page_num', 0],
        ['output', 'json'],
      ],
      auth: SN_AUTH,
      service: 'place',
      now: 0,
    });
    expect(pathAndQuery).toContain('query=%E8%8D%AF%E5%BA%97$%E8%8D%AF%E6%88%BF&');
    expect(pathAndQuery).not.toContain('timestamp');
    expect(pathAndQuery.endsWith('&sn=fbb1ef7c28583d5e953d60920f0aa649')).toBe(true);
  });

  it('signs the %3B-escaped routematrix query as sent', () => {
    const { pathAndQuery } = buildRequest({
      host: '',
      path: '/routematrix/v2/walking',
      params: [
        ['origins', '31.190070,121.644195'],
        ['destinations', '31.190668,121.646020;7740d3d9e9035493744ff1d7|31.189534,121.641817'],
        ['coord_type', 'bd09ll'],
        ['output', 'json'],
      ],
      auth: SN_AUTH,
      service: 'routematrix_walking',
      now: 0,
      escape: ';',
    });
    expect(pathAndQuery).toContain(
      'destinations=31.190668,121.646020%3B7740d3d9e9035493744ff1d7%7C31.189534',
    );
    const [unsigned, sn] = pathAndQuery.split('&sn=');
    expect(sn).toBe('6c6754aac131f29d39e55476afbe442e');
    expect(snSign(unsigned ?? '', SN_AUTH.mode === 'sn' ? SN_AUTH.sk : '')).toBe(sn);
  });

  it('sends IP-whitelist requests unsigned and without timestamp', () => {
    const { url } = buildRequest({
      host: 'https://api.map.baidu.com',
      path: '/directionlite/v1/walking',
      params: [['origin', '31.19,121.64']],
      auth: IP_AUTH,
      service: 'directionlite_walking',
      now: 1_790_414_372_000,
    });
    expect(url).toBe(
      `https://api.map.baidu.com/directionlite/v1/walking?origin=31.19,121.64&ak=${IP_AUTH.ak}`,
    );
  });

  it('escapes query delimiters inside values so user text cannot break the query', () => {
    expect(encodeQuery([['address', '张江路1号#3栋&A=B+C?']])).toBe(
      'address=%E5%BC%A0%E6%B1%9F%E8%B7%AF1%E5%8F%B7%233%E6%A0%8B%26A%3DB%2BC%3F',
    );
    expect(encodeQuery([['coords', '121.1,31.2;121.3,31.4']])).toBe('coords=121.1,31.2;121.3,31.4');
  });

  it('masks ak and sn', () => {
    expect(maskUrl('https://x/p?a=1&ak=SECRET&sn=0123456789abcdef0123456789abcdef&b=2')).toBe(
      'https://x/p?a=1&ak=***&sn=***&b=2',
    );
  });
});
