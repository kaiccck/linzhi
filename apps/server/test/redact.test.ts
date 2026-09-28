import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { logSerializers, redactSecrets } from '../src/redact.js';
import { testConfig } from './helpers.js';

describe('log redaction', () => {
  it('masks Baidu credentials and other secret parameters', () => {
    expect(redactSecrets('/geocoding/v3/?address=海科路&ak=abc123&output=json&sn=ffee')).toBe(
      '/geocoding/v3/?address=海科路&ak=***&output=json&sn=***',
    );
    expect(redactSecrets('BAIDU_SERVER_AK=abc BAIDU_SERVER_SK=def')).toBe(
      'BAIDU_SERVER_AK=*** BAIDU_SERVER_SK=***',
    );
    expect(redactSecrets('/api/x?token=t0k&page=2')).toBe('/api/x?token=***&page=2');
    // names that merely end in a secret word stay untouched
    expect(redactSecrets('mask=1&monkey=2&task=3')).toBe('mask=1&monkey=2&task=3');
  });

  it('logs request lines and errors without secrets', () => {
    const req = { method: 'GET', url: '/api/samples?ak=abc', ip: '10.0.0.1' } as FastifyRequest;
    expect(logSerializers.req(req)).toEqual({
      method: 'GET',
      url: '/api/samples?ak=***',
      remoteAddress: '10.0.0.1',
    });

    const logged = logSerializers.err(
      new Error('GET https://api.map.baidu.com/place/v3?ak=abc&sn=def failed'),
    );
    expect(JSON.stringify(logged)).not.toMatch(/ak=abc|sn=def/); // message and stack
    expect(logged.message).toContain('ak=***');
  });

  it('writes request log lines without query secrets', async () => {
    const lines: string[] = [];
    const app = await buildApp({
      config: testConfig({ logLevel: 'info' }),
      logStream: { write: (line) => void lines.push(line) },
    });
    await app.inject('/api/samples?ak=SECRETVALUE&sn=abc&page=1');
    await app.close();
    const text = lines.join('');
    expect(text).toContain('/api/samples?ak=***&sn=***&page=1');
    expect(text).not.toContain('SECRETVALUE');
  });
});
