import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Tests run in Vite's server (SSR) environment, where resolve.conditions does not reach linked
// workspace packages; alias them to their sources so tests never run against a stale dist.
const src = (pkg: string) => fileURLToPath(new URL(`../../packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    conditions: ['source'],
    alias: [
      { find: /^@zoudedao\/core$/, replacement: src('core') },
      { find: /^@zoudedao\/baidu$/, replacement: src('baidu') },
    ],
  },
  // the synthetic-city pipeline runs the full engine several times; each run takes a few seconds
  test: { include: ['src/**/*.test.ts', 'test/**/*.test.ts'], testTimeout: 60_000, hookTimeout: 120_000 },
});
