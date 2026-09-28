import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Tests run in Vite's server (SSR) environment, where resolve.conditions does not reach linked
// workspace packages; alias them to their sources so tests never run against a stale dist.
const src = (pkg: string) => fileURLToPath(new URL(`../../packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    conditions: ['source'],
    alias: [{ find: /^@zoudedao\/core$/, replacement: src('core') }],
  },
  test: { include: ['src/**/*.test.ts', 'test/**/*.test.ts'] },
});
